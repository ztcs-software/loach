import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";

// Suppress the WebView's native context menu globally. Loach has its own
// inline menus everywhere a right-click is meaningful (chat-row kebabs via
// `onContextMenu`, tile menus, header dropdowns); the browser-default
// "Back / Refresh / Save as / Print / Inspect" menu is never something an
// end user should see in a packaged app.
//
// Listener installed at module scope (not in a React effect) so it fires
// for the entire lifetime of the document, including any modal/portal
// children Radix mounts. React `onContextMenu` handlers in components
// (e.g. `SessionRow`) keep working — they bubble independently and call
// `preventDefault()` themselves, which is idempotent with this one.
//
// Keyboard shortcuts (Ctrl/Cmd + C / V / X / A) still work in inputs and
// textareas, so users don't lose copy/paste — they just can't reach those
// commands via right-click.
window.addEventListener("contextmenu", (e) => e.preventDefault());

// Suppress the WebView's built-in find-in-page bar. On Windows (WebView2)
// Ctrl+F, F3 and Ctrl+G pop a Chrome-style toolbar that doesn't match the
// app's chrome and isn't wired to any Loach search surface. Loach's own
// command palette lives on Ctrl/Cmd+K (see `SearchBar`), so killing these
// shortcuts at the document level just removes the stray UI.
window.addEventListener(
  "keydown",
  (e) => {
    const k = e.key.toLowerCase();
    if (((e.ctrlKey || e.metaKey) && (k === "f" || k === "g")) || e.key === "F3") {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  { capture: true },
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
