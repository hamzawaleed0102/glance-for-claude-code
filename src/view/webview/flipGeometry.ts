/**
 * A card's vertical position relative to the scroll container's
 * *content* (not the viewport).
 *
 * The FLIP reorder animation compares each card's position between two
 * commits and slides it the difference. If it compared viewport-relative
 * `getBoundingClientRect().top`, an in-flight programmatic smooth-scroll
 * — fired by arrow-key navigation keeping the active card in view —
 * would change every card's top each commit and be misread as a massive
 * reorder, slamming bogus transforms over the scroll (the "hold arrow,
 * screen goes weird / list hides" bug).
 *
 * Subtracting the scroll container's own viewport top and adding its
 * `scrollTop` cancels both scrolling and the container moving, leaving a
 * value that changes ONLY when the card genuinely moves within the list.
 *
 * Extracted as a pure function — same rationale as pinSort.ts /
 * reconcileOrder.ts — so the scroll-invariance property is unit-testable
 * without a DOM.
 *
 * @param cardViewportTop  card's `getBoundingClientRect().top`
 * @param listViewportTop  scroll container's `getBoundingClientRect().top`
 * @param listScrollTop    scroll container's `scrollTop`
 */
export function contentRelativeTop(
  cardViewportTop: number,
  listViewportTop: number,
  listScrollTop: number,
): number {
  return cardViewportTop - listViewportTop + listScrollTop;
}

/**
 * The vertical translation, in pixels, encoded in a CSS computed
 * `transform` string.
 *
 * The FLIP reorder animation measures each card with
 * `getBoundingClientRect()`, which reports the card's *rendered* position
 * — its layout box PLUS any transform currently applied. When a render
 * commits while a previous reorder's `translateY` is still mid-transition
 * (an agent card is deleted, then the active-id change commits a frame
 * later; or a streaming `update_state` lands inside the reorder window),
 * the raw measurement reads that transient animated offset as the card's
 * real position. That feeds a bogus delta — snapping the in-flight
 * animation and polluting the stored positions, so every later commit
 * (including arrow-key navigation) keeps jerking until a transform-free
 * commit re-syncs.
 *
 * Subtracting this value off `getBoundingClientRect().top` recovers the
 * settled layout position, making the FLIP measurement invariant to any
 * animation in flight — the same role `contentRelativeTop` plays for
 * in-flight scrolling.
 *
 * Pure string parsing (deliberately not `DOMMatrix`, which Node lacks) so
 * the property is unit-testable under `node --test` without a DOM.
 *
 * @param transform  a computed `transform` value: `none`,
 *                    `matrix(a,b,c,d,tx,ty)`, or `matrix3d(…16 values…)`
 */
export function parseTranslateY(transform: string): number {
  if (!transform || transform === 'none') return 0;
  // matrix(a, b, c, d, tx, ty) — translateY is the 6th (last) value.
  const m2d = transform.match(/^matrix\(([^)]+)\)$/);
  if (m2d) {
    const parts = m2d[1].split(',').map((n) => parseFloat(n));
    return parts.length === 6 && Number.isFinite(parts[5]) ? parts[5] : 0;
  }
  // matrix3d is a column-major 4×4 — translateY is the 14th value.
  const m3d = transform.match(/^matrix3d\(([^)]+)\)$/);
  if (m3d) {
    const parts = m3d[1].split(',').map((n) => parseFloat(n));
    return parts.length === 16 && Number.isFinite(parts[13]) ? parts[13] : 0;
  }
  // Anything else (a non-matrix transform, garbage) is not a vertical
  // move — return 0 rather than risk feeding a false delta.
  return 0;
}
