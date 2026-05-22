# Instant `/rename` echo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the terminal `/rename` echo fire the instant Claude updates the card title, instead of waiting for the turn-end `Stop` hook — gated only on whether the user has typed into the input box.

**Architecture:** Drop the `streaming` gate from the pure `decideRename` decision. Move the queued-rename flush from the `Stop` hook (`notifyTurnComplete`) to the `UserPromptSubmit` handler (`clearTransient`) — the dirty→clean transition on submit is the watcher that releases a held rename.

**Tech Stack:** TypeScript, VS Code extension API, esbuild, `node:test`.

**Spec:** `docs/superpowers/specs/2026-05-21-instant-rename-echo-design.md`

---

## File structure

| File | Change |
| --- | --- |
| `src/agents/renameSync.ts` | `decideRename` drops the `streaming` field; JSDoc + header comment updated. |
| `src/agents/renameSync.test.ts` | `decideRename` cases drop `streaming`; streaming-specific cases removed. |
| `src/agents/Agent.ts` | `maybeSendRename` drops `streaming`; `flushPendingRename` call moves from `notifyTurnComplete` to `clearTransient`; comments updated. |

No new files. This modifies the v0.0.27 terminal `/rename` echo feature.

---

## Task 0: Create the feature branch

**Files:** none (git only).

- [ ] **Step 1: Confirm repo and branch**

Run: `cd /Users/hamzawaleed/Documents/Projects/content+glancer+hw.com/glancer-vscode && git branch --show-current`
Expected: `main`.

- [ ] **Step 2: Create the feature branch**

Run: `git checkout -b feat/instant-rename-echo`
Expected: `Switched to a new branch 'feat/instant-rename-echo'`

- [ ] **Step 3: Commit the design spec and this plan**

```bash
git add docs/superpowers/specs/2026-05-21-instant-rename-echo-design.md docs/superpowers/plans/2026-05-21-instant-rename-echo.md
git commit -m "docs: add instant /rename echo design spec and plan"
```

End the commit message body with a blank line then:
`Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`

---

## Task 1: Drop the `streaming` gate from `renameSync`

**Files:**
- Modify: `src/agents/renameSync.ts`
- Modify: `src/agents/renameSync.test.ts`

The behavior change: `decideRename` no longer queues on `streaming`. It queues
only when the input box is dirty. We update the test file first; the typecheck
fails (the new test calls omit the still-required `streaming` field); then we
update the implementation; typecheck and tests pass.

- [ ] **Step 1: Rewrite the test file**

Replace the entire contents of `src/agents/renameSync.test.ts` with:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRename, decideFlush } from './renameSync';

test('decideRename sends when the input box is clean', () => {
  assert.equal(
    decideRename({ title: 'Auth bug', inputDirty: false, lastSent: null }),
    'send',
  );
});

test('decideRename queues when the user has typed into the box', () => {
  assert.equal(
    decideRename({ title: 'Auth bug', inputDirty: true, lastSent: null }),
    'queue',
  );
});

test('decideRename skips a title already echoed', () => {
  assert.equal(
    decideRename({ title: 'Auth bug', inputDirty: false, lastSent: 'Auth bug' }),
    'skip',
  );
});

test('decideRename skips an already-echoed title even when the box is dirty', () => {
  assert.equal(
    decideRename({ title: 'Auth bug', inputDirty: true, lastSent: 'Auth bug' }),
    'skip',
  );
});

test('decideRename re-sends a title that differs from the last echoed', () => {
  assert.equal(
    decideRename({ title: 'Auth bug fix', inputDirty: false, lastSent: 'Auth bug' }),
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

- [ ] **Step 2: Run the typecheck to verify it fails**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: FAIL — errors in `renameSync.test.ts` because the `decideRename`
calls omit the still-required `streaming` property.

- [ ] **Step 3: Update `renameSync.ts`**

In `src/agents/renameSync.ts`, update the file-header comment — change the
sentence that begins "but only when it is safe: Claude is idle and the user
has not typed into the input box" to read "but only when the user has not
typed into the input box".

Then replace the `decideRename` JSDoc block and function (currently the block
starting `/**\n * Decide what to do when Claude sets a new AI title.` through
the closing `}` of `decideRename`) with:

```ts
/**
 * Decide what to do when Claude sets a new card title.
 *  - already echoed this exact title   -> 'skip'
 *  - user has typed into the input box -> 'queue'
 *  - otherwise                         -> 'send'
 *
 * The title === lastSent check runs first — an already-echoed title is
 * always skipped, even when the input box is dirty.
 */
export function decideRename(opts: {
  title: string;
  inputDirty: boolean;
  lastSent: string | null;
}): RenameDecision {
  if (opts.title === opts.lastSent) return 'skip';
  if (opts.inputDirty) return 'queue';
  return 'send';
}
```

Leave `RenameDecision` and `decideFlush` (including its JSDoc) unchanged.

- [ ] **Step 4: Run the typecheck, build, and tests to verify they pass**

Run: `npx tsc -p tsconfig.json --noEmit && pnpm run build && pnpm run test`
Expected: typecheck clean; build clean; all tests PASS (110 — was 112, the
two streaming-specific `decideRename` cases were removed).

- [ ] **Step 5: Commit**

```bash
git add src/agents/renameSync.ts src/agents/renameSync.test.ts
git commit -m "refactor: decideRename drops the streaming gate"
```

End the message with the `Co-Authored-By:` trailer.

---

## Task 2: Wire instant send + submit-triggered flush into `Agent`

**Files:**
- Modify: `src/agents/Agent.ts`

`Agent.ts` is large — make ONLY these four edits, matching on the surrounding
code text. No unit-test harness for `Agent.ts`; verify by typecheck + build +
the full test suite.

- [ ] **Step 1: Update `maybeSendRename` — drop `streaming`, fix the JSDoc**

Replace this block (the `maybeSendRename` JSDoc and the `decideRename` call):

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
```

with:

```ts
  /**
   * Echo `/rename <title>` into the terminal when Claude assigns a new card
   * title. Sent immediately when the input box is clean — mid-turn or not.
   * If the user has typed into the box, the title is queued and
   * `flushPendingRename` sends it when the user next submits.
   * See docs/superpowers/specs/2026-05-21-instant-rename-echo-design.md.
   *
   * `/rename` renames the session in place — it does not start a new Claude
   * turn, so an instant mid-turn send cannot cascade.
   */
  private maybeSendRename(title: string): void {
    const decision = decideRename({
      title,
      inputDirty: this._inputDirty,
      lastSent: this._lastSentRename,
    });
```

- [ ] **Step 2: Remove the flush call from `notifyTurnComplete`**

In `notifyTurnComplete()`, replace:

```ts
    if (Object.keys(patch).length > 0) this.changeEmitter.fire(patch);
    this.turnCompleteEmitter.fire();
    // Flush is tied to the real Stop hook only — the Notification-driven
    // setNeedsAttention path deliberately does NOT flush, so a queued
    // rename waits for a genuine turn-complete rather than an idle ping.
    this.flushPendingRename();
  }
```

with:

```ts
    if (Object.keys(patch).length > 0) this.changeEmitter.fire(patch);
    this.turnCompleteEmitter.fire();
  }
```

- [ ] **Step 3: Add the flush call to `clearTransient`**

In `clearTransient()`, replace:

```ts
    // A submitted prompt empties the input box — the /rename echo is safe
    // to send again.
    this._inputDirty = false;
    const patch: Partial<AgentSnapshot> = {};
```

with:

```ts
    // A submitted prompt empties the input box — flush any /rename echo held
    // back while the user was mid-message. The dirty→clean transition here is
    // the watcher that releases a queued rename.
    this._inputDirty = false;
    this.flushPendingRename();
    const patch: Partial<AgentSnapshot> = {};
```

- [ ] **Step 4: Update the `flushPendingRename` JSDoc**

Replace:

```ts
  /** Flush a queued `/rename` echo once a turn completes, if now safe. */
```

with:

```ts
  /** Flush a queued `/rename` echo when the input box goes clean (on submit). */
```

- [ ] **Step 5: Typecheck, build, and run the full test suite**

Run: `npx tsc -p tsconfig.json --noEmit && pnpm run build && pnpm run test`
Expected: typecheck clean; build clean; all 110 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agents/Agent.ts
git commit -m "feat: send /rename instantly, flush queued echo on submit"
```

End the message with the `Co-Authored-By:` trailer.

---

## Task 3: Release 0.0.28

**Files:** `package.json`, `CHANGELOG.md` in `glancer-vscode`; the Glance
article in `hamzawaleed-com`.

This task ships the change. Follow the **`releasing-glance` skill**
(`~/.claude/skills/releasing-glance/SKILL.md`) — it is the authoritative
release procedure. Summary of what that involves:

- [ ] **Step 1: Merge to `main`**

Merge the `feat/instant-rename-echo` work to `main` (PR or local merge, per the
user's choice at execution time). Ensure `main` contains the change and is
pushed.

- [ ] **Step 2: Run the `releasing-glance` skill**

Invoke the `releasing-glance` skill and follow it end to end:
- Pre-flight: `pnpm run build && pnpm run test && npx tsc -p tsconfig.json --noEmit`.
- Bump `package.json` version `0.0.27` → `0.0.28`.
- Add a `CHANGELOG.md` entry: `## 0.0.28 — May 21, 2026` describing the
  instant rename (e.g. *"The session rename now lands the moment Claude names
  the session, instead of waiting for the turn to finish."*).
- Commit on `main` as `v0.0.28: instant /rename echo`, push.
- Tag `v0.0.28`, push the tag — this triggers `release.yml` and the
  Marketplace publish.
- Monitor the workflow with `gh run watch`.
- Update the Glance article (`hamzawaleed-com/content/posts/glance-vscode-extension.md`):
  add a `### May 21, 2026 — v0.0.28` entry at the top of `## What's new`,
  commit and push the `hamzawaleed-com` repo.

- [ ] **Step 3: Confirm**

Confirm the release workflow's six matrix jobs all succeeded and the
`hamzawaleed-com` article commit is pushed.

---

## Self-review

**Spec coverage:**
- `decideRename` drops `streaming` — Task 1 Step 3. ✓
- `maybeSendRename` drops `streaming` — Task 2 Step 1. ✓
- Flush moves `notifyTurnComplete` → `clearTransient` — Task 2 Steps 2, 3. ✓
- Comments/JSDoc updated — Task 1 Step 3, Task 2 Steps 1, 4. ✓
- Tests drop `streaming` cases — Task 1 Step 1. ✓
- Release as 0.0.28 — Task 3. ✓

**Placeholder scan:** none — every code step shows complete content.

**Type consistency:** `decideRename`'s new signature `{ title, inputDirty,
lastSent }` is identical between `renameSync.ts` (Task 1 Step 3), its test
calls (Task 1 Step 1), and the `maybeSendRename` call site (Task 2 Step 1).
`decideFlush` and `flushPendingRename` keep their existing signatures.

**Out of scope (per spec):** manual-clear detection; any change to
`_inputDirty` tracking, `sendInput`, `sendRename`, or `clearActive`.
