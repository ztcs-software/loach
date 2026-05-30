import { useChatStore } from "@/stores/chatStore";
import { useMcpStore } from "@/stores/mcpStore";
import { useModelsStore } from "@/stores/modelsStore";
import { usePrivateChatStore } from "@/stores/privateChatStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSnippetStore } from "@/stores/snippetStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useUIStore, type SettingsTab } from "@/stores/uiStore";
import { DEFAULT_PERSONA_ID, PERSONAS } from "@/lib/personas";
import { expandAndPrimeSnippet } from "@/lib/runSnippet";
import { stripSummaryBlock } from "@/lib/contextUsage";
import {
  deleteMessage,
  fetchUrl,
  mcpTest,
} from "@/lib/tauri";
import type { GenerationParams, Message, MessageMetrics, Session } from "@/types";
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

function activeSpaceId(): string {
  const session = useChatStore.getState().sessions.find(
    (s) => s.id === useChatStore.getState().activeSessionId,
  );
  if (session?.space_id) return session.space_id;
  const sid = useSpaceStore.getState().activeSpaceId;
  if (sid) return sid;
  throw new Error(
    "No active space. Open a chat that belongs to a space, or run /space <name>.",
  );
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
  for (const m of messages) {
    await deleteMessage(m.id, session.id);
  }
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
  return ok("Archived chat", session.title);
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
  // copy, save-to-file) rather than duplicating that surface here. The header
  // owns the dialog's data-loading, so we flip a one-shot flag it consumes —
  // same pattern as the onboarding model-picker auto-open.
  requireSession();
  useUIStore.getState().setPendingOpenExport(true);
  return { kind: "noop" };
}

async function runModel(rest: string): Promise<CommandResult> {
  const query = rest.trim();
  if (!query) throw new Error("Usage: /model <name>");
  const session = requireSession();
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
  if (!query) throw new Error("Usage: /persona <name>");
  const session = requireSession();
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
          hint: s.url,
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
      const spaceId = activeSpaceId();
      const memories =
        useSpaceStore.getState().spaceMemories[spaceId] ??
        (await useSpaceStore.getState().loadSpaceMemories(spaceId));
      if (memories.length === 0) return ok("No memories in this space");
      return listItems(
        "Memories",
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
  if (value.toLowerCase() === "clear") {
    await useChatStore.getState().setSessionSystemPrompt(session.id, "");
    return ok("Cleared instructions");
  }
  // We deliberately keep the user's raw text (including newlines after the
  // first space) — that's why `rest` was preserved verbatim in the parser.
  await useChatStore.getState().setSessionSystemPrompt(session.id, value);
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
  const spaceId = activeSpaceId();
  const session = useChatStore.getState().sessions.find(
    (s) => s.id === useChatStore.getState().activeSessionId,
  );
  await useSpaceStore.getState().addMemory({
    space_id: spaceId,
    content: fact,
    source_session_id: session?.id ?? null,
  });
  return ok("Saved to memory", fact.length > 80 ? fact.slice(0, 80) + "…" : fact);
}

async function runForget(rest: string): Promise<CommandResult> {
  const query = rest.trim();
  if (!query) throw new Error("Usage: /forget <id|query>");
  const spaceId = activeSpaceId();
  const memories =
    useSpaceStore.getState().spaceMemories[spaceId] ??
    (await useSpaceStore.getState().loadSpaceMemories(spaceId));
  // First try a full or prefix id match (memories surface their short id in
  // /list memories, so the user might paste either form).
  const byId =
    memories.find((m) => m.id === query) ??
    memories.find((m) => m.id.startsWith(query));
  if (byId) {
    await useSpaceStore.getState().removeMemory(byId.id, spaceId);
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
  await useSpaceStore.getState().removeMemory(m.id, spaceId);
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
  // Probe each server in parallel — mcpTest never throws (failures land in
  // `error`) so Promise.all is safe.
  const probes = await Promise.all(
    servers.map(async (s) => ({
      server: s,
      result: await mcpTest({ id: s.id, name: s.name, url: s.url, headers: s.headers, enabled: true }),
    })),
  );
  const items: CommandResultItem[] = [];
  for (const { server, result } of probes) {
    if (!result.ok) {
      items.push({ label: server.name, detail: "error", hint: result.error ?? "Probe failed" });
      continue;
    }
    if (result.tools.length === 0) {
      items.push({ label: server.name, detail: "0 tools" });
      continue;
    }
    for (const t of result.tools) {
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
  const n = arg.length === 0 ? 1 : Math.max(1, Math.floor(Number(arg)));
  if (!Number.isFinite(n)) throw new Error("Usage: /copy [N]");
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
  // `regenerateLast` already guards against busy chats and missing user
  // turns; on a no-op call it silently returns. We surface the busy /
  // empty-history case ourselves so the user gets feedback instead of
  // wondering whether the command landed.
  const messages = useChatStore.getState().messages[session.id] ?? [];
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") {
    throw new Error("Nothing to regenerate — the last turn isn't an assistant reply.");
  }
  const state = useChatStore.getState();
  if (
    state.runningTask?.sessionId === session.id ||
    state.queue.some((t) => t.sessionId === session.id)
  ) {
    throw new Error("This chat is busy — wait for the current reply to finish.");
  }
  await useChatStore.getState().regenerateLast(session.id);
  return ok("Regenerating reply", "Streaming a fresh response with current settings");
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
  usePrivateChatStore.getState().setOpen(true);
  return { kind: "noop" };
}

async function runCompact(): Promise<CommandResult> {
  const session = requireSession();
  const state = useChatStore.getState();
  if (state.compactingSessionId) {
    throw new Error("Another chat is already being compacted. Try again in a moment.");
  }
  const messages = state.messages[session.id] ?? [];
  // Mirrors the gating logic in ContextUsageBar's popover: small chats
  // aren't worth a round-trip to the summariser. We can't easily compute
  // the ratio from here without duplicating `computeContextUsage`, so we
  // fall back to the more conservative half of the gate (message count)
  // and let the store layer reject impossibly tiny chats.
  if (messages.length < 6) {
    throw new Error("Not enough history to compact yet — keep chatting.");
  }
  // Fire and forget; the store flips `compactingSessionId` so the context
  // bar shows a spinner, and toasts its own success/failure when done.
  void useChatStore.getState().compactContext(session.id);
  return ok("Compacting context", "Summarising older messages with this chat's model");
}

