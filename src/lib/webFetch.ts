import { fetchUrl } from "@/lib/tauri";
import { MAX_INLINED_CHARS_PER_MESSAGE } from "@/lib/files";
import type { FetchedPage } from "@/types";

/**
 * URL prefetch helper.
 *
 * The user can include one or more `http(s)://` links in their prompt.
 * When web-fetch is enabled in settings, we extract those links, call the
 * Rust `fetch_url` command for each (in parallel), and inline the cleaned
 * text back into the user's message as fenced blocks the model can read.
 *
 * Design decisions:
 *   - Cap at {@link MAX_URLS_PER_MESSAGE} to avoid runaway parallel fetches
 *     on a pathological message like 50 links.
 *   - Dedupe; fetching the same URL twice is wasteful.
 *   - Silently swallow per-URL failures — one dead link should not kill the
 *     whole submit. The failure is rendered as a short stub so the model
 *     knows we tried.
 *   - Leave the original URL text in the user message untouched; we *append*
 *     the fetched content below it (mirrors `inlineTextAttachments`).
 */

export const MAX_URLS_PER_MESSAGE = 3;

/** Per-URL outcome, useful for both inlining and showing UI chips. */
export type FetchOutcome =
  | { url: string; ok: true; page: FetchedPage }
  | { url: string; ok: false; error: string };

/**
 * Pull `http(s)://…` URLs out of a free-form string.
 *
 * The regex is deliberately loose — anything with a scheme, host, and optional
 * path/query/fragment matches. It trims trailing punctuation that is almost
 * always not part of the URL (e.g. "see https://example.com/foo." should not
 * include the period).
 */
export function extractUrls(text: string): string[] {
  if (!text) return [];
  const pattern = /\bhttps?:\/\/[^\s<>"'`]+/gi;
  const found = text.match(pattern) ?? [];
  const trimmed = found.map((u) => stripTrailingPunct(u));
  // Dedupe preserving order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of trimmed) {
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

function stripTrailingPunct(s: string): string {
  // Strip a closing bracket only if there's no matching open bracket in the
  // URL — handles cases like "(https://example.com)" without eating the `)`
  // of "https://en.wikipedia.org/wiki/Rust_(programming_language)".
  let end = s.length;
  while (end > 0) {
    const c = s[end - 1];
    if (",.;:!?".includes(c)) {
      end -= 1;
      continue;
    }
    if (c === ")" && !s.slice(0, end - 1).includes("(")) {
      end -= 1;
      continue;
    }
    if (c === "]" && !s.slice(0, end - 1).includes("[")) {
      end -= 1;
      continue;
    }
    break;
  }
  return s.slice(0, end);
}

/**
 * Fetch every URL in parallel. One failed URL never fails the batch.
 * The returned array is in the same order as the input, capped at
 * {@link MAX_URLS_PER_MESSAGE}.
 */
export async function fetchAll(urls: string[]): Promise<FetchOutcome[]> {
  const limited = urls.slice(0, MAX_URLS_PER_MESSAGE);
  const jobs = limited.map(async (url): Promise<FetchOutcome> => {
    try {
      const page = await fetchUrl(url);
      return { url, ok: true, page };
    } catch (e) {
      return {
        url,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });
  return Promise.all(jobs);
}

/**
 * Append the outcomes of `fetchAll` to the user's message as fenced blocks.
 * Mirrors the shape used by `inlineTextAttachments` in `lib/files.ts` so the
 * prompt feels consistent to the model regardless of how the context arrived.
 *
 * Shares the same {@link MAX_INLINED_CHARS_PER_MESSAGE} budget as
 * attachments. Callers should run `inlineTextAttachments` first and pass
 * its result here — the budget is enforced against the running content
 * length, so anything already inlined naturally narrows the headroom for
 * fetched-page bodies. URL fetches that don't fit are listed by URL only.
 */
export function inlineFetchedPages(
  content: string,
  outcomes: FetchOutcome[],
  maxTotalChars: number = MAX_INLINED_CHARS_PER_MESSAGE,
): string {
  if (outcomes.length === 0) return content;
  let out = content;
  const skippedUrls: string[] = [];
  for (const o of outcomes) {
    if (o.ok) {
      const p = o.page;
      const titleStr = p.title
        ? `Fetched URL: ${p.final_url} — "${p.title}"`
        : `Fetched URL: ${p.final_url}`;
      const header = `\n\n---\n${titleStr}\n\`\`\`\n`;
      const upstreamTruncSuffix = p.truncated
        ? "\n\n[Content was truncated by the server-side fetcher. Ask the user if you need more.]"
        : "";
      const footer = "\n```";
      const wrapCost = header.length + upstreamTruncSuffix.length + footer.length;
      const remaining = maxTotalChars - out.length - wrapCost;

      if (remaining <= 200) {
        skippedUrls.push(p.final_url || o.url);
        continue;
      }

      let body = p.text;
      let clippedHere = false;
      if (body.length > remaining) {
        body = body.slice(0, remaining);
        clippedHere = true;
      }
      out += header + body + upstreamTruncSuffix;
      if (clippedHere) {
        out +=
          "\n\n[…this page body was clipped here to fit the per-message size budget.]";
      }
      out += footer;
    } else {
      // Failures are short; always append.
      out += `\n\n---\nFailed to fetch ${o.url}: ${o.error}`;
    }
  }
  if (skippedUrls.length > 0) {
    const urls = skippedUrls.map((u) => `\`${u}\``).join(", ");
    out += `\n\n---\n${skippedUrls.length === 1 ? "This URL was" : `${skippedUrls.length} URLs were`} fetched successfully but couldn't be inlined into this turn (per-message size budget reached): ${urls}.`;
  }
  return out;
}
