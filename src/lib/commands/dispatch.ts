import { useChatStore } from "@/stores/chatStore";
import { useGlobalMemoryStore } from "@/stores/globalMemoryStore";
import { connectionLabel, useMcpStore } from "@/stores/mcpStore";
import { useModelsStore } from "@/stores/modelsStore";
import { usePrivateChatStore } from "@/stores/privateChatStore";
import { useSecurityStore } from "@/stores/securityStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSnippetStore } from "@/stores/snippetStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useUIStore, type SettingsTab } from "@/stores/uiStore";
import { CHAT_LABELS } from "@/lib/labels";
import { DEFAULT_PERSONA_ID, PERSONAS, getPersona } from "@/lib/personas";
import { DEFAULT_TONE_ID, TONES, getTone } from "@/lib/tones";
import { expandAndPrimeSnippet } from "@/lib/runSnippet";
import {
  extractSummary,
  stripSummaryBlock,
  SUMMARY_END_TAG,
  SUMMARY_START_TAG,
} from "@/lib/contextUsage";
import type { MemoryScope } from "@/lib/memory";
import {
  clearSessionMessages,
  fetchUrl,
  mcpTools,
  ollamaUnloadModel,
} from "@/lib/tauri";
import type {
  GenerationParams,
  MemoryRow,
  Message,
  MessageMetrics,
  Session,
} from "@/types";
import { findCommand, parseInput } from "./parser";
import type { CommandResult, CommandResultItem } from "./types";

/** Result of attempting to dispatch a slash command.
 *
 *  `kind: "passthrough"` means the text was not a registered command — the
 *  composer should send it as a regular chat message (per the "ignore
 *  unknown" rule). Every other variant carries a `CommandResult` for the UI
 *  to surface (toast / list panel / error pill). */
export type DispatchOutcome =
  | { kind: "handled"; result: CommandResult }
  | { kind: "passthrough" };

/** Capabilities the dispatcher needs from the React layer. Injected by the
 *  composer so destructive handlers can route through the app's confirm
 *  dialog without the commands layer importing component code. */
export interface CommandDeps {
  /** Async confirm — mirrors `useConfirm().confirm`. Resolves true on
   *  approval, false on cancel / Escape / backdrop. */
  confirm: (req: {
    title: string;
    body?: string;
    confirmLabel?: string;
    destructive?: boolean;
  }) => Promise<boolean>;
}

/** Entry point. Returns synchronously-resolved promises so the composer
 *  can `await dispatch(text)` once and branch on the outcome. */
export async function dispatch(
  text: string,
  deps: CommandDeps,
): Promise<DispatchOutcome> {
  const parsed = parseInput(text);
  if (!parsed || parsed.name.length === 0) return { kind: "passthrough" };
  const cmd = findCommand(parsed.name);
  if (!cmd) return { kind: "passthrough" };

  try {
    const result = await run(parsed.name, parsed.rest, deps);
    return { kind: "handled", result };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      kind: "handled",
      result: { kind: "toast", tone: "error", title: "Command failed", body: message },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireSession(): Session {
  const state = useChatStore.getState();
  const id = state.activeSessionId;
  if (!id) throw new Error("No active chat. Start one with /new first.");
  const session = state.sessions.find((s) => s.id === id);
  if (!session) throw new Error("Active chat is missing — try /new.");
  return session;
}

/** Where `/remember`, `/forget` and `/list memories` operate: the active
 *  chat's Space (or the Space being viewed) when there is one, otherwise the
 *  global list. */
function memoryScope(): MemoryScope {
  const session = useChatStore.getState().sessions.find(
    (s) => s.id === useChatStore.getState().activeSessionId,
  );
  if (session?.space_id) return { kind: "space", spaceId: session.space_id };
  const sid = useSpaceStore.getState().activeSpaceId;
  if (sid) return { kind: "space", spaceId: sid };
  return { kind: "global" };
}

async function scopedMemories(scope: MemoryScope): Promise<MemoryRow[]> {
  if (scope.kind === "global") {
    return useGlobalMemoryStore.getState().ensureLoaded();
  }
  return (
    useSpaceStore.getState().spaceMemories[scope.spaceId] ??
    (await useSpaceStore.getState().loadSpaceMemories(scope.spaceId))
  );
}

function removeScopedMemory(scope: MemoryScope, id: string): Promise<boolean> {
  if (scope.kind === "global") {
    return useGlobalMemoryStore.getState().removeMemory(id);
  }
  return useSpaceStore.getState().removeMemory(id, scope.spaceId);
}

function readCurrentParams(session: Session): Partial<GenerationParams> {
  if (!session.params_json) return {};
  try {
    const v = JSON.parse(session.params_json);
    return v && typeof v === "object" ? (v as Partial<GenerationParams>) : {};
  } catch {
    return {};
  }
}

async function patchParams(patch: Partial<GenerationParams>): Promise<void> {
  const session = requireSession();
  const merged = { ...readCurrentParams(session), ...patch };
  await useChatStore.getState().setSessionParams(session.id, merged as GenerationParams);
}

function ok(title: string, body?: string): CommandResult {
  return { kind: "toast", title, body };
}

function listItems(title: string, items: CommandResultItem[]): CommandResult {
  return { kind: "list", title, items };
}

// ---------------------------------------------------------------------------
// Per-command handlers
// ---------------------------------------------------------------------------

async function run(
  name: string,
  rest: string,
  deps: CommandDeps,
): Promise<CommandResult> {
  switch (name) {
    case "new":
      return runNew();
    case "clear":
      return runClear(deps);
    case "rename":
      return runRename(rest);
    case "pin":
      return runPin();
    case "archive":
      return runArchive();
    case "delete":
      return runDelete(deps);
    case "fork":
      return runFork();
    case "export":
      return runExport();
    case "model":
      return runModel(rest);
    case "persona":
      return runPersona(rest);
    case "list":
      return runList(rest);
    case "instructions":
      return runInstructions(rest);
    case "snippet":
      return runSnippet(rest);
    case "remember":
      return runRemember(rest);
    case "forget":
      return runForget(rest);
    case "space":
      return runSpace(rest);
    case "tools":
      return runTools();
    case "web-fetch":
      return runWebFetch(rest);
    case "fetch":
      return runFetch(rest);
    case "thinking":
      return runThinking(rest);
    case "help":
      return runHelp();
    case "copy":
      return runCopy(rest);
    case "settings":
      return runSettings(rest);
    case "regenerate":
      return runRegenerate();
    case "stats":
      return runStats();
    case "private":
      return runPrivate();
    case "compact":
      return runCompact();
    case "stop":
      return runStop();
    case "find":
      return runFind(rest);
    case "import":
      return runImport();
    case "label":
      return runLabel(rest);
    case "folder":
      return runFolder(rest);
    case "tone":
      return runTone(rest);
    case "set":
      return runSet(rest);
    case "unload":
      return runUnload();
    case "theme":
      return runTheme(rest);
    case "lock":
      return runLock();
    default:
      // Defensive — `dispatch` already filtered unknown commands. Treat as a
      // toast error so the bug surfaces if a new entry in `COMMANDS` is
      // missed here.
      throw new Error(`Unimplemented command: /${name}`);
  }
}

async function runNew(): Promise<CommandResult> {
  const session = await useChatStore.getState().newSession();
  return ok("New chat", session.title || "Untitled");
}

async function runClear(deps: CommandDeps): Promise<CommandResult> {
  const session = requireSession();
  const messages = useChatStore.getState().messages[session.id] ?? [];
  if (messages.length === 0) return ok("Chat is already empty");
  const approved = await deps.confirm({
    title: "Clear this chat?",
    body: `All ${messages.length} message${messages.length === 1 ? "" : "s"} in “${session.title || "Untitled"}” will be removed permanently.`,
    confirmLabel: "Clear chat",
    destructive: true,
  });
  if (!approved) return { kind: "noop" };
  // Stop any stream running in THIS chat before the rows go. Without it the
  // generation kept going headless: its target row no longer existed, so
  // tokens rendered nowhere, the final `updateMessage` updated zero rows, and
  // the composer stayed stuck on "Replying…" over an empty transcript until
  // the model finished on its own. `/regenerate` and `/compact` both guard on
  // busy; this one didn't.
  await useChatStore.getState().cancelForSession(session.id);
  await clearSessionMessages(session.id);
  useChatStore.setState((s) => ({
    messages: { ...s.messages, [session.id]: [] },
    streamingByMessage: Object.fromEntries(
      Object.entries(s.streamingByMessage).filter(
        ([id]) => !messages.some((m) => m.id === id),
      ),
    ),
  }));
  return ok("Cleared chat", `${messages.length} message${messages.length === 1 ? "" : "s"} removed`);
}

async function runRename(rest: string): Promise<CommandResult> {
  const session = requireSession();
  const title = rest.trim();
  if (!title) throw new Error("Usage: /rename <title>");
  await useChatStore.getState().rename(session.id, title);
  return ok("Renamed chat", title);
}

async function runPin(): Promise<CommandResult> {
  const session = requireSession();
  const next = !session.pinned_at;
  await useChatStore.getState().pin(session.id, next);
  return ok(next ? "Pinned chat" : "Unpinned chat");
}

async function runArchive(): Promise<CommandResult> {
  const session = requireSession();
  await useChatStore.getState().archive(session.id, true);
  // No toast of our own: `chatStore.archive` now pushes the richer
  // "Moved to archive — Undo" chip for every archive path, and a second
  // confirmation here would stack a duplicate.
  return { kind: "noop" };
}

async function runDelete(deps: CommandDeps): Promise<CommandResult> {
  const session = requireSession();
  const approved = await deps.confirm({
    title: "Delete this chat?",
    body: `“${session.title || "Untitled"}” will be removed permanently — all messages and metrics will be gone.`,
    confirmLabel: "Delete chat",
    destructive: true,
  });
  if (!approved) return { kind: "noop" };
  await useChatStore.getState().remove(session.id);
  return ok("Deleted chat", session.title);
}

async function runFork(): Promise<CommandResult> {
  const session = requireSession();
  const forked = await useChatStore.getState().fork(session.id);
  return ok("Forked chat", forked.title || "Untitled");
}

async function runExport(): Promise<CommandResult> {
  // Reuses the ChatHeader's "Export context" dialog (full / compacted views,
  // copy to clipboard) rather than duplicating that surface here. The header
  // owns the dialog's data-loading, so we flip a one-shot flag it consumes —
  // same pattern as the onboarding model-picker auto-open.
  requireSession();
  useUIStore.getState().setPendingOpenExport(true);
  return { kind: "noop" };
}

async function runModel(rest: string): Promise<CommandResult> {
  const query = rest.trim();
  const session = requireSession();
  if (!query) {
    // Bare `/model` opens the header's model picker — the same one-shot
    // hand-off `/export` uses, since the picker's state lives there.
    useUIStore.getState().setPendingOpenModelPicker(true);
    return { kind: "noop" };
  }
  const models = useModelsStore.getState().models;
  const lower = query.toLowerCase();
  const exact = models.find(
    (m) => m.id.toLowerCase() === lower || m.label.toLowerCase() === lower,
  );
  const matches = exact
    ? [exact]
    : models.filter(
        (m) =>
          m.id.toLowerCase().includes(lower) ||
          m.label.toLowerCase().includes(lower),
      );
  if (matches.length === 0) {
    throw new Error(`No model matches "${query}". Try /list models.`);
  }
  if (matches.length > 1) {
    return listItems(
      `Multiple models match "${query}"`,
      matches.map((m) => ({ label: m.id, detail: m.provider, hint: m.label !== m.id ? m.label : undefined })),
    );
  }
  const picked = matches[0]!;
  const provider = picked.provider === "openai" ? "openai" : "ollama";
  await useChatStore.getState().setSessionModel(session.id, provider, picked.id);
  return ok("Switched model", `${picked.id} (${provider})`);
}

async function runPersona(rest: string): Promise<CommandResult> {
  const query = rest.trim();
  const session = requireSession();
  if (!query) {
    // Bare `/persona` reports the current one, like bare `/instructions`.
    const current = getPersona(useUIStore.getState().personaIdBySession[session.id]);
    if (!current || current.id === DEFAULT_PERSONA_ID) {
      return ok("No persona set", "Apply one with /persona <name>.");
    }
    return ok("Current persona", current.label);
  }
  const lower = query.toLowerCase();
  const exact = PERSONAS.find(
    (p) => p.id.toLowerCase() === lower || p.label.toLowerCase() === lower,
  );
  const matches = exact
    ? [exact]
    : PERSONAS.filter(
        (p) =>
          p.id.toLowerCase().includes(lower) ||
          p.label.toLowerCase().includes(lower),
      );
  if (matches.length === 0) {
    throw new Error(`No persona matches "${query}". Try /list personas.`);
  }
  if (matches.length > 1) {
    return listItems(
      `Multiple personas match "${query}"`,
      matches.map((p) => ({ label: p.label, detail: p.id, hint: p.description })),
    );
  }
  const persona = matches[0]!;
  useUIStore.getState().setSessionPersona(session.id, persona.id);
  return ok(
    persona.id === DEFAULT_PERSONA_ID ? "Cleared persona" : "Applied persona",
    persona.label,
  );
}

async function runList(rest: string): Promise<CommandResult> {
  const target = rest.trim().toLowerCase();
  if (!target) throw new Error("Usage: /list <models|personas|spaces|snippets|mcp|providers|memories>");
  switch (target) {
    case "models": {
      const models = useModelsStore.getState().models;
      if (models.length === 0) {
        return ok("No models found", "Make sure Ollama is running or add an OpenAI-compatible endpoint.");
      }
      return listItems(
        "Models",
        models.map((m) => ({
          label: m.id,
          detail: m.provider,
          hint: m.label !== m.id ? m.label : undefined,
        })),
      );
    }
    case "personas":
      return listItems(
        "Personas",
        PERSONAS.map((p) => ({ label: p.label, detail: p.id, hint: p.description })),
      );
    case "spaces": {
      const { spaces, activeSpaceId: activeId } = useSpaceStore.getState();
      if (spaces.length === 0) return ok("No spaces yet");
      return listItems(
        "Spaces",
        spaces.map((s) => ({
          label: s.name,
          detail: s.id === activeId ? "active" : undefined,
          hint: s.description || undefined,
        })),
      );
    }
    case "snippets": {
      const snippets = useSnippetStore.getState().snippets;
      if (snippets.length === 0) return ok("No snippets yet");
      return listItems(
        "Snippets",
        snippets.map((s) => ({
          label: s.title,
          detail: s.model ?? undefined,
          hint: s.prompt.length > 80 ? s.prompt.slice(0, 80) + "…" : s.prompt,
        })),
      );
    }
    case "mcp": {
      const servers = useMcpStore.getState().servers;
      if (servers.length === 0) return ok("No MCP servers configured");
      return listItems(
        "MCP servers",
        servers.map((s) => ({
          label: s.name,
          detail: s.enabled ? "enabled" : "disabled",
          hint: connectionLabel(s),
        })),
      );
    }
    case "providers": {
      const s = useSettingsStore.getState();
      return listItems("Providers", [
        { label: "ollama", hint: s.ollama_base_url },
        {
          label: "openai",
          detail: s.openai_key_set ? "key set" : undefined,
          hint: s.openai_base_url,
        },
      ]);
    }
    case "memories": {
      const scope = memoryScope();
      const memories = await scopedMemories(scope);
      if (memories.length === 0) {
        return ok(scope.kind === "global" ? "No global memories" : "No memories in this space");
      }
      return listItems(
        scope.kind === "global" ? "Global memories" : "Memories",
        memories.map((m) => ({
          label: m.content,
          detail: m.id.slice(0, 8),
        })),
      );
    }
    default:
      throw new Error(`Unknown list target "${target}".`);
  }
}

async function runInstructions(rest: string): Promise<CommandResult> {
  const session = requireSession();
  const value = rest.trim();
  // Bare `/instructions` SHOWS the current instructions rather than wiping
  // them — typing it to recall what's set used to silently clear. Strip any
  // auto-summary block so the user sees only their own text. Clearing now
  // requires the explicit `/instructions clear`.
  if (value.length === 0) {
    const current = stripSummaryBlock(session.system_prompt ?? null).trim();
    if (!current) {
      return ok("No instructions set", "Add some with /instructions <text>.");
    }
    return listItems("Chat instructions", [{ label: current }]);
  }
  // Setting and clearing replace only that own text. A compaction summary
  // parked in the same field stands in for the turns `chatHistory` no longer
  // sends, so dropping it would leave the model with neither.
  const summary = extractSummary(session.system_prompt ?? null);
  const withSummary = (own: string) =>
    summary ? `${SUMMARY_START_TAG}\n${summary}\n${SUMMARY_END_TAG}\n\n${own}` : own;
  if (value.toLowerCase() === "clear") {
    await useChatStore.getState().setSessionSystemPrompt(session.id, withSummary(""));
    return ok("Cleared instructions");
  }
  // We deliberately keep the user's raw text (including newlines after the
  // first space) — that's why `rest` was preserved verbatim in the parser.
  await useChatStore.getState().setSessionSystemPrompt(session.id, withSummary(value));
  return ok("Saved instructions", value.length > 80 ? value.slice(0, 80) + "…" : value);
}

async function runSnippet(rest: string): Promise<CommandResult> {
  const query = rest.trim();
  if (!query) throw new Error("Usage: /snippet <name>");
  const snippets = useSnippetStore.getState().snippets;
  const lower = query.toLowerCase();
  const exact = snippets.find((s) => s.title.toLowerCase() === lower);
  const matches = exact
    ? [exact]
    : snippets.filter((s) => s.title.toLowerCase().includes(lower));
  if (matches.length === 0) {
    throw new Error(`No snippet matches "${query}". Try /list snippets.`);
  }
  if (matches.length > 1) {
    return listItems(
      `Multiple snippets match "${query}"`,
      matches.map((s) => ({ label: s.title, detail: s.model ?? undefined })),
    );
  }
  const match = matches[0]!;
  // Fire-and-forget: when the snippet has prompt-on-use placeholders the
  // helper opens a modal and resolves later, after the user fills it in.
  // The slash-command toast lands immediately either way — the dialog is
  // its own surface and doesn't need to gate the result here.
  void expandAndPrimeSnippet(match);
  return ok("Loaded snippet", match.title);
}

async function runRemember(rest: string): Promise<CommandResult> {
  const fact = rest.trim();
  if (!fact) throw new Error("Usage: /remember <fact>");
  const scope = memoryScope();
  const session = useChatStore.getState().sessions.find(
    (s) => s.id === useChatStore.getState().activeSessionId,
  );
  const preview = fact.length > 80 ? fact.slice(0, 80) + "…" : fact;
  if (scope.kind === "global") {
    if (!useSettingsStore.getState().global_memory_enabled) {
      throw new Error(
        "Global memory is off. Turn it on in Settings → Features, or open a chat in a space.",
      );
    }
    await useGlobalMemoryStore.getState().addMemory({
      content: fact,
      source_session_id: session?.id ?? null,
    });
    return ok("Saved to global memory", preview);
  }
  const space = useSpaceStore.getState().spaces.find((s) => s.id === scope.spaceId);
  if (space && !space.memory_enabled) {
    throw new Error(
      `Memory is off for “${space.name}”. Turn it on in the space's Memory tab.`,
    );
  }
  await useSpaceStore.getState().addMemory({
    space_id: scope.spaceId,
    content: fact,
    source_session_id: session?.id ?? null,
  });
  return ok("Saved to memory", preview);
}

async function runForget(rest: string): Promise<CommandResult> {
  const query = rest.trim();
  if (!query) throw new Error("Usage: /forget <id|query>");
  const scope = memoryScope();
  const memories = await scopedMemories(scope);
  // First try a full or prefix id match (memories surface their short id in
  // /list memories, so the user might paste either form). Only treat the
  // query as an id prefix when it's specific enough — /list memories shows
  // 8-char ids, so anything shorter is almost certainly a content search.
  // A loose 1-char prefix silently deleting the first UUID that happens to
  // start with it is a footgun; require a unique >=8-char prefix match.
  const exactId = memories.find((m) => m.id === query);
  const prefixMatches =
    query.length >= 8 ? memories.filter((m) => m.id.startsWith(query)) : [];
  const byId =
    exactId ?? (prefixMatches.length === 1 ? prefixMatches[0] : undefined);
  if (byId) {
    await removeScopedMemory(scope, byId.id);
    return ok("Removed memory", byId.content.length > 60 ? byId.content.slice(0, 60) + "…" : byId.content);
  }
  const lower = query.toLowerCase();
  const byContent = memories.filter((m) => m.content.toLowerCase().includes(lower));
  if (byContent.length === 0) {
    throw new Error(`No memory matches "${query}".`);
  }
  if (byContent.length > 1) {
    return listItems(
      `Multiple memories match "${query}" — re-run with an id`,
      byContent.map((m) => ({ label: m.content, detail: m.id.slice(0, 8) })),
    );
  }
  const m = byContent[0]!;
  await removeScopedMemory(scope, m.id);
  return ok("Removed memory", m.content.length > 60 ? m.content.slice(0, 60) + "…" : m.content);
}

async function runSpace(rest: string): Promise<CommandResult> {
  const query = rest.trim();
  if (!query) throw new Error("Usage: /space <name>");
  const spaces = useSpaceStore.getState().spaces;
  const lower = query.toLowerCase();
  const exact = spaces.find((s) => s.name.toLowerCase() === lower);
  const matches = exact
    ? [exact]
    : spaces.filter((s) => s.name.toLowerCase().includes(lower));
  if (matches.length === 0) {
    throw new Error(`No space matches "${query}". Try /list spaces.`);
  }
  if (matches.length > 1) {
    return listItems(
      `Multiple spaces match "${query}"`,
      matches.map((s) => ({ label: s.name, hint: s.description || undefined })),
    );
  }
  const match = matches[0]!;
  useSpaceStore.getState().selectSpace(match.id);
  return ok("Active space", match.name);
}

async function runTools(): Promise<CommandResult> {
  const servers = useMcpStore.getState().servers.filter((s) => s.enabled);
  if (servers.length === 0) return ok("No enabled MCP servers", "Configure one in Settings → MCP.");
  // The catalogue a chat turn would get, from the servers already running —
  // probing each with `mcp_test` started a second copy of every stdio
  // server and asked for consent all over again.
  const { tools, errors } = await mcpTools();
  const items: CommandResultItem[] = [];
  for (const server of servers) {
    const error = errors.find(([name]) => name === server.name)?.[1];
    if (error) {
      items.push({ label: server.name, detail: "error", hint: error });
      continue;
    }
    const own = tools.filter((t) => t.server_id === server.id);
    if (own.length === 0) {
      items.push({ label: server.name, detail: "0 tools" });
      continue;
    }
    for (const t of own) {
      items.push({
        label: t.name,
        detail: server.name,
        hint: t.description ?? undefined,
      });
    }
  }
  if (items.length === 0) return ok("No tools exposed");
  return listItems("Available tools", items);
}

async function runWebFetch(rest: string): Promise<CommandResult> {
  const flag = rest.trim().toLowerCase();
  if (flag !== "on" && flag !== "off") throw new Error("Usage: /web-fetch on|off");
  await useSettingsStore.getState().update("web_fetch_enabled", flag === "on");
  return ok("Web fetch", flag === "on" ? "Enabled" : "Disabled");
}

async function runFetch(rest: string): Promise<CommandResult> {
  const url = rest.trim();
  if (!url) throw new Error("Usage: /fetch <url>");
  const page = await fetchUrl(url);
  const preview = page.text.length > 200 ? page.text.slice(0, 200) + "…" : page.text;
  return listItems(`Fetched ${page.final_url}`, [
    { label: page.title || "(no title)" },
    { label: `${page.bytes} bytes${page.truncated ? " (truncated)" : ""}`, detail: page.content_type },
    { label: preview || "(empty body)" },
  ]);
}

async function runThinking(rest: string): Promise<CommandResult> {
  const flag = rest.trim().toLowerCase();
  if (flag !== "on" && flag !== "off") throw new Error("Usage: /thinking on|off");
  await patchParams({ think: flag === "on" });
  return ok("Thinking", flag === "on" ? "Enabled" : "Disabled");
}

async function runHelp(): Promise<CommandResult> {
  // Pure UI surface — the dialog lives in App.tsx and reads `helpOpen` /
  // the registry directly. The dispatcher just flips the flag and returns
  // a noop result so the composer doesn't drop a toast on top of the
  // dialog the user just opened.
  useUIStore.getState().setHelpOpen(true);
  return { kind: "noop" };
}

async function runCopy(rest: string): Promise<CommandResult> {
  const session = requireSession();
  const arg = rest.trim();
  // Default to the last assistant reply; `/copy 2` walks back N. We do NOT
  // count user turns — the command is about copying *assistant* output, so
  // `N` indexes into the filtered list (1 = latest reply, 2 = the one
  // before that, etc.).
  // Validate BEFORE clamping. The old `Math.max(1, Math.floor(Number(arg)))`
  // silently turned `/copy 0` and `/copy -5` into `1` (copying the latest
  // reply) instead of rejecting them, because the clamp ran before the
  // finite check. Parse, then require a positive whole number.
  let n: number;
  if (arg.length === 0) {
    n = 1;
  } else {
    // Require a plain decimal. `Number("0x10")`/`"1e2"`/`"0b11"` all pass
    // `Number.isInteger`, so without the shape check `/copy 0x10` would be
    // silently read as "16 replies back".
    const parsed = Number(arg);
    if (!/^\d+$/.test(arg) || parsed < 1) {
      throw new Error("Usage: /copy [N] — N must be a positive whole number.");
    }
    n = parsed;
  }
  const messages = useChatStore.getState().messages[session.id] ?? [];
  const assistantReplies = messages.filter((m) => m.role === "assistant");
  if (assistantReplies.length < n) {
    throw new Error(
      assistantReplies.length === 0
        ? "Nothing to copy yet — wait for a reply first."
        : `This chat only has ${assistantReplies.length} reply${assistantReplies.length === 1 ? "" : "s"}.`,
    );
  }
  const target = assistantReplies[assistantReplies.length - n]!;
  if (!target.content.trim()) {
    throw new Error("That reply is empty.");
  }
  try {
    await navigator.clipboard.writeText(target.content);
  } catch {
    throw new Error("Clipboard access was blocked.");
  }
  const preview = target.content.length > 80 ? target.content.slice(0, 80) + "…" : target.content;
  return ok(
    n === 1 ? "Copied last reply" : `Copied reply ${n} back`,
    preview,
  );
}

// Settings tabs the dialog can land on. Mirrors `SettingsTab` in uiStore —
// we re-state the list here so a typo in the user's `/settings` arg falls
// back to "general" instead of routing to an undefined tab.
const SETTINGS_TABS: readonly SettingsTab[] = [
  "general",
  "providers",
  "features",
  "tools",
  "appearance",
  "mcp",
  "archive",
  "data",
  "security",
  "updates",
  "about",
];

async function runSettings(rest: string): Promise<CommandResult> {
  const arg = rest.trim().toLowerCase();
  if (arg.length === 0) {
    useUIStore.getState().setSettingsOpen(true);
    return { kind: "noop" };
  }
  const tab = SETTINGS_TABS.find((t) => t === arg);
  if (!tab) {
    throw new Error(`Unknown settings tab "${arg}". Try: ${SETTINGS_TABS.join(", ")}.`);
  }
  useUIStore.getState().openSettingsTab(tab);
  return { kind: "noop" };
}

async function runRegenerate(): Promise<CommandResult> {
  const session = requireSession();
  // Surface the preconditions `regenerateLast` checks SILENTLY (it just
  // returns on a bad call) so the user gets feedback instead of a dead
  // command. Mirror its guards: last turn must be an assistant reply, a
  // model must be set, and the chat mustn't be busy.
  const messages = useChatStore.getState().messages[session.id] ?? [];
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") {
    throw new Error("Nothing to regenerate — the last turn isn't an assistant reply.");
  }
  if (last.import_group != null) {
    throw new Error("Can't regenerate an imported reply.");
  }
  // Previously missing: a model-less chat made `regenerateLast` bail silently
  // while this handler still reported a success toast — a false "Regenerating
  // reply". Check it here so the user gets the real reason.
  if (!session.model) {
    throw new Error("Pick a model first.");
  }
  const state = useChatStore.getState();
  if (
    state.runningTask?.sessionId === session.id ||
    state.queue.some((t) => t.sessionId === session.id)
  ) {
    throw new Error("This chat is busy — wait for the current reply to finish.");
  }
  // No premature success toast: `regenerateLast` owns failure feedback (it
  // toasts "Couldn't regenerate" if the delete fails), and on success the
  // fresh reply streams in visibly. A success toast here could stack on top
  // of the store's error toast for the same action.
  await useChatStore.getState().regenerateLast(session.id);
  return { kind: "noop" };
}

async function runStats(): Promise<CommandResult> {
  const session = requireSession();
  const messages = useChatStore.getState().messages[session.id] ?? [];
  const userCount = messages.filter((m) => m.role === "user").length;
  const assistantCount = messages.filter((m) => m.role === "assistant").length;

  let totalTokens = 0;
  let totalElapsed = 0;
  let metricsCount = 0;
  for (const m of messages) {
    const metrics = readMetrics(m);
    if (!metrics) continue;
    totalTokens += metrics.tokens;
    totalElapsed += metrics.elapsed_ms;
    metricsCount += 1;
  }
  const avgTps =
    totalElapsed > 0 ? (totalTokens / (totalElapsed / 1000)) : 0;

  // Last assistant reply with metrics — usually the most recent turn.
  const last = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && readMetrics(m) !== null);
  const lastMetrics = last ? readMetrics(last) : null;

  const items: CommandResultItem[] = [
    { label: "Messages", detail: `${messages.length} (${userCount} user / ${assistantCount} assistant)` },
    {
      label: "Tokens (assistant)",
      detail: metricsCount > 0 ? `${totalTokens} across ${metricsCount} replies` : "—",
    },
    {
      label: "Avg tokens/sec",
      detail: metricsCount > 0 ? avgTps.toFixed(1) : "—",
    },
  ];
  if (lastMetrics) {
    items.push({
      label: "Last reply",
      detail: `${lastMetrics.tokens} tok · ${lastMetrics.tokens_per_second.toFixed(1)} tok/s · ${formatMs(lastMetrics.elapsed_ms)}`,
    });
  }
  items.push({
    label: "Model",
    detail: `${session.model || "—"} (${session.provider})`,
  });

  return listItems("Chat stats", items);
}

function readMetrics(m: Message): MessageMetrics | null {
  if (!m.metrics_json) return null;
  try {
    const parsed = JSON.parse(m.metrics_json) as MessageMetrics;
    if (
      typeof parsed.tokens === "number" &&
      typeof parsed.elapsed_ms === "number" &&
      typeof parsed.tokens_per_second === "number"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return `${m}m ${rest}s`;
}

async function runPrivate(): Promise<CommandResult> {
  // Same orchestration the TitleBar trigger performs: per the "pause regular
  // while private" decision, stop whichever regular chat is streaming before
  // handing the screen over. `privateChatStore` is deliberately agnostic of
  // `chatStore`, so every entry point owns this — and this one used to skip
  // it, leaving the regular stream writing into the SQLite transcript behind
  // the overlay while both generations competed for the same model slot.
  const chat = useChatStore.getState();
  if (chat.streamingSessionId) {
    void chat.cancelForSession(chat.streamingSessionId);
  }
  usePrivateChatStore.getState().setOpen(true);
  return { kind: "noop" };
}

async function runCompact(): Promise<CommandResult> {
  const session = requireSession();
  // Only surface the one guard `compactContext` checks SILENTLY (a
  // concurrent compaction of another chat). Its other gates — busy,
  // model-missing, too-few-messages — already toast their own feedback, and
  // its count gate (non-system, non-compacted ≥ COMPACT_MIN_TOTAL) is the
  // authoritative one. The old coarser `messages.length < 6` check here
  // could pass while the store's gate failed, producing a success toast
  // immediately followed by the store's contradictory "Not enough to
  // compact".
  if (useChatStore.getState().compactingSessionId) {
    throw new Error("Another chat is already being compacted. Try again in a moment.");
  }
  // Fire-and-forget so the composer doesn't freeze for the summariser
  // round-trip. The store flips `compactingSessionId` (context-bar spinner)
  // and owns ALL outcome feedback, so we return noop rather than a premature
  // success toast that could contradict the store's result.
  void useChatStore.getState().compactContext(session.id);
  return { kind: "noop" };
}

async function runStop(): Promise<CommandResult> {
  const session = requireSession();
  // Same scope as the composer's Stop button: this chat only. A prompt still
  // waiting in the queue counts too — `cancelForSession` evicts it.
  const state = useChatStore.getState();
  const running = state.runningTask?.sessionId === session.id;
  if (!running && !state.queue.some((t) => t.sessionId === session.id)) {
    return ok("Nothing to stop");
  }
  await state.cancelForSession(session.id);
  return ok(running ? "Stopped reply" : "Removed queued prompt");
}

async function runFind(rest: string): Promise<CommandResult> {
  requireSession();
  // ChatCanvas owns the finder overlay; this is the event the header's
  // "Search in chat" item fires, plus the text to prefill.
  window.dispatchEvent(
    new CustomEvent("loach:open-chat-search", { detail: { query: rest.trim() } }),
  );
  return { kind: "noop" };
}

async function runImport(): Promise<CommandResult> {
  // Same one-shot hand-off as `/export`: the dialog's state lives in the
  // ChatHeader.
  requireSession();
  useUIStore.getState().setPendingOpenImport(true);
  return { kind: "noop" };
}

async function runLabel(rest: string): Promise<CommandResult> {
  const session = requireSession();
  const arg = rest.trim().toLowerCase();
  if (arg === "clear") {
    await useChatStore.getState().setLabel(session.id, null);
    return ok("Cleared label");
  }
  const label = CHAT_LABELS.find((l) => l.id === arg);
  if (!label) {
    throw new Error(`Usage: /label <${CHAT_LABELS.map((l) => l.id).join("|")}|clear>`);
  }
  await useChatStore.getState().setLabel(session.id, label.id);
  return ok("Labelled chat", label.name);
}

async function runFolder(rest: string): Promise<CommandResult> {
  const session = requireSession();
  const name = rest.trim();
  if (!name) throw new Error("Usage: /folder <name|none>");
  const chat = useChatStore.getState();
  if (name.toLowerCase() === "none") {
    if (!session.folder_id) return ok("Chat isn't in a folder");
    await chat.moveToFolder(session.id, null);
    return ok("Removed from folder");
  }
  // Exact (case-insensitive) name only — anything else creates a folder with
  // the typed name. Substring matching like `/space` would let a near-miss
  // file the chat into the wrong existing folder without saying so.
  const lower = name.toLowerCase();
  const existing = chat.folders.find((f) => f.name.toLowerCase() === lower);
  if (existing) {
    await chat.moveToFolder(session.id, existing.id);
    return ok("Moved to folder", existing.name);
  }
  const folder = await chat.createFolderWith(name, [session.id]);
  return ok("Created folder", folder.name);
}

async function runTone(rest: string): Promise<CommandResult> {
  const query = rest.trim();
  const session = requireSession();
  if (!query) {
    // Bare `/tone` reports the effective tone: this chat's own, else the
    // app-wide default — the order the composer's tone chip reads them in.
    const own = useUIStore.getState().toneIdBySession[session.id];
    const current = getTone(own ?? useSettingsStore.getState().default_tone_id);
    if (!current || current.id === DEFAULT_TONE_ID) {
      return ok("No tone set", "Apply one with /tone <name>.");
    }
    return ok("Current tone", own ? current.label : `${current.label} (app default)`);
  }
  const lower = query.toLowerCase();
  const exact = TONES.find(
    (t) => t.id.toLowerCase() === lower || t.label.toLowerCase() === lower,
  );
  const matches = exact
    ? [exact]
    : TONES.filter(
        (t) =>
          t.id.toLowerCase().includes(lower) ||
          t.label.toLowerCase().includes(lower),
      );
  if (matches.length === 0) {
    throw new Error(`No tone matches "${query}". Try one of: ${TONES.map((t) => t.id).join(", ")}.`);
  }
  if (matches.length > 1) {
    return listItems(
      `Multiple tones match "${query}"`,
      matches.map((t) => ({ label: t.label, detail: t.id, hint: t.shortDescription })),
    );
  }
  const tone = matches[0]!;
  useUIStore.getState().setSessionTone(session.id, tone.id);
  return ok(tone.id === DEFAULT_TONE_ID ? "Cleared tone" : "Applied tone", tone.label);
}

interface ParamRule {
  integer: boolean;
  min?: number;
  max?: number;
  /** The only values accepted, when the panel's control snaps to a list. */
  stops?: readonly number[];
}

// What `/set` accepts, matching the Parameter panel's controls so a value set
// here reads back the same there — its Temperature slider stops at 1, and its
// Context Length slider can only show the `CTX_STOPS` it snaps to. No `max`
// means the panel doesn't cap it either.
const PARAM_RULES: Partial<Record<keyof GenerationParams, ParamRule>> = {
  temperature: { integer: false, min: 0, max: 1 },
  top_p: { integer: false, min: 0, max: 1 },
  top_k: { integer: true, min: 0, max: 200 },
  min_p: { integer: false, min: 0, max: 0.5 },
  num_ctx: {
    integer: true,
    stops: [4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576],
  },
  max_tokens: { integer: true, min: 128, max: 32768 },
  repeat_penalty: { integer: false, min: 0.8, max: 2 },
  frequency_penalty: { integer: false, min: -2, max: 2 },
  presence_penalty: { integer: false, min: -2, max: 2 },
  num_gpu: { integer: true, min: 0 },
  seed: { integer: true },
};

async function runSet(rest: string): Promise<CommandResult> {
  const session = requireSession();
  const [rawKey = "", rawValue = "", ...extra] = rest.split(/\s+/).filter(Boolean);
  const key = rawKey.toLowerCase() as keyof GenerationParams;
  if (rawKey.toLowerCase() === "reset" && !rawValue) {
    // Same as the panel's Reset: drop the override so the chat follows the
    // Space / model / app defaults again.
    await useChatStore.getState().setSessionParams(session.id, null);
    return ok("Reset parameters", "Back to the defaults");
  }
  // `hasOwn`, not a bare lookup: `/set constructor 1` would otherwise find
  // Object.prototype's and write it into the chat's params.
  const rule = Object.hasOwn(PARAM_RULES, key) ? PARAM_RULES[key] : undefined;
  if (!rule) {
    throw new Error(
      `Usage: /set <param> <value> or /set reset. Params: ${Object.keys(PARAM_RULES).join(", ")}.`,
    );
  }
  // Plain decimals only, like `/copy`: `Number` alone would also accept
  // `0x10`, `1e2` and an empty string (as 0).
  const shape = rule.integer ? /^-?\d+$/ : /^-?(\d+(\.\d*)?|\.\d+)$/;
  const n = Number(rawValue);
  const valid =
    shape.test(rawValue) &&
    extra.length === 0 &&
    (!rule.integer || Number.isSafeInteger(n)) &&
    (rule.stops
      ? rule.stops.includes(n)
      : (rule.min === undefined || n >= rule.min) &&
        (rule.max === undefined || n <= rule.max));
  if (!valid) {
    const allowed = rule.stops
      ? `one of ${rule.stops.join(", ")}`
      : `${rule.integer ? "a whole number" : "a number"}${
          rule.min !== undefined && rule.max !== undefined
            ? ` from ${rule.min} to ${rule.max}`
            : rule.min !== undefined
              ? ` of at least ${rule.min}`
              : ""
        }`;
    throw new Error(`Usage: /set ${key} <value> — ${allowed}.`);
  }
  await patchParams({ [key]: n });
  return ok(`Set ${key}`, String(n));
}

async function runUnload(): Promise<CommandResult> {
  const session = requireSession();
  if (!session.model) throw new Error("This chat has no model yet.");
  if (session.provider !== "ollama") {
    throw new Error("Only Ollama models can be unloaded — the server manages OpenAI-compatible ones.");
  }
  // Ollama expires the runner without loading anything first; if a reply is
  // still using the model, it goes once that reply ends.
  await ollamaUnloadModel(useSettingsStore.getState().ollama_base_url, session.model);
  return ok("Unloaded model", `${session.model} — it loads again on your next message`);
}

async function runTheme(rest: string): Promise<CommandResult> {
  const arg = rest.trim().toLowerCase();
  if (arg !== "light" && arg !== "dark" && arg !== "system") {
    throw new Error("Usage: /theme light|dark|system");
  }
  // No success toast: the repaint is the confirmation, and `update` toasts
  // (and reverts) on its own if the save fails.
  await useSettingsStore.getState().update("theme", arg);
  return { kind: "noop" };
}

async function runLock(): Promise<CommandResult> {
  const security = useSecurityStore.getState();
  // `lock()` silently no-ops without a configured lock, which would read as
  // a dead command.
  if (!security.status.configured) {
    throw new Error("App lock isn't set up. Add a PIN or password in Settings → Security.");
  }
  security.lock();
  return { kind: "noop" };
}

