//! URL prefetcher used by the "Web fetch" setting.
//!
//! This is intentionally minimal — it fetches one URL, does some crude
//! HTML-to-text cleanup, and returns a bounded chunk of plain text that the
//! frontend inlines into the user's prompt. There is no search provider,
//! no tool-calling loop, no caching. Keep it that way until we have a real
//! need for more.
//!
//! Hardening:
//! * **SSRF guard** — only `http`/`https` schemes, and the resolved host must
//!   not land on loopback, private RFC1918, link-local, or other special
//!   ranges. A hostname that *looks* public but DNS-resolves to 127.0.0.1 is
//!   rejected.
//! * **Timeout** — 30 s total per fetch.
//! * **Body cap** — at most 5 MB is read off the wire; we truncate early
//!   rather than buffering the whole body.
//! * **Text cap** — after HTML stripping, the returned text is truncated to
//!   [`MAX_TEXT_CHARS`]. The frontend is free to truncate further.

use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use reqwest::Url;
use serde::Serialize;
use tokio::net::lookup_host;

pub const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_BODY_BYTES: usize = 5 * 1024 * 1024; // 5 MB
pub const MAX_TEXT_CHARS: usize = 12_000; // ~3-4k tokens, plenty for inlining
pub const MAX_REDIRECTS: usize = 10;
/// Wall-clock for the TCP connect phase. The whole-request `FETCH_TIMEOUT`
/// only fires once the response starts arriving — a SYN sent to a black-
/// holed address waits for the OS TCP retransmit budget (~75 s on Linux,
/// ~21 s on Windows by default). 10 s is well above any healthy connect
/// on a public host and stops a single dead link from hanging the fetch
/// for the better part of a minute.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------
// Rate limiter
//
// The "Web fetch" toggle is a normal-user feature, but the same IPC
// surface is reachable by a compromised renderer (XSS in a paste, DevTools
// on a shipped build). Without a cap, the attacker can drive Loach as a
// scriptable HTTP client against arbitrary public hosts for harassment,
// scraping, or to amplify a DDoS.
//
// The window is generous enough that a legitimate multi-URL prompt (a few
// links in the user's input) fits comfortably, but tight enough that a
// tight loop bottoms out within a second of starting. State is per-
// process and resets on app restart — fits the same model as the
// app-lock rate limiter in `security.rs`.
// ---------------------------------------------------------------------------

const RATE_WINDOW: Duration = Duration::from_secs(60);
const RATE_LIMIT: usize = 60;

static RATE_LOG: Lazy<Mutex<Vec<Instant>>> = Lazy::new(|| Mutex::new(Vec::new()));

/// Consume one slot in the sliding window. Returns `Err` (with a message
/// suitable for surfacing in the UI) when the cap is exceeded.
fn rate_acquire() -> Result<(), String> {
    let mut log = RATE_LOG.lock();
    let now = Instant::now();
    // Drop entries older than the window in-place. The log only grows to
    // RATE_LIMIT under steady abuse, so the linear scan is cheap.
    log.retain(|t| now.duration_since(*t) < RATE_WINDOW);
    if log.len() >= RATE_LIMIT {
        return Err(format!(
            "Web fetch rate limit hit ({} URLs / {} seconds). Try again shortly.",
            RATE_LIMIT,
            RATE_WINDOW.as_secs()
        ));
    }
    log.push(now);
    Ok(())
}

/// What we hand back to the frontend for a single URL. `truncated` signals
/// that either the response body or the extracted text hit a cap — useful
/// both for UI copy and so the model can be warned not to rely on completeness.
#[derive(Debug, Clone, Serialize)]
pub struct FetchedPage {
    pub url: String,
    /// The final URL after any redirects (may differ from `url`).
    pub final_url: String,
    /// Best-effort `<title>` of the page, if present.
    pub title: Option<String>,
    /// Extracted text. For HTML, tags are stripped; for plain text, the body
    /// is returned verbatim (still truncated).
    pub text: String,
    /// MIME type reported by the server (best-effort; empty string if absent).
    pub content_type: String,
    pub bytes: usize,
    pub truncated: bool,
}

/// Top-level fetch + clean pipeline.
///
/// `_shared_http` is the long-lived client the rest of the app uses; we
/// accept it for API symmetry but DO NOT use it here — the SSRF guard
/// requires a private DNS table per request (see [`build_pinned_client`])
/// to close the TOCTOU window between "we resolved a public IP" and
/// "reqwest dials a now-private one".
pub async fn fetch(_shared_http: &reqwest::Client, raw_url: &str) -> Result<FetchedPage, String> {
    // Rate-limit before URL parsing so even an invalid-URL flood is bounded.
    // The slot is consumed regardless of fetch success — a renderer that
    // keeps firing fetches against malformed URLs still gets throttled.
    rate_acquire()?;
    let initial_url =
        Url::parse(raw_url).map_err(|e| format!("Invalid URL `{raw_url}`: {e}"))?;

    // Follow redirects manually so we can re-screen each hop. Reqwest's
    // built-in redirect follower reuses the original pinned-DNS client, so
    // a cross-origin redirect would fall back to the system resolver for
    // the new host — completely bypassing the SSRF guard. We disable auto-
    // redirect in `build_pinned_client` and walk the chain here, calling
    // `resolve_safe_addrs` + `build_pinned_client` fresh on every hop.
    let mut url = initial_url.clone();
    let mut resp_opt: Option<reqwest::Response> = None;
    // Single wall-clock budget shared across the whole redirect chain. Each
    // hop builds a fresh client and would otherwise get its own full
    // `FETCH_TIMEOUT`, so a chain of slow-but-not-timing-out hops could run
    // up to MAX_REDIRECTS × FETCH_TIMEOUT — far past the "30 s total per
    // fetch" the module docs promise. Shrinking each hop's timeout to the
    // remaining budget keeps the whole fetch bounded.
    let deadline = Instant::now() + FETCH_TIMEOUT;
    for hop in 0..=MAX_REDIRECTS {
        // Scheme allowlist (re-checked per hop in case a redirect tries to
        // jump to `file:` / `ftp:` / etc.).
        match url.scheme() {
            "http" | "https" => {}
            other => {
                return Err(format!(
                    "Unsupported URL scheme: `{other}` (only http/https)"
                ))
            }
        }

        // SSRF guard — resolve, screen, and PIN the resolved IPs into a
        // per-request client. Reqwest will use this map instead of re-
        // resolving before it dials, so a hostname can't flip from public →
        // private between our check and the actual connection.
        let resolved = resolve_safe_addrs(&url).await?;
        let http = build_pinned_client(&url, &resolved)?;

        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!(
                "Fetch exceeded its {}s time budget",
                FETCH_TIMEOUT.as_secs()
            ));
        }
        let resp = http
            .get(url.clone())
            .timeout(remaining)
            .header(reqwest::header::ACCEPT, "text/html,text/plain,*/*;q=0.8")
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let status = resp.status();
        if status.is_redirection() {
            if hop == MAX_REDIRECTS {
                return Err(format!("Too many redirects (> {MAX_REDIRECTS})"));
            }
            let Some(loc) = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
            else {
                return Err(format!(
                    "HTTP {status} with no Location header for {url}"
                ));
            };
            // Resolve the Location header against the current URL so relative
            // redirects work the same way reqwest's follower handles them.
            let next = url
                .join(loc)
                .map_err(|e| format!("Invalid redirect target `{loc}`: {e}"))?;
            url = next;
            continue;
        }

        if !status.is_success() {
            return Err(format!("HTTP {status} for {url}"));
        }

        resp_opt = Some(resp);
        break;
    }

    let resp = resp_opt
        .ok_or_else(|| "redirect loop exited without a response".to_string())?;
    let final_url = resp.url().clone();

    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    // Stream the body with a hard cap so a huge or malicious response can't
    // balloon memory. We buffer into a `Vec<u8>` only up to MAX_BODY_BYTES.
    let mut buf: Vec<u8> = Vec::new();
    let mut truncated_body = false;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Read error: {e}"))?;
        if buf.len() + chunk.len() > MAX_BODY_BYTES {
            let take = MAX_BODY_BYTES.saturating_sub(buf.len());
            buf.extend_from_slice(&chunk[..take]);
            truncated_body = true;
            break;
        }
        buf.extend_from_slice(&chunk);
    }

    let bytes = buf.len();
    let body = String::from_utf8_lossy(&buf).to_string();

    let (title, text_raw) = if content_type.contains("html") || looks_like_html(&body) {
        html_to_text(&body)
    } else {
        (None, body)
    };

    let (text, truncated_text) = truncate(&text_raw, MAX_TEXT_CHARS);

    Ok(FetchedPage {
        url: raw_url.to_string(),
        final_url: final_url.to_string(),
        title,
        text,
        content_type,
        bytes,
        truncated: truncated_body || truncated_text,
    })
}

/// Reject URLs whose host is — or resolves to — a non-routable address,
/// and return the resolved SocketAddrs so the caller can pin them into a
/// reqwest client's DNS table. Pinning closes the TOCTOU window where a
/// hostname's DNS record flipped from public to private between our check
/// and reqwest's pre-connect resolution.
pub(crate) async fn resolve_safe_addrs(url: &Url) -> Result<Vec<SocketAddr>, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "URL has no host".to_string())?;
    let port = url.port_or_known_default().unwrap_or(80);

    // `host_str` keeps the brackets on an IPv6 literal — strip them before
    // parsing, exactly as `resolve_lan_addrs` and `refuse_link_local_host` do.
    // Without this every public IPv6-literal URL fell through to `lookup_host`,
    // which can't resolve a bracketed literal either, and died with a
    // misleading "DNS lookup failed".
    let host = host
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(host);

    // Literal IP: skip DNS, just validate the address.
    if let Ok(ip) = host.parse::<IpAddr>() {
        if !is_public_ip(&ip) {
            return Err(format!("Refusing to fetch private/loopback IP: {ip}"));
        }
        return Ok(vec![SocketAddr::new(ip, port)]);
    }

    // Bare "localhost" never gets past the public check anyway, but reject
    // it explicitly with a clearer message.
    if host.eq_ignore_ascii_case("localhost")
        || host.eq_ignore_ascii_case("ip6-localhost")
        || host.ends_with(".localhost")
    {
        return Err("Refusing to fetch localhost".to_string());
    }

    // Hostname: DNS-resolve and check every returned address.
    let addrs: Vec<SocketAddr> = lookup_host((host, port))
        .await
        .map_err(|e| format!("DNS lookup failed for `{host}`: {e}"))?
        .collect();

    if addrs.is_empty() {
        return Err(format!("DNS returned no addresses for `{host}`"));
    }
    for addr in &addrs {
        let ip = addr.ip();
        if !is_public_ip(&ip) {
            return Err(format!(
                "Refusing to fetch `{host}` — resolves to non-public address {ip}"
            ));
        }
    }
    Ok(addrs)
}

/// Resolve `url`'s host the same way [`resolve_safe_addrs`] does — returning
/// the screened `SocketAddr`s so the caller can DNS-pin them — but apply the
/// looser MCP policy: only **link-local** addresses (the cloud-metadata range,
/// 169.254.0.0/16 and fe80::/10) are refused. Loopback and private / RFC1918 /
/// CGNAT LAN addresses pass.
///
/// This mirrors how the LLM-provider path already treats user-configured
/// endpoints (`providers::refuse_link_local_host`). MCP server URLs are typed
/// by the user in Settings — not model-driven like the web-fetch tool — so a
/// self-hosted server on `192.168.x.x` or `127.0.0.1` is a legitimate
/// destination, while 169.254.169.254 never is. Pinning the returned addresses
/// still closes the DNS-rebinding window.
pub(crate) async fn resolve_lan_addrs(url: &Url) -> Result<Vec<SocketAddr>, HostScreenError> {
    let host = url
        .host_str()
        .ok_or_else(|| HostScreenError::Invalid("URL has no host".to_string()))?;
    let port = url.port_or_known_default().unwrap_or(80);

    // `host_str` keeps the brackets on an IPv6 literal (`[2606:4700::1111]`),
    // which `IpAddr::parse` rejects — so a perfectly good public IPv6 URL fell
    // through to `lookup_host`, which can't resolve a bracketed literal either,
    // and failed with "DNS lookup failed". (Fails closed, so this was never an
    // SSRF hole — just an unusable address family.) `refuse_link_local_host`
    // in providers/mod.rs does the same strip.
    let host = host
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(host);

    // Literal IP: skip DNS, just screen the address.
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_link_local(&ip) {
            return Err(HostScreenError::Blocked(format!(
                "Refusing to connect to link-local address {ip} (cloud-metadata range)"
            )));
        }
        return Ok(vec![SocketAddr::new(ip, port)]);
    }

    // Hostname: DNS-resolve and screen every returned address. No localhost
    // special-case — `localhost` resolves to loopback, which is allowed here.
    let addrs: Vec<SocketAddr> = lookup_host((host, port))
        .await
        .map_err(|e| HostScreenError::Unresolvable(format!("DNS lookup failed for `{host}`: {e}")))?
        .collect();
    if addrs.is_empty() {
        return Err(HostScreenError::Unresolvable(format!(
            "DNS returned no addresses for `{host}`"
        )));
    }
    for addr in &addrs {
        let ip = addr.ip();
        if is_link_local(&ip) {
            return Err(HostScreenError::Blocked(format!(
                "Refusing to connect to `{host}` — resolves to link-local address {ip} (cloud-metadata range)"
            )));
        }
    }
    Ok(addrs)
}

/// Why a host failed the screen. Callers that only report the failure can
/// keep formatting it as a string — `Display` reproduces the exact messages
/// this function has always produced. The distinction exists for snapshot
/// import, which must tell "this row is hostile" apart from "this machine
/// currently has no DNS": the first is a reason to refuse the row, the
/// second is not a reason to throw away the user's entire backup.
#[derive(Debug)]
pub(crate) enum HostScreenError {
    /// Positively identified as link-local — refuse it.
    Blocked(String),
    /// DNS failed or returned nothing, so the host could not be screened
    /// either way. Says nothing about whether the host is safe.
    Unresolvable(String),
    /// Structurally unusable (no host at all).
    Invalid(String),
}

impl std::fmt::Display for HostScreenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Blocked(m) | Self::Unresolvable(m) | Self::Invalid(m) => f.write_str(m),
        }
    }
}

/// Build a one-shot reqwest::Client whose DNS table maps the requested host
/// to the SocketAddrs we already screened. With this in place, reqwest will
/// NOT call the system resolver again before dialing — so a DNS-rebinding
/// attacker can't slip a private address past our check.
pub(crate) fn build_pinned_client(url: &Url, addrs: &[SocketAddr]) -> Result<reqwest::Client, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "URL has no host".to_string())?;
    let mut builder = reqwest::Client::builder()
        .user_agent(concat!("Loach/", env!("CARGO_PKG_VERSION"), " (fetch_url)"))
        // Bound the TCP connect phase. The per-request `.timeout()` only
        // covers the response, so without this a SYN to a black-holed
        // address waits for the OS retransmit budget — minutes on some
        // platforms. `CONNECT_TIMEOUT` keeps a single dead host from
        // hanging the fetch.
        .connect_timeout(CONNECT_TIMEOUT)
        // Disable auto-redirect. Reqwest would otherwise follow redirects
        // using this same pinned-DNS client, which only has the original
        // host pinned — so a cross-origin redirect's new host would fall
        // back to the system resolver, bypassing the SSRF guard. `fetch()`
        // walks the redirect chain manually and rebuilds a pinned client
        // per hop.
        .redirect(reqwest::redirect::Policy::none());

    // `resolve()` plumbs a (host, addr) override into the internal resolver.
    // We feed in every screened address so a multi-A-record host can still
    // failover at the connection level.
    for addr in addrs {
        builder = builder.resolve(host, *addr);
    }

    builder
        .build()
        .map_err(|e| format!("could not build pinned http client: {e}"))
}

/// Returns `false` for loopback, private, link-local, broadcast, multicast,
/// unspecified, and other special-purpose ranges. Only "globally routable"
/// unicast addresses pass.
///
/// This is the strict screen used by the model-driven web-fetch tool
/// ([`resolve_safe_addrs`]). The user-driven MCP path is deliberately looser —
/// it screens with [`is_link_local`] so self-hosted LAN servers work — so the
/// two classifiers are kept distinct.
pub fn is_public_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            if v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_unspecified()
                || v4.is_documentation()
            {
                return false;
            }
            // Carrier-grade NAT (100.64.0.0/10) — treat as private.
            let oct = v4.octets();
            if oct[0] == 100 && (oct[1] & 0b1100_0000) == 0b0100_0000 {
                return false;
            }
            // 0.0.0.0/8 is "this network" — reject.
            if oct[0] == 0 {
                return false;
            }
            // 169.254.0.0/16 (link-local) is covered by `is_link_local`.
            // 192.0.0.0/24 reserved.
            if oct[0] == 192 && oct[1] == 0 && oct[2] == 0 {
                return false;
            }
            // 198.18.0.0/15 benchmark networks.
            if oct[0] == 198 && (oct[1] == 18 || oct[1] == 19) {
                return false;
            }
            // 240.0.0.0/4 reserved (Class E). 255.255.255.255 is already
            // caught by `is_broadcast()` above; the rest is non-routable.
            if oct[0] >= 240 {
                return false;
            }
            true
        }
        IpAddr::V6(v6) => {
            if v6.is_loopback()
                || v6.is_multicast()
                || v6.is_unspecified()
            {
                return false;
            }
            let segs = v6.segments();
            // fc00::/7 — unique local addresses.
            if (segs[0] & 0xfe00) == 0xfc00 {
                return false;
            }
            // fe80::/10 — link-local.
            if (segs[0] & 0xffc0) == 0xfe80 {
                return false;
            }
            // Helper: rebuild the embedded IPv4 from the low 32 bits and run
            // it back through the v4 screen.
            let embedded_v4 = |segs: &[u16; 8]| {
                std::net::Ipv4Addr::new(
                    (segs[6] >> 8) as u8,
                    (segs[6] & 0xff) as u8,
                    (segs[7] >> 8) as u8,
                    (segs[7] & 0xff) as u8,
                )
            };
            // ::ffff:0:0/96 — IPv4-mapped: delegate to the v4 check.
            if segs[0] == 0
                && segs[1] == 0
                && segs[2] == 0
                && segs[3] == 0
                && segs[4] == 0
                && segs[5] == 0xffff
            {
                return is_public_ip(&IpAddr::V4(embedded_v4(&segs)));
            }
            // 64:ff9b::/96 — NAT64 well-known prefix. A host whose AAAA record
            // is `64:ff9b::7f00:1` routes to 127.0.0.1 through a NAT64
            // gateway, so decode the embedded v4 and screen it the same way
            // as the IPv4-mapped case. Without this it fell through to the
            // `true` fallthrough below and bypassed the SSRF guard.
            if segs[0] == 0x0064
                && segs[1] == 0xff9b
                && segs[2] == 0
                && segs[3] == 0
                && segs[4] == 0
                && segs[5] == 0
            {
                return is_public_ip(&IpAddr::V4(embedded_v4(&segs)));
            }
            // ::a.b.c.d — deprecated IPv4-compatible addresses (high 96 bits
            // zero, low 32 the v4). Loopback (::1) and unspecified (::) are
            // already handled above, so a remaining all-zero-prefix address
            // with a non-zero tail is an embedded v4 — screen it too.
            if segs[0] == 0
                && segs[1] == 0
                && segs[2] == 0
                && segs[3] == 0
                && segs[4] == 0
                && segs[5] == 0
            {
                return is_public_ip(&IpAddr::V4(embedded_v4(&segs)));
            }
            true
        }
    }
}

/// Returns `true` only for link-local addresses — IPv4 169.254.0.0/16, IPv6
/// fe80::/10, and the IPv4-mapped / NAT64 / IPv4-compatible IPv6 forms that
/// smuggle a link-local IPv4 (e.g. `::ffff:169.254.169.254`). This is the
/// narrow "cloud-metadata" screen shared by the MCP resolver
/// ([`resolve_lan_addrs`]) and the LLM-provider guard
/// (`providers::refuse_link_local_host`) — one source of truth, distinct from
/// the all-private-ranges screen in [`is_public_ip`].
pub(crate) fn is_link_local(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_link_local(),
        IpAddr::V6(v6) => {
            let segs = v6.segments();
            // Native IPv6 link-local: fe80::/10.
            if (segs[0] & 0xffc0) == 0xfe80 {
                return true;
            }
            // An attacker-controlled AAAA record can smuggle a link-local
            // IPv4 (169.254.169.254 is cloud metadata) inside an IPv6 address
            // — IPv4-mapped (`::ffff:a9fe:a9fe`), NAT64 (`64:ff9b::a9fe:a9fe`),
            // or deprecated IPv4-compatible (`::a9fe:a9fe`) — which the host
            // then routes to 169.254.x.x. Decode the embedded IPv4 and screen
            // it too, the same way `is_public_ip` screens these forms. Without
            // this the bare `fe80::/10` check above let those forms slip past.
            let is_v4_mapped = segs[0] == 0
                && segs[1] == 0
                && segs[2] == 0
                && segs[3] == 0
                && segs[4] == 0
                && segs[5] == 0xffff;
            let is_nat64 = segs[0] == 0x0064
                && segs[1] == 0xff9b
                && segs[2] == 0
                && segs[3] == 0
                && segs[4] == 0
                && segs[5] == 0;
            // ::a.b.c.d — high 96 bits zero. Loopback (::1) / unspecified (::)
            // have a zero tail and aren't link-local, so they harmlessly fall
            // through the embedded check below.
            let is_v4_compat = segs[0] == 0
                && segs[1] == 0
                && segs[2] == 0
                && segs[3] == 0
                && segs[4] == 0
                && segs[5] == 0;
            if is_v4_mapped || is_nat64 || is_v4_compat {
                let embedded = std::net::Ipv4Addr::new(
                    (segs[6] >> 8) as u8,
                    (segs[6] & 0xff) as u8,
                    (segs[7] >> 8) as u8,
                    (segs[7] & 0xff) as u8,
                );
                return embedded.is_link_local();
            }
            false
        }
    }
}

fn looks_like_html(body: &str) -> bool {
    // Walk by chars rather than bytes so a non-ASCII glyph straddling the
    // 2048-byte mark doesn't panic with `byte index N is not a char boundary`.
    // We're only sniffing for ASCII-only HTML tokens anyway, so taking up to
    // 2048 chars (not bytes) is safe and slightly more permissive.
    let head: String = body.chars().take(2048).collect::<String>().to_ascii_lowercase();
    head.contains("<html") || head.contains("<!doctype html") || head.contains("<body")
}

/// Turn HTML into readable-ish plain text.
///
/// Deliberately dumb: no DOM parser, no readability heuristics. Steps:
///   1. Capture the contents of the first `<title>` if any.
///   2. Strip `<script>` / `<style>` / `<noscript>` blocks outright.
///   3. Collapse common block tags to newline markers so paragraphs survive.
///   4. Strip all remaining tags.
///   5. Decode the most common HTML entities.
///   6. Collapse runs of whitespace.
///
/// Good enough for extracting prose. For JS-heavy SPAs the result will be
/// near-empty; that's expected and correct for a zero-dep fetcher.
fn html_to_text(html: &str) -> (Option<String>, String) {
    let title = extract_between_ci(html, "<title", "</title>")
        .map(|raw| {
            // Skip past the opening tag's `>`
            let start = raw.find('>').map(|i| i + 1).unwrap_or(0);
            decode_entities(&raw[start..]).trim().to_string()
        })
        .filter(|s| !s.is_empty());

    // Compute the ASCII-lowercased view of the body exactly ONCE and pass
    // it through the rest of the pipeline. The previous version called
    // `strip_block_ci` + `replace_ci` 18 times in sequence, each of
    // which built a fresh full lowercase copy of its input — for a 5 MB
    // body that's ~90 MB of throwaway allocation per fetch. `to_ascii_-
    // lowercase` preserves byte length so we can safely index into either
    // view interchangeably.
    let lower = html.to_ascii_lowercase();
    debug_assert_eq!(lower.len(), html.len());

    let stripped = strip_blocks_with_lower(
        html,
        &lower,
        &[
            ("<script", "</script>"),
            ("<style", "</style>"),
            ("<noscript", "</noscript>"),
        ],
    );

    // Insert newlines where block-level tags close so paragraphs don't
    // merge. One pass over `stripped`, scanning for any of the closing
    // tags as we go — beats the original 15-pass `replace_ci` loop both
    // in allocations and in pure scan time.
    let s = replace_many_ci(
        &stripped,
        &[
            "</p>", "</div>", "</li>", "</tr>", "</h1>", "</h2>", "</h3>",
            "</h4>", "</h5>", "</h6>", "<br>", "<br/>", "<br />", "</pre>",
            "</blockquote>",
        ],
        "\n",
    );

    // Strip all remaining tags.
    let s = strip_all_tags(&s);
    let s = decode_entities(&s);
    let s = collapse_whitespace(&s);

    (title, s)
}

// ---------------------------------------------------------------------------
// Small string helpers (ASCII-case-insensitive). These live here rather than
// pulling in a regex crate — the alternative is a ~10 MB dep for a half-page
// of logic.

/// Strip every (open, close) range from `hay`, using a pre-computed
/// `lower` (must equal `hay.to_ascii_lowercase()`) so we don't re-allocate
/// the lowercase view per call. All ranges are stripped in a single pass
/// — much cheaper than chaining `strip_block_ci` three times for
/// `<script>`/`<style>`/`<noscript>`.
fn strip_blocks_with_lower(
    hay: &str,
    lower: &str,
    blocks: &[(&str, &str)],
) -> String {
    // Pre-lowercase the needles once; the haystack lowercase view is
    // borrowed from the caller.
    let blocks_l: Vec<(String, String, usize)> = blocks
        .iter()
        .map(|(o, c)| (o.to_ascii_lowercase(), c.to_ascii_lowercase(), c.len()))
        .collect();

    // Per-block byte position of the next opener at or after the cursor
    // (`None` once a block type has no further opener). Seeded with one full
    // scan each, then refreshed lazily — only when a cached hit falls behind
    // the cursor. The previous version re-ran `lower[i..].find(opener)` for
    // every block on every iteration, so an opener that never appears (the
    // common case: a page full of `</p>` but no `<script>`) was re-scanned
    // over the whole remaining body once per consumed block — O(n²) on
    // adversarial input. Searching each absent opener exactly once makes the
    // whole pass O(n·k).
    let mut next_open: Vec<Option<usize>> = blocks_l
        .iter()
        .map(|(open_l, _, _)| lower.find(open_l.as_str()))
        .collect();

    let mut out = String::with_capacity(hay.len());
    let mut i = 0usize;
    while i < hay.len() {
        // Earliest opener at or after `i`, refreshing any stale cached hit
        // (one the cursor has advanced past) before comparing. Ties resolve
        // to the first block in source order, matching the old `min_by_key`.
        let mut best: Option<(usize, usize)> = None; // (opener_pos, block index)
        for (idx, (open_l, _, _)) in blocks_l.iter().enumerate() {
            if matches!(next_open[idx], Some(pos) if pos < i) {
                next_open[idx] = lower[i..].find(open_l.as_str()).map(|rel| i + rel);
            }
            if let Some(pos) = next_open[idx] {
                if best.map_or(true, |(bp, _)| pos < bp) {
                    best = Some((pos, idx));
                }
            }
        }

        match best {
            Some((open_at, idx)) => {
                let (_, close_l, close_byte_len) = &blocks_l[idx];
                out.push_str(&hay[i..open_at]);
                match lower[open_at..].find(close_l.as_str()) {
                    Some(rel_close) => {
                        i = open_at + rel_close + close_byte_len;
                    }
                    None => {
                        // Unterminated — drop the rest.
                        return out;
                    }
                }
            }
            None => {
                out.push_str(&hay[i..]);
                break;
            }
        }
    }
    out
}

/// Replace any occurrence of any needle in `needles` with `repl`. Single
/// pass over `hay` — beats chaining `replace_ci(hay, needle, repl)` for
/// each needle, which lowercase-copies `hay` once per call.
fn replace_many_ci(hay: &str, needles: &[&str], repl: &str) -> String {
    let lower = hay.to_ascii_lowercase();
    let needles_l: Vec<(String, usize)> = needles
        .iter()
        .map(|n| (n.to_ascii_lowercase(), n.len()))
        .collect();
    // Per-needle next-match position, seeded once and refreshed lazily (see
    // `strip_blocks_with_lower` for the rationale). Without the cache, a
    // needle absent from the body — or one matched far ahead — was re-scanned
    // over the whole remaining string on every output position, turning a
    // body of N identical entities into an O(n²) walk.
    let mut next_pos: Vec<Option<usize>> = needles_l
        .iter()
        .map(|(needle_l, _)| lower.find(needle_l.as_str()))
        .collect();
    let mut out = String::with_capacity(hay.len());
    let mut i = 0usize;
    while i < hay.len() {
        // Earliest needle hit at or after `i`, refreshing stale cached hits.
        // Ties resolve to the first needle in `needles`, matching the old
        // `min_by_key`.
        let mut best: Option<(usize, usize)> = None; // (hit_pos, needle index)
        for (idx, (needle_l, _)) in needles_l.iter().enumerate() {
            if matches!(next_pos[idx], Some(pos) if pos < i) {
                next_pos[idx] = lower[i..].find(needle_l.as_str()).map(|rel| i + rel);
            }
            if let Some(pos) = next_pos[idx] {
                if best.map_or(true, |(bp, _)| pos < bp) {
                    best = Some((pos, idx));
                }
            }
        }

        match best {
            Some((at, idx)) => {
                out.push_str(&hay[i..at]);
                out.push_str(repl);
                i = at + needles_l[idx].1;
            }
            None => {
                out.push_str(&hay[i..]);
                break;
            }
        }
    }
    out
}

fn extract_between_ci(hay: &str, open: &str, close: &str) -> Option<String> {
    let lower = hay.to_ascii_lowercase();
    let open_l = open.to_ascii_lowercase();
    let close_l = close.to_ascii_lowercase();
    let a = lower.find(&open_l)?;
    let rest = &lower[a..];
    let b_rel = rest.find(&close_l)?;
    let b = a + b_rel;
    Some(hay[a..b].to_string())
}

fn strip_all_tags(s: &str) -> String {
    // Iterate by chars, not bytes. The previous version cast each byte to a
    // `char`, which works for ASCII but corrupts any multi-byte glyph: a 2-byte
    // UTF-8 sequence like `é` (`C3 A9`) was emitted as two garbage U+00C3 /
    // U+00A9 chars. Char-iteration preserves the original code points.
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        if in_tag {
            if c == '>' {
                in_tag = false;
            }
        } else if c == '<' {
            in_tag = true;
        } else {
            out.push(c);
        }
    }
    out
}

/// How far past an `&` we look for the closing `;`. Generous next to the
/// longest thing `decode_entities` recognises (`&#x10FFFF;`, 9 chars after
/// the `&`) while keeping the scan per-`&` constant instead of linear.
const MAX_ENTITY_LEN: usize = 32;

fn decode_entities(s: &str) -> String {
    // Handle the common named entities plus decimal & hex numeric references.
    // Unknown entities are left as-is.
    //
    // Walk by `char_indices` instead of byte-indexing so a non-ASCII glyph
    // before / after an `&...;` entity isn't truncated and the output keeps
    // multi-byte characters intact.
    let mut out = String::with_capacity(s.len());
    let mut iter = s.char_indices().peekable();
    while let Some((i, c)) = iter.next() {
        if c == '&' {
            // Find the matching ';' (if any) within a BOUNDED window.
            //
            // Scanning `s[i + 1..]` to its end was quadratic: a page of
            // `&`s with no `;` made every one of them walk the whole
            // remaining body, so a hostile 5 MB document (the body cap)
            // pinned a worker for minutes with no timeout and no cancel
            // path. Every entity this function decodes is short — the
            // longest named one is `&hellip;` and the longest numeric is
            // `&#x10FFFF;` — so anything past the window isn't an entity
            // and the old scan was pure waste. `char_indices().take()`
            // keeps the bound char-safe on multi-byte input.
            if let Some(rel) = s[i + 1..]
                .char_indices()
                .take(MAX_ENTITY_LEN)
                .find(|(_, ch)| *ch == ';')
                .map(|(rel, _)| rel)
            {
                let end = i + 1 + rel; // index of the ';'
                let name = &s[i + 1..end];
                let replacement: Option<String> = match name {
                    "amp" => Some("&".into()),
                    "lt" => Some("<".into()),
                    "gt" => Some(">".into()),
                    "quot" => Some("\"".into()),
                    "apos" | "#39" => Some("'".into()),
                    "nbsp" | "#160" => Some(" ".into()),
                    "mdash" | "#8212" => Some("—".into()),
                    "ndash" | "#8211" => Some("–".into()),
                    "hellip" | "#8230" => Some("…".into()),
                    "lsquo" | "#8216" => Some("‘".into()),
                    "rsquo" | "#8217" => Some("’".into()),
                    "ldquo" | "#8220" => Some("“".into()),
                    "rdquo" | "#8221" => Some("”".into()),
                    n if n.starts_with("#x") || n.starts_with("#X") => {
                        u32::from_str_radix(&n[2..], 16)
                            .ok()
                            .and_then(char::from_u32)
                            .map(|c| c.to_string())
                    }
                    n if n.starts_with('#') => n[1..]
                        .parse::<u32>()
                        .ok()
                        .and_then(char::from_u32)
                        .map(|c| c.to_string()),
                    _ => None,
                };
                if let Some(r) = replacement {
                    out.push_str(&r);
                    // Advance the iterator past every char up to & including the ';'.
                    while let Some(&(j, _)) = iter.peek() {
                        if j > end {
                            break;
                        }
                        iter.next();
                    }
                    continue;
                }
            }
        }
        out.push(c);
    }
    out
}

fn collapse_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut blank_line = false;
    for line in s.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            // Only keep one blank line between paragraphs.
            if !blank_line && !out.is_empty() {
                out.push('\n');
                blank_line = true;
            }
            continue;
        }
        blank_line = false;
        let mut last_space = false;
        for c in trimmed.chars() {
            if c.is_whitespace() {
                if !last_space {
                    out.push(' ');
                    last_space = true;
                }
            } else {
                out.push(c);
                last_space = false;
            }
        }
        out.push('\n');
    }
    out.trim().to_string()
}

/// Truncate to a char budget. Prefer to break on whitespace when the cut
/// point is inside a word. Returns `(truncated_text, was_truncated)`.
fn truncate(s: &str, max_chars: usize) -> (String, bool) {
    if s.chars().count() <= max_chars {
        return (s.to_string(), false);
    }
    // Walk up to `max_chars` chars, then back off to the last whitespace within
    // the last 200 chars so we don't sever words.
    let mut end_byte = 0;
    for (n, (i, _)) in s.char_indices().enumerate() {
        if n >= max_chars {
            end_byte = i;
            break;
        }
    }
    if end_byte == 0 {
        end_byte = s.len();
    }
    // Back off ~200 bytes, then snap DOWN to a char boundary. `end_byte` is
    // already a boundary (it came from `char_indices`), but the raw
    // subtraction can land inside a multi-byte codepoint — slicing there
    // panics (`byte index … is not a char boundary`). Walking left to the
    // nearest boundary keeps the window valid UTF-8; it may end up a few
    // bytes wider than 200, which is harmless for a whitespace heuristic.
    let mut scan_start = end_byte.saturating_sub(200);
    while scan_start > 0 && !s.is_char_boundary(scan_start) {
        scan_start -= 1;
    }
    let window = &s[scan_start..end_byte];
    if let Some(last_ws) = window.rfind(char::is_whitespace) {
        end_byte = scan_start + last_ws;
    }
    let mut out = s[..end_byte].trim_end().to_string();
    out.push_str("\n\n[Content truncated]");
    (out, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_simple_html() {
        let html = "<html><head><title>Hi</title><style>x{}</style></head><body><p>Hello &amp; <b>world</b></p></body></html>";
        let (title, text) = html_to_text(html);
        assert_eq!(title.as_deref(), Some("Hi"));
        assert!(text.contains("Hello & world"), "got: {text:?}");
    }

    #[test]
    fn drops_scripts() {
        let html = "<body><script>alert(1)</script>A</body>";
        let (_, text) = html_to_text(html);
        assert!(!text.contains("alert"));
        assert!(text.contains('A'));
    }

    #[test]
    fn rejects_private_ipv4() {
        assert!(!is_public_ip(&"127.0.0.1".parse().unwrap()));
        assert!(!is_public_ip(&"10.0.0.1".parse().unwrap()));
        assert!(!is_public_ip(&"192.168.1.1".parse().unwrap()));
        assert!(!is_public_ip(&"169.254.1.1".parse().unwrap()));
        assert!(!is_public_ip(&"100.64.0.1".parse().unwrap()));
        assert!(is_public_ip(&"8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn preserves_non_ascii_when_stripping() {
        // Regression guard for the old byte-cast bug: every multi-byte glyph
        // must survive the strip / decode pass unchanged.
        let html = "<p>Zażółć gęślą jaźń — 日本語テスト — 🦊</p>";
        let (_, text) = html_to_text(html);
        assert!(text.contains("Zażółć gęślą jaźń"), "got: {text:?}");
        assert!(text.contains("日本語テスト"), "got: {text:?}");
        assert!(text.contains("🦊"), "got: {text:?}");
    }

    #[test]
    fn looks_like_html_handles_long_non_ascii_body() {
        // A long body whose 2048-byte mark lands inside a multi-byte
        // character used to panic. Repeat a 4-byte glyph past the boundary.
        let body: String = "🦊".repeat(1000);
        // Should not panic; with no `<html>` tokens, just returns false.
        assert!(!looks_like_html(&body));
    }

    #[test]
    fn decodes_entities_around_non_ascii() {
        // Entities surrounded by multi-byte characters must decode without
        // corrupting the surrounding text.
        let s = "日本&amp;語";
        let decoded = decode_entities(s);
        assert_eq!(decoded, "日本&語");
    }

    #[test]
    fn rate_limiter_allows_under_cap_and_rejects_at_cap() {
        // The limiter is a module-level singleton. Reset and drive it from
        // here — the test runs serialised because it holds the same lock
        // every production call uses.
        {
            let mut log = RATE_LOG.lock();
            log.clear();
        }
        for i in 0..RATE_LIMIT {
            rate_acquire().unwrap_or_else(|e| {
                panic!("acquire #{i} should succeed under the cap; got {e}")
            });
        }
        let err = rate_acquire().expect_err("call #RATE_LIMIT+1 must be rate-limited");
        assert!(err.contains("Web fetch rate limit"), "unexpected: {err}");
        // Clean up so we don't poison parallel tests in the same binary.
        let mut log = RATE_LOG.lock();
        log.clear();
    }

    #[test]
    fn rejects_private_ipv6() {
        assert!(!is_public_ip(&"::1".parse().unwrap()));
        assert!(!is_public_ip(&"fc00::1".parse().unwrap()));
        assert!(!is_public_ip(&"fe80::1".parse().unwrap()));
        assert!(is_public_ip(&"2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn rejects_ipv4_mapped_private() {
        // ::ffff:a.b.c.d must inherit the v4 screen.
        assert!(!is_public_ip(&"::ffff:127.0.0.1".parse().unwrap()));
        assert!(!is_public_ip(&"::ffff:169.254.169.254".parse().unwrap()));
        assert!(!is_public_ip(&"::ffff:10.0.0.1".parse().unwrap()));
        assert!(is_public_ip(&"::ffff:8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn rejects_nat64_embedded_private() {
        // 64:ff9b::/96 — the embedded v4 must be screened, not waved through.
        // 0x7f000001 = 127.0.0.1, 0xa9fea9fe = 169.254.169.254 (metadata).
        assert!(!is_public_ip(&"64:ff9b::7f00:1".parse().unwrap()));
        assert!(!is_public_ip(&"64:ff9b::a9fe:a9fe".parse().unwrap()));
        // 0x08080808 = 8.8.8.8 — a public embedded v4 still passes.
        assert!(is_public_ip(&"64:ff9b::808:808".parse().unwrap()));
    }

    #[test]
    fn rejects_ipv4_compatible_private() {
        // ::a.b.c.d (deprecated IPv4-compatible). ::1 is loopback and handled
        // separately, so a non-trivial embedded v4 is what we screen here.
        assert!(!is_public_ip(&"::7f00:1".parse().unwrap())); // 127.0.0.1
        assert!(!is_public_ip(&"::a9fe:a9fe".parse().unwrap())); // 169.254.169.254
        assert!(is_public_ip(&"::808:808".parse().unwrap())); // 8.8.8.8
    }

    #[test]
    fn is_link_local_flags_only_link_local() {
        // Link-local / cloud-metadata — flagged (the MCP screen refuses these).
        assert!(is_link_local(&"169.254.169.254".parse().unwrap()));
        assert!(is_link_local(&"fe80::1".parse().unwrap()));
        assert!(is_link_local(&"::ffff:169.254.169.254".parse().unwrap()));
        assert!(is_link_local(&"64:ff9b::a9fe:a9fe".parse().unwrap()));
        // Loopback / private LAN / CGNAT / public — NOT flagged (MCP allows).
        assert!(!is_link_local(&"127.0.0.1".parse().unwrap()));
        assert!(!is_link_local(&"10.0.0.1".parse().unwrap()));
        assert!(!is_link_local(&"192.168.3.125".parse().unwrap()));
        assert!(!is_link_local(&"100.64.0.1".parse().unwrap()));
        assert!(!is_link_local(&"::1".parse().unwrap()));
        assert!(!is_link_local(&"fc00::1".parse().unwrap()));
        assert!(!is_link_local(&"8.8.8.8".parse().unwrap()));
    }

    #[tokio::test]
    async fn resolve_lan_addrs_allows_lan_blocks_link_local() {
        // The homelab case from issue #33: a private LAN IP must resolve, not
        // be rejected the way the strict web-fetch screen would.
        let url = Url::parse("http://192.168.3.125:3010/mcp").unwrap();
        let addrs = resolve_lan_addrs(&url)
            .await
            .expect("RFC1918 LAN address must be allowed for MCP");
        assert_eq!(addrs, vec!["192.168.3.125:3010".parse().unwrap()]);

        // Loopback is allowed too.
        assert!(resolve_lan_addrs(&Url::parse("http://127.0.0.1:3010").unwrap())
            .await
            .is_ok());

        // Cloud-metadata (link-local) is still refused.
        let err = resolve_lan_addrs(&Url::parse("http://169.254.169.254/").unwrap())
            .await
            .expect_err("link-local must be refused");
        assert!(err.to_string().contains("169.254.169.254"), "{err}");
        // …and classified as a positive block, not merely unscreenable —
        // snapshot import keys off this to decide between refusing the whole
        // backup and importing one row disabled.
        assert!(
            matches!(err, HostScreenError::Blocked(_)),
            "link-local must classify as Blocked, got {err:?}"
        );
    }

    /// `host_str()` keeps the brackets on an IPv6 literal, so without a strip
    /// every public IPv6 URL fell through to DNS — which can't resolve
    /// `[2606:…]` either — and failed with a misleading "DNS lookup failed".
    #[tokio::test]
    async fn resolve_safe_addrs_handles_ipv6_literals() {
        let url = Url::parse("http://[2606:4700:4700::1111]:80/").unwrap();
        let addrs = resolve_safe_addrs(&url)
            .await
            .expect("a public IPv6 literal must be fetchable");
        assert_eq!(addrs, vec!["[2606:4700:4700::1111]:80".parse().unwrap()]);

        // The screen still applies to IPv6 — loopback is refused, and the
        // bracket strip must not turn that into a DNS error.
        let err = resolve_safe_addrs(&Url::parse("http://[::1]/").unwrap())
            .await
            .expect_err("IPv6 loopback must be refused");
        assert!(err.contains("private/loopback"), "{err}");
    }

    /// A host DNS can't answer for is `Unresolvable`, NOT `Blocked`: nothing
    /// was learned about it, so it must not be treated as evidence of a
    /// hostile row. `.invalid` is reserved by RFC 2606 and never resolves.
    #[tokio::test]
    async fn unresolvable_host_is_distinguished_from_blocked() {
        let err = resolve_lan_addrs(&Url::parse("http://nonexistent.invalid/mcp").unwrap())
            .await
            .expect_err("an unresolvable host cannot be screened");
        assert!(
            matches!(err, HostScreenError::Unresolvable(_)),
            "expected Unresolvable, got {err:?}"
        );
    }

    #[test]
    fn truncate_breaks_on_multibyte_boundary() {
        // Regression: the whitespace-backoff window used raw byte arithmetic
        // (`end_byte - 200`), which could land inside a multi-byte codepoint
        // and panic when sliced. A long run of 3-byte glyphs past the budget
        // must truncate cleanly, not crash.
        let s = "あ".repeat(20_000);
        let (out, truncated) = truncate(&s, MAX_TEXT_CHARS);
        assert!(truncated);
        assert!(out.ends_with("[Content truncated]"));
        // The kept prefix is whole 'あ' chars — i.e. valid, un-severed UTF-8.
        let prefix = out.trim_end_matches("[Content truncated]").trim_end();
        assert!(!prefix.is_empty());
        assert!(prefix.chars().all(|c| c == 'あ'), "prefix severed a codepoint");
    }

    #[test]
    fn replace_many_ci_handles_absent_and_repeated_needles() {
        // One needle matches many times; another never matches. The absent
        // needle must not change the output (and, with the position cache,
        // is scanned once rather than re-scanned per match).
        let out = replace_many_ci("a&amp;b&amp;c&amp;d", &["&amp;", "&zwnj;"], "+");
        assert_eq!(out, "a+b+c+d");
    }

    #[test]
    fn replace_many_ci_picks_earliest_then_first_needle() {
        // Overlapping needles at the same position: the first needle in the
        // list wins, preserving the previous `min_by_key` tie-break.
        assert_eq!(replace_many_ci("xabcy", &["ab", "abc"], "_"), "x_cy");
        assert_eq!(replace_many_ci("xabcy", &["abc", "ab"], "_"), "x_y");
    }

    #[test]
    fn strip_blocks_drops_repeated_blocks_keeps_prose() {
        // Multiple blocks of one type, with another block type entirely
        // absent — the prose between/around the blocks survives intact.
        let html = "A<style>x{}</style>B<style>y{}</style>C";
        let lower = html.to_ascii_lowercase();
        let out = strip_blocks_with_lower(
            html,
            &lower,
            &[("<style", "</style>"), ("<script", "</script>")],
        );
        assert_eq!(out, "ABC");
    }

    #[test]
    fn html_to_text_handles_adversarial_repeated_tag_body() {
        // Guard against the O(n²) regression: a body that is almost entirely
        // one closing tag (a match) plus block openers that never appear used
        // to take minutes. With the position cache it returns instantly; all
        // the `</p>` collapse to nothing, so the extracted text is empty.
        let body = format!("<body>{}</body>", "</p>".repeat(20_000));
        let (_title, text) = html_to_text(&body);
        assert!(text.is_empty(), "got: {text:?}");
    }
}
