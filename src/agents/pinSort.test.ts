import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionPinnedFirst } from './pinSort';

test('partitionPinnedFirst preserves order when nothing is pinned', () => {
  const input = new Map<string, { pinned: boolean }>([
    ['A', { pinned: false }],
    ['B', { pinned: false }],
    ['C', { pinned: false }],
  ]);
  const out = partitionPinnedFirst(input);
  assert.deepEqual([...out.keys()], ['A', 'B', 'C']);
});

test('partitionPinnedFirst moves a single pinned to the front', () => {
  const input = new Map<string, { pinned: boolean }>([
    ['A', { pinned: false }],
    ['B', { pinned: true }],
    ['C', { pinned: false }],
  ]);
  const out = partitionPinnedFirst(input);
  assert.deepEqual([...out.keys()], ['B', 'A', 'C']);
});

test('partitionPinnedFirst keeps pinned in insertion order (FIFO)', () => {
  const input = new Map<string, { pinned: boolean }>([
    ['A', { pinned: true }],
    ['B', { pinned: false }],
    ['C', { pinned: true }],
  ]);
  const out = partitionPinnedFirst(input);
  assert.deepEqual([...out.keys()], ['A', 'C', 'B']);
});

test('partitionPinnedFirst keeps unpinned in insertion order within their group', () => {
  const input = new Map<string, { pinned: boolean }>([
    ['A', { pinned: false }],
    ['B', { pinned: true }],
    ['C', { pinned: false }],
    ['D', { pinned: true }],
    ['E', { pinned: false }],
  ]);
  const out = partitionPinnedFirst(input);
  assert.deepEqual([...out.keys()], ['B', 'D', 'A', 'C', 'E']);
});

test('partitionPinnedFirst is a no-op when input already satisfies the invariant', () => {
  const input = new Map<string, { pinned: boolean }>([
    ['B', { pinned: true }],
    ['D', { pinned: true }],
    ['A', { pinned: false }],
    ['C', { pinned: false }],
  ]);
  const out = partitionPinnedFirst(input);
  assert.deepEqual([...out.keys()], ['B', 'D', 'A', 'C']);
});

test('partitionPinnedFirst returns a new Map (does not mutate input)', () => {
  const input = new Map<string, { pinned: boolean }>([
    ['A', { pinned: false }],
    ['B', { pinned: true }],
  ]);
  const before = [...input.keys()];
  partitionPinnedFirst(input);
  assert.deepEqual([...input.keys()], before, 'input Map should be unchanged');
});

test('partitionPinnedFirst preserves the same value references', () => {
  const aVal = { pinned: false };
  const bVal = { pinned: true };
  const input = new Map<string, { pinned: boolean }>([
    ['A', aVal],
    ['B', bVal],
  ]);
  const out = partitionPinnedFirst(input);
  assert.equal(out.get('A'), aVal);
  assert.equal(out.get('B'), bVal);
});
