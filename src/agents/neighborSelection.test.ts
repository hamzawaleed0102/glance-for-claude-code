import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neighborAfterRemoval } from './neighborSelection';

test('selects the previous card when a middle card is removed', () => {
  assert.equal(neighborAfterRemoval(['a', 'b', 'c', 'd'], 'c'), 'b');
});

test('selects the previous card when the last card is removed', () => {
  assert.equal(neighborAfterRemoval(['a', 'b', 'c'], 'c'), 'b');
});

test('falls back to the next card when the first card is removed', () => {
  assert.equal(neighborAfterRemoval(['a', 'b', 'c'], 'a'), 'b');
});

test('returns null when the only card is removed', () => {
  assert.equal(neighborAfterRemoval(['a'], 'a'), null);
});

test('returns null when the removed id is not in the list', () => {
  assert.equal(neighborAfterRemoval(['a', 'b'], 'z'), null);
});
