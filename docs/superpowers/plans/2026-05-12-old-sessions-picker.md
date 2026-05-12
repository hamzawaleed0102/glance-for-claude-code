# Old Sessions Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dropdown above the Agents panel that lists past Claude Code sessions for the current workspace and reopens any of them as a new agent card via `claude --resume`.

**Architecture:** Pure host-side scanner reads `~/.claude/projects/<encoded-cwd>/*.jsonl` on demand, extracts the first usable user prompt + mtime, and sends the list to the webview over typed postMessage. Selection round-trips back through a new `AgentManager.openOldSession` that reuses the existing dormant-revive code path.

**Tech Stack:** TypeScript, React 18, node-pty (existing), node:fs/readline, node:test for the scanner.

**Spec reference:** `docs/superpowers/specs/2026-05-12-old-sessions-picker-design.md`.

---

## Task 1: Add `OldSession` type and message variants to shared messages

**Files:**
- Modify: `src/shared/messages.ts`

- [ ] **Step 1: Add the `OldSession` interface and three new message variants**

Edit `src/shared/messages.ts`. Add the `OldSession` interface immediately after the existing `AgentSnapshot` interface (so all shared types stay grouped at the top), then extend the two existing unions.

After:
```ts
  starting: boolean;
}
```

Insert:
```ts
/**
 * One past Claude Code session for the current workspace, as surfaced by
 * the "Open old session" picker. Synthesized host-side from
 * ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl — Claude doesn't
 * store an explicit title, so `firstPrompt` is the first usable user
 * message text (truncated to 200 chars). `null` means no usable prompt
 * was found; the UI renders that as "untitled session".
 */
export interface OldSession {
  sessionId: string;
  firstPrompt: string | null;
  mtimeMs: number;
}
```

Then extend the `HostToWebview` union — add this variant at the end (before the closing `;`):
```ts
  /**
   * Reply to `listOldSessions`. Always fired even if the list is empty
   * (e.g. no past sessions for this workspace) so the picker can flip
   * out of its loading state.
   */
  | { type: 'oldSessions'; sessions: OldSession[] };
```

Extend the `WebviewToHost` union — add these two variants at the end (before the closing `;`):
```ts
  /**
   * User opened the old-sessions picker. Host scans the workspace's
   * Claude project dir and replies with `oldSessions`. Fetched every
   * open — no client-side cache — so freshly-finished sessions show up.
   */
  | { type: 'listOldSessions' }
  /**
   * User picked a session in the picker. Host spawns a new agent card
   * with `claude --resume <sessionId>` using the same cwd as `newAgent`.
   */
  | { type: 'openOldSession'; sessionId: string };
```

- [ ] **Step 2: Run the build to verify both runtimes still type-check**

Run: `pnpm run build`
Expected: success. No type errors. The new types are unused so far — that's fine; subsequent tasks consume them.

- [ ] **Step 3: Commit**

```bash
git add src/shared/messages.ts
git commit -m "feat(types): add OldSession type and picker message variants

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Implement the session scanner (TDD)

**Files:**
- Create: `src/agents/sessionScanner.ts`
- Create: `src/agents/sessionScanner.test.ts`
- Modify: `esbuild.config.mjs:30-35` (testEntries)
- Modify: `package.json:40` (scripts.test)

- [ ] **Step 1: Add the test file with all scanner test cases**

Create `src/agents/sessionScanner.test.ts` with the following exact content. The tests use Node's built-in `node:test` runner (matching the project's existing convention in `extractMarkers.test.ts`). Each test creates an isolated tmpdir under `os.tmpdir()` so they can run in parallel safely.

```ts
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
```

- [ ] **Step 2: Create the scanner module (no implementation yet — empty exports)**

Create `src/agents/sessionScanner.ts` with just the exports so the test file imports resolve:

```ts
import type { OldSession } from '../shared/messages';
export type { OldSession };

export function encodeCwd(_cwd: string): string {
  throw new Error('not implemented');
}

export async function listOldSessions(
  _cwd: string,
  _excludeSessionIds: Set<string>,
): Promise<OldSession[]> {
  throw new Error('not implemented');
}
```

- [ ] **Step 3: Register the new test files in esbuild and package.json**

Edit `esbuild.config.mjs`. Locate the `testEntries` array (around line 30) and add both files:

```js
const testEntries = [
  'src/markers/extractMarkers.ts',
  'src/markers/extractMarkers.test.ts',
  'src/markers/transcriptWatcher.ts',
  'src/markers/transcriptWatcher.test.ts',
  'src/agents/sessionScanner.ts',
  'src/agents/sessionScanner.test.ts',
];
```

Edit `package.json`. Replace the `test` script value (line 40):

```json
    "test": "node --test out/extractMarkers.test.js out/transcriptWatcher.test.js out/sessionScanner.test.js",
```

- [ ] **Step 4: Run tests to verify they fail with "not implemented"**

Run: `pnpm run build && pnpm run test`
Expected: build succeeds; tests fail with `Error: not implemented` thrown from `encodeCwd` / `listOldSessions`. The `encodeCwd` test should fail first.

- [ ] **Step 5: Implement the scanner**

Replace the entire contents of `src/agents/sessionScanner.ts` with:

```ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { OldSession } from '../shared/messages';

export type { OldSession };

const MAX_PROMPT_CHARS = 200;
const MAX_SCAN_LINES = 200;

/**
 * Convert an absolute filesystem path into the slug Claude Code uses
 * for its per-project directory under ~/.claude/projects/. Verified
 * against the actual directory layout: every `/` becomes `-`, dots
 * and other characters pass through unchanged.
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

/**
 * List Claude Code sessions for `cwd`, omitting any session whose id is
 * in `excludeSessionIds`. Reads ~/.claude/projects/<encoded-cwd>/*.jsonl,
 * extracting the first user-typed prompt (truncated to 200 chars) and
 * the file mtime. Returns sorted by mtimeMs descending.
 *
 * Failure modes are silent: missing dir, unreadable files, malformed
 * JSONL lines — each yields the safest fallback (empty list, skipped
 * file, skipped line). Throwing here would break the picker; the user
 * just sees a shorter list.
 */
export async function listOldSessions(
  cwd: string,
  excludeSessionIds: Set<string>,
): Promise<OldSession[]> {
  const projectDir = path.join(
    os.homedir(),
    '.claude',
    'projects',
    encodeCwd(cwd),
  );

  let entries: string[];
  try {
    entries = fs.readdirSync(projectDir);
  } catch {
    return [];
  }

  const candidates = entries
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => ({ name, sessionId: name.slice(0, -'.jsonl'.length) }))
    .filter((c) => !excludeSessionIds.has(c.sessionId));

  const results = await Promise.all(
    candidates.map(async ({ name, sessionId }) => {
      const filePath = path.join(projectDir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(filePath).mtimeMs;
      } catch {
        return null;
      }
      let firstPrompt: string | null = null;
      try {
        firstPrompt = await readFirstUserPrompt(filePath);
      } catch (err) {
        console.warn('[glancer] scanner: failed to read', filePath, err);
      }
      const session: OldSession = { sessionId, firstPrompt, mtimeMs };
      return session;
    }),
  );

  return results
    .filter((r): r is OldSession => r !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Stream the JSONL line-by-line until we hit the first record that
 * qualifies as a user-authored prompt, or until MAX_SCAN_LINES is
 * exhausted. Returns the trimmed + truncated content, or null if
 * nothing qualifies. The early-stop avoids reading multi-MB transcripts
 * end-to-end just to surface their first prompt.
 */
function readFirstUserPrompt(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let scanned = 0;
    let found: string | null = null;

    const finish = () => {
      rl.close();
      stream.destroy();
      resolve(found);
    };

    rl.on('line', (line) => {
      scanned++;
      if (scanned > MAX_SCAN_LINES) {
        finish();
        return;
      }
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        return; // skip malformed line
      }
      const prompt = extractPrompt(record);
      if (prompt !== null) {
        found = prompt;
        finish();
      }
    });
    rl.on('close', () => resolve(found));
    rl.on('error', () => resolve(found));
    stream.on('error', () => resolve(found));
  });
}

function extractPrompt(record: unknown): string | null {
  if (typeof record !== 'object' || record === null) return null;
  const r = record as {
    type?: unknown;
    isMeta?: unknown;
    message?: { content?: unknown };
  };
  if (r.type !== 'user') return null;
  if (r.isMeta === true) return null;
  const content = r.message?.content;
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('<local-command-caveat>')) return null;
  return trimmed.slice(0, MAX_PROMPT_CHARS);
}
```

- [ ] **Step 6: Run tests to verify all pass**

Run: `pnpm run build && pnpm run test`
Expected: build succeeds; all tests pass, including the 3 pre-existing test files. Output lines should include `# pass 12` (or higher) for the new file.

- [ ] **Step 7: Commit**

```bash
git add src/agents/sessionScanner.ts src/agents/sessionScanner.test.ts esbuild.config.mjs package.json
git commit -m "feat(scanner): read past Claude Code sessions from disk

Pure module that scans ~/.claude/projects/<encoded-cwd>/*.jsonl,
streams each transcript for the first usable user prompt, and
returns mtime-sorted records. Tested via node:test against tmpdir
fixtures with a controlled HOME.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Add `listOldSessions` and `openOldSession` methods to `AgentManager`

**Files:**
- Modify: `src/agents/AgentManager.ts`

- [ ] **Step 1: Import the scanner**

Edit `src/agents/AgentManager.ts`. The existing import block ends with:

```ts
import type { AgentSnapshot, ClaudeModel } from '../shared/messages';
```

Add this line directly after it:

```ts
import { listOldSessions as scanOldSessions, type OldSession } from './sessionScanner';
```

- [ ] **Step 2: Add the two new public methods on `AgentManager`**

Locate the `newAgent` method (around line 338). Insert these two methods immediately after `newAgent` (and before `kill`):

```ts
  /**
   * Return past Claude Code sessions for `cwd`, excluding any whose
   * sessionId is currently held by a live agent in this manager. The
   * scanner is pure and async; this method just plumbs the open-agent
   * set and delegates.
   */
  listOldSessions(cwd: string): Promise<OldSession[]> {
    const open = new Set<string>();
    for (const a of this.agents.values()) {
      if (a.sessionId) open.add(a.sessionId);
    }
    return scanOldSessions(cwd, open);
  }

  /**
   * Open an existing Claude Code session as a new agent card. Spawns
   * the PTY immediately with `claude --resume <sessionId>` via the
   * normal makeAgent path. `hasUserPrompt: true` is hard-coded because
   * a session already on disk must have user prompts — otherwise the
   * resume would fail anyway, and Agent.onExit would drop it to
   * dormant naturally.
   */
  openOldSession(opts: { cwd: string; sessionId: string }): string {
    const id = nextAgentId(this.agents.keys());
    const agent = this.makeAgent({
      id,
      cwd: opts.cwd,
      model: 'default',
      sessionId: opts.sessionId,
      hasUserPrompt: true,
      dormant: false,
    });
    this.agents.set(id, agent);
    this.changeEmitter.fire({ type: 'added', agent: agent.snapshot() });
    this.setActive(id);
    agent.reveal();
    this.persist();
    return id;
  }
```

- [ ] **Step 3: Build to verify type safety**

Run: `pnpm run build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add src/agents/AgentManager.ts
git commit -m "feat(manager): list and open past sessions via scanner

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Handle new inbound messages in `AgentPanelProvider`

**Files:**
- Modify: `src/view/AgentPanelProvider.ts`

- [ ] **Step 1: Add `listOldSessions` and `openOldSession` handlers**

Edit `src/view/AgentPanelProvider.ts`. Locate the `handle(m: WebviewToHost)` method's switch statement (around line 186). Add these two cases immediately before the closing `}` of the switch (i.e., after the `case 'reorder':` block):

```ts
      case 'listOldSessions': {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!cwd) {
          this.view?.webview.postMessage({
            type: 'oldSessions',
            sessions: [],
          } satisfies HostToWebview);
          return;
        }
        this.manager.listOldSessions(cwd).then((sessions) => {
          this.view?.webview.postMessage({
            type: 'oldSessions',
            sessions,
          } satisfies HostToWebview);
        });
        break;
      }
      case 'openOldSession': {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!cwd) {
          vscode.window.showWarningMessage('Open a workspace folder first.');
          return;
        }
        const id = this.manager.openOldSession({ cwd, sessionId: m.sessionId });
        // Reuse the same focus-race protection as `newAgent` — VS Code
        // launch is busy for a few hundred ms after the PTY attaches.
        this.pendingFocusTerminalId = id;
        this.scheduleFocusRetries(id);
        break;
      }
```

- [ ] **Step 2: Build to verify the switch covers all message variants**

Run: `pnpm run build`
Expected: success. TypeScript will catch any missed message variant via exhaustiveness.

- [ ] **Step 3: Commit**

```bash
git add src/view/AgentPanelProvider.ts
git commit -m "feat(provider): wire listOldSessions and openOldSession handlers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Build the `OldSessionsPicker` React component

**Files:**
- Create: `src/view/webview/OldSessionsPicker.tsx`
- Modify: `src/view/webview/styles.css`

- [ ] **Step 1: Create the React component**

Create `src/view/webview/OldSessionsPicker.tsx` with the following content:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import type { OldSession } from '../../shared/messages';
import { postToHost } from './api';

interface Props {
  /**
   * Latest list of past sessions from the host. `null` means a fetch is
   * in-flight (or never started); the popover shows a loading row in
   * that case. Reset to `null` by the parent every time the popover
   * opens so a stale result from the previous open doesn't briefly
   * flash before the new fetch arrives.
   */
  sessions: OldSession[] | null;
  /** Parent flips this back to `null` when invoking `onOpen()` requests a fresh fetch. */
  onOpen: () => void;
}

/**
 * Build a human-friendly relative-time string for a file mtime.
 * Decision boundaries match common UX expectations:
 *   < 60s        → "just now"
 *   < 60min      → "Nm ago"
 *   < 24h        → "Nh ago"
 *   < 48h        → "yesterday"
 *   same year    → "Mon D"
 *   else         → "Mon D, YYYY"
 */
export function formatRelativeTime(mtimeMs: number, now = Date.now()): string {
  const diffMs = now - mtimeMs;
  const min = 60 * 1000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diffMs < min) return 'just now';
  if (diffMs < hour) return `${Math.floor(diffMs / min)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  if (diffMs < 2 * day) return 'yesterday';
  const d = new Date(mtimeMs);
  const month = d.toLocaleString('en-US', { month: 'short' });
  const day_ = d.getDate();
  const sameYear = new Date(now).getFullYear() === d.getFullYear();
  return sameYear ? `${month} ${day_}` : `${month} ${day_}, ${d.getFullYear()}`;
}

function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

export function OldSessionsPicker({ sessions, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [highlightIdx, setHighlightIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Filtered + highlight-bounded list. Recomputed cheaply on every render
  // — 68 items per workspace is the realistic upper bound, no need to
  // memoize beyond `useMemo` for the filter result.
  const filtered = useMemo(() => {
    if (!sessions) return [];
    const f = filter.trim().toLowerCase();
    if (!f) return sessions;
    return sessions.filter((s) => {
      if (s.sessionId.toLowerCase().includes(f)) return true;
      if (s.firstPrompt && s.firstPrompt.toLowerCase().includes(f)) return true;
      return false;
    });
  }, [sessions, filter]);

  // Click-outside to close. Listens at the document level so any click
  // anywhere outside the picker collapses it.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Whenever the popover opens, reset filter + highlight and ask the
  // host for a fresh list. The parent clears `sessions` to null on
  // `onOpen()` so the loading row renders correctly.
  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setFilter('');
    setHighlightIdx(0);
    onOpen();
    setOpen(true);
    // Focus the filter input after the popover paints.
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const choose = (sessionId: string) => {
    setOpen(false);
    postToHost({ type: 'openOldSession', sessionId });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filtered.length === 0) return;
      setHighlightIdx((i) => (i + 1) % filtered.length);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (filtered.length === 0) return;
      setHighlightIdx((i) => (i - 1 + filtered.length) % filtered.length);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const pick = filtered[highlightIdx];
      if (pick) choose(pick.sessionId);
    }
  };

  // Loading == sessions is null and popover open. Empty-after-fetch ==
  // sessions is an empty array. Disabled == we have a definitive empty
  // list AND the popover isn't open yet.
  const loading = open && sessions === null;
  const emptyAfterFetch = sessions !== null && sessions.length === 0;

  return (
    <div className="old-sessions" ref={containerRef}>
      <button
        type="button"
        className={`old-sessions-row${open ? ' open' : ''}`}
        onClick={toggle}
        disabled={emptyAfterFetch && !open}
        title={emptyAfterFetch ? 'no past sessions in this workspace' : undefined}
      >
        <span className="old-sessions-row-label">Open old session</span>
        <svg
          className="chev"
          viewBox="0 0 12 12"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="3 4.5 6 7.5 9 4.5" />
        </svg>
      </button>
      {open && (
        <div className="old-sessions-popover" onKeyDown={onKeyDown}>
          <div className="old-sessions-filter">
            <input
              ref={inputRef}
              placeholder="filter…"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setHighlightIdx(0);
              }}
            />
          </div>
          <div className="old-sessions-list">
            {loading && (
              <div className="old-sessions-empty faint">loading sessions…</div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="old-sessions-empty faint">
                {sessions && sessions.length === 0 ? 'no past sessions' : 'no matches'}
              </div>
            )}
            {!loading &&
              filtered.map((s, i) => (
                <button
                  key={s.sessionId}
                  type="button"
                  className={`old-sessions-item${i === highlightIdx ? ' active' : ''}`}
                  onMouseEnter={() => setHighlightIdx(i)}
                  onClick={() => choose(s.sessionId)}
                >
                  <span
                    className={`old-sessions-item-title${
                      s.firstPrompt ? '' : ' untitled'
                    }`}
                  >
                    {s.firstPrompt ?? 'untitled session'}
                  </span>
                  <span className="old-sessions-item-meta">
                    {shortId(s.sessionId)} · {formatRelativeTime(s.mtimeMs)}
                  </span>
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add CSS rules to `styles.css`**

Edit `src/view/webview/styles.css`. Append the following block at the end of the file (after the closing `}` of `.model-picker button:hover`):

```css
/* ---------- Old sessions picker ---------- */
.old-sessions {
  position: relative;
  border-bottom: 1px solid var(--border);
}
.old-sessions-row {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  background: transparent;
  border: none;
  color: var(--fg);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  text-align: left;
}
.old-sessions-row:hover:not(:disabled) {
  background: var(--hover);
}
.old-sessions-row:disabled {
  color: var(--muted);
  cursor: not-allowed;
}
.old-sessions-row .chev {
  width: 10px;
  height: 10px;
  transition: transform 160ms ease;
}
.old-sessions-row.open .chev {
  transform: rotate(180deg);
}
.old-sessions-row-label {
  color: var(--muted);
  letter-spacing: 0.02em;
}
.old-sessions-popover {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 10;
  background: var(--vscode-menu-background, #1a1d22);
  border: 1px solid var(--border);
  border-top: none;
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.40);
}
.old-sessions-filter {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
.old-sessions-filter input {
  width: 100%;
  padding: 4px 6px;
  box-sizing: border-box;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  font: inherit;
}
.old-sessions-list {
  flex: 1;
  overflow: auto;
}
.old-sessions-empty {
  padding: 12px;
  text-align: center;
  font-size: 11px;
}
.old-sessions-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 8px 10px;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border);
  color: var(--fg);
  cursor: pointer;
  font: inherit;
  text-align: left;
}
.old-sessions-item:last-child {
  border-bottom: none;
}
.old-sessions-item.active,
.old-sessions-item:hover {
  background: var(--active);
}
.old-sessions-item-title {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.old-sessions-item-title.untitled {
  color: var(--muted);
  font-style: italic;
}
.old-sessions-item-meta {
  font-size: 10.5px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 3: Build to verify component + CSS compile**

Run: `pnpm run build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add src/view/webview/OldSessionsPicker.tsx src/view/webview/styles.css
git commit -m "feat(webview): OldSessionsPicker component + styles

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Mount `OldSessionsPicker` in `main.tsx` and dispatch `oldSessions`

**Files:**
- Modify: `src/view/webview/main.tsx`

- [ ] **Step 1: Add import, state, and inbound dispatch**

Edit `src/view/webview/main.tsx`.

Replace the existing import block at the top (lines 1-5) with:

```tsx
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import type { AgentSnapshot, HostToWebview, OldSession } from '../../shared/messages';
import { AgentList } from './AgentList';
import { OldSessionsPicker } from './OldSessionsPicker';
import { listenFromHost, postToHost } from './api';
```

Locate the `App` component's state block (lines 36-37) and add an `oldSessions` state directly after `activeId`:

```tsx
function App() {
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [oldSessions, setOldSessions] = useState<OldSession[] | null>(null);
```

In the inbound message dispatcher (the `switch (m.type)` inside the second `useEffect`), add a new case alongside the existing ones — insert immediately before `case 'playTone':`:

```tsx
        case 'oldSessions':
          setOldSessions(m.sessions);
          break;
```

Replace the JSX returned by `App` (the final `return (...)` block) with:

```tsx
  return (
    <>
      <OldSessionsPicker
        sessions={oldSessions}
        onOpen={() => {
          // Wipe the previous list so the loading row shows while the
          // host scans — guarantees stale results from an earlier open
          // never flash on screen.
          setOldSessions(null);
          postToHost({ type: 'listOldSessions' });
        }}
      />
      <AgentList
        agents={agents}
        activeId={activeId}
        onSelect={(id) => postToHost({ type: 'select', id })}
        onKill={(id) => postToHost({ type: 'kill', id })}
      />
    </>
  );
}
```

- [ ] **Step 2: Build**

Run: `pnpm run build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add src/view/webview/main.tsx
git commit -m "feat(webview): mount OldSessionsPicker above agent list

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: End-to-end smoke test in the Extension Development Host

There are no automated tests for the React component, the provider wiring, or the AgentManager methods (they all depend on VS Code APIs the repo doesn't mock). This task verifies the integrated path manually.

- [ ] **Step 1: Launch the Extension Development Host**

Open the project in VS Code. Press `F5` (or Run → Start Debugging) with the `pnpm run build` already complete. A second VS Code window opens labelled `[Extension Development Host]`.

In the dev host, open this same `glancer-vscode` workspace folder. The Glance activity-bar icon should be visible; click it to reveal the panel.

- [ ] **Step 2: Verify the picker renders and lists sessions**

Expected:
- A row labelled `Open old session ▾` sits at the very top of the Glance sidebar, above the `Agents` header.
- Clicking the row opens a popover with a filter input and a scrollable list.
- The first ~5 items show the first user prompt from each past session, with `<shortId> · <relative-time>` underneath.
- Items are sorted with the most recently modified at the top.
- The chevron rotates 180° when the popover is open.

- [ ] **Step 3: Verify "already open" filtering**

Note the `sessionId` of one of the items in the picker (visible as the short id on the meta line, but for the test you need the full one — easier: pick any one, open it, then re-open the picker and confirm it's gone).

Close the picker, click an item to open it as a new agent card. Wait for the card to spawn (status dot turns blue/starting). Re-open the picker.

Expected: the session you just opened is **not** in the list.

- [ ] **Step 4: Verify keyboard nav**

Open the picker. Press `↓` a few times — the highlighted item should move down the list. Press `↑` — moves up. Press `Enter` — opens the highlighted session as a new card, popover closes. Re-open and press `Escape` — popover closes without selecting anything.

- [ ] **Step 5: Verify filter**

Open the picker. Type a fragment of one of the prompts into the filter input. Expected: list narrows to matching items only. Clear the filter — full list returns.

- [ ] **Step 6: Verify "untitled session" fallback**

If you have any session whose first user prompt is purely a slash command (e.g. a session that was opened and only used `/clear`), it should render as `untitled session` in muted italic. If none exist in your workspace, this case is covered by the unit tests in Task 2; skip the manual step.

- [ ] **Step 7: Verify reload persistence**

Open an old session via the picker. Reload the dev-host window (`Cmd+R` in the dev host, or close-and-reopen). Expected: the agent restored from `sessions.json` appears as a dormant card. Clicking it re-spawns Claude with `--resume`; the picker should still exclude that session id now that it's reopened.

- [ ] **Step 8: Verify empty-state**

Run the dev-host against a workspace that has never had a Claude Code session (e.g. open any folder that's never been used with `claude`). Expected: the `Open old session` row is rendered greyed out, hovering shows the tooltip "no past sessions in this workspace", and clicking it does nothing.

- [ ] **Step 9: Final commit (if any wiring tweaks were needed)**

If steps 2-8 surfaced any bugs, fix them and commit. Otherwise this task ends with no commit.

```bash
git status
# If clean → done.
```
