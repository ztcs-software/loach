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

/// Protocol handler registered in `lib.rs`. Every response, the 404 too,
/// carries [`CSP`].
pub fn handle(request: &Request<Vec<u8>>) -> Response<&'static [u8]> {
    let (status, body) = match request.uri().path() {
        "/preview.html" => (StatusCode::OK, PREVIEW_HOST),
        _ => (StatusCode::NOT_FOUND, &[][..]),
    };
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CONTENT_SECURITY_POLICY, CSP)
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
}
