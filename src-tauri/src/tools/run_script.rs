//! `run_script`: lets the model run a script in any chat — code it writes,
//! or a script file in the chat's workspace folder — asking the user every
//! time. Off until Settings → Tools → Run scripts is on, and never offered
//! in Private Chat or to background tasks, which get no tools.
//!
//! The run itself is the skill scripts' ([`crate::skills::script`]): no
//! shell, the interpreter from the language or the extension, a time limit,
//! and Stop kills it. A workspace script is resolved through the workspace
//! sandbox. Code is saved to a temporary folder deleted after the run, which
//! is also where it runs when the chat has no workspace.
//!
//! Not in the built-in registry ([`super::builtin`]): its calls run
//! synchronously under a 20-second cap, and its switches are the in-process
//! utilities that onboarding's presets flip on together.

use std::path::Path;

use serde_json::{json, Map, Value};

use crate::db::Database;
use crate::mcp::{McpCallResult, McpToolDef};
use crate::skills::script;

pub const TOOL_NAME: &str = "run_script";
/// Settings → Tools → Run scripts. Not a `*_tool_enabled` key, which would
/// place it in the registry's set (see the module note).
pub const SETTING_KEY: &str = "run_script_enabled";

pub fn enabled(db: &Database) -> bool {
    db.get_setting(SETTING_KEY).ok().flatten().as_deref() == Some("true")
}

/// The tool as this turn offers it: a `script` file only when the chat has
/// a workspace to find one in.
pub fn tool_def(has_workspace: bool) -> McpToolDef {
    let os = match std::env::consts::OS {
        "windows" => "Windows",
        "macos" => "macOS",
        "linux" => "Linux",
        other => other,
    };
    let (what, place) = if has_workspace {
        (
            "Send the `code` and its `language`, and Loach saves it to a temporary file and \
             runs it; or name a `script` file in the workspace folder to run that.",
            "It runs in the workspace folder, so relative paths point there.",
        )
    } else {
        (
            "Send the `code` and its `language`; Loach saves it to a temporary file and runs it.",
            "It runs in a temporary folder that is deleted afterwards, so files it writes there \
             don't last: print what the user needs.",
        )
    };
    McpToolDef {
        server_id: super::builtin::BUILTIN_SERVER_ID.to_string(),
        server_name: super::builtin::SERVER_NAME.to_string(),
        name: TOOL_NAME.to_string(),
        qualified_name: TOOL_NAME.to_string(),
        description: Some(format!(
            "Run a script on the user's computer, which runs {os}, and get back its exit code \
             and output. {what} Python, bash, Node.js and PowerShell are supported, as installed \
             on the computer. `args` reach the script exactly as given, with no shell in \
             between, so don't quote them and don't use pipes or redirection. {place} It has no \
             terminal and can't ask questions: give it everything through `args` or `stdin`. \
             The user sees the code or command and approves every run. It gets {} seconds.",
            script::TIMEOUT.as_secs()
        )),
        input_schema: input_schema(has_workspace),
    }
}

fn input_schema(has_workspace: bool) -> Value {
    let mut properties = Map::new();
    properties.insert(
        "language".into(),
        json!({ "type": "string", "enum": script::LANGUAGES, "description": "The language `code` is written in." }),
    );
    properties.insert(
        "code".into(),
        json!({ "type": "string", "description": "The whole script to run." }),
    );
    if has_workspace {
        properties.insert(
            "script".into(),
            json!({
                "type": "string",
                "description": "Instead of `code`: a .py, .sh, .js, .mjs, .cjs or .ps1 file to run, relative to the workspace folder (e.g. `scripts/build.py`)."
            }),
        );
    }
    properties.insert(
        "args".into(),
        json!({ "type": "array", "items": { "type": "string" }, "description": "Command-line arguments, one string each." }),
    );
    properties.insert(
        "stdin".into(),
        json!({ "type": "string", "description": "Text for the script's standard input. Omit for none." }),
    );
    let mut schema = json!({ "type": "object", "properties": properties, "additionalProperties": false });
    if !has_workspace {
        schema["required"] = json!(["language", "code"]);
    }
    schema
}

/// Check a call: `code` with its `language`, or a `script` in the workspace.
pub fn plan(workspace_root: Option<&Path>, args: &Value) -> Result<script::Plan, String> {
    let given = |key: &str| args.get(key).filter(|v| !v.is_null());
    match (given("code"), given("script")) {
        (Some(_), Some(_)) => Err("Give either `code` or `script`, not both.".into()),
        (Some(code), None) => {
            let Some(code) = code.as_str() else {
                return Err("`code` must be a string".into());
            };
            let Some(language) = args.get("language").and_then(Value::as_str) else {
                return Err("`code` needs its `language`: python, bash, node or powershell.".into());
            };
            script::plan_code(language, code, args, workspace_root)
        }
        (None, Some(rel)) => {
            let Some(rel) = rel.as_str() else {
                return Err("`script` must be a string".into());
            };
            let Some(root) = workspace_root else {
                return Err(
                    "This chat has no workspace folder, so there's no script file to run. Send \
                     the `code` instead."
                        .into(),
                );
            };
            script::plan_file(root, rel, args, root)
        }
        (None, None) => Err("missing required `code` argument (string), with its `language`".into()),
    }
}

/// What a call would run, for its approval card, or `None` when it can't
/// run — it then fails without one.
pub fn preview(workspace_root: Option<&Path>, args: &Value) -> Option<script::Preview> {
    plan(workspace_root, args).ok().map(|p| p.preview())
}

/// Run one call. The caller races it against Stop: dropping it mid-run
/// kills the script and removes the code's temporary folder.
pub async fn dispatch(db: &Database, workspace_root: Option<&Path>, args: &Value) -> McpCallResult {
    if !enabled(db) {
        return failed("Running scripts is switched off in Loach's settings.".into());
    }
    let (root, args) = (workspace_root.map(Path::to_path_buf), args.clone());
    match tokio::task::spawn_blocking(move || plan(root.as_deref(), &args)).await {
        Ok(Ok(plan)) => script::run(plan).await,
        Ok(Err(e)) => failed(e),
        Err(e) => failed(format!("`{TOOL_NAME}` failed before it started: {e}")),
    }
}

fn failed(text: String) -> McpCallResult {
    McpCallResult {
        content_text: text,
        is_error: true,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn offers_a_workspace_script_only_with_a_workspace() {
        let without = tool_def(false);
        assert_eq!(without.name, TOOL_NAME);
        assert!(without.input_schema["properties"].get("script").is_none());
        assert_eq!(without.input_schema["required"], json!(["language", "code"]));
        assert!(without.description.as_deref().unwrap().contains("temporary folder"));

        let with = tool_def(true);
        assert!(with.input_schema["properties"].get("script").is_some());
        assert!(with.input_schema.get("required").is_none());
        assert!(with.description.as_deref().unwrap().contains("workspace folder"));
    }

    #[test]
    fn plans_code_or_a_workspace_script() {
        let ws = TempDir::new().unwrap();
        fs::create_dir_all(ws.path().join("scripts")).unwrap();
        fs::write(ws.path().join("scripts").join("build.py"), "print(1)").unwrap();
        let root = ws.path().canonicalize().unwrap();

        let code = preview(Some(&root), &json!({ "language": "bash", "code": "echo hi" })).unwrap();
        assert_eq!(code.command, "bash script.sh");
        assert_eq!(code.cwd, Some(dunce::simplified(&root).to_string_lossy().into_owned()));
        assert_eq!(preview(None, &json!({ "language": "bash", "code": "echo hi" })).unwrap().cwd, None);

        let file = preview(Some(&root), &json!({ "script": "scripts/build.py", "args": ["-v"] })).unwrap();
        assert!(file.command.ends_with("build.py -v"), "{}", file.command);
        assert_eq!(file.cwd, code.cwd);
    }

    #[test]
    fn refuses_calls_it_cant_run() {
        let ws = TempDir::new().unwrap();
        let root = ws.path().canonicalize().unwrap();
        let refuse = |root: Option<&Path>, args: Value| plan(root, &args).unwrap_err();
        assert!(refuse(Some(&root), json!({ "code": "x", "language": "bash", "script": "a.sh" })).contains("not both"));
        assert!(refuse(Some(&root), json!({})).contains("missing"));
        assert!(refuse(Some(&root), json!({ "code": "echo hi" })).contains("language"));
        assert!(refuse(Some(&root), json!({ "code": 5, "language": "bash" })).contains("string"));
        assert!(refuse(None, json!({ "script": "a.sh" })).contains("no workspace"));
        assert!(refuse(Some(&root), json!({ "script": "../a.sh" })).contains(".."));
        assert!(refuse(Some(&root), json!({ "script": "missing.sh" })).contains("not readable"));
    }
}
