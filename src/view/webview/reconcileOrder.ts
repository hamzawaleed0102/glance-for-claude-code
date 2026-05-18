/**
 * Reconcile a user-defined card order against the current agent set.
 *
 * The webview holds the drag-defined order in `localOrder`. When agents
 * are added or removed it must NOT be thrown away (doing so snapped the
 * list back to spawn order on every delete) — instead:
 *   - keep `prevOrder`'s sequence,
 *   - drop ids no longer present (deleted agents),
 *   - append newly-seen ids (in their arrival order) at the end.
 *
 * Returns `null` only when there was no prior user-defined order, so the
 * caller can fall back to the natural (prop-supplied) order until the
 * user first drags. Lifted out of AgentList — same rationale as
 * pinSort.ts — so the ordering invariant is unit-testable without React.
 */
export function reconcileOrder(
  prevOrder: string[] | null,
  currentIds: string[],
): string[] | null {
  if (!prevOrder) return null;
  const currentSet = new Set(currentIds);
  const kept = prevOrder.filter((id) => currentSet.has(id));
  const keptSet = new Set(kept);
  const appended = currentIds.filter((id) => !keptSet.has(id));
  return [...kept, ...appended];
}
