import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  Search,
  MessageSquare,
  Layers,
  SquareTerminal,
  Quote,
  Check,
  ChevronDown,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { logger } from "@/lib/logger";
import { searchMessages } from "@/lib/tauri";
import { useChatStore } from "@/stores/chatStore";
import { usePrivateChatStore } from "@/stores/privateChatStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useSnippetStore } from "@/stores/snippetStore";
import { useUIStore } from "@/stores/uiStore";
import { expandAndPrimeSnippet } from "@/lib/runSnippet";
import type { MessageHit, Session, Snippet, Space } from "@/types";

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
 *   - Custom `loach:focus-search` event — fired by the title bar's search
 *     pill so non-keyboard surfaces share the same path
 *
 * Behaviour while open:
 *   - Empty query → "suggestions" mix of recent chats / spaces / snippets
 *   - Typing filters across all three stores with case-insensitive substring
 *     match on the most-relevant fields, and searches inside chat transcripts
 *     (both prompts and responses) via the backend — see `messageHits`
 *   - An `in:<scope>` token narrows the search to one kind. The token is the
 *     ONLY scope state: the dropdown beside the input writes and removes it
 *     rather than tracking a scope of its own, so the menu's label and the
 *     text in the box can never disagree, and editing either is editing the
 *     same thing. See `parseQuery`.
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
 *   message → select the chat it lives in, then hand ChatCanvas the message
 *             id so it scrolls there and flashes the row
 */

type ResultKind = "chat" | "space" | "snippet" | "message";

type Result =
  | { kind: "chat"; id: string; label: string; sub?: string; session: Session }
  | { kind: "space"; id: string; label: string; sub?: string; space: Space }
  | {
      kind: "snippet";
      id: string;
      label: string;
      sub?: string;
      snippet: Snippet;
    }
  | { kind: "message"; id: string; label: string; sub?: string; hit: MessageHit };

/** What the search is currently pointed at. "everywhere" is the default and
 *  means "no filter"; every other value narrows the list to a single kind. */
const SCOPES = ["everywhere", "chats", "messages", "spaces", "snippets"] as const;
type Scope = (typeof SCOPES)[number];

/** The one result kind each narrowing scope admits. "everywhere" is absent
 *  because it admits all of them. */
const SCOPE_KIND: Record<Exclude<Scope, "everywhere">, ResultKind> = {
  chats: "chat",
  messages: "message",
  spaces: "space",
  snippets: "snippet",
};

/** The `in:<scope>` filter, matched as a standalone word anywhere in the query
 *  rather than only at the front — `notes in:messages` is as natural to type as
 *  the other order. `in:everywhere` is deliberately not accepted: "everywhere"
 *  is the *absence* of a filter, spelled by deleting the token. */
const SCOPE_TOKEN = /(^|\s)(in:(?:chats|messages|spaces|snippets))(?=\s|$)/i;

interface ParsedQuery {
  scope: Scope;
  /** The query with the filter token lifted out — what actually gets matched.
   *  Everything downstream searches on this, never on the raw query. */
  terms: string;
  /** Where the token sits in the raw query, so the overlay can draw a box
   *  around exactly those characters. Null when there's no token. */
  token: { start: number; end: number } | null;
}

function parseQuery(raw: string): ParsedQuery {
  const m = SCOPE_TOKEN.exec(raw);
  if (!m) return { scope: "everywhere", terms: raw.trim(), token: null };
  // m[1] is the leading boundary (start-of-string or a space) — the token
  // itself is m[2], and only that should be boxed.
  const start = m.index + m[1].length;
  const end = start + m[2].length;
  return {
    scope: m[2].slice("in:".length).toLowerCase() as Scope,
    // Trim each side before rejoining rather than collapsing whitespace
    // globally: lifting a token out of the middle leaves a double space that
    // a plain `.trim()` wouldn't touch.
    terms: [raw.slice(0, start).trim(), raw.slice(end).trim()]
      .filter(Boolean)
      .join(" "),
    token: { start, end },
  };
}

const MAX_RESULTS = 20;

/** How many transcript hits the backend is asked for, and how many slots the
 *  combined list reserves for them. Without the reservation a query matching
 *  many chat titles would push every message hit past `MAX_RESULTS` — which
 *  is precisely the case where searching message text is most useful. */
const MAX_MESSAGE_RESULTS = 8;

/** Shortest query that goes to the backend. One character matches most of the
 *  database and tells the user nothing; title/space/snippet filtering still
 *  runs from the first keystroke because it's free and local. */
const MIN_MESSAGE_QUERY = 2;

/** Idle time before a keystroke turns into an IPC round trip. Long enough
 *  that typing a word is one query rather than five, short enough to feel
 *  like the local filtering happening beside it. */
const MESSAGE_SEARCH_DEBOUNCE_MS = 160;

export function SearchBar() {
  const sessions = useChatStore((s) => s.sessions);
  const spaces = useSpaceStore((s) => s.spaces);
  const snippets = useSnippetStore((s) => s.snippets);
  const select = useChatStore((s) => s.selectSession);
  const newSession = useChatStore((s) => s.newSession);
  const setViewingSpace = useSpaceStore((s) => s.setViewingSpace);
  const setSidebarTab = useUIStore((s) => s.setSidebarTab);
  const recentSessionIds = useUIStore((s) => s.recentSessionIds);
  const setPendingJumpMessage = useUIStore((s) => s.setPendingJumpMessage);

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  // Transcript hits for the current query. Unlike the other three sources
  // this can't be derived: only the ACTIVE chat's messages are resident in
  // the store, so matching the rest means asking SQLite.
  const [messageHits, setMessageHits] = useState<MessageHit[]>([]);
  // True from the keystroke until that query's transcript search settles.
  // Only used to hold back the "no matches" line: asserting it while a
  // message-only query is still in flight contradicts itself a moment later.
  const [searching, setSearching] = useState(false);
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);

  const { scope, terms, token } = useMemo(() => parseQuery(query), [query]);

  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Underlay that draws the box around the `in:` token. Kept in horizontal
  // sync with the input so the box doesn't drift once the query is long
  // enough for the input to scroll.
  const mirrorRef = useRef<HTMLDivElement>(null);
  // Whatever had focus when the palette opened, so closing can hand it back
  // instead of dropping the user at the top of the document.
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  // Two open paths: Ctrl/Cmd+K and the `loach:focus-search` custom event the
  // title bar fires when its search pill is clicked. Both end up here so
  // there's a single source of truth for "show the palette".
  useEffect(() => {
    const focus = () => {
      // Private Chat owns the screen while it's open. The palette renders
      // *below* that overlay, so opening it here would steal focus from the
      // private composer into an invisible input and let Enter act on the
      // regular app behind it — including surfacing persisted chat titles,
      // which is exactly what the TitleBar's disabled search pill prevents.
      if (usePrivateChatStore.getState().open) return;
      restoreFocusTo.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
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

  // Transcript search. Debounced so a typed word is one round trip, and
  // sequence-guarded so a slow early query can't land on top of a later one
  // and show results for a prefix the user has already typed past.
  useEffect(() => {
    const wantsMessages = scope === "everywhere" || scope === "messages";
    if (!open || !wantsMessages || terms.length < MIN_MESSAGE_QUERY) {
      setMessageHits([]);
      setSearching(false);
      return;
    }
    let live = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      // Scoped to messages there's nothing to share the list with, so ask for
      // a full page instead of the slice reserved in the mixed view.
      searchMessages(terms, scope === "messages" ? MAX_RESULTS : MAX_MESSAGE_RESULTS)
        .then((hits) => {
          if (live) setMessageHits(hits);
        })
        .catch((e) => {
          // Non-fatal: the local title/space/snippet matches are still on
          // screen, so a failed transcript search degrades to the old
          // behaviour rather than emptying the palette.
          logger.error("message search failed", e);
          if (live) setMessageHits([]);
        })
        .finally(() => {
          if (live) setSearching(false);
        });
    }, MESSAGE_SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [terms, scope, open]);

  const results = useMemo<Result[]>(() => {
    const q = terms.toLowerCase();
    // Ternary rather than `scope === "everywhere" || …` so TS narrows `scope`
    // to the keys `SCOPE_KIND` actually has.
    const allows = (kind: ResultKind) =>
      scope === "everywhere" ? true : SCOPE_KIND[scope] === kind;

    // Empty query → "suggestions": a small mixed slice of recent items. Under
    // a narrowed scope one kind has the list to itself, so it gets to show
    // more than its share of the mixed default.
    if (!q) {
      const out: Result[] = [];
      const room = scope === "everywhere" ? { chat: 4, other: 2 } : { chat: 8, other: 8 };
      // `sessions` arrives as `updated_at DESC` — recently *written to*.
      // Chats the user has actually opened this session come first, since
      // "the one I was just looking at" is the overwhelmingly likely
      // target when the palette is opened with an empty box. Everything
      // else keeps the updated_at order behind them.
      const visitRank = new Map(recentSessionIds.map((id, i) => [id, i]));
      if (allows("chat")) {
        const liveChats = sessions
          .filter((s) => !s.archived_at)
          .sort(
            (a, b) =>
              (visitRank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
              (visitRank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
          )
          .slice(0, room.chat);
        for (const s of liveChats) {
          out.push({
            kind: "chat",
            id: s.id,
            label: s.title || "New chat",
            session: s,
          });
        }
      }
      if (allows("space")) {
        for (const sp of spaces.slice(0, room.other)) {
          out.push({
            kind: "space",
            id: sp.id,
            label: sp.name,
            sub: sp.description || undefined,
            space: sp,
          });
        }
      }
      if (allows("snippet")) {
        for (const sn of snippets.slice(0, room.other)) {
          out.push({
            kind: "snippet",
            id: sn.id,
            label: sn.title,
            sub: sn.prompt,
            snippet: sn,
          });
        }
      }
      return out;
    }

    const matches: Result[] = [];

    if (allows("chat")) {
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
    }

    if (allows("space")) {
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
    }

    if (allows("snippet")) {
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
    }

    // Transcript hits go last: a chat whose *title* matches is a stronger
    // signal than a phrase buried in one of its turns. They still get a
    // guaranteed block of slots at the bottom, so a query that also matches
    // dozens of titles can't squeeze them out entirely — and under
    // `in:messages` that block is the whole list.
    const messageRoom = scope === "messages" ? MAX_RESULTS : MAX_MESSAGE_RESULTS;
    const messages: Result[] = allows("message")
      ? messageHits.map((hit) => ({
          kind: "message",
          id: hit.message_id,
          label: hit.session_title || "New chat",
          sub: hit.snippet,
          hit,
        }))
      : [];

    return [
      ...matches.slice(0, MAX_RESULTS - Math.min(messages.length, messageRoom)),
      ...messages.slice(0, messageRoom),
    ];
  }, [terms, scope, sessions, spaces, snippets, recentSessionIds, messageHits]);

  // Keep the active row valid whenever the result set changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [query, results.length]);

  // Options are no longer focusable (see the listbox markup below), so the
  // browser won't scroll them into view the way it did when each row was a
  // real tab stop. Arrowing past the fold has to be driven manually now.
  useEffect(() => {
    if (!open) return;
    panelRef.current
      ?.querySelector(`#search-option-${activeIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const close = () => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
    // Hand focus back to the trigger. Deferred so it lands after the
    // palette has unmounted, otherwise React restores it into a node
    // that's about to disappear.
    const target = restoreFocusTo.current;
    restoreFocusTo.current = null;
    if (target?.isConnected) window.setTimeout(() => target.focus(), 0);
  };

  // The focus() guard above stops the palette OPENING under Private Chat;
  // this covers the reverse order — palette already open when Private Chat
  // takes the screen. Without it the palette lingers beneath the overlay
  // (Esc routes to Private Chat) and greets the user when the overlay
  // closes. Plain setters, not close(): restoring focus into the surface
  // Private Chat just covered would fight its own focus handling.
  const privateChatOpen = usePrivateChatStore((s) => s.open);
  useEffect(() => {
    if (privateChatOpen && open) {
      setOpen(false);
      setQuery("");
      setActiveIndex(0);
      restoreFocusTo.current = null;
    }
  }, [privateChatOpen, open]);

  /**
   * Keep Tab inside the palette while it's open.
   *
   * The overlay covers the app but doesn't stop focus reaching it, so
   * without this Tab walked straight out into the chat behind — and,
   * because Escape is bound to the input, a user who had tabbed away
   * could no longer close the palette from the keyboard at all. Escape is
   * repeated here as a backstop for the same reason: the input's own
   * handler only fires while the input holds focus.
   */
  const onPanelKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // The scope menu portals out of the DOM but stays inside this panel's
    // REACT tree, so its key events still bubble to this handler. While it's
    // open Radix owns Escape and Tab — handling them again here would close
    // the menu and wipe the query on a single keystroke.
    if (scopeMenuOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else close();
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
      'input, button:not([tabindex="-1"]), [href], [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const activeEl = document.activeElement;
    if (e.shiftKey && activeEl === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && activeEl === last) {
      e.preventDefault();
      first.focus();
    }
  };

  /**
   * Point the search at `next` by rewriting the query's `in:` token — the
   * token is the scope, so the dropdown edits the same text the user can.
   * Picking "everywhere" deletes it.
   *
   * The trailing space on an otherwise-empty query means the token is already
   * terminated, so whatever the user types next lands beside it rather than
   * inside it.
   */
  const applyScope = (next: Scope) => {
    if (next === "everywhere") setQuery(terms);
    else setQuery(terms ? `in:${next} ${terms}` : `in:${next} `);
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

    if (r.kind === "message") {
      setViewingSpace(null);
      setSidebarTab("chats");
      // Park the target BEFORE selecting, so it's already waiting whichever
      // way the race goes — ChatCanvas picks it up as soon as the row is in
      // the transcript, which for a cold chat is only after `select` has
      // loaded the messages.
      setPendingJumpMessage(r.hit.message_id);
      await select(r.hit.session_id);
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
    await expandAndPrimeSnippet(r.snippet);
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

  // Driven by `terms`, not the raw query: "in:messages" on its own is a scope
  // with nothing to match yet, so what's below it is still suggestions.
  const headerLabel = terms ? "Results" : "Suggestions";

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
        ref={panelRef}
        // The overlay behaves as a modal — it covers the app and swallows
        // outside clicks — so it has to say so. Without `role="dialog"` /
        // `aria-modal` a screen reader announced nothing on open and kept
        // reading the chat underneath as if it were still live.
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onKeyDown={onPanelKeyDown}
        className="fixed left-1/2 top-[12%] z-[56] w-full max-w-xl -translate-x-1/2 px-4"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="overflow-hidden rounded-2xl border border-foreground/10 bg-popover/95 shadow-2xl backdrop-blur-2xl">
          {/* Input row */}
          <div className="flex items-center gap-3 border-b border-foreground/[0.06] px-4 py-3">
            <Search className="h-4 w-4 shrink-0 text-foreground/45" aria-hidden />
            {/* Input + the underlay that boxes its `in:` token.

                A substring of an <input> can't be styled, so the underlay is
                a character-for-character copy of the query rendered in
                transparent text directly behind it: only the box around the
                token is visible, and the input's own glyphs land on top of it.
                Both are unpadded and share `text-sm`, so the copy lines up.

                `outline` rather than `border` because outlines take no part in
                layout — a border would push every character after the token
                2px right in the copy but not in the input, and the box would
                sit off the word it's meant to mark. */}
            <div className="relative min-w-0 flex-1">
              {token && (
                <div
                  ref={mirrorRef}
                  aria-hidden
                  className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre text-sm text-transparent"
                >
                  {query.slice(0, token.start)}
                  <span className="rounded-[3px] bg-primary/15 outline outline-1 outline-offset-1 outline-primary/50">
                    {query.slice(token.start, token.end)}
                  </span>
                  {query.slice(token.end)}
                </div>
              )}
              <input
                ref={inputRef}
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                // Keep the underlay pinned to the input once the query is long
                // enough to scroll, or the box drifts off its word.
                onScroll={(e) => {
                  if (mirrorRef.current)
                    mirrorRef.current.scrollLeft = e.currentTarget.scrollLeft;
                }}
                placeholder="Search chats, messages, spaces, snippets…"
                spellCheck={false}
                // Combobox-over-listbox: ↑/↓ already moved a visual highlight
                // that existed only as a background colour. `aria-activedescendant`
                // is what turns that into something announceable, and keeps
                // real focus in the input so typing never breaks.
                aria-label="Search chats, messages, spaces, snippets"
                role="combobox"
                aria-expanded={results.length > 0}
                aria-controls="search-results"
                aria-autocomplete="list"
                aria-activedescendant={
                  results.length > 0 ? `search-option-${activeIndex}` : undefined
                }
                // `block` matters: an inline-block input leaves the wrapper a
                // line box ~4px taller than the field, and the underlay —
                // which is `inset-0` on that wrapper — would draw its box
                // that much above the text it's marking.
                className="relative block w-full bg-transparent text-sm text-foreground placeholder:text-foreground/40 focus:outline-none"
              />
            </div>

            {/* Scope picker. Selecting a scope rewrites the query's `in:`
                token, so this menu and the text box are two views of one
                value — there's no second piece of state to drift. */}
            <DropdownMenu open={scopeMenuOpen} onOpenChange={setScopeMenuOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Search scope: ${scope}`}
                  className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-foreground/10 bg-foreground/[0.05] pl-2 pr-1 text-[11px] capitalize text-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground"
                >
                  {scope}
                  <ChevronDown className="h-3 w-3 opacity-70" aria-hidden />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                // Above the palette card (z-56), which the menu portals out of.
                className="z-[60] min-w-[9rem]"
                // Radix returns focus to the trigger on close; the palette is
                // only usable with focus in the input, where every key it
                // handles is bound.
                onCloseAutoFocus={(e) => {
                  e.preventDefault();
                  inputRef.current?.focus();
                }}
              >
                {SCOPES.map((s) => (
                  <DropdownMenuItem
                    key={s}
                    onSelect={() => applyScope(s)}
                    className="justify-between gap-4 capitalize"
                  >
                    {s}
                    {s === scope && (
                      <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

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
              {!query.trim()
                ? "Nothing yet — start a chat, create a space, or save a snippet."
                : searching
                  ? "Searching…"
                  : !terms
                    ? // A bare `in:` token — a scope with nothing to look for
                      // yet. Only reachable when scoped, since an unscoped
                      // query with no terms is caught by the first branch.
                      `Type to search ${scope}.`
                    : scope === "everywhere"
                      ? `No matches for "${terms}"`
                      : `No ${scope} matching "${terms}"`}
            </div>
          ) : (
            // Rows were <button>s, which put every result in the tab order:
            // Tab moved focus off the input onto a result, and since Escape
            // was bound to the input the palette then had no keyboard exit.
            // As listbox options they're driven by `aria-activedescendant`
            // instead — same click behaviour, no stolen tab stops.
            <ul
              id="search-results"
              role="listbox"
              aria-label="Search results"
              className="max-h-[60vh] overflow-y-auto py-1"
            >
              {results.map((r, i) => (
                <li
                  key={`${r.kind}-${r.id}`}
                  id={`search-option-${i}`}
                  role="option"
                  aria-selected={i === activeIndex}
                  onMouseEnter={() => setActiveIndex(i)}
                  // preventDefault on mousedown so the input doesn't blur
                  // before our click handler runs.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void commit(r)}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2.5 px-4 py-2 text-left text-sm transition-colors",
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
  if (kind === "message") return <Quote className={cls} />;
  return <SquareTerminal className={cls} />;
}

export const __testing = { parseQuery };
