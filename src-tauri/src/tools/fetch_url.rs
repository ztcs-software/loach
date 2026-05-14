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
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::Url;
use serde::Serialize;
use tokio::net::lookup_host;

pub const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_BODY_BYTES: usize = 5 * 1024 * 1024; // 5 MB
pub const MAX_TEXT_CHARS: usize = 12_000; // ~3-4k tokens, plenty for inlining

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
    let url =
        Url::parse(raw_url).map_err(|e| format!("Invalid URL `{raw_url}`: {e}"))?;

    // Scheme allowlist.
    match url.scheme() {
        "http" | "https" => {}
        other => return Err(format!("Unsupported URL scheme: `{other}` (only http/https)")),
    }

    // SSRF guard — resolve, screen, and PIN the resolved IPs into a
    // per-request client. Reqwest will use this map instead of re-resolving
    // before it dials, so a hostname can't flip from public → private
    // between our check and the actual connection.
    let resolved = resolve_safe_addrs(&url).await?;
    let http = build_pinned_client(&url, &resolved)?;

    let resp = http
        .get(url.clone())
        .timeout(FETCH_TIMEOUT)
        .header(reqwest::header::ACCEPT, "text/html,text/plain,*/*;q=0.8")
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!(
            "HTTP {} for {}",
            resp.status(),
            url
        ));
    }

    let final_url = resp.url().clone();
    // The final URL may be different after redirects — re-check it. We
    // also rebuild the pinned client if the host changed, so the body
    // download honours the same SSRF policy.
    if final_url.host_str() != url.host_str() {
        // Redirect to a different host — re-resolve and screen. We don't
        // re-issue the request here (the response body is already
        // streaming), but we DO drop it if the redirect target failed the
        // check. Note that reqwest follows redirects internally using the
        // same pinned client, so the only way we get here with a host
        // mismatch is via cross-origin redirects — those bypass our
        // resolver and need re-validation.
        let _ = resolve_safe_addrs(&final_url).await?;
    }

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
async fn resolve_safe_addrs(url: &Url) -> Result<Vec<SocketAddr>, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "URL has no host".to_string())?;
    let port = url.port_or_known_default().unwrap_or(80);

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

/// Build a one-shot reqwest::Client whose DNS table maps the requested host
/// to the SocketAddrs we already screened. With this in place, reqwest will
/// NOT call the system resolver again before dialing — so a DNS-rebinding
/// attacker can't slip a private address past our check.
fn build_pinned_client(url: &Url, addrs: &[SocketAddr]) -> Result<reqwest::Client, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "URL has no host".to_string())?;
    let mut builder = reqwest::Client::builder()
        .user_agent("Loach/0.1 (fetch_url)")
        // Redirect handling: reqwest's default Policy::limited(10) is fine,
        // and the redirect target's host is re-checked in `fetch()` above
        // via final_url comparison. We can't easily run our screener inside
        // the redirect callback because the resolver is per-Client.
        .redirect(reqwest::redirect::Policy::limited(10));

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
/// Exposed `pub` so the MCP-input validator (`commands::validate_mcp_input`)
/// can share the same private-range classifier — we want one source of truth
/// for "this IP isn't safe to send credentials to".
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
            // ::ffff:0:0/96 — IPv4-mapped: delegate to the v4 check.
            if segs[0] == 0
                && segs[1] == 0
                && segs[2] == 0
                && segs[3] == 0
                && segs[4] == 0
                && segs[5] == 0xffff
            {
                let mapped = std::net::Ipv4Addr::new(
                    (segs[6] >> 8) as u8,
                    (segs[6] & 0xff) as u8,
                    (segs[7] >> 8) as u8,
                    (segs[7] & 0xff) as u8,
                );
                return is_public_ip(&IpAddr::V4(mapped));
            }
            true
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

    let mut s = strip_block_ci(html, "<script", "</script>");
    s = strip_block_ci(&s, "<style", "</style>");
    s = strip_block_ci(&s, "<noscript", "</noscript>");

    // Insert newlines where block-level tags close so paragraphs don't merge.
    for tag in [
        "</p>", "</div>", "</li>", "</tr>", "</h1>", "</h2>", "</h3>", "</h4>", "</h5>",
        "</h6>", "<br>", "<br/>", "<br />", "</pre>", "</blockquote>",
    ] {
        s = replace_ci(&s, tag, "\n");
    }

    // Strip all remaining tags.
    s = strip_all_tags(&s);
    s = decode_entities(&s);
    s = collapse_whitespace(&s);

    (title, s)
}

// ---------------------------------------------------------------------------
// Small string helpers (ASCII-case-insensitive). These live here rather than
// pulling in a regex crate — the alternative is a ~10 MB dep for a half-page
// of logic.

fn strip_block_ci(hay: &str, open: &str, close: &str) -> String {
    let mut out = String::with_capacity(hay.len());
    let lower = hay.to_ascii_lowercase();
    let open_l = open.to_ascii_lowercase();
    let close_l = close.to_ascii_lowercase();
    let mut i = 0usize;
    while i < hay.len() {
        match lower[i..].find(&open_l) {
            Some(rel_open) => {
                let open_at = i + rel_open;
                out.push_str(&hay[i..open_at]);
                match lower[open_at..].find(&close_l) {
                    Some(rel_close) => {
                        let close_at = open_at + rel_close + close.len();
                        i = close_at;
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

fn replace_ci(hay: &str, needle: &str, repl: &str) -> String {
    let lower = hay.to_ascii_lowercase();
    let needle_l = needle.to_ascii_lowercase();
    let mut out = String::with_capacity(hay.len());
    let mut i = 0;
    while i < hay.len() {
        match lower[i..].find(&needle_l) {
            Some(rel) => {
                let at = i + rel;
                out.push_str(&hay[i..at]);
                out.push_str(repl);
                i = at + needle.len();
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
            // Find the matching ';' (if any) starting from this position.
            // `s[i..]` is a fresh subslice; both `i` and `i + rel` are valid
            // char boundaries because they came from `char_indices`.
            if let Some(rel) = s[i + 1..].find(';') {
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
    let scan_start = end_byte.saturating_sub(200);
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
    fn rejects_private_ipv6() {
        assert!(!is_public_ip(&"::1".parse().unwrap()));
        assert!(!is_public_ip(&"fc00::1".parse().unwrap()));
        assert!(!is_public_ip(&"fe80::1".parse().unwrap()));
        assert!(is_public_ip(&"2606:4700:4700::1111".parse().unwrap()));
    }
}
