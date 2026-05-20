import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles/globals.css";

// Suppress the WebView's native context menu globally, EXCEPT inside form
// fields where right-click → Cut/Copy/Paste is genuinely useful and the
// keyboard shortcuts (Ctrl/Cmd + C/V/X/A) are too painful to rely on
// exclusively. Loach has its own inline menus everywhere else a right-
// click is meaningful (chat-row kebabs via `onContextMenu`, tile menus,
// header dropdowns); the browser-default "Back / Refresh / Save as /
// Print / Inspect" menu shouldn't surface in a packaged app.
//
// Listener installed at module scope (not in a React effect) so it fires
// for the entire lifetime of the document, including any modal/portal
// children Radix mounts. React `onContextMenu` handlers in components
// (e.g. `SessionRow`) keep working — they bubble independently and call
// `preventDefault()` themselves, which is idempotent with this one.
window.addEventListener("contextmenu", (e) => {
  const target = e.target as Element | null;
  // Leave editable surfaces alone so the OS-native copy/paste menu still
  // appears. `closest` matches the click target *and* its ancestors so
  // a right-click on a span inside a contenteditable div still falls
  // through.
  if (
    target?.closest(
      'input, textarea, [contenteditable=""], [contenteditable="true"]',
    )
  ) {
    return;
  }
  e.preventDefault();
});

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
    {/* Outermost safety net. Catches anything that escapes the per-panel
        boundaries inside App.tsx (or that fails before App's own boundaries
        mount — e.g., a crash in a top-level provider, store hydrate, etc.).
        `scope="app"` means the only escape is a full Reload Loach button. */}
    <ErrorBoundary name="Loach" scope="app">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
