import { useEffect, useMemo, useRef, useState } from "react";
import { ollamaListModels, ollamaProbe, openaiListModels } from "./tauri";
import { useSettingsStore } from "@/stores/settingsStore";
import { DEFAULT_SETTINGS, type ModelInfo } from "@/types";

/**
 * Load the installed model lists for both providers, for a model picker.
 *
 * Probes Ollama first (so a dead server shows as down rather than as an empty
 * list) and asks the OpenAI-compatible endpoint when a key is set or the base
 * URL points somewhere other than the public default — the same rule as the
 * Models tab, since a local server (llama-server, LM Studio) needs no key.
 * Refreshes itself once the settings store hydrates, re-runs whenever a base
 * URL or the key-set flag changes, and re-runs once more when onboarding
 * finishes.
 *
 * Concurrent refreshes are resolved by a monotonic request id: a run that has
 * been superseded drops its results on the floor instead of racing a newer one
 * back into state. Three pickers had hand-rolled this — two identically, and a
 * third (the snippet dialog) had shipped without the guard at all, so a quick
 * base-URL edit there could land the old list last.
 *
 * The store slice is deliberately four narrow selectors rather than a whole
 * `useSettingsStore()` subscription: the latter re-renders every picker on
 * each keystroke in the Settings textareas.
 */
export function useProviderModels() {
  const ollamaBaseUrl = useSettingsStore((s) => s.ollama_base_url);
  const openaiBaseUrl = useSettingsStore((s) => s.openai_base_url);
  const openaiKeySet = useSettingsStore((s) => s.openai_key_set);
  const settingsHydrated = useSettingsStore((s) => s.hydrated);
  const onboardingCompleted = useSettingsStore((s) => s.onboarding_completed);

  const [ollamaModels, setOllamaModels] = useState<ModelInfo[]>([]);
  const [openaiModels, setOpenaiModels] = useState<ModelInfo[]>([]);
  const [ollamaUp, setOllamaUp] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);

  const reqId = useRef(0);
  const refresh = useMemo(
    () => async () => {
      const id = ++reqId.current;
      setLoading(true);
      try {
        const probe = await ollamaProbe(ollamaBaseUrl).catch(() => false);
        if (id !== reqId.current) return;
        setOllamaUp(probe);
        if (probe) {
          const m = await ollamaListModels(ollamaBaseUrl).catch(() => []);
          if (id !== reqId.current) return;
          setOllamaModels(m);
        } else {
          setOllamaModels([]);
        }
        // A key, or a server of the user's own: local ones (llama-server,
        // LM Studio, vLLM) take no key, and gating on the key alone hid
        // their models here while the Models tab listed them.
        const wantOpenai =
          openaiKeySet || openaiBaseUrl !== DEFAULT_SETTINGS.openai_base_url;
        if (wantOpenai) {
          const m = await openaiListModels(openaiBaseUrl).catch(() => []);
          if (id !== reqId.current) return;
          setOpenaiModels(m);
        } else {
          // Clear, don't just skip. Removing the key flips `openai_key_set`,
          // which re-runs this — but without an else the last list survived for
          // the component's lifetime, and the pickers render it whether or not
          // it can be reached. Picking one of those pinned the session to a
          // provider that can only fail at send time with an auth error. Functional so
          // an already-empty list keeps its identity: this branch runs on every
          // keyless refresh, and a fresh `[]` re-rendered each picker for nothing.
          setOpenaiModels((prev) => (prev.length === 0 ? prev : []));
        }
      } finally {
        // Only the latest-initiated run owns the loading flag.
        if (id === reqId.current) setLoading(false);
      }
    },
    [ollamaBaseUrl, openaiBaseUrl, openaiKeySet],
  );

  // `onboardingCompleted` is a dependency even though it's not an input to the
  // probe: it's the signal that the world may have changed underneath us.
  // Every picker mounts behind the onboarding overlay at boot, so it captures
  // its probe BEFORE the wizard runs — and the wizard is where the user
  // installs Ollama, or has Loach start it for them. Without this the chat
  // header kept offering "Start Ollama" for a daemon onboarding had just
  // started, with no base-URL or key change to invalidate the stale `false`.
  useEffect(() => {
    if (!settingsHydrated) return;
    void refresh();
  }, [settingsHydrated, refresh, onboardingCompleted]);

  return { ollamaModels, openaiModels, ollamaUp, loading, refresh };
}
