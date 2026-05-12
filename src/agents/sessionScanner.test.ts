import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { encodeCwd, listOldSessions } from './sessionScanner';

// Fixture helper: writes `lines` (JSONL records) to a file named
// <sessionId>.jsonl inside `dir` and returns the absolute path. Each
// element is JSON-stringified onto its own line. Pass a raw string to
// inject a malformed line.
function writeJsonl(dir: string, sessionId: string, lines: unknown[]): string {
  const file = path.join(dir, `${sessionId}.jsonl`);
  const body = lines
    .map((l) => (typeof l === 'string' ? l : JSON.stringify(l)))
    .join('\n');
  fs.writeFileSync(file, body);
  return file;
}

function mkTmpProjectDir(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glance-scanner-test-'));
  // Mimic the layout listOldSessions expects relative to its argument.
  // We pass `tmp` as cwd; the scanner encodes it under HOME, so for the
  // tests we instead invoke the dir-resolution via a small shim: tests
  // set HOME=tmp/home and place files at $HOME/.claude/projects/<enc>/.
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  return tmp;
}

// Build the full project dir for a given cwd inside a fake HOME, returns
// (cwd, projectDir). The scanner uses os.homedir() — tests override HOME.
function setupProjectDir(tmpRoot: string, cwd: string): string {
  const home = path.join(tmpRoot, 'home');
  process.env.HOME = home;
  const projectDir = path.join(
    home,
    '.claude',
    'projects',
    encodeCwd(cwd),
  );
  fs.mkdirSync(projectDir, { recursive: true });
  return projectDir;
}

test('encodeCwd replaces forward slashes with dashes', () => {
  assert.equal(
    encodeCwd('/Users/me/Documents/Projects/foo'),
    '-Users-me-Documents-Projects-foo',
  );
});

test('listOldSessions returns [] when project dir does not exist', async () => {
  const tmp = mkTmpProjectDir();
  process.env.HOME = path.join(tmp, 'home');
  const result = await listOldSessions('/totally/not/a/real/path', new Set());
  assert.deepEqual(result, []);
});

test('listOldSessions returns [] for empty project dir', async () => {
  const tmp = mkTmpProjectDir();
  setupProjectDir(tmp, '/some/cwd');
  const result = await listOldSessions('/some/cwd', new Set());
  assert.deepEqual(result, []);
});

test('finds first user prompt in multi-record JSONL', async () => {
  const tmp = mkTmpProjectDir();
  const dir = setupProjectDir(tmp, '/cwd1');
  writeJsonl(dir, 'sess-A', [
    { type: 'file-history-snapshot', timestamp: 0 },
    {
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: '<local-command-caveat>nope</local-command-caveat>' },
    },
    {
      type: 'user',
      isMeta: false,
      message: { role: 'user', content: 'fix the login bug please' },
    },
    {
      type: 'assistant',
      message: { role: 'assistant', content: 'sure' },
    },
  ]);
  const result = await listOldSessions('/cwd1', new Set());
  assert.equal(result.length, 1);
  assert.equal(result[0].sessionId, 'sess-A');
  assert.equal(result[0].firstPrompt, 'fix the login bug please');
});

test('skips records whose content is wrapped in <local-command-caveat>', async () => {
  const tmp = mkTmpProjectDir();
  const dir = setupProjectDir(tmp, '/cwd2');
  writeJsonl(dir, 'sess-B', [
    {
      type: 'user',
      isMeta: false,
      message: {
        role: 'user',
        content: '<local-command-caveat>...</local-command-caveat>',
      },
    },
    {
      type: 'user',
      isMeta: false,
      message: { role: 'user', content: 'the real prompt' },
    },
  ]);
  const result = await listOldSessions('/cwd2', new Set());
  assert.equal(result[0].firstPrompt, 'the real prompt');
});

test('skips records whose message.content is an array (tool-use payload)', async () => {
  const tmp = mkTmpProjectDir();
  const dir = setupProjectDir(tmp, '/cwd3');
  writeJsonl(dir, 'sess-C', [
    {
      type: 'user',
      isMeta: false,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'x' }],
      },
    },
    {
      type: 'user',
      isMeta: false,
      message: { role: 'user', content: 'plain text prompt' },
    },
  ]);
  const result = await listOldSessions('/cwd3', new Set());
  assert.equal(result[0].firstPrompt, 'plain text prompt');
});

test('session with no qualifying user message returns firstPrompt: null', async () => {
  const tmp = mkTmpProjectDir();
  const dir = setupProjectDir(tmp, '/cwd4');
  writeJsonl(dir, 'sess-D', [
    { type: 'file-history-snapshot', timestamp: 0 },
    { type: 'assistant', message: { content: 'hi' } },
  ]);
  const result = await listOldSessions('/cwd4', new Set());
  assert.equal(result.length, 1);
  assert.equal(result[0].sessionId, 'sess-D');
  assert.equal(result[0].firstPrompt, null);
});

test('malformed JSON lines do not abort the scan', async () => {
  const tmp = mkTmpProjectDir();
  const dir = setupProjectDir(tmp, '/cwd5');
  writeJsonl(dir, 'sess-E', [
    '{ this is not valid json',
    { type: 'user', isMeta: false, message: { content: 'recovered prompt' } },
  ]);
  const result = await listOldSessions('/cwd5', new Set());
  assert.equal(result[0].firstPrompt, 'recovered prompt');
});

test('truncates first prompt to 200 chars', async () => {
  const tmp = mkTmpProjectDir();
  const dir = setupProjectDir(tmp, '/cwd6');
  const long = 'a'.repeat(500);
  writeJsonl(dir, 'sess-F', [
    { type: 'user', isMeta: false, message: { content: long } },
  ]);
  const result = await listOldSessions('/cwd6', new Set());
  assert.equal(result[0].firstPrompt?.length, 200);
});

test('excludeSessionIds removes matching files', async () => {
  const tmp = mkTmpProjectDir();
  const dir = setupProjectDir(tmp, '/cwd7');
  writeJsonl(dir, 'keep', [
    { type: 'user', isMeta: false, message: { content: 'keep me' } },
  ]);
  writeJsonl(dir, 'drop', [
    { type: 'user', isMeta: false, message: { content: 'drop me' } },
  ]);
  const result = await listOldSessions('/cwd7', new Set(['drop']));
  assert.equal(result.length, 1);
  assert.equal(result[0].sessionId, 'keep');
});

test('sorts results by mtimeMs descending', async () => {
  const tmp = mkTmpProjectDir();
  const dir = setupProjectDir(tmp, '/cwd8');
  const older = writeJsonl(dir, 'older', [
    { type: 'user', isMeta: false, message: { content: 'old' } },
  ]);
  const newer = writeJsonl(dir, 'newer', [
    { type: 'user', isMeta: false, message: { content: 'new' } },
  ]);
  // Force mtime ordering deterministically (some filesystems coalesce
  // writes to the same second).
  const past = new Date('2020-01-01T00:00:00Z');
  const future = new Date('2030-01-01T00:00:00Z');
  fs.utimesSync(older, past, past);
  fs.utimesSync(newer, future, future);
  const result = await listOldSessions('/cwd8', new Set());
  assert.equal(result.length, 2);
  assert.equal(result[0].sessionId, 'newer');
  assert.equal(result[1].sessionId, 'older');
});

test('ignores non-jsonl files in the project dir', async () => {
  const tmp = mkTmpProjectDir();
  const dir = setupProjectDir(tmp, '/cwd9');
  fs.writeFileSync(path.join(dir, 'README.md'), 'not a session');
  writeJsonl(dir, 'real', [
    { type: 'user', isMeta: false, message: { content: 'real one' } },
  ]);
  const result = await listOldSessions('/cwd9', new Set());
  assert.equal(result.length, 1);
  assert.equal(result[0].sessionId, 'real');
});
