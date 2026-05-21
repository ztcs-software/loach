import { create } from "zustand";
import { logger } from "@/lib/logger";
import {
  ollamaCopyModel,
  ollamaCreateModel,
  ollamaDeleteModel,
  ollamaListModels,
  ollamaShowModel,
  ollamaPullModel,
  openaiListModels,
  makeRequestId,
} from "@/lib/tauri";
import { useSettingsStore } from "./settingsStore";
import { parseModelParameters } from "@/lib/modelParams";
import {
  DEFAULT_SETTINGS,
  type AdminEvent,
  type GenerationParams,
  type ModelInfo,
  type OllamaShowResponse,
} from "@/types";

/** Progress snapshot for an in-flight pull / create. Either field can be
 *  zero while the daemon is still figuring out what to download, so the UI
 *  shows an indeterminate bar until `total` becomes positive. */
export interface AdminProgress {
  kind: "pull" | "create";
  /** Tag being pulled / created, shown in the progress chip. */
  target: string;
  status: string;
  total: number;
  completed: number;
  /** Terminal state — progress is kept around briefly so the chip can show
   *  "done" / "cancelled" / "error" instead of silently vanishing.
   *  `"cancelled"` is distinct from `"ok"` so the UI can render a neutral
   *  "Cancelled" badge rather than a misleading green checkmark when a
   *  partial pull was interrupted. */
  finished: "ok" | "cancelled" | "error" | null;
  error: string | null;
}

interface AdminRun {
  stop: () => Promise<void>;
  unlisten: () => void;
}

interface ModelsState {
  /** Flat list combining Ollama + OpenAI models. `provider` disambiguates. */
  models: ModelInfo[];
  loading: boolean;
  /** Last error string from a refresh attempt. Shown inline in the panel so
   *  users who forget to start `ollama serve` get a clear message. */
  error: string | null;

  /** Tag of the Ollama model currently being edited in the main view, or
   *  null when the user isn't inside the editor. */
  viewingModel: string | null;

  /** Progress map keyed by stream id. Multiple pulls can run concurrently
   *  (the user might queue a few at once) so we keep them separate. */
  runs: Record<string, AdminProgress>;

  /** Per-model default parameters parsed from the Modelfile (`/api/show`
   *  `parameters` block). Lazy-populated by `loadModelDefaults`; entries are
   *  keyed by model id (e.g. `llama3.1:8b`). Empty `{}` is a valid result
   *  meaning "we looked, the model lists no overrides" — distinct from
   *  "missing key" which means "we haven't asked yet". */
  modelDefaults: Record<string, Partial<GenerationParams>>;

  /** Per-model capability tags from `/api/show` (e.g. `"thinking"`,
   *  `"tools"`, `"vision"`). Populated alongside `modelDefaults` by
   *  `loadModelDefaults`. Empty `[]` means "we looked and the model lists
   *  none"; missing key means "we haven't asked yet". Older Ollama builds
   *  that omit the field show up as `[]` here. */
  modelCapabilities: Record<string, string[]>;

  /** User-set "default thinking" preference per model (the Thinking toggle
   *  in ModelsView). Sits as a layer between Modelfile defaults and
   *  per-session overrides — sessions still win when the user touches the
   *  toggle in ParameterPanel. Absence of an entry means "no preference,
   *  use the model's natural default" (which is ON for thinking-capable
   *  models, omitted for the rest). */
  modelThinkPrefs: Record<string, boolean>;
  /** Set / clear the per-model thinking preference. Pass `null` to clear
   *  back to the model's natural default; passing `true` / `false`
   *  records an explicit override. Stored in-memory only for now — no
   *  persistence layer yet. */
  setModelThinkPref: (modelId: string, value: boolean | null) => void;

  hydrate: () => Promise<void>;
  refresh: () => Promise<void>;
  setViewingModel: (name: string | null) => void;
  /** Lazily fetch + parse a model's PARAMETER block AND capabilities. The
   *  returned promise resolves with the parsed defaults; capabilities land
   *  in `modelCapabilities` as a side effect (they're not on the
   *  GenerationParams shape). OpenAI models cache to `{}` and `[]` since
   *  the catalog endpoint doesn't expose this info. */
  loadModelDefaults: (modelId: string) => Promise<Partial<GenerationParams>>;

  showModel: (name: string) => Promise<OllamaShowResponse>;
  deleteModel: (name: string) => Promise<void>;
  copyModel: (source: string, destination: string) => Promise<void>;
  /** Start a pull; resolves once the stream *ends* (done or error). */
  pullModel: (name: string) => Promise<void>;
  /** Start a create; resolves once the stream ends. */
  createModel: (name: string, modelfile: string) => Promise<void>;
  /** Cancel a running admin stream by id. */
  cancelRun: (streamId: string) => Promise<void>;
  /** Remove a terminal (done / error) run from the tracker. */
  dismissRun: (streamId: string) => void;
}

/** Active admin streams kept at module scope so we can tear them down on
 *  cancel without putting function handles into zustand state (which would
 *  make state non-serialisable for devtools). */
const activeRuns = new Map<string, AdminRun>();

export const useModelsStore = create<ModelsState>((set, get) => ({
  models: [],
  loading: false,
  error: null,
  viewingModel: null,
  runs: {},
  modelDefaults: {},
  modelCapabilities: {},
  modelThinkPrefs: {},

  setModelThinkPref: (modelId, value) =>
    set((s) => {
      const next = { ...s.modelThinkPrefs };
      if (value === null) delete next[modelId];
      else next[modelId] = value;
      return { modelThinkPrefs: next };
    }),

  hydrate: async () => {
    await get().refresh();
  },

  refresh: async () => {
    set({ loading: true, error: null });
    const s = useSettingsStore.getState();
    const out: ModelInfo[] = [];
    let err: string | null = null;

    try {
      const ollama = await ollamaListModels(s.ollama_base_url);
      out.push(...ollama);
    } catch (e) {
      // Ollama being unreachable is a common "not running" state rather
      // than a hard failure — surface it as a soft error so the panel can
      // show a "start ollama serve" hint without hiding the OpenAI list.
      err = e instanceof Error ? e.message : String(e);
    }

    // Try the OpenAI-compatible listing if either a key is stored or the base
    // URL has been pointed away from the public default — local/proxy servers
    // (llama-server, LM Studio, vLLM, LiteLLM) don't require auth, so gating
    // purely on `openai_key_set` would hide their models from the picker.
    const baseChanged = s.openai_base_url !== DEFAULT_SETTINGS.openai_base_url;
    if (s.openai_key_set || baseChanged) {
      try {
        const openai = await openaiListModels(s.openai_base_url);
        out.push(...openai);
      } catch (e) {
        // Don't clobber a more meaningful Ollama error with a minor OpenAI
        // listing hiccup; only set if nothing failed yet.
        if (!err) err = e instanceof Error ? e.message : String(e);
      }
    }

    set({ models: out, loading: false, error: err });
  },

  setViewingModel: (name) => set({ viewingModel: name }),

  showModel: async (name) => {
    const base = useSettingsStore.getState().ollama_base_url;
    return ollamaShowModel(base, name);
  },

  loadModelDefaults: async (modelId) => {
    if (!modelId) return {};
    const cached = get().modelDefaults[modelId];
    if (cached) return cached;

    // OpenAI catalog: the listing endpoint doesn't return Modelfile-style
    // parameters, so we cache an empty patch and move on. Identifying it
    // through the existing `models` array works as long as the user has
    // refreshed at least once; if they haven't, we conservatively try
    // Ollama's `/api/show` and let it 404 — cached as `{}` either way.
    const known = get().models.find((m) => m.id === modelId);
    if (known && known.provider !== "ollama") {
      set((s) => ({
        modelDefaults: { ...s.modelDefaults, [modelId]: {} },
        modelCapabilities: { ...s.modelCapabilities, [modelId]: [] },
      }));
      return {};
    }

    const base = useSettingsStore.getState().ollama_base_url;
    let patch: Partial<GenerationParams> = {};
    let caps: string[] = [];
    try {
      const resp = await ollamaShowModel(base, modelId);
      patch = parseModelParameters(resp.parameters);
      caps = resp.capabilities ?? [];
    } catch {
      // Network / 404 — cache empty so we don't retry on every render.
      // The user will still see app defaults; it's the same behaviour as
      // before this feature landed.
      patch = {};
      caps = [];
    }
    set((s) => ({
      modelDefaults: { ...s.modelDefaults, [modelId]: patch },
      modelCapabilities: { ...s.modelCapabilities, [modelId]: caps },
    }));
    return patch;
  },

  deleteModel: async (name) => {
    const base = useSettingsStore.getState().ollama_base_url;
    await ollamaDeleteModel(base, name);
    // If the user was viewing the model they just deleted, drop the editor
    // view so we don't leave them staring at a stale form.
    if (get().viewingModel === name) set({ viewingModel: null });
    await get().refresh();
  },

  copyModel: async (source, destination) => {
    const base = useSettingsStore.getState().ollama_base_url;
    await ollamaCopyModel({ base_url: base, source, destination });
    await get().refresh();
  },

  pullModel: async (name) => {
    const base = useSettingsStore.getState().ollama_base_url;
    const streamId = makeRequestId();

    set((s) => ({
      runs: {
        ...s.runs,
        [streamId]: {
          kind: "pull",
          target: name,
          status: "starting",
          total: 0,
          completed: 0,
          finished: null,
          error: null,
        },
      },
    }));

    await runAdminStream(
      streamId,
      () =>
        ollamaPullModel(
          { base_url: base, name, stream_id: streamId },
          (ev) => handleAdminEvent(set, streamId, ev),
        ),
      async () => {
        await get().refresh();
      },
    );
  },

  createModel: async (name, modelfile) => {
    const base = useSettingsStore.getState().ollama_base_url;
    const streamId = makeRequestId();

    set((s) => ({
      runs: {
        ...s.runs,
        [streamId]: {
          kind: "create",
          target: name,
          status: "starting",
          total: 0,
          completed: 0,
          finished: null,
          error: null,
        },
      },
    }));

    await runAdminStream(
      streamId,
      () =>
        ollamaCreateModel(
          { base_url: base, name, modelfile, stream_id: streamId },
          (ev) => handleAdminEvent(set, streamId, ev),
        ),
      async () => {
        await get().refresh();
      },
    );
  },

  cancelRun: async (streamId) => {
    const run = activeRuns.get(streamId);
    if (!run) return;
    try {
      run.unlisten();
    } catch {
      /* already detached */
    }
    try {
      await run.stop();
    } catch (e) {
      logger.warn("admin cancel failed", e);
    }
    activeRuns.delete(streamId);
    set((s) => ({
      runs: {
        ...s.runs,
        [streamId]: s.runs[streamId]
          ? { ...s.runs[streamId], finished: "cancelled", status: "cancelled" }
          : s.runs[streamId],
      },
    }));
  },

  dismissRun: (streamId) =>
    set((s) => {
      const runs = { ...s.runs };
      delete runs[streamId];
      return { runs };
    }),
}));

/** Apply an `AdminEvent` to the progress tracker. The "finished" flag is
 *  sticky — once set, the chip stays until the user dismisses it. */
function handleAdminEvent(
  set: (partial: Partial<ModelsState> | ((s: ModelsState) => Partial<ModelsState>)) => void,
  streamId: string,
  ev: AdminEvent,
) {
  set((s: ModelsState) => {
    const prev = s.runs[streamId];
    if (!prev) return {};
    let next: AdminProgress;
    if (ev.kind === "progress") {
      next = {
        ...prev,
        status: ev.status,
        total: ev.total ?? prev.total,
        completed: ev.completed ?? prev.completed,
      };
    } else if (ev.kind === "done") {
      next = { ...prev, finished: "ok", status: "done" };
    } else if (ev.kind === "cancelled") {
      // Distinct from `done` so the UI can label this run "Cancelled"
      // instead of showing a green checkmark. Pull/create may have left
      // partial state on the Ollama side — treat as a soft failure.
      next = { ...prev, finished: "cancelled", status: "cancelled" };
    } else {
      next = { ...prev, finished: "error", error: ev.message, status: "error" };
    }
    return { runs: { ...s.runs, [streamId]: next } };
  });
}

/** Wire up an admin stream: register the handle, wait for the stream's own
 *  "done" / "error" terminal frame, then run the onFinish hook (usually a
 *  model-list refresh). Always clears the handle from `activeRuns` so a
 *  second pull doesn't leak the previous listener. */
async function runAdminStream(
  streamId: string,
  start: () => Promise<AdminRun>,
  onFinish: () => Promise<void>,
): Promise<void> {
  let handle: AdminRun;
  try {
    handle = await start();
  } catch (e) {
    // Failure to even *start* the stream — surface as a terminal error
    // progress entry so the UI can show it.
    useModelsStore.setState((s) => {
      const prev = s.runs[streamId];
      if (!prev) return {};
      return {
        runs: {
          ...s.runs,
          [streamId]: {
            ...prev,
            finished: "error",
            error: e instanceof Error ? e.message : String(e),
            status: "error",
          },
        },
      };
    });
    return;
  }
  activeRuns.set(streamId, handle);

  // Wait for the run to reach a terminal state. The subscribe + check order
  // matters: a fast local stream can deliver `done` *before* this code runs
  // (the listener was attached inside `start()` above, so it can already
  // have flipped `finished`). If we just subscribed without an initial
  // snapshot check, we'd never see another store update for this run and
  // the promise would hang forever.
  await new Promise<void>((resolve) => {
    // Snapshot check — terminal already? Resolve immediately.
    if (useModelsStore.getState().runs[streamId]?.finished) {
      resolve();
      return;
    }
    // Otherwise, subscribe and watch for the transition. We track the
    // previous `finished` value ourselves so the callback only fires
    // real work when our run's terminal state actually changes — the
    // default `useModelsStore.subscribe(...)` fires on EVERY state
    // change (model list refreshes, viewing-model swaps, …) which adds
    // up over a long pull. Cheap, but trivially avoidable.
    let prevFinished = useModelsStore.getState().runs[streamId]?.finished ?? null;
    const unsub = useModelsStore.subscribe((s) => {
      const finished = s.runs[streamId]?.finished ?? null;
      if (finished === prevFinished) return;
      prevFinished = finished;
      if (finished) {
        unsub();
        resolve();
      }
    });
  });

  try {
    handle.unlisten();
  } catch {
    /* already detached */
  }
  activeRuns.delete(streamId);
  try {
    await onFinish();
  } catch (e) {
    logger.warn("admin onFinish hook failed", e);
  }
}
