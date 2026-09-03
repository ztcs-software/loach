/**
 * Temporal awareness helpers.
 *
 * Models have no clock of their own, so we inject the current date /
 * weekday / timezone into the system prompt of every request. Compatible
 * with Open WebUI's `{{CURRENT_DATE}}` / `{{CURRENT_TIME}}` /
 * `{{CURRENT_WEEKDAY}}` template syntax — authors who want precise
 * placement (including the minute-precision time, which the auto preamble
 * deliberately omits — see `temporalPreamble`) can drop the placeholders
 * directly into their system prompt. Everyone else gets a short preamble
 * auto-prepended.
 *
 * All values come from the user's local machine clock (via `Date`) so the
 * model sees the same wall time the user does.
 */

interface TemporalVars {
  CURRENT_DATE: string; // YYYY-MM-DD
  CURRENT_TIME: string; // HH:MM (24h)
  CURRENT_WEEKDAY: string; // Monday, Tuesday, ...
  CURRENT_DATETIME: string; // YYYY-MM-DD HH:MM
  CURRENT_TIMEZONE: string; // IANA zone (e.g. "Europe/Warsaw") with best-effort fallback
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function temporalVars(now: Date = new Date()): TemporalVars {
  const yyyy = now.getFullYear();
  const mm = pad2(now.getMonth() + 1);
  const dd = pad2(now.getDate());
  const hh = pad2(now.getHours());
  const mi = pad2(now.getMinutes());

  const date = `${yyyy}-${mm}-${dd}`;
  const time = `${hh}:${mi}`;
  const weekday = WEEKDAYS[now.getDay()];

  // `Intl.DateTimeFormat().resolvedOptions().timeZone` is the standards-based
  // way to resolve the user's IANA zone. Some very old WebViews return an
  // empty string, in which case we fall back to a UTC offset like `UTC+02:00`.
  let tz = "";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    tz = "";
  }
  if (!tz) {
    const offset = -now.getTimezoneOffset(); // minutes east of UTC
    const sign = offset >= 0 ? "+" : "-";
    const abs = Math.abs(offset);
    tz = `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  }

  return {
    CURRENT_DATE: date,
    CURRENT_TIME: time,
    CURRENT_WEEKDAY: weekday,
    CURRENT_DATETIME: `${date} ${time}`,
    CURRENT_TIMEZONE: tz,
  };
}

/**
 * Replace `{{CURRENT_DATE}}` / `{{CURRENT_TIME}}` / `{{CURRENT_WEEKDAY}}` /
 * `{{CURRENT_DATETIME}}` / `{{CURRENT_TIMEZONE}}` occurrences with their
 * concrete values. Whitespace inside the braces is tolerated so copy-pastes
 * from other tools don't break silently.
 */
function substituteTemporalVars(prompt: string, vars: TemporalVars): string {
  return prompt.replace(
    /\{\{\s*(CURRENT_DATE|CURRENT_TIME|CURRENT_WEEKDAY|CURRENT_DATETIME|CURRENT_TIMEZONE)\s*\}\}/g,
    (_match, key: keyof TemporalVars) => vars[key],
  );
}

/** Does the prompt already reference any temporal template variable? If so,
 *  the user has taken manual control and we skip the auto preamble so we
 *  don't stomp on their phrasing. */
function promptUsesTemporalVars(prompt: string): boolean {
  return /\{\{\s*(CURRENT_DATE|CURRENT_TIME|CURRENT_WEEKDAY|CURRENT_DATETIME|CURRENT_TIMEZONE)\s*\}\}/.test(
    prompt,
  );
}

/**
 * Short stand-alone preamble suitable for prepending to any system prompt.
 * Kept deliberately terse so it doesn't dominate small context windows.
 *
 * Carries only date / weekday / timezone — values that change at most once
 * a day. Minute-precision time is intentionally NOT included: this preamble
 * sits at the very front of the system prompt, i.e. the head of the model's
 * KV-cache prefix, so a per-minute timestamp here would invalidate Ollama's
 * cached prefix on nearly every follow-up message and force a full
 * re-evaluation of the whole conversation. Users who need the exact wall
 * time can place `{{CURRENT_TIME}}` explicitly (accepting that trade-off) or
 * enable the datetime built-in tool, which the model can call on demand.
 */
function temporalPreamble(vars: TemporalVars): string {
  return `Current date: ${vars.CURRENT_DATE} (${vars.CURRENT_WEEKDAY}, ${vars.CURRENT_TIMEZONE}).`;
}

/**
 * High-level helper: given a raw system prompt (which may be null or empty)
 * and the setting flag, returns the final string to send to the model.
 *
 * - Always substitutes `{{CURRENT_*}}` template vars.
 * - If `enabled` is true and the prompt doesn't already use any temporal
 *   placeholder, prepends the preamble on its own line.
 */
export function applyTemporalAwareness(
  rawPrompt: string | null,
  enabled: boolean,
): string | null {
  const vars = temporalVars();
  const base = rawPrompt ?? "";
  const substituted = substituteTemporalVars(base, vars);

  if (!enabled) {
    return substituted.length > 0 ? substituted : rawPrompt;
  }

  // Author opted into manual placement — don't double up.
  if (promptUsesTemporalVars(base)) {
    return substituted;
  }

  const preamble = temporalPreamble(vars);
  if (substituted.trim().length === 0) return preamble;
  return `${preamble}\n\n${substituted}`;
}
