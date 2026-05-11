import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMarkers } from './extractMarkers';

test('extracts TL;DR at tail', () => {
  const m = extractMarkers('body line 1\nbody line 2\n🔊 TL;DR: hello world');
  assert.equal(m.tldr, 'hello world');
});

test('extracts title only on its own line at tail', () => {
  const m = extractMarkers('done.\n🏷️ Title: lower case title\n🔊 TL;DR: ok');
  assert.equal(m.title, 'lower case title');
  assert.equal(m.tldr, 'ok');
});

test('ignores marker quoted in body', () => {
  const m = extractMarkers('some text\n🔊 TL;DR: quoted\nmore prose\n');
  assert.equal(m.tldr, undefined);
});

test('extracts needs-input', () => {
  const m = extractMarkers('done.\n⚠️ Needs input: pick a path');
  assert.equal(m.needsInput, 'pick a path');
});

test('extracts error', () => {
  const m = extractMarkers('done.\n❌ Error: build broken');
  assert.equal(m.error, 'build broken');
});

test('extracts progress', () => {
  const m = extractMarkers('🔊 TL;DR: x\n📊 Progress: 0.4 — Refactoring user_test.py');
  assert.deepEqual(m.progress, { value: 0.4, label: 'Refactoring user_test.py' });
});

test('question-mark fallback fills needsInput when marker missing', () => {
  const m = extractMarkers('I checked things.\nWhich one should I pick?');
  assert.equal(m.needsInput, 'Which one should I pick?');
});
