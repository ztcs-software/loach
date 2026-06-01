//! Registry for the built-in (non-MCP) tools the model can call.
//!
//! Every built-in tool shares the same shape:
//!   * a settings key the user flips in Settings → Tools,
//!   * a model-facing name (the bare `name`; `qualified_name` is the same
//!     because there is no `server-name__` prefix to disambiguate against),
//!   * a description + JSON-Schema sent in the tools catalogue,
//!   * a `dispatch(arguments) -> McpCallResult` entry point.
//!
//! This module collects all of them in one table so adding a new tool is
//! one row + one tool module + one Settings UI line, with no repeated
//! catalogue-injection or dispatch boilerplate in `commands.rs` /
//! `mcp::dispatch_tool_call`.

use std::time::Duration;

use serde_json::Value;

use crate::db::Database;
use crate::mcp::{McpCallResult, McpToolDef};

/// Hard ceiling on a single built-in tool call. Built-ins are pure CPU and
/// should return in well under a second; this only exists so a pathological
/// model-supplied input (e.g. a giant `diff_text`) can't pin a worker
/// indefinitely.
const BUILTIN_TIMEOUT: Duration = Duration::from_secs(20);

/// Synthetic `server_id` stamped on every built-in [`McpToolDef`]. The
/// MCP dispatcher checks for this exact value and routes the call here
/// instead of opening a network session.
pub const BUILTIN_SERVER_ID: &str = "__builtin__";

/// `server_name` field on every built-in def — only shown in places like
/// the assistant-bubble tool-call chip; the user sees "Loach" rather than
/// "__builtin__".
const SERVER_NAME: &str = "Loach";

struct Builtin {
    setting_key: &'static str,
    name: &'static str,
    description: fn() -> &'static str,
    input_schema: fn() -> Value,
    dispatch: fn(&Value) -> McpCallResult,
}

/// Single source of truth. Order is the order tools appear in the model
/// catalogue — keep `calculate` first for backwards compatibility with
/// existing prompts that learned the catalogue layout in older builds.
const BUILTINS: &[Builtin] = &[
    Builtin {
        setting_key: "calculate_tool_enabled",
        name: super::calculate::TOOL_NAME,
        description: super::calculate::tool_description,
        input_schema: super::calculate::input_schema,
        dispatch: super::calculate::dispatch,
    },
    Builtin {
        setting_key: "datetime_tool_enabled",
        name: super::datetime::TOOL_NAME,
        description: super::datetime::tool_description,
        input_schema: super::datetime::input_schema,
        dispatch: super::datetime::dispatch,
    },
    Builtin {
        setting_key: "count_tool_enabled",
        name: super::count::TOOL_NAME,
        description: super::count::tool_description,
        input_schema: super::count::input_schema,
        dispatch: super::count::dispatch,
    },
    Builtin {
        setting_key: "hash_tool_enabled",
        name: super::hash::TOOL_NAME,
        description: super::hash::tool_description,
        input_schema: super::hash::input_schema,
        dispatch: super::hash::dispatch,
    },
    Builtin {
        setting_key: "uuid_tool_enabled",
        name: super::uuid_gen::TOOL_NAME,
        description: super::uuid_gen::tool_description,
        input_schema: super::uuid_gen::input_schema,
        dispatch: super::uuid_gen::dispatch,
    },
    Builtin {
        setting_key: "base64_tool_enabled",
        name: super::base64_tool::TOOL_NAME,
        description: super::base64_tool::tool_description,
        input_schema: super::base64_tool::input_schema,
        dispatch: super::base64_tool::dispatch,
    },
    Builtin {
        setting_key: "json_tool_enabled",
        name: super::json_tool::TOOL_NAME,
        description: super::json_tool::tool_description,
        input_schema: super::json_tool::input_schema,
        dispatch: super::json_tool::dispatch,
    },
    Builtin {
        setting_key: "unit_convert_tool_enabled",
        name: super::unit_convert::TOOL_NAME,
        description: super::unit_convert::tool_description,
        input_schema: super::unit_convert::input_schema,
        dispatch: super::unit_convert::dispatch,
    },
    Builtin {
        setting_key: "diff_text_tool_enabled",
        name: super::diff_text::TOOL_NAME,
        description: super::diff_text::tool_description,
        input_schema: super::diff_text::input_schema,
        dispatch: super::diff_text::dispatch,
    },
    Builtin {
        setting_key: "sort_tool_enabled",
        name: super::sort_tool::TOOL_NAME,
        description: super::sort_tool::tool_description,
        input_schema: super::sort_tool::input_schema,
        dispatch: super::sort_tool::dispatch,
    },
    Builtin {
        setting_key: "ip_tool_enabled",
        name: super::ip_tool::TOOL_NAME,
        description: super::ip_tool::tool_description,
        input_schema: super::ip_tool::input_schema,
        dispatch: super::ip_tool::dispatch,
    },
    Builtin {
        setting_key: "pdf_tool_enabled",
        name: super::pdf::TOOL_NAME,
        description: super::pdf::tool_description,
        input_schema: super::pdf::input_schema,
        dispatch: super::pdf::dispatch,
    },
];

/// Build catalogue entries for every built-in tool whose settings toggle
/// is on. Called once per chat turn; the per-row DB read is a cheap
/// indexed lookup on a tiny table.
pub fn enabled_builtin_defs(db: &Database) -> Vec<McpToolDef> {
    BUILTINS
        .iter()
        .filter(|b| {
            db.get_setting(b.setting_key).ok().flatten().as_deref() == Some("true")
        })
        .map(|b| McpToolDef {
            server_id: BUILTIN_SERVER_ID.to_string(),
            server_name: SERVER_NAME.to_string(),
            name: b.name.to_string(),
            qualified_name: b.name.to_string(),
            description: Some((b.description)().to_string()),
            input_schema: (b.input_schema)(),
        })
        .collect()
}

/// Dispatch a built-in tool by its bare name. Returns `None` for unknown
/// names so the MCP dispatcher can turn it into an `unknown built-in tool`
/// error with the offending name in the message.
pub fn dispatch_builtin(name: &str, arguments: &Value) -> Option<McpCallResult> {
    BUILTINS
        .iter()
        .find(|b| b.name == name)
        .map(|b| (b.dispatch)(arguments))
}

/// Run a built-in tool with a panic boundary and a wall-clock timeout.
///
/// Built-in dispatch is synchronous CPU work invoked inline on the chat
/// stream's async task. Without isolation, a panic on adversarial model
/// input unwinds the whole stream task (no `Done`/`Error` emitted, leaked
/// `StreamRegistry` entry, hung turn) and a slow tool blocks an async worker
/// the cancel button can't preempt. We offload to `spawn_blocking`, catch any
/// panic, and bound the runtime — mapping both failure modes to an `is_error`
/// result the model can read instead of a stuck conversation.
///
/// Returns `None` only for an unknown tool name, preserving the caller's
/// existing "unknown built-in tool" error.
pub async fn dispatch_builtin_guarded(name: &str, arguments: &Value) -> Option<McpCallResult> {
    let name_owned = name.to_string();
    let args_owned = arguments.clone();
    let outcome = tokio::time::timeout(
        BUILTIN_TIMEOUT,
        tokio::task::spawn_blocking(move || {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                dispatch_builtin(&name_owned, &args_owned)
            }))
        }),
    )
    .await;

    let error_result = |msg: String| {
        Some(McpCallResult {
            content_text: msg,
            is_error: true,
            ..Default::default()
        })
    };

    match outcome {
        // Ran to completion — `None` (unknown tool) or `Some(result)` pass
        // straight through.
        Ok(Ok(Ok(result))) => result,
        // The tool panicked; contain it and tell the model.
        Ok(Ok(Err(_panic))) => {
            tracing::error!("built-in tool `{name}` panicked");
            error_result(format!("Built-in tool `{name}` failed (internal error)."))
        }
        // spawn_blocking's join failed (runtime shutting down / task aborted).
        Ok(Err(join_err)) => {
            tracing::error!("built-in tool `{name}` task failed: {join_err}");
            error_result(format!("Built-in tool `{name}` did not complete."))
        }
        // Blew the wall-clock budget.
        Err(_elapsed) => error_result(format!(
            "Built-in tool `{name}` timed out after {}s — try smaller input.",
            BUILTIN_TIMEOUT.as_secs()
        )),
    }
}

/// Every settings key managed by this module. `commands::set_setting`
/// uses this to whitelist writes without listing the keys by hand.
pub fn setting_keys() -> impl Iterator<Item = &'static str> {
    BUILTINS.iter().map(|b| b.setting_key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn tool_names_are_unique() {
        let mut seen = HashSet::new();
        for b in BUILTINS {
            assert!(
                seen.insert(b.name),
                "duplicate built-in tool name `{}`",
                b.name
            );
        }
    }

    #[test]
    fn setting_keys_are_unique() {
        let mut seen = HashSet::new();
        for b in BUILTINS {
            assert!(
                seen.insert(b.setting_key),
                "duplicate setting key `{}`",
                b.setting_key
            );
        }
    }

    #[test]
    fn dispatch_unknown_returns_none() {
        assert!(dispatch_builtin("definitely_not_a_tool", &Value::Null).is_none());
    }
}
