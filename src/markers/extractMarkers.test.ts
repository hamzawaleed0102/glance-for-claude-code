import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMarkers } from './extractMarkers';

test('extracts TL;DR at tail', () => {
  const m = extractMarkers('body line 1\nbody line 2\n🔊 TL;DR: hello world');
  assert.equal(m.tldr, 'hello world');
});

test('extracts title only on its own line at tail (legacy fallback)', () => {
  const m = extractMarkers('done.\n🏷️ Title: lower case title\n🔊 TL;DR: ok');
  assert.equal(m.title, 'lower case title');
  assert.equal(m.tldr, 'ok');
});

test('extracts head-anchored title from first non-empty line', () => {
  const m = extractMarkers('🏷️ Title: fix login bug\n\nHere is the plan…\n🔊 TL;DR: fixed it');
  assert.equal(m.title, 'fix login bug');
  assert.equal(m.tldr, 'fixed it');
});

test('head-anchored title ignores leading blank lines', () => {
  const m = extractMarkers('\n\n🏷️ Title: refactor auth\nBody.\n🔊 TL;DR: ok');
  assert.equal(m.title, 'refactor auth');
});

test('head title prefers head over tail when both present', () => {
  const m = extractMarkers(
    '🏷️ Title: head title\nBody.\n🏷️ Title: tail title\n🔊 TL;DR: ok',
  );
  assert.equal(m.title, 'head title');
});

test('head scan skips a leading slash-command line and finds title below', () => {
  const m = extractMarkers(
    '/rename intro-chat\n\n🏷️ Title: intro chat\n\nHere is what I can do.\n🔊 TL;DR: ready',
  );
  assert.equal(m.title, 'intro chat');
  assert.equal(m.tldr, 'ready');
});

test('handles the user-reported short-stories case (slash-command + double-space title)', () => {
  // Verbatim shape of a real failing payload: `/rename …` on line 0, blank
  // line, then `🏷️  Title: …` with TWO spaces after the emoji (Claude
  // sometimes pads emoji that the model treats as visually double-width).
  const text =
    '/rename shr 3 shrt strs\n' +
    '\n' +
    '🏷️  Title: short stories\n' +
    '\n' +
    '1. The Lighthouse Keeper\n' +
    'For forty years he climbed the spiral stairs.\n' +
    '\n' +
    '🔊 TL;DR: Three short stories about a lighthouse keeper.\n' +
    '📊 Progress: 1 — Three stories delivered';
  const m = extractMarkers(text);
  assert.equal(m.title, 'short stories');
  assert.equal(m.tldr, 'Three short stories about a lighthouse keeper.');
  assert.deepEqual(m.progress, { value: 1, label: 'Three stories delivered' });
});

test('head scan strips markdown emphasis around title', () => {
  const m = extractMarkers('**🏷️ Title: fix login**\n\nBody.\n🔊 TL;DR: ok');
  assert.equal(m.title, 'fix login');
});

test('head scan strips heading hash before title', () => {
  const m = extractMarkers('### 🏷️ Title: refactor auth\n\nDone.\n🔊 TL;DR: ok');
  assert.equal(m.title, 'refactor auth');
});

test('head scan stops at first prose line; inline title in body is not picked up', () => {
  // The body has a "🏷️ Title:" fragment inside a prose line (not on its
  // own). The first non-empty, non-slash line is plain prose, so head scan
  // stops there. The tail-anchored fallback also requires a whole-line
  // match, so this inline mention stays out.
  const m = extractMarkers(
    'We could call this the 🏷️ Title: pattern.\n🔊 TL;DR: ok',
  );
  assert.equal(m.title, undefined);
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
