import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastAssistantText } from './transcriptWatcher';

test('returns text of the last assistant message', () => {
  const jsonl = [
    JSON.stringify({ role: 'user', content: 'hi' }),
    JSON.stringify({ role: 'assistant', content: 'old' }),
    JSON.stringify({ role: 'user', content: 'next' }),
    JSON.stringify({
      role: 'assistant',
      content: [
        { type: 'text', text: 'hello\n' },
        { type: 'text', text: '🔊 TL;DR: hi there' },
      ],
    }),
  ].join('\n');
  const out = lastAssistantText(jsonl);
  assert.match(out, /TL;DR: hi there$/);
});

test('returns empty string when no assistant message present', () => {
  const jsonl = JSON.stringify({ role: 'user', content: 'only user' });
  assert.equal(lastAssistantText(jsonl), '');
});

test('tolerates trailing partial line', () => {
  const jsonl =
    JSON.stringify({ role: 'assistant', content: 'complete' }) +
    '\n{"role":"assistant","content":"part';
  assert.equal(lastAssistantText(jsonl), 'complete');
});
