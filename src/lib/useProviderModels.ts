import { useEffect, useMemo, useRef, useState } from "react";
import { ollamaListModels, ollamaProbe, openaiListModels } from "./tauri";
import { useSettingsStore } from "@/stores/settingsStore";
import type { ModelInfo } from "@/types";

/**
 * Load the installed model lists for both providers, for a model picker.
 *
 * Probes Ollama first (so a dead server shows as down rather than as an empty
 * list) and only asks the OpenAI-compatible endpoint when a key is set.
 * Refreshes itself once the settings store hydrates, and re-runs whenever a
 * base URL or the key-set flag changes.
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
        if (openaiKeySet) {
          const m = await openaiListModels(openaiBaseUrl).catch(() => []);
          if (id !== reqId.current) return;
          setOpenaiModels(m);
        }
      } finally {
        // Only the latest-initiated run owns the loading flag.
        if (id === reqId.current) setLoading(false);
      }
    },
    [ollamaBaseUrl, openaiBaseUrl, openaiKeySet],
  );

  useEffect(() => {
    if (!settingsHydrated) return;
    void refresh();
  }, [settingsHydrated, refresh]);

  return { ollamaModels, openaiModels, ollamaUp, loading, refresh };
}
