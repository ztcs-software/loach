import { makeRequestId, startChatStream } from "@/lib/tauri";
import { logger } from "@/lib/logger";
import {
  MAX_MEMORY_CHARS,
  buildExtractorSystemPrompt,
  clip,
  isDuplicate,
  normalize,
  parseExtractionJson,
  selectMemoriesForPrompt,
} from "@/lib/memoryRules";
import { useGlobalMemoryStore } from "@/stores/globalMemoryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useToastStore } from "@/stores/toastStore";
import type { MemoryRow, ProviderId } from "@/types";

/** Where an extraction run reads and writes: one Space's memory, or the
 *  global list. Decided by the chat store from the finished session —
 *  Space chats go to their Space, space-less chats go global. */
export type MemoryScope =
  | { kind: "space"; spaceId: string }
  | { kind: "global" };

/** One finished user/assistant exchange the extractor should read. */
export interface MemoryTurn {
  userText: string;
  assistantText: string;
  assistantMessageId: string;
}

export interface MemoryExtractionArgs {
  scope: MemoryScope;
  sessionId: string;
  provider: ProviderId;
  model: string;
  baseUrl: string;
  turn: MemoryTurn;
}

/**
 * Most turns one extraction run reads. Turns that couldn't be extracted
 * when they finished (chat still busy, or the run was aborted by the next
 * send) are parked in `pendingTurns` and folded into the next run for the
 * same chat, so a fast back-and-forth no longer loses every fact but the
 * last one. Small so the prompt stays within tiny local contexts.
 */
const MAX_TURNS_PER_RUN = 3;

/**
 * Cap on how much user + assistant text a run feeds the extractor, per
 * side, split across the turns in the run. Large code blocks etc. eat the
 * model's context and the durable facts that warrant memory rarely come
 * from the tail of a long answer. Still generous enough to handle a
 * typical multi-paragraph reply.
 */
const TURN_CHAR_BUDGET = 8_000;

/** How long an Undo-bearing memory toast stays up. Matches the archive
 *  undo — long enough to read the fact and decide. */
const UNDO_TOAST_MS = 7000;

/** Turns awaiting extraction, keyed by session id. See MAX_TURNS_PER_RUN. */
const pendingTurns = new Map<string, MemoryTurn[]>();

/** Park a finished turn for the next extraction run in its chat. Called
 *  instead of `extractMemories` while the chat still has work queued. Keeps
 *  only the newest turns so the next run's prompt stays bounded. */
export function deferMemoryTurn(args: MemoryExtractionArgs): void {
  const list = [...(pendingTurns.get(args.sessionId) ?? []), args.turn];
  pendingTurns.set(args.sessionId, list.slice(-(MAX_TURNS_PER_RUN - 1)));
}

/** Store-agnostic view of one memory scope's CRUD, so the extractor body
 *  reads the same for a Space and for the global list. */
interface MemoryOps {
  list: () => Promise<MemoryRow[]>;
  add: (
    content: string,
    sourceSessionId: string | null,
    sourceMessageId: string | null,
  ) => Promise<MemoryRow>;
  update: (id: string, content: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

function opsFor(scope: MemoryScope): MemoryOps {
  if (scope.kind === "global") {
    const s = () => useGlobalMemoryStore.getState();
    return {
      list: () => s().ensureLoaded(),
      add: (content, source_session_id, source_message_id) =>
        s().addMemory({ content, source_session_id, source_message_id }),
      update: (id, content) => s().updateMemory(id, content),
      remove: (id) => s().removeMemory(id),
    };
  }
  const { spaceId } = scope;
  const s = () => useSpaceStore.getState();
  return {
    list: async () =>
      s().spaceMemories[spaceId] ?? (await s().loadSpaceMemories(spaceId)),
    add: (content, source_session_id, source_message_id) =>
      s().addMemory({
        space_id: spaceId,
        content,
        source_session_id,
        source_message_id,
      }),
    update: (id, content) => s().updateMemory(id, spaceId, content),
    remove: (id) => s().removeMemory(id, spaceId),
  };
}

/**
 * One end-to-end run of the memory extractor for a finished assistant turn
 * (plus any turns parked for this chat by `deferMemoryTurn`).
 *
 * Flow:
 *   1. Build a tight extractor prompt that numbers the existing memories so
 *      the model can dedupe, correct, or retire them at the LLM level.
 *   2. Fire a non-displayed chat stream against the same provider/model/
 *      base_url the user is chatting with.
 *   3. Parse the model's JSON output. Tolerant of fenced code blocks and
 *      stray prose around the JSON object.
 *   4. Apply removals and updates by number, then run a local
 *      string-similarity dedupe on each addition against the (now
 *      corrected) existing memories — belt-and-suspenders for when the
 *      model ignores the dedupe instruction.
 *   5. Persist through the scope's store, then push one toast per change,
 *      each with an Undo.
 *
 * Errors are caught at the boundary — extraction is best-effort and must
 * never disrupt the user's chat flow.
 */
export async function extractMemories(args: MemoryExtractionArgs): Promise<void> {
  const { scope, sessionId, provider, model, baseUrl } = args;
  if (!model) return;

  const turns = [...(pendingTurns.get(sessionId) ?? []), args.turn].slice(
    -MAX_TURNS_PER_RUN,
  );
  pendingTurns.delete(sessionId);

  const ops = opsFor(scope);
  // Pull the latest cached memories — a stale cache would cause us to
  // re-add a row we just inserted earlier in the same session.
  let existing: MemoryRow[] = [];
  try {
    existing = await ops.list();
  } catch (e) {
    logger.warn("memory list failed before extraction", e);
  }

  // Inside a Space the global facts are shown as read-only context so the
  // model doesn't copy them into the Space; they're only editable through a
  // global run, so they aren't numbered.
  let alreadyKnown: string[] = [];
  if (scope.kind === "space" && useSettingsStore.getState().global_memory_enabled) {
    try {
      alreadyKnown = selectMemoriesForPrompt(
        await useGlobalMemoryStore.getState().ensureLoaded(),
      ).map((m) => m.content);
    } catch {
      /* best-effort context — extraction proceeds without it */
    }
  }

  const promptRows = selectMemoriesForPrompt(existing);
  const systemPrompt = buildExtractorSystemPrompt(
    promptRows.map((m) => m.content),
    alreadyKnown,
  );

  const perSide = Math.floor(TURN_CHAR_BUDGET / turns.length);
  const turnPrompt =
    turns
      .map(
        (t, i) =>
          `Conversation turn ${i + 1} of ${turns.length}:\n` +
          `<user>\n${clip(t.userText, perSide)}\n</user>\n\n` +
          `<assistant>\n${clip(t.assistantText, perSide)}\n</assistant>`,
      )
      .join("\n\n") + `\n\nReturn the JSON object now.`;

  let raw: string | null;
  try {
    raw = await runOneShotStream({
      provider,
      model,
      baseUrl,
      systemPrompt,
      userMessage: turnPrompt,
    });
  } catch (e) {
    logger.warn("memory extraction stream failed", e);
    return;
  }
  if (raw === null) {
    // Aborted by a new user send. Park the turns again so the run that
    // follows the next reply in this chat picks them up.
    pendingTurns.set(sessionId, turns.slice(-(MAX_TURNS_PER_RUN - 1)));
    return;
  }

  const parsed = parseExtractionJson(raw);
  if (!parsed) return;

  const byNumber = (n: number): MemoryRow | undefined => promptRows[n - 1];
  const latestMessageId = args.turn.assistantMessageId;

  // Removals and updates first so the dedupe list below reflects the
  // model's corrections — otherwise a reversed preference would be rejected
  // as a duplicate of the very row it replaces.
  const removedIds = new Set<string>();
  for (const n of parsed.remove) {
    const row = byNumber(n);
    if (!row || removedIds.has(row.id)) continue;
    try {
      await ops.remove(row.id);
      removedIds.add(row.id);
      announceRemoved(row, ops);
    } catch (e) {
      logger.warn("failed to remove memory", e);
    }
  }

  const updatedContent = new Map<string, string>();
  for (const u of parsed.update) {
    const row = byNumber(u.n);
    if (!row || removedIds.has(row.id) || updatedContent.has(row.id)) continue;
    const content = u.content.trim();
    if (!content || content.length > MAX_MEMORY_CHARS) continue;
    if (content === row.content) continue;
    try {
      await ops.update(row.id, content);
      updatedContent.set(row.id, content);
      announceUpdated(row, content, ops);
    } catch (e) {
      logger.warn("failed to update memory", e);
    }
  }

  const existingNormalized = existing
    .filter((m) => !removedIds.has(m.id))
    .map((m) => normalize(updatedContent.get(m.id) ?? m.content))
    .concat(alreadyKnown.map(normalize));
  const seenInRun = new Set<string>();

  for (const candidate of parsed.add) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_MEMORY_CHARS) continue;

    const norm = normalize(trimmed);
    if (!norm) continue;
    if (seenInRun.has(norm)) continue;
    if (isDuplicate(norm, existingNormalized)) continue;

    seenInRun.add(norm);
    try {
      const saved = await ops.add(trimmed, sessionId, latestMessageId);
      existingNormalized.push(norm);
      announceSaved(saved, ops);
    } catch (e) {
      logger.warn("failed to persist memory", e);
    }
  }
}

// Handle to the in-flight extractor stream's `stop()` (which routes through
// chat_cancel on the Rust side), or null when no extraction is running. Lets a
// new user send abort a still-running extractor so it stops competing for the
// model's generation slot. See `cancelMemoryExtraction`.
let memoryStopFn: (() => Promise<void>) | null = null;

/** Abort any in-flight memory extraction. Called when the user sends a new
 *  message so the extractor — a second full generation against the same model
 *  — doesn't keep hogging the generation slot and inflating the new turn's
 *  time-to-first-token. No-op when nothing is running. Best-effort: the Rust
 *  stream is told to cancel and the extractor re-parks its turns for the next
 *  run (its partial output is never parsed). */
export function cancelMemoryExtraction(): void {
  const stop = memoryStopFn;
  memoryStopFn = null;
  if (stop) void stop().catch(() => {});
}

/**
 * Issue a single non-streaming chat call against the user-selected model
 * and resolve to the concatenated assistant text — or `null` when the run
 * was cancelled. We re-use `startChatStream` so we don't have to duplicate
 * the per-provider request shaping in JS — we just buffer the tokens it
 * emits, ignore the rest, and resolve on `done`.
 *
 * Concurrent with the user's next chat: yes, but Ollama serialises
 * generation per-model and the extractor finishes quickly given the small
 * prompt + tight max_tokens. A new user send aborts it via
 * `cancelMemoryExtraction` so it never delays the visible turn.
 */
async function runOneShotStream(args: {
  provider: ProviderId;
  model: string;
  baseUrl: string;
  systemPrompt: string;
  userMessage: string;
}): Promise<string | null> {
  const { provider, model, baseUrl, systemPrompt, userMessage } = args;
  const streamId = makeRequestId();

  return new Promise<string | null>((resolve, reject) => {
    let buffer = "";
    let unlistenFn: (() => void) | null = null;
    // This run's own stop handle. Kept separately from the module-global
    // `memoryStopFn` so cleanup can tell "my handle" from "a newer run's".
    let stopFn: (() => Promise<unknown>) | null = null;
    // `timedOut` covers the race where `startChatStream`'s setup takes
    // longer than the wall-clock budget: the timer fires first, but
    // `unlistenFn` is still null because the `.then` hasn't run. Without
    // this flag we'd silently leak the listener once the .then finally
    // installs it. We also use it to short-circuit the .then so we don't
    // hand a now-useless handle back into the world.
    let timedOut = false;

    const cleanup = () => {
      try {
        unlistenFn?.();
      } catch {
        /* already unlistened — harmless */
      }
      unlistenFn = null;
      // Only clear the module-global when it still points at THIS run. A
      // superseded run's late `cancelled` event would otherwise wipe the
      // handle a newer extraction had just installed, leaving that one with
      // no working `cancelMemoryExtraction`.
      if (memoryStopFn === stopFn) memoryStopFn = null;
      stopFn = null;
    };

    // Hard ceiling on extractor wall-clock. If a model goes off the rails
    // and never emits `done`, we'd otherwise leak a listener.
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      // Stop the backend generation, don't just drop the listener: the model
      // would otherwise keep burning a generation slot with nobody reading
      // it, competing with the user's next visible turn — and since cleanup
      // clears the stop handle, no later `cancelMemoryExtraction()` could
      // reach it either. Same reasoning as `generateSummary`'s `finally`.
      const stop = stopFn;
      cleanup();
      if (stop) void stop().catch(() => {});
      reject(new Error("memory extraction timed out"));
    }, 60_000);

    startChatStream(
      {
        stream_id: streamId,
        provider,
        model,
        base_url: baseUrl,
        system_prompt: systemPrompt,
        messages: [
          { role: "user", content: userMessage, images: [] },
        ],
        params: {
          // Small budget — a JSON object with a handful of one-line facts
          // shouldn't need more.
          max_tokens: 512,
          // Low temperature — we want deterministic-ish dedupe behaviour.
          temperature: 0.2,
          // Suppress chain-of-thought when the model supports it; we only
          // care about the final JSON. Models that don't support `think`
          // ignore the field on the Rust side.
          think: false,
        },
      },
      (ev) => {
        if (ev.kind === "token") {
          buffer += ev.delta;
        } else if (ev.kind === "done") {
          window.clearTimeout(timeoutId);
          cleanup();
          resolve(buffer);
        } else if (ev.kind === "error") {
          window.clearTimeout(timeoutId);
          cleanup();
          reject(new Error(ev.message));
        } else if (ev.kind === "cancelled") {
          // Aborted by a new user send (cancelMemoryExtraction). Resolve NULL
          // — never parse the partial output — so the caller saves nothing
          // and re-parks the turns instead of logging a failure.
          window.clearTimeout(timeoutId);
          cleanup();
          resolve(null);
        }
      },
    )
      .then((handle) => {
        // The timer may have already fired and rejected the promise. If
        // it has, the handle's unlisten is the only thing keeping the
        // Rust-side event listener alive — call it immediately rather
        // than stashing it.
        if (timedOut) {
          try {
            handle.unlisten();
          } catch {
            /* ignore */
          }
          // Stop the generation too — the timer already gave up on reading
          // it, so leaving it running would strand the model exactly as the
          // timeout path above describes.
          void handle.stop().catch(() => {});
          return;
        }
        unlistenFn = handle.unlisten;
        stopFn = handle.stop;
        memoryStopFn = handle.stop;
      })
      .catch((e) => {
        window.clearTimeout(timeoutId);
        reject(e);
      });
  });
}

// ---------------------------------------------------------------------------
// Toasts. One per change, each with an Undo — the extractor writes silently
// on the user's behalf, so the chip is both the receipt and the way out
// when it saved something wrong (or something a fetched page planted).
// ---------------------------------------------------------------------------

function undoFailed(e: unknown) {
  logger.warn("memory undo failed", e);
}

/** "Saved to memory" pill with the saved text underneath so the user can
 *  verify what landed in long-term memory. Undo deletes the row. */
function announceSaved(memory: MemoryRow, ops: MemoryOps) {
  useToastStore.getState().push({
    kind: "memory",
    title: "Saved to memory",
    body: memory.content,
    durationMs: UNDO_TOAST_MS,
    action: {
      label: "Undo",
      onClick: () => void ops.remove(memory.id).catch(undoFailed),
    },
  });
}

/** Undo restores the previous wording. */
function announceUpdated(before: MemoryRow, content: string, ops: MemoryOps) {
  useToastStore.getState().push({
    kind: "memory",
    title: "Updated memory",
    body: content,
    durationMs: UNDO_TOAST_MS,
    action: {
      label: "Undo",
      onClick: () => void ops.update(before.id, before.content).catch(undoFailed),
    },
  });
}

/** Undo re-adds the row (under a fresh id, same text and source pointers). */
function announceRemoved(row: MemoryRow, ops: MemoryOps) {
  useToastStore.getState().push({
    kind: "memory",
    title: "Removed memory",
    body: row.content,
    durationMs: UNDO_TOAST_MS,
    action: {
      label: "Undo",
      onClick: () =>
        void ops
          .add(row.content, row.source_session_id, row.source_message_id)
          .catch(undoFailed),
    },
  });
}
