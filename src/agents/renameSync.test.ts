import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRename, decideFlush } from './renameSync';

test('decideRename sends the first rename when the input box is clean', () => {
  assert.equal(
    decideRename({ inputDirty: false, lastSent: null }),
    'send',
  );
});

test('decideRename queues the first rename when the user has typed into the box', () => {
  assert.equal(
    decideRename({ inputDirty: true, lastSent: null }),
    'queue',
  );
});

test('decideRename skips once a rename was already echoed this session', () => {
  assert.equal(
    decideRename({ inputDirty: false, lastSent: 'Auth bug' }),
    'skip',
  );
});

test('decideRename skips a later rename even when the input box is dirty', () => {
  assert.equal(
    decideRename({ inputDirty: true, lastSent: 'Auth bug' }),
    'skip',
  );
});

test('decideFlush skips when nothing is queued', () => {
  assert.equal(
    decideFlush({ pending: null, inputDirty: false, lastSent: null }),
    'skip',
  );
});

test('decideFlush sends a fresh queued title when the box is clean', () => {
  assert.equal(
    decideFlush({ pending: 'Auth bug', inputDirty: false, lastSent: null }),
    'send',
  );
});

test('decideFlush keeps queuing while the user has typed into the box', () => {
  assert.equal(
    decideFlush({ pending: 'Auth bug', inputDirty: true, lastSent: null }),
    'queue',
  );
});

test('decideFlush skips a queued title once a rename was already echoed this session', () => {
  assert.equal(
    decideFlush({ pending: 'New title', inputDirty: false, lastSent: 'Auth bug' }),
    'skip',
  );
});
