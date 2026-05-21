import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveShellTitle } from './shellTitle';

test('returns a plain command unchanged', () => {
  assert.equal(deriveShellTitle('npm run dev'), 'npm run dev');
});

test('trims surrounding whitespace', () => {
  assert.equal(deriveShellTitle('  git status  '), 'git status');
});

test('returns null for an empty string', () => {
  assert.equal(deriveShellTitle(''), null);
});

test('returns null for a whitespace-only string', () => {
  assert.equal(deriveShellTitle('   \t  '), null);
});

test('truncates an over-long command with an ellipsis', () => {
  const result = deriveShellTitle('x'.repeat(200));
  assert.equal(result?.length, 120);
  assert.ok(result?.endsWith('…'));
});

test('returns a 120-char command unchanged (boundary)', () => {
  const exact = 'y'.repeat(120);
  assert.equal(deriveShellTitle(exact), exact);
});

test('keeps the original prefix when truncating', () => {
  const input = 'a'.repeat(200);
  const result = deriveShellTitle(input);
  assert.equal(result?.slice(0, 119), 'a'.repeat(119));
});
