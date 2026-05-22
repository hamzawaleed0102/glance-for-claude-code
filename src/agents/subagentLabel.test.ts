import test from 'node:test';
import assert from 'node:assert/strict';
import { subagentLabel } from './subagentLabel';

test('uses the description field when present', () => {
  assert.equal(subagentLabel({ description: 'explore api routes' }), 'explore api routes');
});

test('falls back to subagent_type when there is no description', () => {
  assert.equal(subagentLabel({ subagent_type: 'Explore' }), 'Explore');
});

test('falls back to "subagent" when neither field is present', () => {
  assert.equal(subagentLabel({ prompt: 'do a thing' }), 'subagent');
});

test('returns "subagent" for a non-object input', () => {
  assert.equal(subagentLabel(null), 'subagent');
  assert.equal(subagentLabel('nope'), 'subagent');
});

test('truncates an over-long description', () => {
  const long = 'a'.repeat(80);
  const out = subagentLabel({ description: long });
  assert.equal(out.length, 60);
  assert.ok(out.endsWith('…'));
});
