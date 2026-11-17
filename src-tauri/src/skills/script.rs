//! `run_skill_script`: runs a script that ships with a skill. The same
//! runner serves `run_script` ([`crate::tools::run_script`]), which runs
//! code the model wrote or a script in the chat's workspace folder. The
//! only place Loach starts a program the model picked, so it is narrow on
//! purpose:
//!
//! * **Only checked files.** A script is resolved through the workspace
//!   sandbox with the skill's folder — or, for `run_script`, the workspace —
//!   as the root: no absolute paths, no `..`, no link out of the folder.
//!   Code the model wrote is saved to a temporary folder of its own, deleted
//!   when the run ends.
//! * **No shell.** The interpreter comes from the extension
//!   ([`interpreter`]) and the arguments are handed over as an argv, so
//!   nothing in them is expanded, piped or redirected.
//! * **Asked every time.** `mcp::needs_approval` parks every call on the
//!   approval card, which shows the exact command and folder ([`Preview`])
//!   — and the code, whether the model wrote it in the call or it's in the
//!   script file — and `providers::execute_tool_call` never records "allow
//!   for this chat" for either tool.
//! * **Bounded.** [`TIMEOUT`], capped output, no terminal and no input
//!   beyond `stdin`. Everything the script starts is in one job object
//!   (Windows) or process group (Unix): when the run ends, times out or is
//!   stopped (Stop drops it), all of it is killed, so nothing it started
//!   outlives it. On Windows, what it starts outside the job — the
//!   Microsoft Store's Python starts everything that way — is found by
//!   parent id and killed with it.
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
/// How long output may keep coming once the script itself has exited.
const PIPE_GRACE: Duration = Duration::from_secs(2);
const MAX_ARGS: usize = 64;
const MAX_ARGS_BYTES: usize = 16 * 1024;
const MAX_STDIN_BYTES: usize = 1024 * 1024;
const MAX_CODE_BYTES: usize = 1024 * 1024;
/// The languages `run_script` takes code in, as its schema lists them.
pub const LANGUAGES: &[&str] = &["python", "bash", "node", "powershell"];
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
    /// Code the model wrote appears here under the name it's saved as
    /// (`script.py`); the card shows the code itself next to it.
    pub command: String,
    /// `None`: the temporary folder the code is saved in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Characters of standard input, when there is any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdin_chars: Option<usize>,
    /// A script file's text, for the card to show next to the command —
    /// the model may have written the file moments earlier under a
    /// standing write grant, so its path alone says nothing. The first
    /// [`MAX_SHOWN_FILE_BYTES`]; `file_bytes` is the whole file's size.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_bytes: Option<u64>,
}

/// How much of a script file its card shows. It's kept with the chat.
pub const MAX_SHOWN_FILE_BYTES: u64 = 256 * 1024;

/// A checked run, ready to start.
#[derive(Debug)]
pub struct Plan {
    program: String,
    /// The interpreter's own flags, ahead of the script.
    lead: &'static [&'static str],
    script: Script,
    /// The script's arguments.
    args: Vec<String>,
    /// `None`: the temporary folder the code is saved in.
    cwd: Option<PathBuf>,
    stdin: Option<String>,
}

#[derive(Debug)]
enum Script {
    /// A checked file on disk.
    File(PathBuf),
    /// Code the model wrote, saved as `name` in a temporary folder when the
    /// run starts.
    Code { name: &'static str, text: String },
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

/// The name code in `language` is saved as; its extension picks the
/// interpreter. Takes the names models tend to use besides [`LANGUAGES`].
fn code_file(language: &str) -> Option<&'static str> {
    Some(match language.trim().to_ascii_lowercase().as_str() {
        "python" | "python3" | "py" => "script.py",
        "bash" | "sh" => "script.sh",
        "node" | "javascript" | "js" => "script.js",
        "powershell" | "pwsh" | "ps1" => "script.ps1",
        _ => return None,
    })
}

/// Check a `run_skill_script` call against the skill's folder.
pub fn plan(skill_dir: &Path, args: &Value, workspace_root: Option<&Path>) -> Result<Plan, String> {
    let Some(rel) = args.get("script").and_then(Value::as_str) else {
        return Err("missing required `script` argument (string)".into());
    };
    plan_file(skill_dir, rel, args, workspace_root.unwrap_or(skill_dir))
}

/// A run of the script at `rel` inside `root`, in `cwd`, with the call's
/// `args` and `stdin`.
pub fn plan_file(root: &Path, rel: &str, args: &Value, cwd: &Path) -> Result<Plan, String> {
    let script = crate::tools::fs::resolve_read(root, rel)?;
    if !script.is_file() {
        return Err(format!("`{rel}` isn't a file."));
    }
    let Some((program, lead)) = interpreter(&script) else {
        return Err(format!(
            "Loach runs .py, .sh, .js, .mjs, .cjs and .ps1 scripts, and `{rel}` isn't one of them."
        ));
    };
    // Windows PowerShell reads a `.ps1` without a byte-order mark in the ANSI
    // code page, while the card shows it as UTF-8: a letter's two bytes there
    // can read as a quote here and end a string early, running a command the
    // card showed as text. (Code the model sends is saved with the mark.)
    if program == "powershell" {
        let bytes = std::fs::read(&script).map_err(|e| format!("Couldn't read `{rel}`: {e}"))?;
        let marked = [&[0xEF, 0xBB, 0xBF][..], &[0xFF, 0xFE], &[0xFE, 0xFF]]
            .iter()
            .any(|bom| bytes.starts_with(bom));
        if !marked && !bytes.is_ascii() {
            return Err(format!(
                "`{rel}` has non-ASCII text but no byte-order mark, so Windows PowerShell would \
                 read it in the ANSI code page — not as the approval card shows it. Save it as \
                 UTF-8 with a byte-order mark (start it with U+FEFF), or use ASCII only."
            ));
        }
    }
    let (args, stdin) = inputs(args)?;
    Ok(Plan {
        program: program.to_string(),
        lead,
        script: Script::File(script),
        args,
        // The display form: Windows won't run a process in a `\\?\` folder.
        cwd: Some(dunce::simplified(cwd).to_path_buf()),
        stdin,
    })
}

/// A run of code the model wrote, with the call's `args` and `stdin`, in
/// `cwd` — or, with none, in the temporary folder the code is saved in.
pub fn plan_code(language: &str, code: &str, args: &Value, cwd: Option<&Path>) -> Result<Plan, String> {
    let Some(name) = code_file(language) else {
        return Err(format!(
            "Loach runs python, bash, node and powershell code, and `{language}` isn't one of them."
        ));
    };
    if code.trim().is_empty() {
        return Err("`code` is empty.".into());
    }
    if code.len() > MAX_CODE_BYTES {
        return Err("`code` is limited to 1 MB".into());
    }
    let (program, lead) = interpreter(Path::new(name)).expect("every code file has an interpreter");
    let (args, stdin) = inputs(args)?;
    Ok(Plan {
        program: program.to_string(),
        lead,
        script: Script::Code { name, text: code.to_string() },
        args,
        cwd: cwd.map(|p| dunce::simplified(p).to_path_buf()),
        stdin,
    })
}

/// A call's `args` and `stdin`, checked.
fn inputs(args: &Value) -> Result<(Vec<String>, Option<String>), String> {
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
    // The card shows these as the exact command. A newline, a bidi
    // override or a zero-width character made it read differently from what
    // runs — refused, as the stdio MCP dialog refuses them. Text like that
    // can go through `stdin`.
    if extra.iter().any(|a| a.chars().any(crate::tools::fs::unreviewable_char)) {
        return Err(
            "arguments can't contain control, invisible or text-direction characters (a newline, \
             a bidi override…): the approval card couldn't show them as they'd run. Pass text like \
             that through `stdin`."
                .into(),
        );
    }
    let stdin = match args.get("stdin") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.len() <= MAX_STDIN_BYTES => Some(s.clone()),
        Some(Value::String(_)) => return Err("`stdin` is limited to 1 MB".into()),
        Some(_) => return Err("`stdin` must be a string".into()),
    };
    Ok((extra, stdin))
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
        // Code shows as the name it's saved under: its folder doesn't exist
        // until the run starts.
        let script = match &self.script {
            Script::File(path) => crate::tools::fs::display_path(path),
            Script::Code { name, .. } => name.to_string(),
        };
        let mut command = shown(&self.program);
        for a in self.lead.iter().copied().chain([script.as_str()]).chain(self.args.iter().map(String::as_str)) {
            command.push(' ');
            command.push_str(&shown(a));
        }
        let (file_text, file_bytes) = match &self.script {
            Script::File(path) => match read_shown(path) {
                Some((text, bytes)) => (Some(text), Some(bytes)),
                None => (None, None),
            },
            Script::Code { .. } => (None, None),
        };
        Preview {
            command,
            cwd: self.cwd.as_ref().map(|p| p.to_string_lossy().into_owned()),
            stdin_chars: self.stdin.as_ref().map(|s| s.chars().count()),
            file_text,
            file_bytes,
        }
    }
}

/// The start of a script file as text, and the file's size in bytes.
fn read_shown(path: &Path) -> Option<(String, u64)> {
    use std::io::Read as _;
    let file = std::fs::File::open(path).ok()?;
    let bytes = file.metadata().ok()?.len();
    let mut buf = Vec::new();
    file.take(MAX_SHOWN_FILE_BYTES).read_to_end(&mut buf).ok()?;
    Some((String::from_utf8_lossy(&buf).into_owned(), bytes))
}

/// Windows PowerShell writes to a pipe in the console's OEM code page, so
/// `zażółć ✓` came back `zaz�lc V`, and only code inside the process can
/// change that. A `.ps1` runs through this wrapper instead: it switches the
/// output to UTF-8 — and the input, which read the OEM code page too — then
/// runs the script named by [`PS_SCRIPT_VAR`] the way
/// `-File` would — the same arguments, its `exit` code, 1 when it throws.
/// Standard input too: `-File` feeds it to `$input` only when the script's
/// code names `$input` (otherwise `[Console]::In` reads it), and naming it
/// here would hand it over before the script runs — so the wrapper looks
/// for `$input` in the script, and only then passes the lines on. The
/// approval card shows the script's own command; this part is the same for
/// every run.
const PS_UTF8_WRAPPER: &str = r#"[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$LoachScript = $env:LOACH_SCRIPT
Remove-Item Env:LOACH_SCRIPT
$LoachAst = [Management.Automation.Language.Parser]::ParseFile($LoachScript, [ref]$null, [ref]$null)
if ($LoachAst.Find({ param($n) $n -is [Management.Automation.Language.VariableExpressionAst] -and $n.VariablePath.UserPath -eq 'input' }, $true)) {
  & { while ($null -ne ($l = [Console]::In.ReadLine())) { $l } } | & $LoachScript @args
} else {
  & $LoachScript @args
}
if (-not $?) { exit $LASTEXITCODE }
"#;
/// Where [`PS_UTF8_WRAPPER`] finds the script; it removes the variable
/// before the script starts.
const PS_SCRIPT_VAR: &str = "LOACH_SCRIPT";

/// Save [`PS_UTF8_WRAPPER`] beside the code, or in a temporary folder of its
/// own for a script file, and return its path.
fn save_ps_wrapper(saved: &mut SavedCode) -> std::io::Result<String> {
    let dir = match saved.0.take() {
        Some(dir) => dir,
        None => tempfile::Builder::new().prefix("loach-script-").tempdir()?,
    };
    let path = dir.path().join("loach-utf8-output.ps1");
    saved.0 = Some(dir);
    std::fs::write(&path, PS_UTF8_WRAPPER)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Save code in a temporary folder of its own, removed when the returned
/// guard drops. Windows PowerShell reads a script without a byte-order mark
/// in the ANSI code page, so a `.ps1` gets one.
fn save_code(name: &str, text: &str) -> std::io::Result<tempfile::TempDir> {
    let dir = tempfile::Builder::new().prefix("loach-script-").tempdir()?;
    let bom = if name.ends_with(".ps1") { "\u{feff}" } else { "" };
    std::fs::write(dir.path().join(name), format!("{bom}{text}"))?;
    Ok(dir)
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

/// The code's temporary folder, removed when dropped — retried for a few
/// seconds on a thread of its own when the first try fails. On Windows a
/// process just told to stop (Stop, the timeout) or one it started can still
/// have the folder as its working directory, or the script open: `TempDir`'s
/// own drop gave up silently and left the model's code behind.
struct SavedCode(Option<tempfile::TempDir>);

impl SavedCode {
    fn path(&self) -> Option<&Path> {
        self.0.as_ref().map(tempfile::TempDir::path)
    }
}

impl Drop for SavedCode {
    fn drop(&mut self) {
        let Some(dir) = self.0.take() else {
            return;
        };
        let path = dir.keep();
        if std::fs::remove_dir_all(&path).is_ok() {
            return;
        }
        std::thread::spawn(move || {
            for _ in 0..20 {
                std::thread::sleep(std::time::Duration::from_millis(250));
                if std::fs::remove_dir_all(&path).is_ok() || !path.exists() {
                    return;
                }
            }
            tracing::warn!("couldn't remove the script's temporary folder {}", path.display());
        });
    }
}

pub async fn run(plan: Plan) -> McpCallResult {
    // Code goes in a folder of its own, removed when `saved` drops: when the
    // run ends, however it ends — Stop drops this future, the process first.
    let (script, mut saved) = match &plan.script {
        Script::File(path) => (crate::tools::fs::display_path(path), SavedCode(None)),
        Script::Code { name, text } => match save_code(name, text) {
            Ok(dir) => (dir.path().join(name).to_string_lossy().into_owned(), SavedCode(Some(dir))),
            Err(e) => return failed(format!("Couldn't save the code to a temporary file: {e}")),
        },
    };
    let program = match program_path(&plan.program) {
        Ok(program) => program,
        Err(e) => return failed(e),
    };
    let mut cmd = tokio::process::Command::new(&program);
    // Windows PowerShell (`pwsh`, elsewhere, writes UTF-8) runs the script
    // through [`PS_UTF8_WRAPPER`].
    if plan.program == "powershell" {
        let wrapper = match save_ps_wrapper(&mut saved) {
            Ok(wrapper) => wrapper,
            Err(e) => return failed(format!("Couldn't save PowerShell's UTF-8 wrapper to a temporary file: {e}")),
        };
        cmd.args(plan.lead).arg(wrapper).args(&plan.args).env(PS_SCRIPT_VAR, &script);
    } else {
        cmd.args(plan.lead).arg(&script).args(&plan.args);
    }
    #[cfg(unix)]
    {
        // The PATH a terminal would see, as stdio MCP servers get it: started
        // from the Dock or a desktop launcher, Loach's own lacks what
        // `.zprofile` or `.bashrc` add, so `python3`, `node` or `pwsh` from
        // Homebrew, nvm or pyenv weren't found. std looks the program up on
        // the child's PATH once it's set.
        if let Some(path) = crate::mcp::stdio::login_shell_path().await {
            cmd.env("PATH", path);
        }
    }
    if let Some(cwd) = plan.cwd.as_deref().or(saved.path()) {
        cmd.current_dir(cwd);
    }
    cmd.stdin(if plan.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Python on Windows writes a pipe in the ANSI code page and fails on
        // the first character outside it; its UTF-8 mode makes it UTF-8.
        .env("PYTHONUTF8", "1")
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up.
    // Its own process group, so `tree` can stop everything the script starts.
    #[cfg(unix)]
    cmd.process_group(0);

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
    // Everything the script starts: dropped — when the run ends, times out
    // or is stopped — it stops all of it.
    let tree = crate::mcp::stdio::ProcessTree::adopt(&child);
    let (stdin, stdout, stderr) = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    let input = plan.stdin.unwrap_or_default();
    let (mut out, mut err) = (Capture::default(), Capture::default());
    let mut held_open = false;
    let waited = tokio::time::timeout(TIMEOUT, async {
        let feed = async {
            if let Some(mut pipe) = stdin {
                // A script that never reads its input closes the pipe; the
                // write then fails, which is fine.
                let _ = pipe.write_all(input.as_bytes()).await;
            }
        };
        let pipes = async {
            tokio::join!(feed, out.drain(stdout), err.drain(stderr));
        };
        tokio::pin!(pipes);
        tokio::select! {
            status = child.wait() => {
                // The script is done. Its output ends with it unless a
                // process it started still holds the pipes (`cmd &`,
                // `Popen`): reading on would wait for that process instead.
                held_open = tokio::time::timeout(PIPE_GRACE, &mut pipes).await.is_err();
                status
            }
            () = &mut pipes => child.wait().await,
        }
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
    // Stops whatever the script left running. Unix: the group id is still
    // the script's own — reaped at most PIPE_GRACE ago, and reserved while
    // any of the group lives.
    drop(tree);
    if held_open {
        text.push_str(
            " A process the script started was still running, so Loach stopped it: a script \
             can't leave programs running.",
        );
    }
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

/// The program to start for `program`: itself, except `bash` on Windows,
/// where a bare `bash` finds WSL's launcher in System32 before anything on
/// PATH ([`find_bash`]).
#[cfg(windows)]
fn program_path(program: &str) -> Result<std::ffi::OsString, String> {
    if program != "bash" {
        return Ok(program.into());
    }
    let windir = std::env::var_os("SystemRoot").map_or_else(|| PathBuf::from(r"C:\Windows"), PathBuf::from);
    let path = std::env::var_os("PATH").unwrap_or_default();
    match find_bash(std::env::split_paths(&path), &windir) {
        Bash::Found(bash) => Ok(bash.into_os_string()),
        Bash::OnlyWsl(bash) => Err(format!(
            "Couldn't start `bash`: the only one here is WSL's ({}), which runs a script inside \
             Linux, where this one's Windows path doesn't exist. Install Git for Windows, which \
             brings Git Bash, or put another bash.exe on PATH, then restart Loach.",
            bash.display()
        )),
        // Starting it then reports it missing.
        Bash::Missing => Ok(program.into()),
    }
}

#[cfg(not(windows))]
fn program_path(program: &str) -> Result<std::ffi::OsString, String> {
    Ok(program.into())
}

/// Where `bash` is, on Windows.
#[cfg(any(windows, test))]
#[derive(Debug, PartialEq)]
enum Bash {
    /// One that runs a script at its Windows path.
    Found(PathBuf),
    /// Only WSL's launcher.
    OnlyWsl(PathBuf),
    Missing,
}

/// The bash.exe to run a `.sh` with, given the `PATH` folders in order: the
/// first outside Windows' own folder and `…\Microsoft\WindowsApps`, which is
/// where WSL's launcher and its alias live, else Git for Windows' own
/// `bin\bash.exe` beside the `git` on PATH (all its installer adds there by
/// default). WSL's runs the script inside Linux, where a Windows path like
/// the script's doesn't exist.
#[cfg(any(windows, test))]
fn find_bash(dirs: impl IntoIterator<Item = PathBuf>, windir: &Path) -> Bash {
    let lower = |p: &Path| PathBuf::from(p.to_string_lossy().to_lowercase());
    let (windir_lower, apps) = (lower(windir), Path::new("microsoft").join("windowsapps"));
    let (mut wsl, mut git) = (None, None);
    for dir in dirs.into_iter().filter(|d| d.is_absolute()) {
        let bash = dir.join("bash.exe");
        if bash.is_file() {
            let d = lower(&dir);
            if !d.starts_with(&windir_lower) && !d.ends_with(&apps) {
                return Bash::Found(bash);
            }
            wsl.get_or_insert(bash);
        }
        if git.is_none() && dir.join("git.exe").is_file() {
            // `<Git>\cmd\git.exe`, or `<Git>\mingw64\bin\git.exe`.
            git = dir.ancestors().take(3).map(|a| a.join("bin").join("bash.exe")).find(|b| b.is_file());
        }
    }
    if let Some(bash) = git {
        return Bash::Found(bash);
    }
    // A bare `bash` tries the System32 folder even when it isn't on PATH.
    let system = windir.join("System32").join("bash.exe");
    match wsl.or_else(|| system.is_file().then_some(system)) {
        Some(bash) => Bash::OnlyWsl(bash),
        None => Bash::Missing,
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
        assert!(matches!(&plan.script, Script::File(p) if p.ends_with("run.sh")));
        assert_eq!(plan.args, ["a b".to_string(), "3".to_string()]);
        assert_eq!(plan.cwd.as_deref(), Some(dunce::simplified(&dir)));
        let preview = plan.preview();
        assert!(preview.command.starts_with("bash "));
        assert!(preview.command.ends_with("run.sh \"a b\" 3"));
        assert_eq!(preview.cwd, Some(dunce::simplified(&dir).to_string_lossy().into_owned()));
        assert_eq!(preview.stdin_chars, None);

        let ws = TempDir::new().unwrap();
        let ws_dir = ws.path().canonicalize().unwrap();
        let plan = super::plan(&dir, &json!({ "script": "scripts/run.sh", "stdin": "xyz" }), Some(&ws_dir)).unwrap();
        assert_eq!(plan.cwd.as_deref(), Some(dunce::simplified(&ws_dir)));
        assert_eq!(plan.preview().stdin_chars, Some(3));
    }

    /// Windows PowerShell would read a mark-less `.ps1` in the ANSI code
    /// page: `’` from `Ò`'s bytes is a quote to it.
    #[cfg(windows)]
    #[test]
    fn refuses_a_non_ascii_ps1_without_a_byte_order_mark() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().canonicalize().unwrap();
        let run = |text: &[u8]| {
            fs::write(dir.join("x.ps1"), text).unwrap();
            plan(&dir, &json!({ "script": "x.ps1" }), None)
        };
        let err = run("Write-Output 'CafÒ'".as_bytes()).unwrap_err();
        assert!(err.contains("byte-order mark"), "{err}");
        assert!(run(b"\xEF\xBB\xBFWrite-Output 'Caf\xC3\x92'").is_ok());
        assert!(run(b"Write-Output 'Cafe'").is_ok());
    }

    #[test]
    fn plans_code_under_the_name_it_is_saved_as() {
        let plan = plan_code("Python", "print(1)", &json!({ "args": ["x"] }), None).unwrap();
        let python = if cfg!(windows) { "python" } else { "python3" };
        assert_eq!(plan.preview().command, format!("{python} script.py x"));
        assert_eq!(plan.preview().cwd, None);
        let ws = TempDir::new().unwrap();
        let plan = plan_code("pwsh", "Write-Output 1", &json!({}), Some(ws.path())).unwrap();
        assert!(plan.preview().command.ends_with(" -File script.ps1"));
        assert_eq!(plan.cwd.as_deref(), Some(dunce::simplified(ws.path())));
        for language in LANGUAGES {
            assert!(plan_code(language, "x", &json!({}), None).is_ok(), "{language}");
        }
        assert!(plan_code("ruby", "x", &json!({}), None).unwrap_err().contains("isn't one of them"));
        assert!(plan_code("bash", " \n", &json!({}), None).unwrap_err().contains("empty"));
        assert!(plan_code("bash", "x", &json!({ "stdin": 5 }), None).unwrap_err().contains("string"));
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
        // B3-07: anything the card couldn't show as it would run — NUL, a
        // line break, a bidi override, a zero-width space.
        for hidden in ["a\0b", "a\nb", "a\u{202E}b", "a\u{200B}b"] {
            assert!(refuse(json!({ "script": "ok.py", "args": [hidden] })).contains("stdin"), "{hidden:?}");
        }
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
            lead: &[],
            script: Script::File(std::env::temp_dir()),
            args: Vec::new(),
            cwd: Some(std::env::temp_dir()),
            stdin: None,
        };
        let r = run(plan).await;
        assert!(r.is_error);
        assert!(r.content_text.contains("isn't installed"), "{}", r.content_text);
    }

    /// WSL's launcher, in Windows' own folder or as the WindowsApps alias,
    /// gives way to any other bash.exe on PATH, then to Git for Windows' own
    /// beside `git`; when it's all there is, it's reported as WSL's.
    #[test]
    fn bash_on_windows_passes_over_wsls_launcher() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let touch = |rel: &str| {
            let p = root.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, "").unwrap();
            p
        };
        let windir = root.join("Windows");
        let system = root.join("Windows/System32");
        let apps = root.join("AppData/Local/Microsoft/WindowsApps");
        let wsl = touch("Windows/System32/bash.exe");
        touch("AppData/Local/Microsoft/WindowsApps/bash.exe");
        assert_eq!(find_bash([system.clone(), apps.clone()], &windir), Bash::OnlyWsl(wsl.clone()));
        assert_eq!(find_bash([apps.clone()], &windir), Bash::OnlyWsl(apps.join("bash.exe")));
        assert_eq!(find_bash([], &windir), Bash::OnlyWsl(wsl));

        touch("Git/cmd/git.exe");
        touch("Git/mingw64/bin/git.exe");
        let git_bash = touch("Git/bin/bash.exe");
        let found = |dirs: Vec<PathBuf>| find_bash(dirs, &windir);
        assert_eq!(found(vec![system.clone(), apps, root.join("Git/cmd")]), Bash::Found(git_bash.clone()));
        assert_eq!(found(vec![root.join("Git/mingw64/bin")]), Bash::Found(git_bash));

        let msys = touch("msys64/usr/bin/bash.exe");
        assert_eq!(
            found(vec![system, root.join("Git/cmd"), root.join("msys64/usr/bin")]),
            Bash::Found(msys)
        );
        let nothing = TempDir::new().unwrap();
        assert_eq!(find_bash([PathBuf::from("relative")], nothing.path()), Bash::Missing);
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
            "\u{feff}$line = [Console]::In.ReadLine()\r\n\
             Write-Output \"got $line and $($args[0])\"\r\n\
             [Console]::Error.WriteLine('oops ✓')\r\n\
             exit 3\r\n",
        )
        .unwrap();
        // Standard input as `$input` too, as `-File` gives it to a script
        // that names it.
        fs::write(tmp.path().join("lines.ps1"), "\"lines=$(@($input) -join ',')\"\r\nexit 4\r\n").unwrap();
        let dir = tmp.path().canonicalize().unwrap();
        let plan = plan(&dir, &json!({ "script": "t.ps1", "args": ["arg"], "stdin": "zażółć\r\n" }), None).unwrap();
        let r = run(plan).await;
        assert!(r.is_error);
        assert!(r.content_text.starts_with("Exit code 3."), "{}", r.content_text);
        // Read as UTF-8 too.
        assert!(r.content_text.contains("--- stdout ---\ngot zażółć and arg"), "{}", r.content_text);
        // UTF-8, not the console's code page.
        assert!(r.content_text.contains("--- stderr ---\noops ✓"), "{}", r.content_text);

        let plan = super::plan(&dir, &json!({ "script": "lines.ps1", "stdin": "a\r\nż\r\n" }), None).unwrap();
        let r = run(plan).await;
        assert!(r.content_text.starts_with("Exit code 4."), "{}", r.content_text);
        assert!(r.content_text.contains("--- stdout ---\nlines=a,ż"), "{}", r.content_text);
    }

    #[tokio::test]
    async fn runs_code_in_a_folder_it_removes_afterwards() {
        // On Windows, the length also shows the code was read as UTF-8, and
        // the text that its output reaches Loach as UTF-8, not in the
        // console's code page.
        let (language, code, rest) = if cfg!(windows) {
            (
                "powershell",
                "(Get-Location).Path\n'zażółć'.Length\n'zażółć ✓'\n$args[0]\n",
                vec!["6", "zażółć ✓", "arg"],
            )
        } else {
            ("bash", "pwd\necho \"$1\"\n", vec!["arg"])
        };
        let plan = plan_code(language, code, &json!({ "args": ["arg"] }), None).unwrap();
        let r = run(plan).await;
        assert!(!r.is_error, "{}", r.content_text);
        let out: Vec<&str> = r.content_text.split("--- stdout ---\n").nth(1).unwrap().lines().collect();
        assert!(out[0].contains("loach-script-"), "{}", r.content_text);
        assert!(!Path::new(out[0]).exists());
        assert_eq!(out[1..], rest);
    }

    /// A script that leaves a process running, still holding its output,
    /// ends when the script does — with its own exit code, not after the
    /// 300 s timeout — says so, and takes that process with it (B3-02).
    #[tokio::test]
    async fn a_process_left_running_is_stopped_with_the_script() {
        let (language, code) = if cfg!(windows) {
            ("powershell", "(Start-Process ping -ArgumentList '-n','60','127.0.0.1' -NoNewWindow -PassThru).Id\n")
        } else {
            ("bash", "sleep 60 &\necho $!\n")
        };
        let started = std::time::Instant::now();
        let r = run(plan_code(language, code, &json!({}), None).unwrap()).await;
        assert!(started.elapsed() < Duration::from_secs(30), "{}", r.content_text);
        assert!(r.content_text.starts_with("Exit code 0."), "{}", r.content_text);
        assert!(r.content_text.contains("Loach stopped it"), "{}", r.content_text);

        let stdout = r.content_text.split("--- stdout ---\n").nth(1).unwrap();
        let pid: u32 = stdout.lines().find_map(|l| l.trim().parse().ok()).expect("the pid");
        let running = |pid: u32| {
            #[cfg(unix)]
            {
                // SAFETY: signal 0 only checks that the process exists.
                unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
            }
            #[cfg(windows)]
            {
                let list = std::process::Command::new("tasklist")
                    .args(["/FI", &format!("PID eq {pid}"), "/NH"])
                    .output()
                    .unwrap();
                String::from_utf8_lossy(&list.stdout).contains(&pid.to_string())
            }
        };
        // Killed at once; give whoever reaps it a moment.
        let gone = (0..50).any(|_| {
            std::thread::sleep(Duration::from_millis(100));
            !running(pid)
        });
        assert!(gone, "process {pid} outlived the script");
    }
}
