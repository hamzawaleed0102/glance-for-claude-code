import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextAgentId } from './ids';

test('nextAgentId returns AG-01 when no agents exist', () => {
  assert.equal(nextAgentId([]), 'AG-01');
});

test('nextAgentId picks the next contiguous id when ids are contiguous', () => {
  assert.equal(nextAgentId(['AG-01', 'AG-02']), 'AG-03');
});

test('nextAgentId reuses the lowest free slot when ids have gaps', () => {
  // This is the behavior that motivated the orphan-state-file wipe in
  // AgentManager.newAgent — when AG-02 is killed, the next spawn lands
  // back on AG-02 and would otherwise inherit any state file left
  // behind at state/AG-02.json.
  assert.equal(nextAgentId(['AG-01', 'AG-03']), 'AG-02');
});

test('nextAgentId ignores non-numeric suffixes', () => {
  assert.equal(nextAgentId(['AG-foo', 'AG-01']), 'AG-02');
});

test('nextAgentId zero-pads to two digits', () => {
  assert.equal(nextAgentId([]), 'AG-01');
  const big = Array.from({ length: 9 }, (_, i) => `AG-0${i + 1}`);
  assert.equal(nextAgentId(big), 'AG-10');
});

test('nextAgentId works with non-Set iterables', () => {
  function* gen() {
    yield 'AG-01';
    yield 'AG-02';
  }
  assert.equal(nextAgentId(gen()), 'AG-03');
});
