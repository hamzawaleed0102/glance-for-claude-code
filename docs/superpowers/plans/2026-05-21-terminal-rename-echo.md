# Terminal `/rename` echo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Claude sets a new card title via `update_state`, Glance echoes `/rename <title>` + Enter into that session's terminal — but only when Claude is idle and the user has not typed into the input box.

**Architecture:** A new pure module (`renameSync.ts`) holds the safe/queue/skip decision logic. `pseudoterminal.ts` gains a `sendInput` channel (extension-injected input, bypasses `handleInput`) and an `onUserInput` event (real keystrokes only). `Agent.ts` tracks a best-effort `_inputDirty` flag, calls the decision functions when an AI title lands, and flushes a queued echo on the next `Stop` hook.

**Tech Stack:** TypeScript, VS Code extension API, `node-pty`, esbuild, `node:test`.

**Spec:** `docs/superpowers/specs/2026-05-21-terminal-rename-echo-design.md`

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/agents/renameSync.ts` (new) | Pure decision logic: `decideRename`, `decideFlush`. No I/O, no state. |
| `src/agents/renameSync.test.ts` (new) | `node:test` unit coverage for the pure module. |
| `src/agents/pseudoterminal.ts` (modify) | Add `sendInput(text)` and the `onUserInput` event to `ClaudePty`. |
| `src/agents/Agent.ts` (modify) | Track `_inputDirty` / `_pendingRename` / `_lastSentRename`; wire `onUserInput`, `clearTransient`, `notifyTurnComplete`, `applyState`, `resetCardState`; migrate `clearActive` to `sendInput`. |
| `esbuild.config.mjs` (modify) | Register the new module + test in `testEntries`. |
| `package.json` (modify) | Add the compiled test file to the `test` script. |

`Agent` owns all mutable state and performs I/O; `renameSync.ts` is pure so the
branching logic is unit-testable without a VS Code or `node-pty` harness.

---

## Task 0: Create the feature branch

**Files:** none (git only).

- [ ] **Step 1: Confirm the repo and branch**

Run: `cd glancer-vscode && git rev-parse --is-inside-work-tree && git branch --show-current`
Expected: `true` then `main`.

- [ ] **Step 2: Create and switch to the feature branch**

Run: `git checkout -b feat/terminal-rename-echo`
Expected: `Switched to a new branch 'feat/terminal-rename-echo'`

- [ ] **Step 3: Commit the already-written design spec**

```bash
git add docs/superpowers/specs/2026-05-21-terminal-rename-echo-design.md docs/superpowers/plans/2026-05-21-terminal-rename-echo.md
git commit -m "docs: add terminal /rename echo design spec and plan"
```

---

## Task 1: Pure decision module `renameSync.ts`

**Files:**
- Create: `src/agents/renameSync.ts`
- Test: `src/agents/renameSync.test.ts`
- Modify: `esbuild.config.mjs:34-55` (the `testEntries` array)
- Modify: `package.json:40` (the `test` script)

- [ ] **Step 1: Write the failing test**

Create `src/agents/renameSync.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRename, decideFlush } from './renameSync';

test('decideRename sends when idle and input clean', () => {
  assert.equal(
    decideRename({ title: 'Auth bug', streaming: false, inputDirty: false, lastSent: null }),
    'send',
  );
});

test('decideRename queues while Claude is streaming', () => {
  assert.equal(
    decideRename({ title: 'Auth bug', streaming: true, inputDirty: false, lastSent: null }),
    'queue',
  );
});

test('decideRename queues when the user has typed into the box', () => {
  assert.equal(
    decideRename({ title: 'Auth bug', streaming: false, inputDirty: true, lastSent: null }),
    'queue',
  );
});

test('decideRename skips a title already echoed', () => {
  assert.equal(
    decideRename({ title: 'Auth bug', streaming: false, inputDirty: false, lastSent: 'Auth bug' }),
    'skip',
  );
});

test('decideRename re-sends a title that differs from the last echoed', () => {
  assert.equal(
    decideRename({ title: 'Auth bug fix', streaming: false, inputDirty: false, lastSent: 'Auth bug' }),
    'send',
  );
});

test('decideFlush skips when nothing is queued', () => {
  assert.equal(
    decideFlush({ pending: null, inputDirty: false, lastSent: null }),
    'skip',
  );
});

test('decideFlush skips when the queued title was already echoed', () => {
  assert.equal(
    decideFlush({ pending: 'Auth bug', inputDirty: false, lastSent: 'Auth bug' }),
    'skip',
  );
});

test('decideFlush keeps queuing while the user has typed into the box', () => {
  assert.equal(
    decideFlush({ pending: 'Auth bug', inputDirty: true, lastSent: null }),
    'queue',
  );
});

test('decideFlush sends a fresh queued title when the box is clean', () => {
  assert.equal(
    decideFlush({ pending: 'Auth bug', inputDirty: false, lastSent: null }),
    'send',
  );
});
```

- [ ] **Step 2: Register the new files in the build**

In `esbuild.config.mjs`, in the `testEntries` array, add two lines after
`'src/agents/shellTitle.test.ts',` (line 48):

```js
  'src/agents/renameSync.ts',
  'src/agents/renameSync.test.ts',
```

In `package.json`, the `test` script (line 40) currently ends with
`out/view/webview/agentListKeymap.test.js`. Append the new compiled test so the
script reads:

```json
    "test": "node --test out/markers/extractMarkers.test.js out/markers/transcriptWatcher.test.js out/agents/sessionScanner.test.js out/agents/ids.test.js out/agents/pinSort.test.js out/agents/neighborSelection.test.js out/view/webview/reconcileOrder.test.js out/view/webview/flipGeometry.test.js out/agents/shellTitle.test.js out/view/webview/agentListKeymap.test.js out/agents/renameSync.test.js",
```

- [ ] **Step 3: Run the build + test to verify it fails**

Run: `pnpm run build && pnpm run test`
Expected: build succeeds; the test run FAILS — `renameSync.test.js` errors because `./renameSync` does not exist (`Cannot find module`).

- [ ] **Step 4: Write the implementation**

Create `src/agents/renameSync.ts`:

```ts
/**
 * Pure decision logic for the terminal `/rename` echo feature.
 *
 * When Claude sets a new card title via `update_state`, Glance echoes
 * `/rename <title>` into the terminal — but only when it is safe: Claude is
 * idle and the user has not typed into the input box. These two pure
 * functions encode "is it safe?" so the stateful Agent stays thin and the
 * logic is unit-testable.
 *
 * See docs/superpowers/specs/2026-05-21-terminal-rename-echo-design.md.
 */

/** What the Agent should do with a candidate rename. */
export type RenameDecision = 'send' | 'queue' | 'skip';

/**
 * Decide what to do when Claude sets a new AI title.
 *  - already echoed this exact title         -> 'skip'
 *  - Claude mid-turn, or user has typed       -> 'queue'
 *  - otherwise                                -> 'send'
 */
export function decideRename(opts: {
  title: string;
  streaming: boolean;
  inputDirty: boolean;
  lastSent: string | null;
}): RenameDecision {
  if (opts.title === opts.lastSent) return 'skip';
  if (opts.streaming || opts.inputDirty) return 'queue';
  return 'send';
}

/**
 * Decide what to do with a queued rename when a turn completes (Stop).
 *  - nothing queued                  -> 'skip'
 *  - queued title already echoed      -> 'skip'  (caller clears the queue)
 *  - user has typed into the box      -> 'queue' (keep waiting)
 *  - otherwise                        -> 'send'
 */
export function decideFlush(opts: {
  pending: string | null;
  inputDirty: boolean;
  lastSent: string | null;
}): RenameDecision {
  if (opts.pending === null) return 'skip';
  if (opts.pending === opts.lastSent) return 'skip';
  if (opts.inputDirty) return 'queue';
  return 'send';
}
```

- [ ] **Step 5: Run the build + test to verify it passes**

Run: `pnpm run build && pnpm run test`
Expected: build succeeds; all `renameSync.test.js` tests PASS; no other test file regresses.

- [ ] **Step 6: Commit**

```bash
git add src/agents/renameSync.ts src/agents/renameSync.test.ts esbuild.config.mjs package.json
git commit -m "feat: add pure renameSync decision module"
```

---

## Task 2: Add `sendInput` + `onUserInput` to the PTY wrapper

**Files:**
- Modify: `src/agents/pseudoterminal.ts` (the `ClaudePty` interface ~line 12-39; `createClaudePty` body)

No unit test — `pseudoterminal.ts` depends on `vscode` and `node-pty` and has no
test harness in this repo (consistent with how it is untested today). Verified
by typecheck + build here, and by the manual smoke test in Task 4.

- [ ] **Step 1: Extend the `ClaudePty` interface**

In `src/agents/pseudoterminal.ts`, in the `ClaudePty` interface, insert these
two members between `onCloseRequested` and `setName` (after the
`onCloseRequested` JSDoc + property, before the `setName` JSDoc):

```ts
  /**
   * Fires whenever the user types into the terminal — any keystroke or paste
   * routed through `Pseudoterminal.handleInput`. Extension-injected input
   * sent via `sendInput` does NOT fire this, so a consumer can treat it as a
   * pure "the user touched the input box" signal.
   */
  onUserInput: vscode.Event<void>;
  /**
   * Write text straight to the underlying PTY, bypassing the `handleInput`
   * path. Used for extension-injected input (slash commands) so it is never
   * mistaken for the user typing. Include a trailing `\r` to submit.
   */
  sendInput(text: string): void;
```

- [ ] **Step 2: Add the `userInputEmitter`**

In `createClaudePty`, after the line
`const closeRequestEmitter = new vscode.EventEmitter<void>();` (line 104), add:

```ts
  const userInputEmitter = new vscode.EventEmitter<void>();
```

- [ ] **Step 3: Fire the emitter from `handleInput`**

Replace the existing `handleInput` method (currently lines 253-255):

```ts
    handleInput(data) {
      proc?.write(data);
    },
```

with:

```ts
    handleInput(data) {
      proc?.write(data);
      // Only real terminal keystrokes / pastes reach handleInput — input
      // injected by the extension goes through `sendInput`, which writes
      // straight to the PTY. So this is a clean "user touched the box" signal.
      userInputEmitter.fire();
    },
```

- [ ] **Step 4: Expose `sendInput` and `onUserInput` on the returned object**

In the returned object, the `setName` method currently looks like:

```ts
    setName(name: string) {
      nameEmitter.fire(name);
    },
```

Immediately after it, add:

```ts
    sendInput(text: string) {
      proc?.write(text);
    },
    onUserInput: userInputEmitter.event,
```

- [ ] **Step 5: Dispose the emitter**

In the returned object's `dispose()` method, alongside the existing
`startupCompleteEmitter.dispose();` / `nameEmitter.dispose();` /
`closeRequestEmitter.dispose();` lines, add:

```ts
      userInputEmitter.dispose();
```

- [ ] **Step 6: Typecheck + build to verify**

Run: `npx tsc -p tsconfig.json --noEmit && pnpm run build`
Expected: no type errors; build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/agents/pseudoterminal.ts
git commit -m "feat: add sendInput and onUserInput to ClaudePty"
```

---

## Task 3: Wire the rename echo into `Agent`

**Files:**
- Modify: `src/agents/Agent.ts` (import ~line 6; fields ~line 133; `spawn` ~line 340; `resetCardState` ~line 427; `notifyTurnComplete` ~line 488; `clearTransient` ~line 545; `clearActive` ~line 642; `applyState` ~line 723)

The new behavior's branching logic lives in `renameSync.ts` and is already
covered by Task 1's unit tests. This task is glue: verified by typecheck +
build, and by the Task 4 smoke test.

- [ ] **Step 1: Import the decision functions**

In `src/agents/Agent.ts`, after the existing import block (after line 6,
`import type { ManagedAgent } from './ManagedAgent';`), add:

```ts
import { decideRename, decideFlush } from './renameSync';
```

- [ ] **Step 2: Add the three state fields**

In the `Agent` class, immediately after the `private _starting = true;` field
(line 133), add:

```ts
  /**
   * Best-effort "the user has typed into the terminal input box" flag. Set
   * true on any keystroke via the PTY's `onUserInput`; set false on
   * UserPromptSubmit and /clear (both empty the box). Gates the `/rename`
   * terminal echo so Glance never concatenates onto half-typed text.
   */
  private _inputDirty = false;
  /** Latest AI title waiting to be echoed as `/rename` once it is safe. */
  private _pendingRename: string | null = null;
  /** Title text of the most recent `/rename` echo Glance sent — loop guard. */
  private _lastSentRename: string | null = null;
```

- [ ] **Step 3: Subscribe to `onUserInput` in `spawn()`**

In `spawn()`, immediately after the `this.claude.onStartupComplete(() => { … });`
block ends (around line 340) and before the closing `}` of `spawn()`, add:

```ts
    // Any real keystroke into the terminal marks the input box "dirty" so
    // the /rename echo waits rather than clobbering half-typed text.
    this.claude.onUserInput(() => {
      this._inputDirty = true;
    });
```

- [ ] **Step 4: Reset the rename state in `resetCardState()`**

In `resetCardState()`, immediately after the method's opening line
`const patch: Partial<AgentSnapshot> = {};` (line 427), add:

```ts
    // The /rename echo state is per-conversation — /clear starts a new one.
    this._pendingRename = null;
    this._lastSentRename = null;
    this._inputDirty = false;
```

- [ ] **Step 5: Clear `_inputDirty` in `clearTransient()`**

In `clearTransient()`, immediately before the line
`const patch: Partial<AgentSnapshot> = {};` (line 546), add:

```ts
    // A submitted prompt empties the input box — the /rename echo is safe
    // to send again.
    this._inputDirty = false;
```

- [ ] **Step 6: Flush a queued echo in `notifyTurnComplete()`**

In `notifyTurnComplete()`, the method currently ends with:

```ts
    if (Object.keys(patch).length > 0) this.changeEmitter.fire(patch);
    this.turnCompleteEmitter.fire();
  }
```

Add `this.flushPendingRename();` as the last statement, so it reads:

```ts
    if (Object.keys(patch).length > 0) this.changeEmitter.fire(patch);
    this.turnCompleteEmitter.fire();
    this.flushPendingRename();
  }
```

- [ ] **Step 7: Add the three rename-echo methods**

In `src/agents/Agent.ts`, immediately after the `clearActive()` method closes
(after line 646 `}`), add:

```ts
  /**
   * Echo `/rename <title>` into the terminal when Claude assigns a new AI
   * title — but only when it is safe (Claude idle, input box clean). When
   * unsafe, the title is queued and `flushPendingRename` retries on the next
   * Stop. See docs/superpowers/specs/2026-05-21-terminal-rename-echo-design.md.
   *
   * `/rename` is not a Claude slash command — this is a deliberate, visible
   * echo in the conversation, not a real session rename.
   */
  private maybeSendRename(title: string): void {
    const decision = decideRename({
      title,
      streaming: this._streaming,
      inputDirty: this._inputDirty,
      lastSent: this._lastSentRename,
    });
    if (decision === 'send') {
      this.sendRename(title);
    } else if (decision === 'queue') {
      this._pendingRename = title;
    }
    // 'skip' — already echoed this exact title; do nothing.
  }

  /** Flush a queued `/rename` echo once a turn completes, if now safe. */
  private flushPendingRename(): void {
    const decision = decideFlush({
      pending: this._pendingRename,
      inputDirty: this._inputDirty,
      lastSent: this._lastSentRename,
    });
    if (decision === 'send' && this._pendingRename !== null) {
      this.sendRename(this._pendingRename);
      this._pendingRename = null;
    } else if (decision === 'skip') {
      this._pendingRename = null;
    }
    // 'queue' — keep _pendingRename; a later Stop retries.
  }

  /**
   * Write `/rename <title>` + Enter straight to the PTY via `sendInput`
   * (bypassing handleInput, so it is not counted as user typing). Strips any
   * CR/LF from the title so the line submits exactly once.
   */
  private sendRename(title: string): void {
    const clean = title.replace(/[\r\n]+/g, ' ').trim();
    if (clean.length === 0) return;
    this.claude?.sendInput(`/rename ${clean}\r`);
    this._lastSentRename = title;
  }
```

- [ ] **Step 8: Trigger `maybeSendRename` from `applyState()`**

In `applyState()`, the AI-title branch currently ends like this:

```ts
      if (next !== null && next !== this._name) {
        this._name = next;
        this._titleSource = 'ai';
        patch.name = next;
        patch.titleSource = 'ai';
        this.claude?.setName(next);
      }
```

Add `this.maybeSendRename(next);` as the last statement inside that `if` block:

```ts
      if (next !== null && next !== this._name) {
        this._name = next;
        this._titleSource = 'ai';
        patch.name = next;
        patch.titleSource = 'ai';
        this.claude?.setName(next);
        this.maybeSendRename(next);
      }
```

- [ ] **Step 9: Migrate `clearActive()` to `sendInput`**

In `clearActive()`, replace the body and update the JSDoc paragraph that
describes the `sendText`/`handleInput` chain. The method's JSDoc currently
contains this paragraph:

```ts
   * `Terminal.sendText` calls our pseudoterminal's `handleInput`, which
   * forwards to node-pty's `write` — Claude sees `/clear<Enter>` exactly
   * as if the user typed it.
```

Replace that paragraph with:

```ts
   * Uses `claude.sendInput` (a direct PTY write) rather than
   * `terminal.sendText` — `sendText` routes through `handleInput`, which
   * would falsely mark the input box dirty for the /rename echo. The PTY
   * still sees `/clear<Enter>` exactly as if the user typed it.
```

Then replace the method body line:

```ts
    this.terminal?.sendText('/clear');
```

with:

```ts
    this.claude?.sendInput('/clear\r');
```

- [ ] **Step 10: Typecheck + build to verify**

Run: `npx tsc -p tsconfig.json --noEmit && pnpm run build`
Expected: no type errors; build succeeds.

- [ ] **Step 11: Run the full test suite**

Run: `pnpm run test`
Expected: all tests PASS, including `renameSync.test.js`; no regressions.

- [ ] **Step 12: Commit**

```bash
git add src/agents/Agent.ts
git commit -m "feat: echo /rename into terminal on AI title update"
```

---

## Task 4: Full verification + manual smoke test

**Files:** none.

- [ ] **Step 1: Clean build + full test + typecheck**

Run: `pnpm run build && pnpm run test && npx tsc -p tsconfig.json --noEmit`
Expected: build succeeds; every test passes; no type errors.

- [ ] **Step 2: Launch the Extension Development Host**

In VS Code with the `glancer-vscode` folder open, press **F5** (after the build
above). A second VS Code window opens with the extension loaded.

- [ ] **Step 3: Smoke test — happy path**

In the Glance panel, create a Claude agent. Send it a first prompt (e.g.
"help me refactor the auth module"). When Claude finishes the turn and the card
title changes from `glance-XX` to an AI title, confirm the terminal shows a
`/rename <that title>` line submitted as the next prompt.

- [ ] **Step 4: Smoke test — dirty-input guard**

Create another Claude agent. Send a first prompt; while Claude is still
streaming, type some text into the Claude input box but do NOT submit. Confirm
that when the turn ends, the `/rename` line is NOT sent (it stays queued).
Submit your typed text; confirm the `/rename` echo is sent after that turn's
Stop.

- [ ] **Step 5: Smoke test — `/clear` still works**

With an agent focused, press the `c c` chord. Confirm `/clear` runs in the
terminal and the card resets to `glance-XX` (verifies the `clearActive`
migration to `sendInput`).

- [ ] **Step 6: Commit any fixes**

If the smoke test surfaced issues, fix them, re-run Step 1, and commit:

```bash
git add -A
git commit -m "fix: address terminal /rename echo smoke-test findings"
```

If no fixes were needed, skip this step.

---

## Self-review notes

**Spec coverage:**
- Trigger on AI title (`applyState` branch) — Task 3 Step 8. ✓
- Action `/rename <title>` + Enter via `sendInput` — Task 3 Step 7 (`sendRename`). ✓
- `_inputDirty` set on keystroke / cleared on UserPromptSubmit — Task 3 Steps 3, 5. ✓
- Queue while streaming/dirty, flush on Stop — Task 3 Steps 6, 7; Task 1 logic. ✓
- `sendInput` bypasses `handleInput` — Task 2 Steps 3, 4. ✓
- `clearActive` migrated so `/clear` does not dirty the flag — Task 3 Step 9. ✓
- `_lastSentRename` loop guard — Task 1 (`decideRename`/`decideFlush`), Task 3 Step 7. ✓
- Per-conversation reset on `/clear` — Task 3 Step 4. ✓
- New test registered in esbuild + package.json — Task 1 Step 2. ✓

**Out of scope (per spec):** no transcript `.jsonl` write; no echo on manual
panel rename; `ShellAgent` untouched.

**Type consistency:** `decideRename` / `decideFlush` signatures and the
`RenameDecision` union are identical between `renameSync.ts` (Task 1 Step 4),
its test (Task 1 Step 1), and the call sites in `Agent.ts` (Task 3 Step 7).
`sendInput` / `onUserInput` names match between the `ClaudePty` interface and
the implementation (Task 2) and the `Agent` call sites (Task 3).
