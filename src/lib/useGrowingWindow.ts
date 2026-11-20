import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A long list rendered in steps: the first `step` items, and `step` more each
 * time a sentinel placed after them comes within a screen of view. Mounted
 * whole, thousands of sidebar chats or Library items cost seconds to open
 * and a re-render of every row on each store update; this way only what the
 * user scrolls to is ever mounted (and stays mounted once it is).
 *
 * Put `sentinelRef` on an empty element right after the rendered items,
 * keyed by `count` so each growth mounts a fresh one: an observer only
 * reports changes, and a sentinel still in view after the list grew would
 * never report again. `resetKey` starts over at `step` (another tab, a new
 * search).
 */
export function useGrowingWindow(total: number, step: number, resetKey: unknown) {
  const [shown, setShown] = useState(step);
  const [key, setKey] = useState(resetKey);
  if (key !== resetKey) {
    setKey(resetKey);
    setShown(step);
  }

  const observer = useRef<IntersectionObserver | null>(null);
  const sentinelRef = useCallback(
    (el: Element | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (!el || typeof IntersectionObserver === "undefined") return;
      observer.current = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) setShown((n) => n + step);
        },
        { rootMargin: "100% 0px" },
      );
      observer.current.observe(el);
    },
    [step],
  );
  useEffect(() => () => observer.current?.disconnect(), []);

  const count = Math.min(shown, total);
  return { count, more: count < total, sentinelRef };
}
