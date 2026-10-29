/** The four networks the share dialog offers. */
export type ShareNetwork = "facebook" | "x" | "reddit" | "linkedin";

/** Shared as the link when a network can't post plain text on its own
 *  (Facebook). Same URL the Settings dialog links to. */
const LOACH_URL = "https://github.com/ztcs-software/loach";

/** How much text each network's composer will actually accept. X counts
 *  characters against the post limit; the others just get unwieldy URLs
 *  past a point. The full text is on the clipboard either way, so a clamp
 *  here only trims the pre-fill. */
const LIMITS: Record<ShareNetwork, number> = {
  facebook: 2000,
  x: 270,
  reddit: 4000,
  linkedin: 2800,
};

/** Reddit self-posts need a title; it caps at 300 characters. */
const REDDIT_TITLE_LIMIT = 300;

export function truncate(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  // Measured and cut in the same unit, UTF-16 code units (an emoji is two,
  // as X counts it): checked in units but cut by code points, 200 emoji
  // against X's limit came back whole with an ellipsis on the end. Never
  // between a surrogate pair's halves, though — a lone half renders as the
  // replacement glyph right before the ellipsis.
  const cut = t.slice(0, max - 1);
  const kept = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  return `${kept.trimEnd()}…`;
}

/**
 * Build the URL that opens `network`'s composer with `text` pre-filled.
 *
 * Every network here takes text (or a link) through query params only —
 * none of them accept an image, which is why the image mode of the share
 * dialog puts the PNG on the clipboard and lets the user paste it.
 *
 * Facebook is the odd one out: `sharer.php` refuses to open without a `u`
 * link, so the message rides along as `quote` next to the Loach URL.
 */
export function buildShareUrl(network: ShareNetwork, text: string): string {
  const body = truncate(text, LIMITS[network]);
  switch (network) {
    case "facebook":
      return `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(
        LOACH_URL,
      )}&quote=${encodeURIComponent(body)}`;
    case "x":
      return `https://x.com/intent/post?text=${encodeURIComponent(body)}`;
    case "reddit": {
      // First non-empty line makes a far better title than the first 300
      // characters of a wrapped paragraph.
      const firstLine = body.split("\n").find((l) => l.trim() !== "") ?? "";
      const title = truncate(firstLine || "Shared from Loach", REDDIT_TITLE_LIMIT);
      return `https://www.reddit.com/submit?title=${encodeURIComponent(
        title,
      )}&text=${encodeURIComponent(body)}`;
    }
    case "linkedin":
      // `/feed/?shareActive=true&text=` opens the real post composer with the
      // text in it; `share-offsite` would only take a URL.
      return `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(
        body,
      )}`;
  }
}
