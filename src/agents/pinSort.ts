/**
 * Pure helper: return a new Map with all pinned entries first (in their
 * original relative order) followed by all unpinned entries (also in
 * original relative order). Stable partition. Does not mutate the input.
 *
 * Lifted out of AgentManager so we can unit-test the ordering invariant
 * without spinning up a real Agent (which spawns a node-pty child shell
 * and is unfit for node:test runs).
 *
 * Operates on the structural shape `{ pinned: boolean }` so callers can
 * pass either `Map<string, Agent>` or test fixtures.
 */
export function partitionPinnedFirst<V extends { pinned: boolean }>(
  entries: Map<string, V>,
): Map<string, V> {
  const pinned: [string, V][] = [];
  const unpinned: [string, V][] = [];
  for (const entry of entries) {
    (entry[1].pinned ? pinned : unpinned).push(entry);
  }
  const out = new Map<string, V>();
  for (const [k, v] of pinned) out.set(k, v);
  for (const [k, v] of unpinned) out.set(k, v);
  return out;
}
