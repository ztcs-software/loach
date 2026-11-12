//! `run_skill_script`: runs a script that ships with a skill. The only
//! place Loach starts a program the model picked, so it is narrow on
//! purpose:
//!
//! * **Only a skill's own files.** The script is resolved through the
//!   workspace sandbox with the skill's folder as the root — no absolute
//!   paths, no `..`, no link out of the folder.
//! * **No shell.** The interpreter comes from the extension
//!   ([`interpreter`]) and the arguments are handed over as an argv, so
//!   nothing in them is expanded, piped or redirected.
//! * **Asked every time.** `mcp::needs_approval` parks every call on the
//!   approval card, which shows the exact command and folder ([`Preview`]),
//!   and `providers::execute_tool_call` never records "allow for this chat"
//!   for it.
//! * **Bounded.** [`TIMEOUT`], capped output, no terminal and no input
//!   beyond `stdin`. Stop drops the run, and `kill_on_drop` kills the
//!   process. Only that process, though: anything it started itself and
//!   left running is not tracked.
//!
//! Once it starts, a script runs as the user, with their access to every
//! file — not just the workspace. The approval card says so.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWriteExt as _};

use crate::mcp::McpCallResult;

/// Longest a script may run before it is killed.
pub const TIMEOUT: Duration = Duration::from_secs(300);
const MAX_ARGS: usize = 64;
const MAX_ARGS_BYTES: usize = 16 * 1024;
const MAX_STDIN_BYTES: usize = 1024 * 1024;
/// Output kept per stream. The model gets less (the per-result cap); the
/// transcript gets this much.
const MAX_CAPTURE_BYTES: usize = 256 * 1024;

pub fn description() -> String {
    format!(
        "Run a script that ships with a skill: a file in the skill's folder that its \
         instructions tell you to run. The interpreter comes from the extension: .py \
         (Python), .sh (bash), .js/.mjs/.cjs (Node.js) or .ps1 (PowerShell). `args` reach \
         the script exactly as given, with no shell in between, so don't quote them and \
         don't use pipes or redirection. The script runs in the chat's workspace folder \
         when it has one, otherwise in the skill's folder, so relative paths in `args` \
         point there. It has no terminal and can't ask questions: give it everything \
         through `args` or `stdin`. The user sees the exact command and approves every \
         run. It gets {} seconds; you get its exit code and output.",
        TIMEOUT.as_secs()
    )
}

pub fn input_schema(skills: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": {
            "skill": { "type": "string", "enum": skills },
            "script": {
                "type": "string",
                "description": "The script, relative to the skill's folder (e.g. `scripts/extract.py`)."
            },
            "args": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Command-line arguments, one string each."
            },
            "stdin": {
                "type": "string",
                "description": "Text for the script's standard input. Omit for none."
            }
        },
        "required": ["skill", "script"],
        "additionalProperties": false
    })
}

/// What the approval card shows: the command as it will run, and where.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Preview {
    pub command: String,
    pub cwd: String,
    /// Characters of standard input, when there is any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdin_chars: Option<usize>,
}

/// A checked run, ready to start.
#[derive(Debug)]
pub struct Plan {
    program: String,
    args: Vec<String>,
    cwd: PathBuf,
    stdin: Option<String>,
}

/// The interpreter for a script, and the arguments that go before it.
fn interpreter(script: &Path) -> Option<(&'static str, &'static [&'static str])> {
    let ext = script.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        // `python3` isn't on Windows; `python` is the python.org installer's
        // name for it.
        "py" => (if cfg!(windows) { "python" } else { "python3" }, &[]),
        "sh" => ("bash", &[]),
        "js" | "mjs" | "cjs" => ("node", &[]),
        "ps1" => (
            if cfg!(windows) { "powershell" } else { "pwsh" },
            &["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"],
        ),
        _ => return None,
    })
}

/// Check a `run_skill_script` call against the skill's folder.
pub fn plan(skill_dir: &Path, args: &Value, workspace_root: Option<&Path>) -> Result<Plan, String> {
    let Some(rel) = args.get("script").and_then(Value::as_str) else {
        return Err("missing required `script` argument (string)".into());
    };
    let script = crate::tools::fs::resolve_read(skill_dir, rel)?;
    if !script.is_file() {
        return Err(format!("`{rel}` isn't a file in the skill's folder."));
    }
    let Some((program, lead)) = interpreter(&script) else {
        return Err(format!(
            "Loach runs .py, .sh, .js, .mjs, .cjs and .ps1 scripts, and `{rel}` isn't one of them."
        ));
    };
    let extra: Vec<String> = match args.get("args") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| match v {
                Value::String(s) => Ok(s.clone()),
                // Local models write `3` for `"3"`; the meaning is plain.
                Value::Number(n) => Ok(n.to_string()),
                Value::Bool(b) => Ok(b.to_string()),
                _ => Err("every entry in `args` must be a string".to_string()),
            })
            .collect::<Result<_, _>>()?,
        Some(_) => return Err("`args` must be an array of strings".into()),
    };
    if extra.len() > MAX_ARGS || extra.iter().map(String::len).sum::<usize>() > MAX_ARGS_BYTES {
        return Err(format!("too many arguments (at most {MAX_ARGS}, 16 KB in all)"));
    }
    if extra.iter().any(|a| a.contains('\0')) {
        return Err("arguments can't contain NUL characters".into());
    }
    let stdin = match args.get("stdin") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.len() <= MAX_STDIN_BYTES => Some(s.clone()),
        Some(Value::String(_)) => return Err("`stdin` is limited to 1 MB".into()),
        Some(_) => return Err("`stdin` must be a string".into()),
    };
    let mut argv: Vec<String> = lead.iter().map(|s| s.to_string()).collect();
    argv.push(crate::tools::fs::display_path(&script));
    argv.extend(extra);
    Ok(Plan {
        program: program.to_string(),
        args: argv,
        // The display form: Windows won't run a process in a `\\?\` folder.
        cwd: dunce::simplified(workspace_root.unwrap_or(skill_dir)).to_path_buf(),
        stdin,
    })
}

/// One argument as a reader would type it: quoted when it has spaces or
/// quotes in it, or is empty.
fn shown(arg: &str) -> String {
    if !arg.is_empty() && !arg.chars().any(|c| c.is_whitespace() || c == '"' || c == '\'') {
        return arg.to_string();
    }
    format!("\"{}\"", arg.replace('"', "\\\""))
}

impl Plan {
    pub fn preview(&self) -> Preview {
        let mut command = shown(&self.program);
        for a in &self.args {
            command.push(' ');
            command.push_str(&shown(a));
        }
        Preview {
            command,
            cwd: self.cwd.to_string_lossy().into_owned(),
            stdin_chars: self.stdin.as_ref().map(|s| s.chars().count()),
        }
    }
}

#[derive(Default)]
struct Capture {
    bytes: Vec<u8>,
    total: usize,
}

impl Capture {
    /// Read a pipe to its end, keeping the first [`MAX_CAPTURE_BYTES`].
    /// Reading on past the cap keeps the script from blocking on a full pipe.
    async fn drain(&mut self, pipe: Option<impl AsyncRead + Unpin>) {
        let Some(mut pipe) = pipe else { return };
        let mut buf = [0u8; 8192];
        loop {
            match pipe.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    self.total += n;
                    let room = MAX_CAPTURE_BYTES.saturating_sub(self.bytes.len());
                    self.bytes.extend_from_slice(&buf[..n.min(room)]);
                }
            }
        }
    }

    fn text(&self) -> String {
        let mut text = String::from_utf8_lossy(&self.bytes).trim_end().to_string();
        if self.total > self.bytes.len() {
            text.push_str(&format!(
                "\n[… {} more bytes not kept by Loach]",
                self.total - self.bytes.len()
            ));
        }
        text
    }
}

pub async fn run(plan: Plan) -> McpCallResult {
    let mut cmd = tokio::process::Command::new(&plan.program);
    cmd.args(&plan.args)
        .current_dir(&plan.cwd)
        .stdin(if plan.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Python on Windows writes a pipe in the ANSI code page and fails on
        // the first character outside it; its UTF-8 mode makes it UTF-8.
        .env("PYTHONUTF8", "1")
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up.

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return failed(format!(
                "Couldn't start `{}`: it isn't installed, or isn't on PATH.",
                plan.program
            ))
        }
        Err(e) => return failed(format!("Couldn't start `{}`: {e}", plan.program)),
    };
    let (stdin, stdout, stderr) = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    let input = plan.stdin.unwrap_or_default();
    let (mut out, mut err) = (Capture::default(), Capture::default());
    let waited = tokio::time::timeout(TIMEOUT, async {
        let feed = async {
            if let Some(mut pipe) = stdin {
                // A script that never reads its input closes the pipe; the
                // write then fails, which is fine.
                let _ = pipe.write_all(input.as_bytes()).await;
            }
        };
        let (status, (), (), ()) = tokio::join!(child.wait(), feed, out.drain(stdout), err.drain(stderr));
        status
    })
    .await;

    let (mut text, is_error) = match waited {
        Ok(Ok(status)) => match status.code() {
            Some(code) => (format!("Exit code {code}."), code != 0),
            None => ("The script was ended by a signal.".to_string(), true),
        },
        Ok(Err(e)) => (format!("Loach lost track of the script: {e}"), true),
        Err(_) => {
            let _ = child.start_kill();
            (
                format!("Stopped after {} seconds, the most a script may run.", TIMEOUT.as_secs()),
                true,
            )
        }
    };
    let (out, err) = (out.text(), err.text());
    if !out.is_empty() {
        text.push_str(&format!("\n\n--- stdout ---\n{out}"));
    }
    if !err.is_empty() {
        text.push_str(&format!("\n\n--- stderr ---\n{err}"));
    }
    if out.is_empty() && err.is_empty() {
        text.push_str(" No output.");
    }
    McpCallResult {
        content_text: text,
        is_error,
        ..Default::default()
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

    fn skill_with(file: &str) -> TempDir {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "echo hi").unwrap();
        tmp
    }

    #[test]
    fn plans_a_run_inside_the_skill() {
        let tmp = skill_with("scripts/run.sh");
        let dir = tmp.path().canonicalize().unwrap();
        let plan = plan(&dir, &json!({ "script": "scripts/run.sh", "args": ["a b", 3] }), None).unwrap();
        assert_eq!(plan.program, "bash");
        assert_eq!(plan.args.len(), 3);
        assert!(plan.args[0].ends_with("run.sh"));
        assert_eq!(plan.args[1..], ["a b".to_string(), "3".to_string()]);
        assert_eq!(plan.cwd, dunce::simplified(&dir));
        let preview = plan.preview();
        assert!(preview.command.starts_with("bash "));
        assert!(preview.command.ends_with(" \"a b\" 3"));
        assert_eq!(preview.stdin_chars, None);

        let ws = TempDir::new().unwrap();
        let ws_dir = ws.path().canonicalize().unwrap();
        let plan = super::plan(&dir, &json!({ "script": "scripts/run.sh", "stdin": "xyz" }), Some(&ws_dir)).unwrap();
        assert_eq!(plan.cwd, dunce::simplified(&ws_dir));
        assert_eq!(plan.preview().stdin_chars, Some(3));
    }

    #[test]
    fn refuses_what_it_cant_or_mustnt_run() {
        let tmp = skill_with("scripts/run.rb");
        let dir = tmp.path().canonicalize().unwrap();
        let refuse = |args: Value| plan(&dir, &args, None).unwrap_err();
        assert!(refuse(json!({ "script": "scripts/run.rb" })).contains(".py, .sh"));
        assert!(refuse(json!({ "script": "../other/x.py" })).contains(".."));
        assert!(refuse(json!({ "script": "missing.py" })).contains("not readable"));
        assert!(refuse(json!({ "script": "scripts" })).contains("isn't a file"));
        assert!(refuse(json!({})).contains("missing"));
        fs::write(tmp.path().join("ok.py"), "").unwrap();
        assert!(refuse(json!({ "script": "ok.py", "args": "x" })).contains("array"));
        assert!(refuse(json!({ "script": "ok.py", "args": [{}] })).contains("string"));
        assert!(refuse(json!({ "script": "ok.py", "args": ["a\0b"] })).contains("NUL"));
        assert!(refuse(json!({ "script": "ok.py", "stdin": 5 })).contains("string"));
    }

    #[test]
    fn shows_arguments_the_way_they_would_be_typed() {
        assert_eq!(shown("plain"), "plain");
        assert_eq!(shown(""), "\"\"");
        assert_eq!(shown("two words"), "\"two words\"");
        assert_eq!(shown("say \"hi\""), "\"say \\\"hi\\\"\"");
    }

    #[tokio::test]
    async fn a_missing_interpreter_says_so() {
        let plan = Plan {
            program: "loach-no-such-program".into(),
            args: Vec::new(),
            cwd: std::env::temp_dir(),
            stdin: None,
        };
        let r = run(plan).await;
        assert!(r.is_error);
        assert!(r.content_text.contains("isn't installed"), "{}", r.content_text);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runs_a_script_with_input_and_reports_both_streams() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("t.sh"),
            "read line; echo \"got $line and $1\"; echo oops >&2; exit 3\n",
        )
        .unwrap();
        let dir = tmp.path().canonicalize().unwrap();
        let plan = plan(&dir, &json!({ "script": "t.sh", "args": ["arg"], "stdin": "input\n" }), None).unwrap();
        let r = run(plan).await;
        assert!(r.is_error);
        assert!(r.content_text.starts_with("Exit code 3."), "{}", r.content_text);
        assert!(r.content_text.contains("--- stdout ---\ngot input and arg"));
        assert!(r.content_text.contains("--- stderr ---\noops"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn runs_a_powershell_script_with_input_and_reports_both_streams() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("t.ps1"),
            "$line = [Console]::In.ReadLine()\r\n\
             Write-Output \"got $line and $($args[0])\"\r\n\
             [Console]::Error.WriteLine('oops')\r\n\
             exit 3\r\n",
        )
        .unwrap();
        let dir = tmp.path().canonicalize().unwrap();
        let plan = plan(&dir, &json!({ "script": "t.ps1", "args": ["arg"], "stdin": "input\r\n" }), None).unwrap();
        let r = run(plan).await;
        assert!(r.is_error);
        assert!(r.content_text.starts_with("Exit code 3."), "{}", r.content_text);
        assert!(r.content_text.contains("--- stdout ---\ngot input and arg"), "{}", r.content_text);
        assert!(r.content_text.contains("--- stderr ---\noops"), "{}", r.content_text);
    }
}
