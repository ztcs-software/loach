import { useChatStore } from "@/stores/chatStore";
import { useMcpStore } from "@/stores/mcpStore";
import { useModelsStore } from "@/stores/modelsStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSnippetStore } from "@/stores/snippetStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useUIStore } from "@/stores/uiStore";
import { DEFAULT_PERSONA_ID, PERSONAS } from "@/lib/personas";
import {
  deleteMessage,
  fetchUrl,
  mcpTest,
} from "@/lib/tauri";
import type { GenerationParams, Session } from "@/types";
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

/** Entry point. Returns synchronously-resolved promises so the composer
 *  can `await dispatch(text)` once and branch on the outcome. */
export async function dispatch(text: string): Promise<DispatchOutcome> {
  const parsed = parseInput(text);
  if (!parsed || parsed.name.length === 0) return { kind: "passthrough" };
  const cmd = findCommand(parsed.name);
  if (!cmd) return { kind: "passthrough" };

  try {
    const result = await run(parsed.name, parsed.rest);
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

function parseNumber(label: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number, got "${raw}".`);
  return n;
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

async function run(name: string, rest: string): Promise<CommandResult> {
  switch (name) {
    case "new":
      return runNew();
    case "clear":
      return runClear();
    case "rename":
      return runRename(rest);
    case "pin":
      return runPin();
    case "archive":
      return runArchive();
    case "delete":
      return runDelete();
    case "model":
      return runModel(rest);
    case "persona":
      return runPersona(rest);
    case "list":
      return runList(rest);
    case "temp":
      return runParam("temperature", rest);
    case "top_p":
      return runParam("top_p", rest);
    case "top_k":
      return runParam("top_k", rest);
    case "min_p":
      return runParam("min_p", rest);
    case "max-tokens":
      return runParam("max_tokens", rest);
    case "num_ctx":
      return runParam("num_ctx", rest);
    case "seed":
      return runSeed(rest);
    case "parameters":
      return runParametersReset(rest);
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

async function runClear(): Promise<CommandResult> {
  const session = requireSession();
  const messages = useChatStore.getState().messages[session.id] ?? [];
  if (messages.length === 0) return ok("Chat is already empty");
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

async function runDelete(): Promise<CommandResult> {
  const session = requireSession();
  await useChatStore.getState().remove(session.id);
  return ok("Deleted chat", session.title);
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
  const persona =
    PERSONAS.find(
      (p) => p.id.toLowerCase() === lower || p.label.toLowerCase() === lower,
    ) ??
    PERSONAS.find(
      (p) =>
        p.id.toLowerCase().includes(lower) ||
        p.label.toLowerCase().includes(lower),
    );
  if (!persona) {
    throw new Error(`No persona matches "${query}". Try /list personas.`);
  }
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

async function runParam(
  field: keyof GenerationParams,
  rest: string,
): Promise<CommandResult> {
  const raw = rest.trim();
  if (!raw) throw new Error(`Usage: /${paramFlagFor(field)} <number>`);
  const value = parseNumber(field, raw);
  await patchParams({ [field]: value } as Partial<GenerationParams>);
  return ok("Updated parameter", `${field} = ${value}`);
}

function paramFlagFor(field: keyof GenerationParams): string {
  return field === "max_tokens" ? "max-tokens" : (field as string);
}

async function runSeed(rest: string): Promise<CommandResult> {
  const raw = rest.trim();
  if (!raw) throw new Error("Usage: /seed <int|random>");
  if (raw.toLowerCase() === "random" || raw.toLowerCase() === "none") {
    await patchParams({ seed: null });
    return ok("Updated parameter", "seed = random");
  }
  const value = parseNumber("seed", raw);
  await patchParams({ seed: value });
  return ok("Updated parameter", `seed = ${value}`);
}

async function runParametersReset(rest: string): Promise<CommandResult> {
  if (rest.trim().toLowerCase() !== "reset") {
    throw new Error("Usage: /parameters reset");
  }
  const session = requireSession();
  await useChatStore.getState().setSessionParams(session.id, null);
  return ok("Reset parameters", "Falling back to model defaults");
}

async function runInstructions(rest: string): Promise<CommandResult> {
  const session = requireSession();
  const value = rest.trim();
  if (value.length === 0 || value.toLowerCase() === "clear") {
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
  const match =
    snippets.find((s) => s.title.toLowerCase() === lower) ??
    snippets.find((s) => s.title.toLowerCase().includes(lower));
  if (!match) throw new Error(`No snippet matches "${query}". Try /list snippets.`);
  useUIStore.getState().primeComposer(match.prompt, []);
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
  const match =
    spaces.find((s) => s.name.toLowerCase() === lower) ??
    spaces.find((s) => s.name.toLowerCase().includes(lower));
  if (!match) throw new Error(`No space matches "${query}". Try /list spaces.`);
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

