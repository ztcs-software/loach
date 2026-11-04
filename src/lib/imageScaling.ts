import type { ImageScaling } from "@/types";

/**
 * How images are scaled down before they reach a model. One setting, stored
 * as JSON at four levels — the app (`Settings.image_scaling`), the Library
 * (`Settings.library_image_scaling`, for Library images), a Space and a chat
 * (`image_scaling_json`) — where every level but the app's may be left
 * unset to inherit. The most specific level that sets it wins:
 *
 *  - a chat's attachments and its Space's uploads: chat → Space → app;
 *  - Library images linked to the chat or its Space: chat → Space →
 *    Library → app.
 *
 * Scaling happens at send time; the stored image stays the original.
 */

/** The app's default: a camera photo kept whole runs to thousands of image
 *  tokens, and models do worse with it, not better — Gemma 4 on Ollama
 *  answered a 24-megapixel dataset photo as if no picture were attached, and
 *  described it at 1024 px. */
export const DEFAULT_IMAGE_SCALING: ImageScaling = {
  enabled: true,
  mode: "px",
  px: 1024,
  percent: 50,
};

/** The sizes the controls offer — and all the backend's setters accept
 *  (`db::normalize_image_scaling`). */
export const IMAGE_SCALING_PX = { min: 64, max: 8192 } as const;
export const IMAGE_SCALING_PERCENT = { min: 1, max: 100 } as const;

const inRange = (n: unknown, r: { min: number; max: number }): n is number =>
  Number.isInteger(n) && (n as number) >= r.min && (n as number) <= r.max;

/** A stored setting, or null when there is none (`""` / null: inherit) or
 *  it can't be read — a hand-edited snapshot falls back to inheriting
 *  rather than breaking every send. */
export function parseImageScaling(json: string | null | undefined): ImageScaling | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Record<string, unknown> | null;
    if (
      !v ||
      typeof v.enabled !== "boolean" ||
      (v.mode !== "px" && v.mode !== "percent") ||
      !inRange(v.px, IMAGE_SCALING_PX) ||
      !inRange(v.percent, IMAGE_SCALING_PERCENT)
    ) {
      return null;
    }
    return { enabled: v.enabled, mode: v.mode, px: v.px, percent: v.percent };
  } catch {
    return null;
  }
}

/** The setting the first level that has one holds, most specific first;
 *  the default when none does. */
export function resolveImageScaling(...levels: (string | null | undefined)[]): ImageScaling {
  for (const level of levels) {
    const s = parseImageScaling(level);
    if (s) return s;
  }
  return DEFAULT_IMAGE_SCALING;
}

/** The size a `width`×`height` image is sent at under `s` — never larger
 *  than it is. */
export function scaledSize(
  width: number,
  height: number,
  s: ImageScaling,
): { width: number; height: number } {
  const factor = !s.enabled ? 1 : s.mode === "px" ? s.px / Math.max(width, height) : s.percent / 100;
  if (!(factor < 1)) return { width, height };
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
}

/** One line saying what `s` does, for hints and inherited values. */
export function describeImageScaling(s: ImageScaling): string {
  if (!s.enabled) return "original size";
  return s.mode === "px" ? `longest side up to ${s.px} px` : `${s.percent}% of the original size`;
}
