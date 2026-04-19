import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Search, MessageSquare, Layers, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useSnippetStore } from "@/stores/snippetStore";
import { useUIStore } from "@/stores/uiStore";
import type { Attachment, Session, Snippet, Space } from "@/types";

/**
 * A compact "command-palette"-style search that lives in the TitleBar.
 *
 * Behavior:
 * - Click / focus → opens a dropdown with suggestions (recent chats / spaces
 *   / snippets) even when the query is empty.
 * - Typing filters across all three stores with a case-insensitive substring
 *   match on the most-relevant fields (chat title, space name+description,
 *   snippet title+prompt).
 * - ↑/↓ move the active row, Enter commits it, Esc clears then closes.
 * - Picking a result navigates without duplicating logic already present in
 *   the sidebar:
 *     chat    → select session, flip sidebar to "chats"
 *     space   → open SpaceView, flip sidebar to "spaces"
 *     snippet → open a fresh chat and prime the composer (same as
 *               SnippetsPanel.runSnippet)
 *
 * NOTE: the TitleBar is a Tauri drag region. Interactive descendants
 * (button, input) are excluded by Tauri's built-in rule, so focus/typing
 * work without fighting the drag behavior.
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

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close when the user clicks anywhere outside the bar or the dropdown.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const root = rootRef.current;
      if (root && !root.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Ctrl/Cmd+K focuses the search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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

  const reset = () => {
    setQuery("");
    setOpen(false);
    setActiveIndex(0);
  };

  const commit = async (r: Result) => {
    reset();
    inputRef.current?.blur();

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
      setOpen(true);
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
      if (query) {
        setQuery("");
      } else {
        setOpen(false);
        inputRef.current?.blur();
      }
    }
  };

  const headerLabel = query.trim() ? "Results" : "Suggestions";

  return (
    <div ref={rootRef} className="relative w-full max-w-md">
      <div
        className={cn(
          "flex h-7 items-center gap-2 rounded-full border border-foreground/10 bg-foreground/[0.05] px-3 transition-colors",
          open && "border-foreground/25 bg-foreground/[0.08]",
        )}
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-foreground/45" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search chats, spaces, snippets..."
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-foreground/40 focus:outline-none"
        />
        <kbd className="hidden rounded border border-foreground/10 bg-foreground/[0.05] px-1.5 py-0.5 text-[10px] tracking-wider text-foreground/40 sm:inline">
          Ctrl K
        </kbd>
      </div>

      {open && (
        <div className="absolute left-0 right-0 top-full z-40 mt-1.5 overflow-hidden rounded-xl border border-foreground/10 bg-popover/95 shadow-lg backdrop-blur-2xl">
          <div className="flex items-center justify-between border-b border-foreground/5 px-3 py-1.5">
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
            <div className="px-3 py-4 text-xs text-foreground/45">
              {query.trim()
                ? `No matches for "${query.trim()}"`
                : "Nothing yet — start a chat, create a space, or save a snippet."}
            </div>
          ) : (
            <ul className="max-h-80 overflow-y-auto py-1">
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
                      "flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors",
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
                        <div className="truncate text-[11px] text-foreground/45">
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
      )}
    </div>
  );
}

function ResultIcon({ kind }: { kind: ResultKind }) {
  const cls = "h-3.5 w-3.5 shrink-0 text-foreground/55";
  if (kind === "chat") return <MessageSquare className={cls} />;
  if (kind === "space") return <Layers className={cls} />;
  return <Sparkles className={cls} />;
}
