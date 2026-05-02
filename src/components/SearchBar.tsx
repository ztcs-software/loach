import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Search, MessageSquare, Layers, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useSnippetStore } from "@/stores/snippetStore";
import { useUIStore } from "@/stores/uiStore";
import type { Attachment, Session, Snippet, Space } from "@/types";

/**
 * Floating command-palette-style search.
 *
 * Used to live as an in-place pill inside the TitleBar; now mounts as a
 * centred overlay (Linear / Raycast / ChatGPT "Search chats" pattern) so
 * the title bar stays minimal and the same surface is reachable from any
 * tab without competing with the in-app brand row for space.
 *
 * Trigger paths (any of):
 *   - Ctrl/Cmd + K (window-level listener)
 *   - Custom `loach:focus-search` event — fired by the sidebar's "Search"
 *     quick action so non-keyboard surfaces share the same path
 *
 * Behaviour while open:
 *   - Empty query → "suggestions" mix of recent chats / spaces / snippets
 *   - Typing filters across all three stores with case-insensitive substring
 *     match on the most-relevant fields
 *   - ↑/↓ move the active row, Enter commits, Esc closes (clears query first
 *     if non-empty)
 *   - Click on the backdrop closes
 *
 * Picking a result navigates without duplicating logic already present in
 * the sidebar:
 *   chat    → select session, flip sidebar to "chats"
 *   space   → open SpaceView, flip sidebar to "spaces"
 *   snippet → open a fresh chat and prime the composer (mirrors
 *             SnippetsLibrary.runSnippet)
 */

type ResultKind = "chat" | "space" | "snippet";

type Result =
  | { kind: "chat"; id: string; label: string; sub?: string; session: Session }
  | { kind: "space"; id: string; label: string; sub?: string; space: Space }
  | {
      kind: "snippet";
      id: string;
      label: string;
      sub?: string;
      snippet: Snippet;
    };

const MAX_RESULTS = 20;

export function SearchBar() {
  const sessions = useChatStore((s) => s.sessions);
  const spaces = useSpaceStore((s) => s.spaces);
  const snippets = useSnippetStore((s) => s.snippets);
  const select = useChatStore((s) => s.selectSession);
  const newSession = useChatStore((s) => s.newSession);
  const setViewingSpace = useSpaceStore((s) => s.setViewingSpace);
  const setSidebarTab = useUIStore((s) => s.setSidebarTab);
  const primeComposer = useUIStore((s) => s.primeComposer);

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);

  // Two open paths: Ctrl/Cmd+K and the `loach:focus-search` custom event the
  // sidebar fires when its "Search" quicklink is clicked. Both end up here so
  // there's a single source of truth for "show the palette".
  useEffect(() => {
    const focus = () => {
      setOpen(true);
      // Defer the focus call so the input has been mounted by the time we
      // try to grab focus.
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        focus();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("loach:focus-search", focus);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("loach:focus-search", focus);
    };
  }, []);

  const results = useMemo<Result[]>(() => {
    const q = query.trim().toLowerCase();

    // Empty query → "suggestions": a small mixed slice of recent items.
    if (!q) {
      const out: Result[] = [];
      const liveChats = sessions.filter((s) => !s.archived_at).slice(0, 4);
      for (const s of liveChats) {
        out.push({
          kind: "chat",
          id: s.id,
          label: s.title || "New chat",
          session: s,
        });
      }
      for (const sp of spaces.slice(0, 2)) {
        out.push({
          kind: "space",
          id: sp.id,
          label: sp.name,
          sub: sp.description || undefined,
          space: sp,
        });
      }
      for (const sn of snippets.slice(0, 2)) {
        out.push({
          kind: "snippet",
          id: sn.id,
          label: sn.title,
          sub: sn.prompt,
          snippet: sn,
        });
      }
      return out;
    }

    const matches: Result[] = [];

    for (const s of sessions) {
      if (s.archived_at) continue;
      const title = (s.title || "New chat").toLowerCase();
      if (title.includes(q)) {
        matches.push({
          kind: "chat",
          id: s.id,
          label: s.title || "New chat",
          session: s,
        });
      }
    }

    for (const sp of spaces) {
      const name = sp.name.toLowerCase();
      const desc = (sp.description || "").toLowerCase();
      if (name.includes(q) || desc.includes(q)) {
        matches.push({
          kind: "space",
          id: sp.id,
          label: sp.name,
          sub: sp.description || undefined,
          space: sp,
        });
      }
    }

    for (const sn of snippets) {
      const title = sn.title.toLowerCase();
      const prompt = sn.prompt.toLowerCase();
      if (title.includes(q) || prompt.includes(q)) {
        matches.push({
          kind: "snippet",
          id: sn.id,
          label: sn.title,
          sub: sn.prompt,
          snippet: sn,
        });
      }
    }

    return matches.slice(0, MAX_RESULTS);
  }, [query, sessions, spaces, snippets]);

  // Keep the active row valid whenever the result set changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [query, results.length]);

  const close = () => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
  };

  const commit = async (r: Result) => {
    close();

    if (r.kind === "chat") {
      setViewingSpace(null);
      setSidebarTab("chats");
      await select(r.id);
      return;
    }

    if (r.kind === "space") {
      setSidebarTab("spaces");
      setViewingSpace(r.id);
      return;
    }

    // snippet — same handler as the sidebar's "Run" action.
    setViewingSpace(null);
    setSidebarTab("chats");
    await newSession({
      spaceId: null,
      provider: r.snippet.provider ?? undefined,
      model: r.snippet.model ?? undefined,
    });
    primeComposer(r.snippet.prompt, [] as Attachment[]);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) =>
        results.length === 0 ? 0 : Math.min(i + 1, results.length - 1),
      );
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      const r = results[activeIndex];
      if (r) {
        e.preventDefault();
        void commit(r);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      // First Esc clears the query, second closes — same pattern as
      // Linear / Raycast: lets the user keep the palette open while
      // refining the search.
      if (query) {
        setQuery("");
      } else {
        close();
      }
    }
  };

  if (!open) return null;

  const headerLabel = query.trim() ? "Results" : "Suggestions";

  return (
    <>
      {/* Backdrop — full-window, semi-opaque + backdrop blur. Clicking
          anywhere outside the palette card closes the overlay. We attach
          to mousedown rather than click so the input doesn't blur first
          (which would race the close handler on some browsers). */}
      <div
        className="fixed inset-0 z-[55] bg-background/55 backdrop-blur-sm"
        onMouseDown={close}
        aria-hidden
      />

      {/* Palette card — centred horizontally, ~15% from the top so the
          eye lands on it without it feeling like a modal dialog. Stops
          propagation so backdrop clicks INSIDE the card don't close. */}
      <div
        className="fixed left-1/2 top-[12%] z-[56] w-full max-w-xl -translate-x-1/2 px-4"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="overflow-hidden rounded-2xl border border-foreground/10 bg-popover/95 shadow-2xl backdrop-blur-2xl">
          {/* Input row */}
          <div className="flex items-center gap-3 border-b border-foreground/[0.06] px-4 py-3">
            <Search className="h-4 w-4 shrink-0 text-foreground/45" aria-hidden />
            <input
              ref={inputRef}
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search chats, spaces, snippets…"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-foreground/40 focus:outline-none"
            />
            <kbd className="hidden rounded border border-foreground/10 bg-foreground/[0.05] px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-foreground/40 sm:inline">
              Esc
            </kbd>
            <button
              type="button"
              onClick={close}
              aria-label="Close search"
              className="-mr-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground/45 transition-colors hover:bg-foreground/10 hover:text-foreground sm:hidden"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex items-center justify-between border-b border-foreground/[0.04] px-4 py-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wider text-foreground/45">
              {headerLabel}
            </span>
            {results.length > 0 && (
              <span className="text-[10px] text-foreground/35">
                {results.length}
                {results.length === MAX_RESULTS ? "+" : ""}
              </span>
            )}
          </div>

          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-foreground/45">
              {query.trim()
                ? `No matches for "${query.trim()}"`
                : "Nothing yet — start a chat, create a space, or save a snippet."}
            </div>
          ) : (
            <ul className="max-h-[60vh] overflow-y-auto py-1">
              {results.map((r, i) => (
                <li key={`${r.kind}-${r.id}`}>
                  <button
                    type="button"
                    onMouseEnter={() => setActiveIndex(i)}
                    // preventDefault on mousedown so the input doesn't blur
                    // before our click handler runs.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void commit(r)}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm transition-colors",
                      i === activeIndex
                        ? "bg-foreground/10"
                        : "hover:bg-foreground/[0.06]",
                    )}
                  >
                    <ResultIcon kind={r.kind} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-foreground">
                        {r.label || "Untitled"}
                      </div>
                      {r.sub && (
                        <div className="truncate text-[12px] text-foreground/45">
                          {r.sub}
                        </div>
                      )}
                    </div>
                    <span className="shrink-0 text-[10px] uppercase tracking-wider text-foreground/35">
                      {r.kind}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

function ResultIcon({ kind }: { kind: ResultKind }) {
  const cls = "h-4 w-4 shrink-0 text-foreground/55";
  if (kind === "chat") return <MessageSquare className={cls} />;
  if (kind === "space") return <Layers className={cls} />;
  return <Sparkles className={cls} />;
}
