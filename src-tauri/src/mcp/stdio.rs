//! stdio transport for MCP.
//!
//! Loach spawns the server as a child process and exchanges newline-
//! delimited JSON-RPC over its stdin / stdout, the way Claude Desktop,
//! LM Studio and Jan do. One [`StdioSession`] owns one child; dropping the
//! session kills the process (`kill_on_drop`), and a process that exits
//! on its own flips [`StdioSession::is_alive`] so the pool in `mod.rs`
//! respawns it on the next call.
//!
//! What the child sees:
//!   - Loach's own environment, plus the row's `env` map layered on top —
//!     stdio servers take API keys that way, and inheriting `PATH` / `HOME`
//!     is what lets `npx` and `uvx` find their toolchains.
//!   - stdin / stdout as the protocol pipes. stderr is drained into a small
//!     ring so a failed handshake can quote the server's own complaint
//!     (`npm ERR! 404`, a Python traceback) instead of "exited".
//!
//! Consent to *run* a given command line is not this module's job — see
//! `commands::confirm_stdio_spawn`, which gates every save / test of a
//! stdio row behind a native dialog. By the time a row reaches the pool
//! the user has seen the exact command.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::oneshot;

use super::client::{assemble_call_result, unwrap_response, PreExecutionFailure};
use super::types::{
    CallToolResult, InitializeResult, JsonRpcResponse, ListToolsResult, McpCallResult,
    McpTestResult, McpTool, McpToolRaw, PROTOCOL_VERSION,
};
use crate::db::McpServer;

/// Ceiling on the `initialize` round-trip. Longer than the per-request
/// timeout because `npx -y …` / `uvx …` may have to download the package
/// on first run, and the handshake only answers once the process is up.
const START_TIMEOUT: Duration = Duration::from_secs(60);

/// Per-request ceiling once the server is up — same budget as the HTTP
/// transport so a tool call behaves identically whichever way it is wired.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Longest stdout line we'll buffer. A JSON-RPC message is one line, so
/// this is the per-message cap; matches the HTTP transport's body cap. A
/// server that streams past it (a runaway log to stdout, a hostile binary)
/// gets its session torn down rather than growing our heap.
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;

/// How much of the child's stderr we keep for diagnostics.
const STDERR_TAIL_BYTES: usize = 8 * 1024;

const CLIENT_NAME: &str = "loach";
const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");

type Pending = Arc<Mutex<HashMap<i64, oneshot::Sender<JsonRpcResponse>>>>;
type StderrTail = Arc<Mutex<Vec<u8>>>;

/// A live stdio MCP server: the child plus the reader task that pairs its
/// replies to our outstanding requests.
pub struct StdioSession {
    /// Held only for its `kill_on_drop` and `try_wait` — all I/O goes
    /// through the pipes we took out of it.
    child: Child,
    stdin: Arc<tokio::sync::Mutex<ChildStdin>>,
    pending: Pending,
    alive: Arc<AtomicBool>,
    stderr_tail: StderrTail,
    reader: tokio::task::JoinHandle<()>,
    stderr_pump: tokio::task::JoinHandle<()>,
    next_id: i64,
    /// For error messages.
    label: String,
}

impl Drop for StdioSession {
    fn drop(&mut self) {
        // The pumps would end on their own once the child is killed and the
        // pipes close, but aborting is immediate and leaves nothing parked.
        self.reader.abort();
        self.stderr_pump.abort();
        // `kill_on_drop` covers the child itself when `self.child` drops.
    }
}

impl StdioSession {
    /// Start the process. No protocol traffic yet — call [`initialize`]
    /// next. Fails when the executable can't be found or started; a server
    /// that starts and then dies surfaces on the first request instead,
    /// with its stderr attached.
    pub async fn spawn(server: &McpServer) -> Result<Self> {
        let command = server
            .command
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow!("MCP server `{}` has no command", server.name))?;
        let program = resolve_program(command);

        let mut cmd = Command::new(&program);
        cmd.args(server.args())
            .envs(server.env())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            // CREATE_NO_WINDOW — same reason as `ollama_launch::spawn_serve`:
            // a console child of a GUI process otherwise pops a terminal.
            cmd.creation_flags(0x0800_0000);
        }

        let mut child = cmd.spawn().with_context(|| {
            format!(
                "couldn't start `{command}` for MCP server `{}`",
                server.name
            )
        })?;
        let stdin = child.stdin.take().context("child stdin not piped")?;
        let stdout = child.stdout.take().context("child stdout not piped")?;
        let stderr = child.stderr.take().context("child stderr not piped")?;

        let stdin = Arc::new(tokio::sync::Mutex::new(stdin));
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let stderr_tail: StderrTail = Arc::new(Mutex::new(Vec::new()));

        let reader = tokio::spawn(pump_stdout(
            stdout,
            pending.clone(),
            alive.clone(),
            stdin.clone(),
            server.name.clone(),
        ));
        let stderr_pump = tokio::spawn(pump_stderr(stderr, stderr_tail.clone()));

        Ok(Self {
            child,
            stdin,
            pending,
            alive,
            stderr_tail,
            reader,
            stderr_pump,
            next_id: 1,
            label: server.name.clone(),
        })
    }

    /// `false` once the child's stdout reached EOF — the process exited or
    /// closed its end. The pool treats a dead session as absent.
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    fn fresh_id(&mut self) -> i64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// Run the `initialize` + `notifications/initialized` handshake. Must
    /// be the first call on a fresh session.
    pub async fn initialize(&mut self) -> Result<InitializeResult> {
        let params = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": CLIENT_NAME, "version": CLIENT_VERSION },
        });
        let resp = self.request("initialize", Some(params), START_TIMEOUT).await?;
        let parsed: InitializeResult = unwrap_response(resp)?;
        self.notify("notifications/initialized").await?;
        Ok(parsed)
    }

    pub async fn list_tools_raw(&mut self) -> Result<Vec<McpToolRaw>> {
        let resp = self.request("tools/list", None, REQUEST_TIMEOUT).await?;
        let parsed: ListToolsResult = unwrap_response(resp)?;
        Ok(parsed.tools)
    }

    pub async fn call_tool(&mut self, name: &str, arguments: &Value) -> Result<McpCallResult> {
        let params = json!({ "name": name, "arguments": arguments });
        let resp = self
            .request("tools/call", Some(params), REQUEST_TIMEOUT)
            .await?;
        let parsed: CallToolResult = unwrap_response(resp)?;
        Ok(assemble_call_result(parsed.content, parsed.is_error))
    }

    /// Send one request and wait for its reply. Failures are tagged
    /// [`PreExecutionFailure`] only when the frame provably never reached
    /// the server (dead process, write error) — a timeout or an exit while
    /// we were waiting may have run the tool already, and the pool must
    /// not replay those.
    async fn request(
        &mut self,
        method: &str,
        params: Option<Value>,
        timeout: Duration,
    ) -> Result<JsonRpcResponse> {
        if !self.is_alive() {
            let suffix = self.stderr_suffix();
            return Err(
                anyhow!("MCP server `{}` process has exited{suffix}", self.label)
                    .context(PreExecutionFailure),
            );
        }
        let id = self.fresh_id();
        let mut frame = json!({ "jsonrpc": "2.0", "id": id, "method": method });
        if let Some(p) = params {
            frame["params"] = p;
        }
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .expect("stdio pending map poisoned")
            .insert(id, tx);

        if let Err(e) = self.write_frame(&frame).await {
            self.pending
                .lock()
                .expect("stdio pending map poisoned")
                .remove(&id);
            let suffix = self.stderr_suffix();
            return Err(e
                .context(format!(
                    "couldn't write to MCP server `{}`{suffix}",
                    self.label
                ))
                .context(PreExecutionFailure));
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(resp)) => Ok(resp),
            // Sender dropped: the reader task cleared the map because the
            // process went away.
            Ok(Err(_)) => {
                let suffix = self.stderr_suffix();
                bail!(
                    "MCP server `{}` exited before replying to `{method}`{suffix}",
                    self.label
                )
            }
            Err(_) => {
                self.pending
                    .lock()
                    .expect("stdio pending map poisoned")
                    .remove(&id);
                bail!(
                    "MCP server `{}` did not reply to `{method}` within {}s",
                    self.label,
                    timeout.as_secs()
                )
            }
        }
    }

    async fn notify(&mut self, method: &str) -> Result<()> {
        let frame = json!({ "jsonrpc": "2.0", "method": method });
        self.write_frame(&frame)
            .await
            .with_context(|| format!("couldn't send `{method}` to MCP server `{}`", self.label))
    }

    async fn write_frame(&self, frame: &Value) -> Result<()> {
        // `to_string` never emits a raw newline (they're escaped inside
        // strings), which is what makes one-message-per-line framing safe.
        let mut line = serde_json::to_string(frame)?;
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await?;
        Ok(())
    }

    /// Exit status (if the child has been reaped) plus the tail of its
    /// stderr, formatted to append to an error message. Empty when there is
    /// nothing useful to add.
    fn stderr_suffix(&mut self) -> String {
        let mut out = String::new();
        if let Ok(Some(status)) = self.child.try_wait() {
            out.push_str(&format!(" ({status})"));
        }
        let tail = self
            .stderr_tail
            .lock()
            .expect("stdio stderr tail poisoned")
            .clone();
        let text = String::from_utf8_lossy(&tail);
        let text = text.trim();
        if !text.is_empty() {
            // Last few lines only; the whole ring is for the log.
            let last: Vec<&str> = text.lines().rev().take(5).collect();
            let last: Vec<&str> = last.into_iter().rev().collect();
            out.push_str(" — stderr: ");
            out.push_str(&last.join(" | "));
        }
        out
    }
}

/// Read stdout line by line, pairing responses with waiting requests and
/// answering the few requests a server may send *us*. Ends at EOF, after
/// which every outstanding request fails (their senders are dropped).
async fn pump_stdout(
    stdout: tokio::process::ChildStdout,
    pending: Pending,
    alive: Arc<AtomicBool>,
    stdin: Arc<tokio::sync::Mutex<ChildStdin>>,
    label: String,
) {
    let mut reader = BufReader::new(stdout);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        match read_line_capped(&mut reader, &mut buf, MAX_LINE_BYTES).await {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) => {
                tracing::warn!("MCP stdio `{label}`: stdout read failed: {e:#}");
                break;
            }
        }
        let line = String::from_utf8_lossy(&buf);
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => {
                // The spec forbids non-protocol output on stdout, but a
                // banner or a stray `console.log` shouldn't kill the session.
                tracing::debug!("MCP stdio `{label}`: ignoring non-JSON stdout line");
                continue;
            }
        };
        match classify(&msg) {
            Incoming::Response(id) => {
                let waiter = pending
                    .lock()
                    .expect("stdio pending map poisoned")
                    .remove(&id);
                match (waiter, serde_json::from_value::<JsonRpcResponse>(msg)) {
                    (Some(tx), Ok(resp)) => {
                        let _ = tx.send(resp);
                    }
                    (Some(_), Err(e)) => {
                        tracing::warn!("MCP stdio `{label}`: malformed response for id {id}: {e}");
                    }
                    // A reply to a request that already timed out.
                    (None, _) => {}
                }
            }
            Incoming::Request { id, method } => {
                let reply = server_request_reply(&method, id);
                if let Ok(mut line) = serde_json::to_string(&reply) {
                    line.push('\n');
                    let mut w = stdin.lock().await;
                    if let Err(e) = w.write_all(line.as_bytes()).await {
                        tracing::debug!("MCP stdio `{label}`: couldn't answer `{method}`: {e}");
                    }
                    let _ = w.flush().await;
                }
            }
            Incoming::Notification => {}
            Incoming::Other => {
                tracing::debug!("MCP stdio `{label}`: unrecognised frame ignored");
            }
        }
    }
    alive.store(false, Ordering::Release);
    // Fail every waiter: dropping the senders wakes them with RecvError.
    pending
        .lock()
        .expect("stdio pending map poisoned")
        .clear();
}

async fn pump_stderr(stderr: tokio::process::ChildStderr, tail: StderrTail) {
    let mut stderr = stderr;
    let mut chunk = [0u8; 1024];
    loop {
        match stderr.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let mut t = tail.lock().expect("stdio stderr tail poisoned");
                t.extend_from_slice(&chunk[..n]);
                if t.len() > STDERR_TAIL_BYTES {
                    let excess = t.len() - STDERR_TAIL_BYTES;
                    t.drain(..excess);
                }
            }
        }
    }
}

/// What kind of JSON-RPC frame the server just sent.
#[derive(Debug, PartialEq, Eq)]
enum Incoming {
    /// A reply to one of our requests (numeric id we issued).
    Response(i64),
    /// The server is asking *us* something (`ping`, `roots/list`, …).
    Request { id: Value, method: String },
    /// `method` without `id` — progress / logging; nothing to pair.
    Notification,
    Other,
}

fn classify(msg: &Value) -> Incoming {
    let has_id = msg.get("id").is_some_and(|v| !v.is_null());
    let method = msg.get("method").and_then(Value::as_str);
    let is_reply = msg.get("result").is_some() || msg.get("error").is_some();
    match (has_id, method, is_reply) {
        (true, None, true) => match msg["id"].as_i64() {
            Some(id) => Incoming::Response(id),
            None => Incoming::Other,
        },
        (true, Some(m), _) => Incoming::Request {
            id: msg["id"].clone(),
            method: m.to_string(),
        },
        (false, Some(_), _) => Incoming::Notification,
        _ => Incoming::Other,
    }
}

/// Answer a server-initiated request. We advertise no capabilities, so
/// the honest reply to anything beyond a `ping` (and the roots query some
/// SDKs issue unprompted) is "method not found" — the server then carries
/// on without it rather than hanging on an unanswered id.
fn server_request_reply(method: &str, id: Value) -> Value {
    match method {
        "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
        "roots/list" => json!({ "jsonrpc": "2.0", "id": id, "result": { "roots": [] } }),
        _ => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("method not supported by this client: {method}") },
        }),
    }
}

/// `read_until('\n')` with a byte ceiling. Returns the number of bytes
/// read (0 at EOF), failing — rather than allocating without bound — when
/// a line exceeds `max`.
async fn read_line_capped<R: AsyncBufReadExt + Unpin>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    max: usize,
) -> Result<usize> {
    let mut total = 0usize;
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            return Ok(total);
        }
        let (take, done) = match chunk.iter().position(|&b| b == b'\n') {
            Some(i) => (i + 1, true),
            None => (chunk.len(), false),
        };
        if total + take > max {
            bail!("MCP server sent a {max}+ byte line — refusing to buffer further");
        }
        buf.extend_from_slice(&chunk[..take]);
        reader.consume(take);
        total += take;
        if done {
            return Ok(total);
        }
    }
}

/// Windows: `CreateProcess` finds `foo.exe` on `PATH` for a bare `foo`,
/// but not `foo.cmd` — and the npm shims (`npx.cmd`, `uvx` via pipx, …)
/// that most stdio servers are launched through are `.cmd` files. Walk
/// `PATH` × `PATHEXT` ourselves so `npx` works as typed. Anything with an
/// extension or a directory separator is passed through untouched.
#[cfg(windows)]
fn resolve_program(command: &str) -> std::ffi::OsString {
    use std::path::Path;
    let p = Path::new(command);
    if p.extension().is_some() || command.contains(['\\', '/']) {
        return command.into();
    }
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let exts: Vec<&str> = pathext.split(';').filter(|s| !s.is_empty()).collect();
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for ext in &exts {
                let candidate = dir.join(format!("{command}{ext}"));
                if candidate.is_file() {
                    return candidate.into_os_string();
                }
            }
        }
    }
    command.into()
}

#[cfg(not(windows))]
fn resolve_program(command: &str) -> std::ffi::OsString {
    command.into()
}

/// Probe a stdio server: spawn, handshake, list tools, then drop (kill)
/// it. Never panics; any failure is packaged into `McpTestResult::failure`.
pub async fn test_server(server: &McpServer) -> McpTestResult {
    match test_inner(server).await {
        Ok(r) => r,
        Err(e) => McpTestResult::failure(format!("{e:#}")),
    }
}

async fn test_inner(server: &McpServer) -> Result<McpTestResult> {
    let mut session = StdioSession::spawn(server).await?;
    let init = session.initialize().await?;
    let tools = session.list_tools_raw().await?;
    Ok(McpTestResult {
        ok: true,
        server_name: init.server_info.as_ref().and_then(|s| s.name.clone()),
        server_version: init.server_info.as_ref().and_then(|s| s.version.clone()),
        protocol_version: init.protocol_version,
        tools: tools
            .into_iter()
            .map(|t| McpTool {
                name: t.name,
                description: t.description,
            })
            .collect(),
        error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_responses_requests_and_notifications() {
        assert_eq!(
            classify(&json!({ "jsonrpc": "2.0", "id": 7, "result": {} })),
            Incoming::Response(7)
        );
        assert_eq!(
            classify(&json!({ "jsonrpc": "2.0", "id": 8, "error": { "code": -1, "message": "x" } })),
            Incoming::Response(8)
        );
        assert_eq!(
            classify(&json!({ "jsonrpc": "2.0", "id": "srv-1", "method": "ping" })),
            Incoming::Request { id: json!("srv-1"), method: "ping".into() }
        );
        assert_eq!(
            classify(&json!({ "jsonrpc": "2.0", "method": "notifications/progress", "params": {} })),
            Incoming::Notification
        );
        // A response whose id isn't one of our integers can't be paired.
        assert_eq!(
            classify(&json!({ "jsonrpc": "2.0", "id": "abc", "result": {} })),
            Incoming::Other
        );
        assert_eq!(classify(&json!({ "hello": "world" })), Incoming::Other);
    }

    #[test]
    fn server_requests_get_answered_or_refused() {
        let ping = server_request_reply("ping", json!(3));
        assert_eq!(ping["id"], json!(3));
        assert!(ping.get("result").is_some());
        let roots = server_request_reply("roots/list", json!("r"));
        assert_eq!(roots["result"]["roots"], json!([]));
        let other = server_request_reply("sampling/createMessage", json!(9));
        assert_eq!(other["error"]["code"], json!(-32601));
        assert_eq!(other["id"], json!(9));
    }

    #[tokio::test]
    async fn read_line_capped_splits_on_newline_and_reports_eof() {
        let data: &[u8] = b"first\nsecond line\nlast-no-newline";
        let mut reader = BufReader::new(data);
        let mut buf = Vec::new();
        assert_eq!(read_line_capped(&mut reader, &mut buf, 1024).await.unwrap(), 6);
        assert_eq!(buf, b"first\n");
        buf.clear();
        assert_eq!(read_line_capped(&mut reader, &mut buf, 1024).await.unwrap(), 12);
        assert_eq!(buf, b"second line\n");
        buf.clear();
        assert_eq!(read_line_capped(&mut reader, &mut buf, 1024).await.unwrap(), 15);
        assert_eq!(buf, b"last-no-newline");
        buf.clear();
        assert_eq!(read_line_capped(&mut reader, &mut buf, 1024).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn read_line_capped_refuses_oversized_lines() {
        let data = vec![b'x'; 100];
        let mut reader = BufReader::new(data.as_slice());
        let mut buf = Vec::new();
        let err = read_line_capped(&mut reader, &mut buf, 32).await.unwrap_err();
        assert!(err.to_string().contains("32+ byte line"), "{err}");
    }

    #[cfg(windows)]
    #[test]
    fn resolve_program_leaves_paths_and_extensions_alone() {
        assert_eq!(resolve_program("node.exe"), std::ffi::OsString::from("node.exe"));
        assert_eq!(
            resolve_program(r"C:\tools\server"),
            std::ffi::OsString::from(r"C:\tools\server")
        );
        // A bare name that exists nowhere on PATH is passed through so the
        // spawn error names what the user typed.
        assert_eq!(
            resolve_program("definitely-not-a-real-program-xyz"),
            std::ffi::OsString::from("definitely-not-a-real-program-xyz")
        );
    }
}
