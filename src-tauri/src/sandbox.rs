//! The `loach-sandbox` URI scheme: an origin of its own for content Loach
//! renders but must not trust — the Code canvas's HTML preview.
//!
//! The protocol serves one fixed host page. The canvas frames it in
//! `<iframe sandbox="allow-scripts allow-forms">` and hands it the HTML over
//! `postMessage`; the page never learns anything else. What keeps that HTML
//! away from the app:
//!
//! * **An opaque origin.** The sandbox (no `allow-same-origin`) keeps the
//!   page out of the app's DOM, storage and globals.
//! * **Its own CSP** ([`CSP`]), sent on every response: inline script and
//!   style run, nothing is fetched — no network, no IPC endpoint, no nested
//!   frames, no form submissions. This one is load-bearing for IPC: on
//!   Windows wry injects Tauri's init scripts into *every* frame (see wry's
//!   `with_initialization_script_for_main_only`), so the preview holds a
//!   working `__TAURI_INTERNALS__.invoke` with the real invoke key, and
//!   Tauri counts a registered custom protocol as a *local* origin. The
//!   CSP blocks invoke's `ipc:` fetch, and WebView2 delivers its
//!   `postMessage` fallback to the frame's own event, which wry doesn't
//!   listen to — verified against Tauri 2.12 / wry 0.57 by invoking a
//!   command from the frame and seeing it never run. Re-check that after a
//!   Tauri or wry upgrade. (On macOS and Linux the scripts stay in the main
//!   frame.)
//! * **The app's `frame-src`** (`tauri.conf.json`) allows only this scheme,
//!   which also stops the preview navigating itself to an outside URL — the
//!   webview's navigation hook only sees the main frame.
//! * **The host page** (`assets/sandbox/preview.html`) covers what no CSP
//!   directive does. It takes WebRTC away before the HTML runs (a peer
//!   connection's ICE traffic reaches a STUN server regardless of
//!   `connect-src`), and removes nested frames as they're added: a `srcdoc`
//!   or `javascript:` frame isn't stopped by `frame-src` and would run its
//!   own script with a fresh `RTCPeerConnection`.
//! * **WebView2's WebRTC policy**, on Windows, behind the host page: the main
//!   window's `additionalBrowserArgs` (`tauri.conf.json`) add
//!   `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, so a peer
//!   connection that got past the page still has no UDP to reach a STUN
//!   server with. Setting the field replaces wry's own arguments
//!   (`--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`, the
//!   `default_args` in wry 0.57's `src/webview2/mod.rs`), so they're repeated
//!   ahead of it — re-check them after a wry upgrade.
//!
//! Previews start with the page's scripts off: the same host page is also
//! served as `preview-static.html` under [`STATIC_CSP`], which lets only the
//! host's own script run. On macOS and Linux WebKit runs the frame on the
//! app's main thread, so a page stuck in a loop froze all of Loach — lock
//! screen included — the moment it was previewed; the canvas now asks first.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use once_cell::sync::Lazy;
use sha2::{Digest, Sha256};
use tauri::http::{header, Request, Response, StatusCode};

/// Scheme name. The frame URL is `loach-sandbox://localhost/…` on macOS and
/// Linux and `http://loach-sandbox.localhost/…` on Windows; the frontend
/// builds it with `convertFileSrc`, and the app CSP's `frame-src` lists both.
pub const SCHEME: &str = "loach-sandbox";

const PREVIEW_HOST: &[u8] = include_bytes!("../assets/sandbox/preview.html");

/// Everything not named falls back to `default-src 'none'`: `connect-src`
/// (fetch, WebSocket, the IPC endpoint), `frame-src`, `worker-src`,
/// `object-src`. `form-action` and `base-uri` don't fall back, so they're
/// spelled out. Images, fonts and media are limited to what the page builds
/// itself (`data:` / `blob:`): a remote URL would load, and leak, from
/// outside.
const CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; \
                   style-src 'unsafe-inline'; img-src data: blob:; font-src data:; \
                   media-src data: blob:; form-action 'none'; base-uri 'none'";

/// [`CSP`] with `script-src` narrowed to the host page's own script, by
/// hash: the scripts-off preview. The policy belongs to the document and
/// survives the host's `document.open()` / `write()`, so the page it renders
/// can't run inline scripts, event-handler attributes or `javascript:` URLs.
static STATIC_CSP: Lazy<String> = Lazy::new(|| {
    CSP.replace(
        "script-src 'unsafe-inline'",
        &format!("script-src '{}'", host_script_hash()),
    )
});

/// CSP hash of the host page's inline script.
fn host_script_hash() -> String {
    let page = std::str::from_utf8(PREVIEW_HOST).expect("preview.html is UTF-8");
    let start = page.find("<script>").expect("preview.html has its script") + "<script>".len();
    let end = start + page[start..].find("</script>").expect("its script is closed");
    script_hash(&page[start..end])
}

/// A CSP `sha256-` source for an inline script's text, as the browser
/// computes it: after the HTML parser has turned CRLF and lone CR into LF
/// (a Windows checkout gives preview.html CRLF line endings).
fn script_hash(text: &str) -> String {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    format!("sha256-{}", STANDARD.encode(Sha256::digest(text.as_bytes())))
}

/// Protocol handler registered in `lib.rs`. Every response, the 404 too,
/// carries a CSP: [`CSP`], or [`STATIC_CSP`] for the scripts-off page.
pub fn handle(request: &Request<Vec<u8>>) -> Response<&'static [u8]> {
    let (status, body, csp) = match request.uri().path() {
        "/preview.html" => (StatusCode::OK, PREVIEW_HOST, CSP),
        "/preview-static.html" => (StatusCode::OK, PREVIEW_HOST, STATIC_CSP.as_str()),
        _ => (StatusCode::NOT_FOUND, &[][..], CSP),
    };
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CONTENT_SECURITY_POLICY, csp)
        .body(body)
        .expect("static response parts are valid")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(uri: &str) -> Response<&'static [u8]> {
        handle(&Request::get(uri).body(Vec::new()).unwrap())
    }

    #[test]
    fn serves_the_preview_host_on_both_url_shapes() {
        for uri in [
            "loach-sandbox://localhost/preview.html",
            "http://loach-sandbox.localhost/preview.html",
        ] {
            let res = get(uri);
            assert_eq!(res.status(), StatusCode::OK, "{uri}");
            assert_eq!(*res.body(), PREVIEW_HOST);
        }
    }

    #[test]
    fn the_scripts_off_page_runs_only_the_host_script() {
        let res = get("loach-sandbox://localhost/preview-static.html");
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(*res.body(), PREVIEW_HOST);
        let csp = res.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
        // The host script by hash, and nothing that would let the page's own
        // scripts, handlers or `javascript:` URLs run…
        assert!(csp.contains(&format!("script-src '{}'", host_script_hash())), "{csp}");
        let script_src = csp.split(';').find(|d| d.trim().starts_with("script-src")).unwrap();
        assert!(!script_src.contains("'unsafe-inline'"), "{script_src}");
        // …while everything else stays exactly as locked down as the
        // scripts-on page.
        assert_eq!(
            csp.replace(&format!("script-src '{}'", host_script_hash()), ""),
            CSP.replace("script-src 'unsafe-inline'", ""),
        );
    }

    #[test]
    fn the_script_hash_is_taken_over_lf_line_endings() {
        // A Windows checkout serves the page with CRLF; the browser hashes
        // the script text with LF, so the CSP must too.
        let expected = "sha256-kRFp3arxRq/1OfWMJsSJrzuJLf8P4oPBwmTGWuWqWaI=";
        assert_eq!(script_hash("a\nb\n"), expected);
        assert_eq!(script_hash("a\r\nb\r\n"), expected);
        assert_eq!(script_hash("a\rb\r"), expected);
    }

    #[test]
    fn unknown_paths_are_not_found() {
        for uri in [
            "loach-sandbox://localhost/",
            "loach-sandbox://localhost/other.html",
            "loach-sandbox://localhost/../preview.html",
            "loach-sandbox://localhost/sandbox/preview.html",
        ] {
            let res = get(uri);
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "{uri}");
            assert!(res.body().is_empty());
        }
    }

    #[test]
    fn every_response_carries_the_csp() {
        for uri in ["loach-sandbox://localhost/preview.html", "loach-sandbox://localhost/nope"] {
            let res = get(uri);
            assert_eq!(res.headers()[header::CONTENT_SECURITY_POLICY], CSP, "{uri}");
        }
    }

    #[test]
    fn csp_fetches_nothing_from_outside() {
        for d in ["default-src 'none'", "form-action 'none'", "base-uri 'none'"] {
            assert!(CSP.contains(d), "missing `{d}`");
        }
        // Sources stay limited to inline code and URLs the page builds itself…
        for token in CSP.split([';', ' ']).filter(|t| !t.is_empty()) {
            assert!(
                token.ends_with("-src")
                    || token.ends_with("-action")
                    || token.ends_with("-uri")
                    || ["'none'", "'unsafe-inline'", "data:", "blob:"].contains(&token),
                "unexpected source `{token}`"
            );
        }
        // …and nothing re-opens what `default-src 'none'` closes.
        for name in ["connect-src", "frame-src", "child-src", "worker-src", "object-src"] {
            assert!(!CSP.contains(name), "`{name}` must stay on the default-src fallback");
        }
    }

    /// The CSP can't stop WebRTC, so the host page has to: it takes every
    /// constructor away and keeps the page from opening a frame that would
    /// bring them back.
    #[test]
    fn the_host_page_takes_webrtc_away() {
        let page = std::str::from_utf8(PREVIEW_HOST).unwrap();
        for name in ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"] {
            assert!(page.contains(&format!("\"{name}\"")), "`{name}` is left in place");
        }
        assert!(page.contains("new MutationObserver"), "nested frames are no longer removed");
    }
}
