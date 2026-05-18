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
