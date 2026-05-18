import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileOrder } from './reconcileOrder';

test('returns null when there is no prior user-defined order', () => {
  assert.equal(reconcileOrder(null, ['a', 'b', 'c']), null);
});

test('preserves the user-defined order when the agent set is unchanged', () => {
  assert.deepEqual(
    reconcileOrder(['c', 'a', 'b'], ['a', 'b', 'c']),
    ['c', 'a', 'b'],
  );
});

test('drops a removed id without resorting the rest (the delete bug)', () => {
  // User dragged to [c, a, b]; then deletes `a`. The remaining cards
  // must keep their dragged relative order — NOT snap back to [b, c].
  assert.deepEqual(
    reconcileOrder(['c', 'a', 'b'], ['b', 'c']),
    ['c', 'b'],
  );
});

test('appends a newly-added id at the end, keeping the dragged order', () => {
  assert.deepEqual(
    reconcileOrder(['c', 'a', 'b'], ['a', 'b', 'c', 'd']),
    ['c', 'a', 'b', 'd'],
  );
});

test('handles simultaneous removal and addition', () => {
  assert.deepEqual(
    reconcileOrder(['c', 'a', 'b'], ['c', 'b', 'd']),
    ['c', 'b', 'd'],
  );
});

test('appends multiple new ids in their arrival order', () => {
  assert.deepEqual(
    reconcileOrder(['b', 'a'], ['a', 'b', 'x', 'y']),
    ['b', 'a', 'x', 'y'],
  );
});
