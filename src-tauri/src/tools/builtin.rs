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

use std::path::{Path, PathBuf};
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

/// How a built-in is invoked.
///
/// Almost every built-in is a pure function of its arguments, but the
/// workspace filesystem tools (`tools/fs.rs`) also need the directory the
/// current chat is scoped to. Rather than thread an `Option<&Path>` through
/// twelve tools that would ignore it, the registry carries the distinction
/// and [`enabled_builtin_defs`] uses it to withhold `Workspace` tools from
/// the catalogue entirely when the chat has no root.
enum Dispatch {
    Pure(fn(&Value) -> McpCallResult),
    Workspace(fn(&Path, &Value) -> McpCallResult),
}

struct Builtin {
    setting_key: &'static str,
    name: &'static str,
    description: fn() -> &'static str,
    input_schema: fn() -> Value,
    dispatch: Dispatch,
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
        dispatch: Dispatch::Pure(super::calculate::dispatch),
    },
    Builtin {
        setting_key: "datetime_tool_enabled",
        name: super::datetime::TOOL_NAME,
        description: super::datetime::tool_description,
        input_schema: super::datetime::input_schema,
        dispatch: Dispatch::Pure(super::datetime::dispatch),
    },
    Builtin {
        setting_key: "count_tool_enabled",
        name: super::count::TOOL_NAME,
        description: super::count::tool_description,
        input_schema: super::count::input_schema,
        dispatch: Dispatch::Pure(super::count::dispatch),
    },
    Builtin {
        setting_key: "hash_tool_enabled",
        name: super::hash::TOOL_NAME,
        description: super::hash::tool_description,
        input_schema: super::hash::input_schema,
        dispatch: Dispatch::Pure(super::hash::dispatch),
    },
    Builtin {
        setting_key: "uuid_tool_enabled",
        name: super::uuid_gen::TOOL_NAME,
        description: super::uuid_gen::tool_description,
        input_schema: super::uuid_gen::input_schema,
        dispatch: Dispatch::Pure(super::uuid_gen::dispatch),
    },
    Builtin {
        setting_key: "base64_tool_enabled",
        name: super::base64_tool::TOOL_NAME,
        description: super::base64_tool::tool_description,
        input_schema: super::base64_tool::input_schema,
        dispatch: Dispatch::Pure(super::base64_tool::dispatch),
    },
    Builtin {
        setting_key: "json_tool_enabled",
        name: super::json_tool::TOOL_NAME,
        description: super::json_tool::tool_description,
        input_schema: super::json_tool::input_schema,
        dispatch: Dispatch::Pure(super::json_tool::dispatch),
    },
    Builtin {
        setting_key: "unit_convert_tool_enabled",
        name: super::unit_convert::TOOL_NAME,
        description: super::unit_convert::tool_description,
        input_schema: super::unit_convert::input_schema,
        dispatch: Dispatch::Pure(super::unit_convert::dispatch),
    },
    Builtin {
        setting_key: "diff_text_tool_enabled",
        name: super::diff_text::TOOL_NAME,
        description: super::diff_text::tool_description,
        input_schema: super::diff_text::input_schema,
        dispatch: Dispatch::Pure(super::diff_text::dispatch),
    },
    Builtin {
        setting_key: "sort_tool_enabled",
        name: super::sort_tool::TOOL_NAME,
        description: super::sort_tool::tool_description,
        input_schema: super::sort_tool::input_schema,
        dispatch: Dispatch::Pure(super::sort_tool::dispatch),
    },
    Builtin {
        setting_key: "ip_tool_enabled",
        name: super::ip_tool::TOOL_NAME,
        description: super::ip_tool::tool_description,
        input_schema: super::ip_tool::input_schema,
        dispatch: Dispatch::Pure(super::ip_tool::dispatch),
    },
    Builtin {
        setting_key: "pdf_tool_enabled",
        name: super::pdf::TOOL_NAME,
        description: super::pdf::tool_description,
        input_schema: super::pdf::input_schema,
        dispatch: Dispatch::Pure(super::pdf::dispatch),
    },
    // Workspace filesystem tools. All five share one settings toggle and one
    // extra gate the rows above don't have: they are only offered when the
    // chat has a workspace root. See `tools/fs.rs`.
    Builtin {
        setting_key: super::fs::SETTING_KEY,
        name: super::fs::LIST_DIRECTORY,
        description: super::fs::list_directory_description,
        input_schema: super::fs::list_directory_schema,
        dispatch: Dispatch::Workspace(super::fs::dispatch_list_directory),
    },
    Builtin {
        setting_key: super::fs::SETTING_KEY,
        name: super::fs::FIND_FILES,
        description: super::fs::find_files_description,
        input_schema: super::fs::find_files_schema,
        dispatch: Dispatch::Workspace(super::fs::dispatch_find_files),
    },
    Builtin {
        setting_key: super::fs::SETTING_KEY,
        name: super::fs::READ_FILE,
        description: super::fs::read_file_description,
        input_schema: super::fs::read_file_schema,
        dispatch: Dispatch::Workspace(super::fs::dispatch_read_file),
    },
    Builtin {
        setting_key: super::fs::SETTING_KEY,
        name: super::fs::SEARCH_FILES,
        description: super::fs::search_files_description,
        input_schema: super::fs::search_files_schema,
        dispatch: Dispatch::Workspace(super::fs::dispatch_search_files),
    },
    Builtin {
        setting_key: super::fs::SETTING_KEY,
        name: super::fs::WRITE_FILE,
        description: super::fs::write_file_description,
        input_schema: super::fs::write_file_schema,
        dispatch: Dispatch::Workspace(super::fs::dispatch_write_file),
    },
    Builtin {
        setting_key: super::fs::SETTING_KEY,
        name: super::fs::EDIT_FILE,
        description: super::fs::edit_file_description,
        input_schema: super::fs::edit_file_schema,
        dispatch: Dispatch::Workspace(super::fs::dispatch_edit_file),
    },
    Builtin {
        setting_key: super::fs::SETTING_KEY,
        name: super::fs::MOVE_FILE,
        description: super::fs::move_file_description,
        input_schema: super::fs::move_file_schema,
        dispatch: Dispatch::Workspace(super::fs::dispatch_move_file),
    },
    Builtin {
        setting_key: super::fs::SETTING_KEY,
        name: super::fs::DELETE_FILE,
        description: super::fs::delete_file_description,
        input_schema: super::fs::delete_file_schema,
        dispatch: Dispatch::Workspace(super::fs::dispatch_delete_file),
    },
];

/// Build catalogue entries for every built-in tool whose settings toggle
/// is on. Called once per chat turn; the per-row DB read is a cheap
/// indexed lookup on a tiny table.
///
/// `has_workspace` is the second gate on the filesystem tools: with no
/// directory picked for this chat there is nothing for them to operate on,
/// so they are left out of the catalogue rather than offered and then
/// failing. The model never sees a tool it cannot use.
pub fn enabled_builtin_defs(db: &Database, has_workspace: bool) -> Vec<McpToolDef> {
    BUILTINS
        .iter()
        .filter(|b| !matches!(b.dispatch, Dispatch::Workspace(_)) || has_workspace)
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
///
/// A `Workspace` tool reached without a root is a bug upstream —
/// [`enabled_builtin_defs`] should never have offered it — so it answers
/// with an error the model can read rather than panicking the stream.
pub fn dispatch_builtin(
    name: &str,
    arguments: &Value,
    workspace_root: Option<&Path>,
) -> Option<McpCallResult> {
    BUILTINS.iter().find(|b| b.name == name).map(|b| match b.dispatch {
        Dispatch::Pure(f) => f(arguments),
        Dispatch::Workspace(f) => match workspace_root {
            Some(root) => f(root, arguments),
            None => McpCallResult {
                content_text: format!(
                    "`{name}` needs a workspace directory, and this chat has none. \
                     Ask the user to pick one with the + button next to the message box."
                ),
                is_error: true,
                ..Default::default()
            },
        },
    })
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
pub async fn dispatch_builtin_guarded(
    name: &str,
    arguments: &Value,
    workspace_root: Option<&Path>,
) -> Option<McpCallResult> {
    let name_owned = name.to_string();
    let args_owned = arguments.clone();
    // Owned across the `spawn_blocking` boundary — the borrow can't outlive
    // this frame, and the filesystem tools are the reason the blocking pool
    // matters here in the first place: they are the only built-ins that do
    // real I/O rather than pure CPU work.
    let root_owned: Option<PathBuf> = workspace_root.map(|p| p.to_path_buf());
    let outcome = tokio::time::timeout(
        BUILTIN_TIMEOUT,
        tokio::task::spawn_blocking(move || {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                dispatch_builtin(&name_owned, &args_owned, root_owned.as_deref())
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
///
/// Keys repeat — the five workspace tools share one — but every consumer
/// is a membership test, so deduplicating would cost more than it saves.
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

    /// One toggle per tool, with the workspace group as the single
    /// deliberate exception: those five rows are one capability and share
    /// `fs::SETTING_KEY`.
    #[test]
    fn setting_keys_are_unique_outside_the_workspace_group() {
        let mut seen = HashSet::new();
        for b in BUILTINS {
            if b.setting_key == crate::tools::fs::SETTING_KEY {
                continue;
            }
            assert!(
                seen.insert(b.setting_key),
                "duplicate setting key `{}`",
                b.setting_key
            );
        }
    }

    #[test]
    fn dispatch_unknown_returns_none() {
        assert!(dispatch_builtin("definitely_not_a_tool", &Value::Null, None).is_none());
    }

    /// A workspace tool called with no root must explain itself rather than
    /// panic — `enabled_builtin_defs` should have withheld it, so reaching
    /// here at all means something upstream is wrong.
    #[test]
    fn workspace_tool_without_a_root_is_an_error_not_a_panic() {
        let r = dispatch_builtin(crate::tools::fs::READ_FILE, &Value::Null, None)
            .expect("read_file is registered");
        assert!(r.is_error);
        assert!(r.content_text.contains("workspace directory"));
    }
}
