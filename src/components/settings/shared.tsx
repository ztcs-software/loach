//! Small pieces every Settings tab reaches for: the section heading and the
//! buffered-text-setting hook that keeps typing out of the store until the
//! user pauses, blurs, or closes the dialog.

import type { Settings } from "@/types";
import { useCallback, useEffect, useRef, useState } from "react";


/** How long a text setting sits in local state before it's persisted. */
const SETTING_DEBOUNCE_MS = 400;

/** Why a provider base URL can't be used, or null. Stored as typed, a stray
 *  space (`http://localhost:11434 `) or a missing scheme broke every request
 *  with reqwest's bare "builder error". */
export function baseUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Enter a full URL, starting with http:// or https://.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Use an http:// or https:// URL.";
  }
  return null;
}

/**
 * Buffer a free-text setting locally and persist it on a pause, on blur, and
 * on unmount.
 *
 * These fields used to call `settings.update` on EVERY keystroke, so typing
 * a base URL meant an IPC round-trip plus a SQLite write per character — and
 * every consumer keyed on that value (the model picker's Ollama probe, for
 * one) re-ran against each half-typed prefix. It also meant a crash
 * mid-typing persisted a partial URL as if the user had chosen it.
 *
 * `dialogOpen` is what makes "type, then immediately hit Escape" safe. It is
 * NOT enough to flush on unmount: this hook lives on `SettingsDialog`, which
 * stays mounted for the app's lifetime — Radix only unmounts the *content* —
 * so the cleanup never runs on close. Watching the open flag flip to false is
 * the event that actually corresponds to the user leaving. Blur covers "type,
 * then click Test connection"; the store's optimistic `set` is synchronous,
 * so the button reads the new value.
 */
export function useBufferedSetting(
  key: "ollama_base_url" | "openai_base_url" | "user_name" | "global_system_prompt",
  committed: string,
  update: <K extends keyof Settings>(k: K, v: Settings[K]) => Promise<void>,
  dialogOpen: boolean,
) {
  const [draft, setDraft] = useState(committed);
  // Base URLs are trimmed and checked before they're saved; one that fails
  // stays in the field with this message, and isn't saved.
  const isUrl = key === "ollama_base_url" || key === "openai_base_url";
  const [error, setError] = useState<string | null>(null);
  const dirty = useRef(false);
  const latest = useRef(committed);
  const timer = useRef<number | null>(null);

  // Adopt external changes (hydration, a reset) — but never while the user
  // has unsaved keystrokes in flight, or we'd yank the caret's text away.
  useEffect(() => {
    if (!dirty.current) {
      latest.current = committed;
      setDraft(committed);
      setError(null);
    }
  }, [committed]);

  /** Save what's pending. False when it was refused (an unusable URL). */
  const flush = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (!dirty.current) return true;
    dirty.current = false;
    const value = isUrl ? latest.current.trim() : latest.current;
    const problem = isUrl ? baseUrlProblem(value) : null;
    setError(problem);
    if (problem) return false;
    void update(key, value);
    return true;
  }, [key, update, isUrl]);

  // Closing the dialog commits whatever is pending — or, when that was
  // refused, puts back the value still in use, so reopening doesn't show
  // the rejected one as if it were saved.
  const wasOpen = useRef(dialogOpen);
  useEffect(() => {
    if (wasOpen.current && !dialogOpen && !flush()) {
      latest.current = committed;
      setDraft(committed);
      setError(null);
    }
    wasOpen.current = dialogOpen;
  }, [dialogOpen, flush, committed]);

  // Backstop for a real unmount (hot reload, an ErrorBoundary reset).
  useEffect(() => () => void flush(), [flush]);

  const onChange = (next: string) => {
    latest.current = next;
    dirty.current = true;
    setDraft(next);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, SETTING_DEBOUNCE_MS);
  };

  return { value: draft, onChange, onBlur: () => void flush(), error };
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-lg font-semibold tracking-tight">{children}</h3>
  );
}
