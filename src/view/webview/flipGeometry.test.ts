import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentRelativeTop } from './flipGeometry';

// The FLIP reorder animation must measure a card's position relative to
// the scroll container's *content*, not the viewport. Otherwise a
// programmatic smooth-scroll (fired by arrow-key navigation keeping the
// active card in view) is misread as a reorder and every card gets a
// bogus translateY — the "hold arrow, screen goes weird / list hides"
// bug.

test('is invariant under scrolling (the arrow-hold bug)', () => {
  // Card at viewport y=300, list at viewport y=100, scrollTop=0.
  const before = contentRelativeTop(300, 100, 0);
  // List smooth-scrolls down by 80px: card moves up to y=220 in the
  // viewport, list box stays put, scrollTop becomes 80. The card did
  // NOT move within the content — value must be unchanged.
  const after = contentRelativeTop(300 - 80, 100, 80);
  assert.equal(before, after);
});

test('still reflects a genuine layout move (a real reorder)', () => {
  const before = contentRelativeTop(300, 100, 0);
  // No scroll change, but the card's viewport top dropped 50px because
  // a card above it appeared / it was reordered downward.
  const after = contentRelativeTop(350, 100, 0);
  assert.equal(after - before, 50);
});

test('combined scroll + reorder yields only the reorder delta', () => {
  const before = contentRelativeTop(300, 100, 0);
  // Scrolled by 80 AND reordered down by 30: viewport top = 300-80+30.
  const after = contentRelativeTop(300 - 80 + 30, 100, 80);
  assert.equal(after - before, 30);
});

test('accounts for the list box itself moving (panel resize)', () => {
  const before = contentRelativeTop(300, 100, 0);
  // Whole list box shifts down 40px (e.g. a header grew); the card did
  // not move within the content.
  const after = contentRelativeTop(340, 140, 0);
  assert.equal(before, after);
});
