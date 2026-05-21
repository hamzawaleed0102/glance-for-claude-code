# Terminal `/rename` echo on AI title update

**Date:** 2026-05-21
**Project:** `glancer-vscode`
**Status:** Approved design — ready for implementation plan

## Summary

When Claude sets a new card title via the `update_state` MCP tool, Glance also
types `/rename <title>` + Enter into that session's terminal — but only when the
terminal input box is empty. If the user has typed something into the box, Glance
waits until they submit it, then sends the `/rename` line.

This is a **visible echo** in the Claude conversation. It is requested as a UX
behavior; see "Known finding" for why it does not, by itself, rename anything.

## Known finding (context for the implementer)

`/rename` is **not** a Claude Code slash command — no command file exists in
`~/.claude/commands/`, any project `.claude/commands/`, or any plugin. In the
user's wider setup, `~/.claude/scripts/auto-rename.sh` is a `Stop` hook that
reads the **assistant's** reply, finds a `/rename <topic>` text line, and renames
the session by appending a `custom-title` record to the transcript `.jsonl`.

Therefore: typing `/rename <title>` into the terminal from Glance produces an
ordinary user prompt and a normal Claude turn. It does not rename the session.
The user has reviewed this and still wants the echo. Writing the `custom-title`
transcript record was considered and explicitly **dropped** from scope — this
spec covers the terminal echo only.

## Scope

### In scope

- One trigger: `Agent.applyState()` accepts an AI-supplied title and the card
  name changes (the existing `'title' in s` branch).
- One action: send `/rename <title>` followed by Enter into the Claude terminal.
- Gate the send on a best-effort "input box empty" signal.
- Defer the send while the box is non-empty or Claude is mid-turn; flush later.

### Out of scope (unchanged)

- All existing rename logic: `setManualTitle()`, manual panel rename, the card
  title, the VS Code terminal tab title via `setName()`. Untouched.
- Manual renames do **not** trigger a `/rename` echo.
- No transcript / `.jsonl` write.
- `ShellAgent` (shell cards) — has no Claude session; no change.

## Key constraint

Glance cannot read Claude's TUI input box. Claude runs as a full-screen
alt-screen app inside a `node-pty` child wrapped by a `vscode.Pseudoterminal`;
VS Code owns the rendered buffer and exposes no API to read it. The only
observable signal is the byte stream through the pseudoterminal's `handleInput`.

So "is the box empty?" is a **best-effort flag**, not a true read:

| Event | Detectable? | How |
| --- | --- | --- |
| User typed into the box | Yes | any `handleInput` call carrying real user input |
| User submitted the box | Yes (clean) | the `UserPromptSubmit` hook fires |
| User typed then cleared without submitting (Ctrl+U / Esc / backspace-to-empty) | No | would need a full terminal emulator |

**Accepted consequence:** if the user types then clears without submitting, the
queued `/rename` keeps waiting until their next submit. It is never concatenated
onto half-typed text. Worst case the echo is delayed, or dropped if the user
never submits again. Bias-to-wait is the safe trade and is approved.

## Design

### 1. `src/agents/pseudoterminal.ts`

- Add a `userInputEmitter` (`vscode.EventEmitter<void>`). In `handleInput(data)`,
  after the existing `proc?.write(data)`, fire `userInputEmitter`. `handleInput`
  is only ever called by VS Code for real terminal keyboard input / paste — it
  is **not** called for extension-originated input sent via the new `sendInput`
  path below.
- Expose `onUserInput: userInputEmitter.event` on the returned session object.
- Add `sendInput(text: string): void` that writes straight to `proc?.write(text)`,
  bypassing `handleInput`. This is the channel for all Glance-originated input,
  so Glance's own injected text never registers as user typing.
- Dispose `userInputEmitter` in `dispose()` alongside the other emitters.

### 2. `src/agents/Agent.ts`

State fields:

- `_inputDirty: boolean` — initial `false` (a fresh session has an empty box).
- `_pendingRename: string | null` — initial `null`. Latest-wins.
- `_lastSentRename: string | null` — initial `null`. The title text of the most
  recent `/rename` Glance sent.

Wiring:

- Subscribe to `this.claude.onUserInput` → set `_inputDirty = true`.
- On the `UserPromptSubmit` hook (already handled in the agent) → set
  `_inputDirty = false`. A submit empties the box.
- In `applyState()`'s AI-title branch, after `this._name = next` is committed,
  call `maybeSendRename(next)`.
- On the `Stop` hook (turn complete; already handled) → call `flushPendingRename()`.

`maybeSendRename(title)`:

- Compute the decision via the pure `decideRename` function (module below).
- `send` → `this.claude.sendInput('/rename ' + title + '\r')`, set
  `_lastSentRename = title`, clear `_pendingRename`.
- `queue` → `_pendingRename = title`.
- `skip` → no-op.

`flushPendingRename()` (on `Stop`):

- Compute via the pure `decideFlush` function.
- `send` → `sendInput` the pending title, set `_lastSentRename`, clear
  `_pendingRename`.
- `skip` → clear `_pendingRename` (it equals `_lastSentRename` — already echoed).
- `queue` → leave `_pendingRename` set (box still dirty); a later submit +
  `Stop` retries.

- Migrate `clearActive()` from `this.terminal?.sendText('/clear')` to
  `this.claude?.sendInput('/clear\r')`. Required: `sendText` routes through
  `handleInput` and would falsely mark `_inputDirty`. `sendInput` is functionally
  identical (`proc.write('/clear\r')`) and keeps the dirty flag clean.

### 3. `src/agents/renameSync.ts` (new — pure module)

```ts
export type RenameDecision = 'send' | 'queue' | 'skip';

export function decideRename(opts: {
  title: string;
  streaming: boolean;
  inputDirty: boolean;
  lastSent: string | null;
}): RenameDecision;
// title === lastSent          -> 'skip'  (already echoed this exact title)
// streaming || inputDirty     -> 'queue' (not safe to send now)
// otherwise                   -> 'send'

export function decideFlush(opts: {
  pending: string | null;
  inputDirty: boolean;
  lastSent: string | null;
}): RenameDecision;
// pending === null            -> 'skip'
// pending === lastSent        -> 'skip'  (caller clears _pendingRename)
// inputDirty                  -> 'queue' (keep waiting)
// otherwise                   -> 'send'
```

`Agent` holds the mutable state and performs I/O; `renameSync.ts` is pure and
fully unit-testable.

### 4. Tests — `src/agents/renameSync.test.ts` (new)

`node:test` cases covering `decideRename` and `decideFlush`:

- `decideRename`: idle + clean → `send`; streaming → `queue`; dirty → `queue`;
  `title === lastSent` → `skip` even when idle and clean.
- `decideFlush`: `null` pending → `skip`; `pending === lastSent` → `skip`;
  dirty → `queue`; idle + clean + new pending → `send`.

Per `glancer-vscode/CLAUDE.md`, register the new test in **both**
`esbuild.config.mjs::testEntries` and `package.json::scripts.test` — there is
no glob.

## Behavior walkthrough

1. **First turn.** User submits their first prompt → `UserPromptSubmit` →
   `_inputDirty = false`. Claude streams; mid-turn it calls `update_state` with
   a title → `applyState` → `maybeSendRename`. `streaming` is `true` → `queue`,
   `_pendingRename = title`.
2. **Turn ends.** `Stop` → `flushPendingRename`. If `_inputDirty` is `false`
   (user did not type during the turn) → `sendInput('/rename <title>\r')`,
   `_lastSentRename = title`.
3. **The echo turn.** `/rename <title>` is an ordinary prompt → a new turn runs
   and fires `UserPromptSubmit` (`_inputDirty = false`). That turn's own
   `update_state` likely sets the same title → `decideRename` sees
   `title === _lastSentRename` → `skip`. Loop ends.
4. **User typing.** If the user has typed into the box, `_inputDirty = true`;
   `maybeSendRename` / `flushPendingRename` return `queue`. The echo waits until
   the user submits (`UserPromptSubmit` clears the flag), then the next `Stop`
   flushes it.

## Edge cases

- **Title changes again before flush** — `_pendingRename` is latest-wins; only
  the newest title is echoed.
- **Re-send loop** — the `_lastSentRename` guard skips a `/rename` for a title
  already echoed. If a follow-up turn produces a genuinely *different* title,
  one further echo fires, then converges. Acceptable.
- **Dormant agent** — no PTY; `this.claude` is absent. `sendInput` is guarded by
  optional chaining and no-ops. A dormant agent receives no `update_state`, so
  `maybeSendRename` is not reached anyway.
- **`/clear`** — resets the card title to `glance-XX` via a path that does not
  call `maybeSendRename`; no echo. `clearActive` uses `sendInput`, so it does
  not mark `_inputDirty`.
- **Title sanitization** — `applyState` already sanitizes, capitalizes, and
  clamps the title to 40 chars before this runs. `maybeSendRename` additionally
  strips any `\r` / `\n` from the title before composing the command line.

## Files touched

| File | Change |
| --- | --- |
| `src/agents/pseudoterminal.ts` | add `sendInput`, `onUserInput`; fire on `handleInput`; dispose emitter |
| `src/agents/Agent.ts` | dirty/pending/lastSent state, `maybeSendRename`, `flushPendingRename`, wire `onUserInput` + `UserPromptSubmit` + `Stop`, migrate `clearActive` to `sendInput` |
| `src/agents/renameSync.ts` | new — pure `decideRename` / `decideFlush` |
| `src/agents/renameSync.test.ts` | new — `node:test` coverage |
| `esbuild.config.mjs` | add `renameSync.test` to `testEntries` |
| `package.json` | add compiled test file to `scripts.test` |

## Non-goals / explicitly rejected

- Writing a `custom-title` record to the transcript `.jsonl` (the real rename
  mechanism) — dropped at the user's request.
- Detecting "typed then cleared without submit" — not feasible without a
  terminal emulator; bias-to-wait covers it safely.
- Triggering the echo on manual panel renames — out of scope.
