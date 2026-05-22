# Instant `/rename` echo

**Date:** 2026-05-21
**Project:** `glancer-vscode`
**Status:** Approved design — ready for implementation plan
**Builds on:** `2026-05-21-terminal-rename-echo-design.md` (shipped as v0.0.27)

## Summary

Change the terminal `/rename` echo (shipped in v0.0.27) so it fires **the moment
Claude updates the card title**, instead of waiting for the turn-end `Stop` hook.
The only thing that holds the echo back is the user having typed into the
terminal input box; the instant they submit (box goes clean), the held `/rename`
is sent.

## Motivation

v0.0.27 queues the echo whenever Claude is mid-turn (`streaming === true`) and
flushes it on the `Stop` hook. Because Claude sets the title *during* its turn,
the echo always waits until the turn ends. The desired behavior is immediate:
send as soon as the title updates, gated only on whether the user is mid-message.

## Behavior

- Claude updates the card title → if the input box is clean, send
  `/rename <title>` into the terminal **immediately**, even while Claude is
  mid-turn.
- If the user has typed into the input box, queue the rename. When the user
  submits (the `UserPromptSubmit` hook fires, box goes clean), send the queued
  rename.
- A manual clear without submit is **not** detected (decided: submit-only). A
  typed-then-cleared box releases the held rename on the user's next submit.

## Changes

All changes are inside the existing v0.0.27 feature code. No new files.

### `src/agents/renameSync.ts`

`decideRename` drops the `streaming` field:

```ts
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

`decideFlush` is unchanged. Update the `decideRename` JSDoc: the queue case is
now "the user has typed into the input box" only — no mention of streaming.

### `src/agents/Agent.ts`

- `maybeSendRename` calls `decideRename` without `streaming`:
  `decideRename({ title, inputDirty: this._inputDirty, lastSent: this._lastSentRename })`.
- Move the `flushPendingRename()` call: remove it from `notifyTurnComplete()`,
  add it to `clearTransient()` immediately after `this._inputDirty = false;`.
  This is the watcher — the dirty→clean transition on submit releases the queue.
- Remove the now-stale comment in `notifyTurnComplete()` about the flush being
  tied to the `Stop` hook.
- Update the `maybeSendRename` JSDoc: it now sends immediately when the box is
  clean (mid-turn or not); it queues only when the box is dirty.

`_inputDirty`, `_pendingRename`, `_lastSentRename`, `sendRename`, the
`onUserInput` subscription, and `clearActive` are unchanged. `Agent._streaming`
still exists for the card bubble — it is simply no longer consulted by the
rename logic.

### `src/agents/renameSync.test.ts`

Update `decideRename` cases to drop `streaming`. Remove the streaming-specific
cases. Final `decideRename` coverage:

- clean box, new title → `send`
- dirty box → `queue`
- `title === lastSent` → `skip`
- `title !== lastSent`, clean box → `send`

`decideFlush` tests are unchanged.

## Behavior walkthrough

1. **First turn.** User submits the first prompt → `clearTransient` →
   `_inputDirty = false` (and `flushPendingRename` runs — nothing queued yet,
   no-op). Claude streams; mid-turn it sets a title → `applyState` →
   `maybeSendRename` → box is clean → `/rename <title>` sent immediately.
2. **User mid-message.** Claude sets a title while the user has text in the
   box → `_inputDirty` is true → `decideRename` → `queue`, `_pendingRename`
   set. When the user submits → `clearTransient` sets `_inputDirty = false`
   then calls `flushPendingRename` → `decideFlush` → `send`.
3. **`/clear`.** `resetCardState` clears `_pendingRename` / `_lastSentRename` /
   `_inputDirty` — unchanged from v0.0.27.

## Edge cases

- **Loop safety.** `/rename` renames in place; it does not start a Claude turn,
  so an instant mid-turn send cannot cascade. The `_lastSentRename` guard still
  skips a redundant echo of an unchanged title.
- **Pending rename + clean box but no submit.** Cannot occur: `_pendingRename`
  is only set while `_inputDirty` is true, and `_inputDirty` only clears via
  `clearTransient` (which now flushes) or `resetCardState` (which clears the
  queue). So no held rename is ever stranded with a clean box.

## Files touched

| File | Change |
| --- | --- |
| `src/agents/renameSync.ts` | `decideRename` drops `streaming`; JSDoc update |
| `src/agents/Agent.ts` | `maybeSendRename` drops `streaming`; move `flushPendingRename` to `clearTransient`; comment updates |
| `src/agents/renameSync.test.ts` | drop `streaming` from `decideRename` cases |

## Out of scope

- Detecting a manual clear without submit (decided: submit-only).
- Any change to `_inputDirty` tracking, `sendInput`, or `clearActive`.
