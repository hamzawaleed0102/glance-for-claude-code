import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRename, decideFlush } from './renameSync';

test('decideRename sends when idle and input clean', () => {
  assert.equal(
    decideRename({ title: 'Auth bug', streaming: false, inputDirty: false, lastSent: null }),
    'send',
  );
});

test('decideRename queues while Claude is streaming', () => {
  assert.equal(
    decideRename({ title: 'Auth bug', streaming: true, inputDirty: false, lastSent: null }),
    'queue',
  );
});

test('decideRename queues when the user has typed into the box', () => {
  assert.equal(
    decideRename({ title: 'Auth bug', streaming: false, inputDirty: true, lastSent: null }),
    'queue',
  );
});

test('decideRename skips a title already echoed', () => {
  assert.equal(
    decideRename({ title: 'Auth bug', streaming: false, inputDirty: false, lastSent: 'Auth bug' }),
    'skip',
  );
});

test('decideRename re-sends a title that differs from the last echoed', () => {
  assert.equal(
    decideRename({ title: 'Auth bug fix', streaming: false, inputDirty: false, lastSent: 'Auth bug' }),
    'send',
  );
});

test('decideFlush skips when nothing is queued', () => {
  assert.equal(
    decideFlush({ pending: null, inputDirty: false, lastSent: null }),
    'skip',
  );
});

test('decideFlush skips when the queued title was already echoed', () => {
  assert.equal(
    decideFlush({ pending: 'Auth bug', inputDirty: false, lastSent: 'Auth bug' }),
    'skip',
  );
});

test('decideFlush keeps queuing while the user has typed into the box', () => {
  assert.equal(
    decideFlush({ pending: 'Auth bug', inputDirty: true, lastSent: null }),
    'queue',
  );
});

test('decideFlush sends a fresh queued title when the box is clean', () => {
  assert.equal(
    decideFlush({ pending: 'Auth bug', inputDirty: false, lastSent: null }),
    'send',
  );
});
