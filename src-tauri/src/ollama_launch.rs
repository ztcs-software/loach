//! Starting a local Ollama server on the user's behalf.
//!
//! Loach talks to Ollama over HTTP and has always assumed the daemon was
//! already running. This module closes that gap: it finds the `ollama`
//! executable, spawns `ollama serve` detached, and waits for `/api/tags`
//! to answer before reporting success.
//!
//! Two callers, one behaviour:
//!   - the "Start Ollama" button in the model picker (always available), and
//!   - the `ollama_auto_launch` setting, fired once from `App.tsx` on boot.
//!
//! The spawned server deliberately outlives Loach. Ollama is a shared
//! machine-wide service — killing it on quit would yank the rug out from
//! under any other client (or a second Loach window) using it.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use reqwest::Client;

/// How long to wait for a freshly spawned `ollama serve` to answer.
/// A cold start on Windows (loading the runners, enumerating GPUs) is
/// routinely a few seconds; 20 s leaves headroom without leaving the
/// button spinning forever on a wedged install.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
/// Gap between readiness probes. `probe` carries its own 5 s timeout, so
/// a hung server paces the loop rather than this sleep.
const POLL_INTERVAL: Duration = Duration::from_millis(300);

/// Ensure a local Ollama is running at `base_url`. Returns `Ok(())` once
/// the server answers — including the common case where it was already up
/// and nothing was spawned.
pub async fn start(http: &Client, base_url: &str) -> Result<(), String> {
    if crate::providers::ollama::probe(http, base_url).await {
        return Ok(());
    }

    // We can only start a server on this machine. A base URL pointing at a
    // LAN GPU box or a tunnel is a legitimate configuration — it just isn't
    // one we can do anything about, so say so instead of spawning a local
    // daemon the user would never talk to.
    if !is_loopback_host(base_url) {
        return Err(format!(
            "Ollama isn't running at {base_url}, and Loach can only start Ollama on this computer."
        ));
    }

    let bin = find_binary().ok_or_else(|| {
        "Couldn't find the Ollama executable. Install Ollama, or start it yourself with \
         `ollama serve`."
            .to_string()
    })?;

    tracing::info!("starting ollama: {}", bin.display());
    spawn_serve(&bin).map_err(|e| format!("Couldn't start Ollama: {e}"))?;

    let deadline = Instant::now() + STARTUP_TIMEOUT;
    loop {
        tokio::time::sleep(POLL_INTERVAL).await;
        if crate::providers::ollama::probe(http, base_url).await {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "Started Ollama, but it didn't respond at {base_url} in time."
            ));
        }
    }
}

/// Whether `base_url` names this machine. Deliberately stricter than
/// `preload::is_safe_preload_host`, which also accepts private-LAN ranges:
/// warming a model on a LAN box is useful, but *launching a process* only
/// makes sense against loopback. `0.0.0.0` / `::` are included because
/// `ollama serve --host 0.0.0.0` is a common local setup and requests to
/// them resolve locally.
fn is_loopback_host(base_url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(base_url) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    if host.eq_ignore_ascii_case("localhost") || host.eq_ignore_ascii_case("ip6-localhost") {
        return true;
    }
    // `host_str` keeps the brackets on IPv6 literals (`[::1]`), which
    // `IpAddr::parse` rejects.
    let host = host
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(host);
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) => ip.is_loopback() || ip.is_unspecified(),
        Err(_) => false,
    }
}

/// Locate the `ollama` executable, PATH first then the platform's default
/// install location.
fn find_binary() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "ollama.exe" } else { "ollama" };

    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(exe);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    // A GUI app launched from the Dock / a desktop launcher inherits the
    // session's PATH, not the login shell's — so on macOS and Linux the
    // scan above misses installs that `which ollama` finds in a terminal.
    fallback_paths().into_iter().find(|p| p.is_file())
}

/// Default install locations, in preference order, for the platform we were
/// built for.
///
/// Branches on `cfg!` rather than `#[cfg]` deliberately. `#[cfg]` would strip
/// the other platforms' arms before type-checking, so a mistake in the macOS
/// arm couldn't surface until a macOS build — and CI only runs `cargo test`
/// on Linux, which means that would be the release job. With `cfg!` every arm
/// is compiled everywhere and the dead ones fold away; the only cost is a few
/// unreachable string literals in the binary.
fn fallback_paths() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut out = Vec::new();

    if cfg!(windows) {
        // The installer writes to LOCALAPPDATA for a per-user install and
        // Program Files for a machine-wide one. ProgramW6432 catches the
        // 64-bit directory when we're a 32-bit process.
        for key in ["LOCALAPPDATA", "ProgramFiles", "ProgramW6432"] {
            let Some(root) = std::env::var_os(key).map(PathBuf::from) else {
                continue;
            };
            out.push(root.join("Programs").join("Ollama").join("ollama.exe"));
            out.push(root.join("Ollama").join("ollama.exe"));
        }
    } else if cfg!(target_os = "macos") {
        // Ollama.app offers to install this symlink on first run, so it's
        // the likeliest hit. The in-bundle binary is the backstop for users
        // who declined that prompt.
        out.push(PathBuf::from("/usr/local/bin/ollama"));
        out.push(PathBuf::from("/opt/homebrew/bin/ollama"));
        out.push(PathBuf::from(
            "/Applications/Ollama.app/Contents/Resources/ollama",
        ));
        if let Some(home) = &home {
            out.push(home.join("Applications/Ollama.app/Contents/Resources/ollama"));
        }
    } else {
        // Where install.sh puts it, plus the distro-package locations.
        out.push(PathBuf::from("/usr/local/bin/ollama"));
        out.push(PathBuf::from("/usr/bin/ollama"));
        out.push(PathBuf::from("/bin/ollama"));
        if let Some(home) = &home {
            out.push(home.join(".local/bin/ollama"));
        }
    }

    out
}

/// Spawn `ollama serve` and let it go. We never wait on the child: tokio
/// reaps orphans in the background, so a server that exits immediately
/// (port already bound by another Ollama) doesn't leave a zombie behind.
fn spawn_serve(bin: &Path) -> std::io::Result<()> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW. Without it, spawning a console binary from a
        // GUI process pops a terminal window in front of the app and
        // leaves it there for as long as the server runs.
        cmd.creation_flags(0x0800_0000);
    }

    cmd.spawn().map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_hosts_are_startable() {
        assert!(is_loopback_host("http://localhost:11434"));
        assert!(is_loopback_host("http://LOCALHOST:11434"));
        assert!(is_loopback_host("http://127.0.0.1:11434"));
        assert!(is_loopback_host("http://127.1.2.3:11434"));
        assert!(is_loopback_host("http://[::1]:11434"));
        // `ollama serve --host 0.0.0.0` binds every interface, and requests
        // to 0.0.0.0 land on the local one.
        assert!(is_loopback_host("http://0.0.0.0:11434"));
    }

    /// Guards the shape of whichever `fallback_paths` arm we were built
    /// with. Can only exercise the host platform's arm — the value of
    /// `cfg!` over `#[cfg]` is that the *other* arms still have to compile.
    #[test]
    fn fallback_paths_are_absolute_and_named_right() {
        let paths = fallback_paths();
        assert!(!paths.is_empty(), "no fallback install locations");
        let exe = if cfg!(windows) { "ollama.exe" } else { "ollama" };
        for p in &paths {
            assert!(p.is_absolute(), "{} is not absolute", p.display());
            assert_eq!(
                p.file_name().and_then(|n| n.to_str()),
                Some(exe),
                "{} doesn't end in {exe}",
                p.display()
            );
        }
    }

    #[test]
    fn remote_hosts_are_not_startable() {
        // A LAN GPU box is a real deployment — we just can't launch it.
        // Note this is stricter than the preload allowlist, which accepts
        // these; spawning a process for them would be meaningless.
        assert!(!is_loopback_host("http://192.168.1.10:11434"));
        assert!(!is_loopback_host("http://10.0.1.5:11434"));
        assert!(!is_loopback_host("http://100.64.0.1:11434"));
        assert!(!is_loopback_host("https://ollama.example.com"));
        // Hostnames that merely *look* local still need DNS to resolve.
        assert!(!is_loopback_host("http://ollama.local:11434"));
        assert!(!is_loopback_host("not a url"));
    }
}
