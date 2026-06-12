//! Speculative model warming at application startup.
//!
//! When the user has enabled "preload default model" in settings, the
//! frontend would normally fire [`crate::commands::ollama_preload_model`]
//! only after the JS bundle parses, React mounts, the security probe
//! resolves, the settings + chats stores hydrate, and the IPC round-trip
//! lands. On a cold launch that easily stacks 1–3 s of user-visible
//! latency on top of the actual model load — which is itself the single
//! biggest contributor to time-to-first-token for local models.
//!
//! Doing the warming in Rust from inside Tauri's `setup()` shifts that
//! work to overlap with webview boot. By the time the user sees the
//! composer, Ollama already has the model resident and the first chat
//! request skips the cold load entirely.
//!
//! Not a replacement for the JS preload in `App.tsx`:
//!   - Users with an app-lock configured shouldn't have anything warmed
//!     before they prove identity, so this preload bails out in that
//!     case. The post-unlock JS preload still picks it up.
//!   - The JS preload also re-fires after settings changes within the
//!     session (e.g. the user flips `default_model_choice`); the Rust
//!     preload only runs once at startup, against the values present in
//!     the DB at that moment.
//!   - Defense in depth: if the Rust preload misses (Ollama not yet up
//!     when Loach starts), the JS one runs a few hundred ms later and
//!     usually succeeds. The duplicate is harmless — the second `/api/chat`
//!     against an already-loaded model is a no-op.
//!
//! Every failure path is silent: this is best-effort.

use std::collections::HashMap;
use std::sync::Arc;

use crate::db::{Database, Session};

/// Matches the frontend default for `Settings.ollama_base_url` in
/// `src/types.ts`. Used only when the settings row is missing entirely
/// (fresh install on first launch — at which point `default_model_preload`
/// will also be `false`, so we won't actually fire anything).
const DEFAULT_OLLAMA_BASE_URL: &str = "http://localhost:11434";

/// Best-effort speculative preload. Called from `lib.rs::setup` after the
/// DB is open and the HTTP client is built. Spawns a background task and
/// returns immediately — startup is never blocked on this.
pub fn try_warm_default_model(db: Arc<Database>, http: reqwest::Client) {
    // `tauri::async_runtime::spawn` so we don't have to assume the caller
    // already has a tokio runtime in scope. Tauri sets one up before
    // `setup()` runs, so this is safe from inside the builder closure.
    tauri::async_runtime::spawn(async move {
        // If the user has an app-lock configured, don't warm anything
        // before they prove they're allowed to be here. The lock-screen
        // UI then drives the post-unlock JS preload. (The model itself
        // isn't user data, but spinning up VRAM before authentication
        // crosses a sensible boundary — and saves nothing for someone
        // who closes the lock screen without unlocking.)
        match crate::security::status() {
            Ok(s) if s.configured => {
                tracing::debug!("preload: skipped, app-lock configured");
                return;
            }
            Err(e) => {
                tracing::debug!("preload: security status read failed: {e}");
                return;
            }
            _ => {}
        }

        let settings: HashMap<String, String> = match db.all_settings() {
            Ok(rows) => rows.into_iter().collect(),
            Err(e) => {
                tracing::debug!("preload: settings read failed: {e}");
                return;
            }
        };

        // Bail out unless the user has explicitly opted in. The settings
        // KV table is stringly-typed (see `settingsStore::hydrate` for
        // the matching coerce-back on the frontend), so treat anything
        // other than the literal `"true"` as the default-off case —
        // including the missing-row case on a fresh install.
        if settings.get("default_model_preload").map(String::as_str) != Some("true") {
            return;
        }

        let choice = settings
            .get("default_model_choice")
            .cloned()
            .unwrap_or_else(|| "recent".to_string());
        let default_provider = settings
            .get("default_provider")
            .cloned()
            .unwrap_or_else(|| "ollama".to_string());
        let default_model = settings.get("default_model").cloned().unwrap_or_default();
        let base_url = settings
            .get("ollama_base_url")
            .cloned()
            .unwrap_or_else(|| DEFAULT_OLLAMA_BASE_URL.to_string());

        // The session list is only consulted by `provider:` choices; skip
        // the read otherwise. `list_sessions` returns rows ordered by
        // `updated_at DESC` today, but the resolver baked an implicit
        // dependency on that ORDER BY which would silently rot if the
        // query ever changed. Re-sort defensively here — matches what
        // `resolveDefaultModelChoice` does in `chatStore.ts` and removes
        // the hidden coupling between the two files.
        let sessions: Vec<Session> = if choice.starts_with("provider:") {
            let mut s = db.list_sessions().unwrap_or_default();
            s.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            s
        } else {
            Vec::new()
        };

        let Some((provider, model)) = resolve_default_model_choice(
            &choice,
            &default_provider,
            &default_model,
            &sessions,
        ) else {
            return;
        };

        // Cloud providers have no local load step — there's nothing to
        // warm. We don't probe the cloud endpoint here either: pre-
        // establishing an idle keep-alive socket helps at most for ~30 s
        // (see `pool_max_idle_per_host` / `tcp_keepalive` in lib.rs) and
        // costs an extra /v1/models call on every launch with no
        // guaranteed payoff.
        if provider != "ollama" || model.is_empty() {
            return;
        }

        // Refuse to fire the speculative warm at anything other than a
        // loopback or private-LAN host. Preload runs before the app-lock
        // screen and reads the URL straight out of the settings table — a
        // corrupted settings row or an imported snapshot pointing at an
        // attacker-controlled host would otherwise leak a model-name probe
        // on every cold launch. Real chat traffic isn't gated by this
        // check; it still goes through the regular request path with the
        // user's full intent. Worst case here: a user running Ollama on a
        // public IP gets a slightly slower first request (preload skipped),
        // not a broken app.
        if !is_safe_preload_host(&base_url) {
            tracing::debug!(
                "preload: skipped, {base_url} is not a loopback or private-LAN host"
            );
            return;
        }

        tracing::info!("preload: warming {model} via {base_url}");
        // Warm with the user's configured keep_alive so the model doesn't
        // evaporate before their first message if they picked a longer
        // residency than Ollama's 5-minute default.
        let keep_alive = settings
            .get("ollama_keep_alive")
            .map(String::as_str)
            .and_then(crate::providers::ollama::keep_alive_value);
        // `preload_model` swallows its own transport errors (timeout,
        // connection refused, 4xx model-not-found) and returns Ok(()).
        // The `let _ =` is belt-and-braces for any future signature change.
        let _ = crate::providers::ollama::preload_model(&http, &base_url, &model, keep_alive).await;
    });
}

/// Whether `base_url`'s host is safe to fire a speculative warm at before
/// the user has had a chance to intervene (lock screen, settings UI). Accepts
/// loopback (127.0.0.0/8, ::1), `localhost`, RFC 1918 LAN ranges (10/8,
/// 172.16/12, 192.168/16), and Tailscale's CGNAT-overlay range
/// (100.64.0.0/10). Link-local (169.254/16) is *rejected* even though it's
/// technically private — that range hosts cloud-metadata services, which
/// are exactly the SSRF target a corrupted-settings preload would aim at.
///
/// A hostname that doesn't parse as an IP is rejected because we can't tell
/// during startup whether the DNS resolution will end up at a private or a
/// public address — preload is best-effort, so erring on the side of "skip"
/// is the right call here.
fn is_safe_preload_host(base_url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(base_url) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    if host.eq_ignore_ascii_case("localhost") || host.eq_ignore_ascii_case("ip6-localhost") {
        return true;
    }
    // `url::Url::host_str` returns IPv6 hosts with the surrounding `[ ]`
    // brackets (e.g. `[::1]`). Strip them before letting `IpAddr::parse`
    // see the address — `"::1".parse()` works, `"[::1]".parse()` doesn't.
    let host_for_ip = host
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(host);
    let Ok(ip) = host_for_ip.parse::<std::net::IpAddr>() else {
        // Hostnames (e.g. `ollama.lan`, `gpu-box.tailnet.ts.net`) can't be
        // statically classified without a DNS lookup. Preload is best-effort
        // so we err on the side of "skip" — the JS-side preload that runs
        // post-unlock can pick it up with the real chat client.
        return false;
    };
    if ip.is_loopback() || ip.is_unspecified() {
        // `is_unspecified` covers 0.0.0.0 / ::, which both resolve to
        // loopback on a request from the local host. Including them keeps
        // configurations like `ollama serve --host 0.0.0.0` working.
        return true;
    }
    match ip {
        std::net::IpAddr::V4(v4) => {
            let o = v4.octets();
            // RFC 1918 private ranges
            if o[0] == 10 {
                return true;
            }
            if o[0] == 172 && (16..=31).contains(&o[1]) {
                return true;
            }
            if o[0] == 192 && o[1] == 168 {
                return true;
            }
            // IPv4 link-local (169.254/16): *rejected*. Even though it's
            // technically a private range, it's where cloud-metadata
            // services live (AWS / GCP / Azure all use 169.254.169.254),
            // so warming a model at one of those addresses would defeat
            // the SSRF guard the chat-stream path applies. Fall through
            // to the `false` return at the bottom.
            // Tailscale CGNAT-overlay range (100.64.0.0/10)
            if o[0] == 100 && (64..=127).contains(&o[1]) {
                return true;
            }
            false
        }
        std::net::IpAddr::V6(v6) => {
            // IPv6 unique-local (fc00::/7) is fine — that's the v6
            // equivalent of RFC 1918. Link-local (fe80::/10) is
            // *rejected* for the same reason as IPv4 169.254/16 above:
            // it's where cloud-metadata services live, not where a
            // legitimate model server runs. `Ipv6Addr::is_unique_local`
            // is currently unstable, so we check the high bits
            // directly.
            let first = v6.segments()[0];
            (first & 0xfe00) == 0xfc00
        }
    }
}

/// Rust port of `resolveDefaultModelChoice` in `src/stores/chatStore.ts`.
/// The encoding lives in three places (this function, the TS one, and
/// the picker UI in `SettingsDialog.tsx`) — keep them in lockstep.
///
/// Returns `None` only for future-proofing (no current branch produces
/// it); callers must treat `None` as "skip the preload".
fn resolve_default_model_choice(
    choice: &str,
    recent_provider: &str,
    recent_model: &str,
    sessions: &[Session],
) -> Option<(String, String)> {
    // "model:<provider>:<id>" — pin to this exact model. The model id
    // itself may contain ':' (e.g. "llama3:8b"), so split on the FIRST
    // ':' after the prefix, not the last.
    if let Some(rest) = choice.strip_prefix("model:") {
        if let Some(sep) = rest.find(':') {
            let p = &rest[..sep];
            let m = &rest[sep + 1..];
            if (p == "ollama" || p == "openai") && !m.is_empty() {
                return Some((p.to_string(), m.to_string()));
            }
        }
        // Malformed `model:` choice — fall through to the default branch
        // below rather than the `provider:` check, matching the TS impl.
    }

    // "provider:<id>" — most recent session for that provider.
    if let Some(p) = choice.strip_prefix("provider:") {
        if p == "ollama" || p == "openai" {
            // sessions arrive in `updated_at DESC` order from
            // `Database::list_sessions`, so the first match is already
            // the most recent — no extra sort needed (the TS version
            // re-sorts defensively because the in-memory list can drift
            // after a model swap; the Rust preload reads straight from
            // disk so we don't have that concern).
            if let Some(s) = sessions
                .iter()
                .find(|s| s.provider == p && !s.model.is_empty())
            {
                return Some((p.to_string(), s.model.clone()));
            }
            // No history for this provider yet — preserve the recent
            // model only if it happens to match the pinned provider,
            // otherwise leave the model blank (the caller will skip
            // because empty model + ollama still bails out below).
            let m = if recent_provider == p { recent_model } else { "" };
            return Some((p.to_string(), m.to_string()));
        }
    }

    // "recent" or anything unrecognised — recent (provider, model) pair.
    // Matches the TS fallthrough so a corrupted settings value never
    // blocks the warming path entirely.
    Some((recent_provider.to_string(), recent_model.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(provider: &str, model: &str, updated_at: i64) -> Session {
        Session {
            id: format!("{provider}-{model}-{updated_at}"),
            title: String::new(),
            provider: provider.into(),
            model: model.into(),
            system_prompt: None,
            params_json: None,
            space_id: None,
            pinned_at: None,
            archived_at: None,
            forked_from_session_id: None,
            created_at: 0,
            updated_at,
        }
    }

    #[test]
    fn pinned_model_choice_wins() {
        // Model ids with embedded colons must round-trip — Ollama uses
        // `name:tag` widely (llama3:8b, qwen2.5:14b-instruct, etc.).
        let got =
            resolve_default_model_choice("model:ollama:llama3:8b", "openai", "gpt-4o", &[]);
        assert_eq!(got, Some(("ollama".into(), "llama3:8b".into())));
    }

    #[test]
    fn provider_choice_uses_most_recent_matching_session() {
        // Caller passes sessions in `updated_at DESC` order (the order
        // `list_sessions` returns) — the resolver trusts that and picks
        // the first match.
        let sessions = vec![
            s("ollama", "llama3", 200),
            s("ollama", "phi", 100),
            s("openai", "gpt-4o", 300),
        ];
        let got = resolve_default_model_choice("provider:ollama", "openai", "gpt-4o", &sessions);
        assert_eq!(got, Some(("ollama".into(), "llama3".into())));
    }

    #[test]
    fn provider_choice_falls_back_to_recent_when_matching() {
        let got = resolve_default_model_choice("provider:ollama", "ollama", "phi", &[]);
        assert_eq!(got, Some(("ollama".into(), "phi".into())));
    }

    #[test]
    fn provider_choice_returns_blank_model_on_mismatch() {
        // Empty model — the caller bails before issuing the preload, so
        // there's no danger of /api/chat with a missing `model` field.
        let got = resolve_default_model_choice("provider:ollama", "openai", "gpt-4o", &[]);
        assert_eq!(got, Some(("ollama".into(), "".into())));
    }

    #[test]
    fn recent_choice_returns_recent_pair() {
        let got = resolve_default_model_choice("recent", "ollama", "phi", &[]);
        assert_eq!(got, Some(("ollama".into(), "phi".into())));
    }

    #[test]
    fn unrecognised_choice_falls_back_to_recent() {
        // A garbage settings value (corrupted DB, downgrade from a future
        // build that introduced a new choice kind) must not block the
        // preload — fall back to whatever the user last touched.
        let got = resolve_default_model_choice("nonsense", "ollama", "phi", &[]);
        assert_eq!(got, Some(("ollama".into(), "phi".into())));
    }

    #[test]
    fn malformed_model_choice_falls_back_to_recent() {
        // "model:ollama:" — empty model id. Must NOT silently warm an
        // empty Ollama model name (which would 404 anyway).
        let got = resolve_default_model_choice("model:ollama:", "openai", "gpt-4o", &[]);
        assert_eq!(got, Some(("openai".into(), "gpt-4o".into())));
    }

    #[test]
    fn unknown_provider_in_model_choice_falls_back_to_recent() {
        let got = resolve_default_model_choice(
            "model:anthropic:claude-3",
            "ollama",
            "phi",
            &[],
        );
        assert_eq!(got, Some(("ollama".into(), "phi".into())));
    }

    #[test]
    fn preload_host_allowlist_accepts_local_and_lan() {
        // Loopback + the `localhost` aliases that callers commonly type.
        assert!(is_safe_preload_host("http://localhost:11434"));
        assert!(is_safe_preload_host("http://127.0.0.1:11434"));
        assert!(is_safe_preload_host("http://[::1]:11434"));
        assert!(is_safe_preload_host("http://0.0.0.0:11434"));
        // RFC 1918 ranges — LAN GPU box is a first-class deployment.
        assert!(is_safe_preload_host("http://10.0.1.5:11434"));
        assert!(is_safe_preload_host("http://172.16.0.1:11434"));
        assert!(is_safe_preload_host("http://172.31.255.255:11434"));
        assert!(is_safe_preload_host("http://192.168.1.10:11434"));
        // Tailscale CGNAT-overlay range (100.64.0.0/10).
        assert!(is_safe_preload_host("http://100.64.0.1:11434"));
        assert!(is_safe_preload_host("http://100.127.255.254:11434"));
        // IPv6 unique-local.
        assert!(is_safe_preload_host("http://[fc00::1]:11434"));
    }

    #[test]
    fn preload_host_allowlist_rejects_public_and_ambiguous() {
        // Public IPv4 — exactly the case we're defending against.
        assert!(!is_safe_preload_host("http://8.8.8.8:11434"));
        assert!(!is_safe_preload_host("http://203.0.113.10:11434"));
        // 172.32/12 sits just outside the RFC 1918 172.16/12 block.
        assert!(!is_safe_preload_host("http://172.32.0.1:11434"));
        // 100.128/9 sits just outside the Tailscale CGNAT range.
        assert!(!is_safe_preload_host("http://100.128.0.1:11434"));
        // Hostnames can't be classified without DNS — err on the side of
        // skipping so a `gpu-box.example.com` snapshot can't auto-fire.
        assert!(!is_safe_preload_host("http://ollama.example.com:11434"));
        // Malformed URLs short-circuit to false.
        assert!(!is_safe_preload_host("not a url"));
    }

    #[test]
    fn preload_host_allowlist_rejects_link_local() {
        // Link-local is the SSRF target the guard exists for — cloud
        // metadata services live at 169.254.169.254. Even though it's
        // technically "private", we must NOT preload at it.
        assert!(!is_safe_preload_host("http://169.254.169.254:80"));
        assert!(!is_safe_preload_host("http://169.254.1.1:11434"));
        // IPv6 link-local: same threat model (fe80::a9fe:a9fe style).
        assert!(!is_safe_preload_host("http://[fe80::1]:11434"));
    }
}
