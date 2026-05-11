import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastAssistantText } from './transcriptWatcher';

test('returns text of the last assistant message (flat shape)', () => {
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

test('returns text from Claude Code nested-message shape', () => {
  const jsonl = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'doing the thing\n' },
          { type: 'text', text: '🔊 TL;DR: done it' },
        ],
      },
      sessionId: 'abc',
    }),
  ].join('\n');
  const out = lastAssistantText(jsonl);
  assert.match(out, /TL;DR: done it$/);
});

test('skips tool_use blocks and joins only text blocks', () => {
  const jsonl = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'thinking\n' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        { type: 'text', text: '🔊 TL;DR: ran ls' },
      ],
    },
  });
  const out = lastAssistantText(jsonl);
  assert.match(out, /TL;DR: ran ls$/);
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

test('concatenates all assistant text messages within the current turn', () => {
  // Mirrors a real multi-tool-call turn: assistant emits the title in its
  // FIRST message, makes tool calls, then emits TL;DR / progress on its
  // LAST message. The text in between (tool_use blocks and tool_result
  // user messages) carries no prose. The combined output should contain
  // both the head title and the tail markers.
  const jsonl = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'do the thing' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '🏷️ Title: read agent files\n\nReading Agent.ts first.' },
          { type: 'tool_use', id: 't1', name: 'Read', input: {} },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'File does not exist.' }],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text:
              'None of those exist.\n🔊 TL;DR: paths missing\n📊 Progress: 0.2 — Awaiting paths',
          },
        ],
      },
    }),
  ].join('\n');
  const out = lastAssistantText(jsonl);
  // Title at the head, markers at the tail — both must be present.
  assert.match(out, /^🏷️ Title: read agent files/);
  assert.match(out, /📊 Progress: 0\.2 — Awaiting paths$/);
});

test('stops at the most recent real user prompt, ignoring earlier turns', () => {
  const jsonl = [
    JSON.stringify({ role: 'user', content: 'turn 1' }),
    JSON.stringify({ role: 'assistant', content: 'old answer' }),
    JSON.stringify({ role: 'user', content: 'turn 2' }),
    JSON.stringify({ role: 'assistant', content: 'new answer' }),
  ].join('\n');
  // Should NOT include "old answer" from turn 1.
  const out = lastAssistantText(jsonl);
  assert.equal(out, 'new answer');
});

test('tool_result user messages do NOT terminate the turn walk', () => {
  const jsonl = [
    JSON.stringify({ role: 'user', content: 'go' }),
    JSON.stringify({ role: 'assistant', content: 'first half' }),
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'x', content: 'data' }],
      },
    }),
    JSON.stringify({ role: 'assistant', content: 'second half' }),
  ].join('\n');
  const out = lastAssistantText(jsonl);
  assert.equal(out, 'first half\n\nsecond half');
});
