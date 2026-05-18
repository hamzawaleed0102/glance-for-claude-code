/**
 * Which card should become active when `removedId` is killed.
 *
 * Picks the card *before* it in the list so focus stays where the user
 * was — the old behavior (jump to the first card) yanked the selection
 * to the top of the list and smooth-scrolled the panel away from the
 * delete site. Falls back to the next card when the removed one was
 * first, and `null` when it was the only card.
 *
 * `ids` must be in display order and captured BEFORE the removal.
 * Extracted as a pure function — same rationale as pinSort.ts /
 * reconcileOrder.ts — so the selection rule is unit-testable without an
 * AgentManager.
 */
export function neighborAfterRemoval(
  ids: string[],
  removedId: string,
): string | null {
  const idx = ids.indexOf(removedId);
  if (idx < 0) return null;
  if (ids.length <= 1) return null;
  return idx > 0 ? ids[idx - 1] : ids[idx + 1];
}
