import type { SpaceContext } from "@/types";

/**
 * Per-space cache of the assembled {@link SpaceContext} (instructions +
 * reference files + memories).
 *
 * Without it, every chat send in a Space re-ships all reference-file data
 * across IPC twice — Rust→JS in `getSpaceContext`, then JS→Rust embedded in the
 * outgoing `system_prompt` — which is squarely on the time-to-first-token path
 * and scales with how much reference material the Space holds.
 *
 * Correctness rests on EXPLICIT invalidation: every `spaceStore` mutation that
 * can change a space's instructions, files, or memories calls
 * {@link invalidateSpaceContext}. Memory extraction routes through
 * `spaceStore.addMemory`, so it's covered too. (A cache keyed on
 * `space.updated_at` would NOT be safe — `add_space_file` / `add_space_memory`
 * deliberately don't bump that column.) The cache is module-level, so it's also
 * naturally dropped on app restart.
 */
const cache = new Map<string, SpaceContext>();

export function getCachedSpaceContext(spaceId: string): SpaceContext | undefined {
  return cache.get(spaceId);
}

export function setCachedSpaceContext(spaceId: string, ctx: SpaceContext): void {
  cache.set(spaceId, ctx);
}

export function invalidateSpaceContext(spaceId: string): void {
  cache.delete(spaceId);
}

/** Drop the whole cache — used on (re)hydration, e.g. after a data import
 *  rewrites the spaces tables out from under us. */
export function invalidateAllSpaceContext(): void {
  cache.clear();
}
