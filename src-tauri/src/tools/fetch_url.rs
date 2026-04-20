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
//! * **Timeout** — 15 s total per fetch.
//! * **Body cap** — at most 5 MB is read off the wire; we truncate early
//!   rather than buffering the whole body.
//! * **Text cap** — after HTML stripping, the returned text is truncated to
//!   [`MAX_TEXT_CHARS`]. The frontend is free to truncate further.

use std::net::IpAddr;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::Url;
use serde::Serialize;
use tokio::net::lookup_host;

pub const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
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
pub async fn fetch(http: &reqwest::Client, raw_url: &str) -> Result<FetchedPage, String> {
    let url =
        Url::parse(raw_url).map_err(|e| format!("Invalid URL `{raw_url}`: {e}"))?;

    // Scheme allowlist.
    match url.scheme() {
        "http" | "https" => {}
        other => return Err(format!("Unsupported URL scheme: `{other}` (only http/https)")),
    }

    // SSRF guard — check the URL's host, and (for hostnames) the resolved IPs.
    assert_safe_host(&url).await?;

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
    // The final URL may be different after redirects — re-check it.
    assert_safe_host(&final_url).await?;

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

/// Reject URLs whose host is — or resolves to — a non-routable address.
///
/// This does not fully eliminate TOCTOU (reqwest will re-resolve before the
/// actual connection), but it catches the common cases (`http://127.0.0.1`,
/// `http://localhost`, `http://10.0.0.1`) and DNS-rebinding attempts where a
/// hostname *currently* resolves to a private address.
async fn assert_safe_host(url: &Url) -> Result<(), String> {
    let host = url
        .host_str()
        .ok_or_else(|| "URL has no host".to_string())?;

    // Literal IP: validate directly.
    if let Ok(ip) = host.parse::<IpAddr>() {
        if !is_public_ip(&ip) {
            return Err(format!("Refusing to fetch private/loopback IP: {ip}"));
        }
        return Ok(());
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
    let port = url.port_or_known_default().unwrap_or(80);
    let addrs = lookup_host((host, port))
        .await
        .map_err(|e| format!("DNS lookup failed for `{host}`: {e}"))?;

    let mut any = false;
    for addr in addrs {
        any = true;
        let ip = addr.ip();
        if !is_public_ip(&ip) {
            return Err(format!(
                "Refusing to fetch `{host}` — resolves to non-public address {ip}"
            ));
        }
    }
    if !any {
        return Err(format!("DNS returned no addresses for `{host}`"));
    }
    Ok(())
}

/// Returns `false` for loopback, private, link-local, broadcast, multicast,
/// unspecified, and other special-purpose ranges. Only "globally routable"
/// unicast addresses pass.
fn is_public_ip(ip: &IpAddr) -> bool {
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
    let head = &body[..body.len().min(2048)].to_ascii_lowercase();
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
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    let mut in_tag = false;
    while i < bytes.len() {
        let c = bytes[i];
        if in_tag {
            if c == b'>' {
                in_tag = false;
            }
        } else if c == b'<' {
            in_tag = true;
        } else {
            out.push(c as char);
        }
        i += 1;
    }
    out
}

fn decode_entities(s: &str) -> String {
    // Handle the common named entities plus decimal & hex numeric references.
    // Unknown entities are left as-is.
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'&' {
            if let Some(end_rel) = s[i..].find(';') {
                let end = i + end_rel;
                let name = &s[i + 1..end];
                let replacement = match name {
                    "amp" => Some("&".to_string()),
                    "lt" => Some("<".to_string()),
                    "gt" => Some(">".to_string()),
                    "quot" => Some("\"".to_string()),
                    "apos" | "#39" => Some("'".to_string()),
                    "nbsp" | "#160" => Some(" ".to_string()),
                    "mdash" | "#8212" => Some("—".to_string()),
                    "ndash" | "#8211" => Some("–".to_string()),
                    "hellip" | "#8230" => Some("…".to_string()),
                    "lsquo" | "#8216" => Some("‘".to_string()),
                    "rsquo" | "#8217" => Some("’".to_string()),
                    "ldquo" | "#8220" => Some("“".to_string()),
                    "rdquo" | "#8221" => Some("”".to_string()),
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
                    i = end + 1;
                    continue;
                }
            }
        }
        out.push(bytes[i] as char);
        i += 1;
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
    fn rejects_private_ipv6() {
        assert!(!is_public_ip(&"::1".parse().unwrap()));
        assert!(!is_public_ip(&"fc00::1".parse().unwrap()));
        assert!(!is_public_ip(&"fe80::1".parse().unwrap()));
        assert!(is_public_ip(&"2606:4700:4700::1111".parse().unwrap()));
    }
}
