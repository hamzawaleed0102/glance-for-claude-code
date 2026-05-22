/**
 * Pure decision logic for the terminal `/rename` echo feature.
 *
 * When Claude first sets a card title via `update_state`, Glance echoes
 * `/rename <title>` into the terminal so the session and its card share one
 * name. The session is renamed **once per conversation** — later title changes
 * never re-echo. `resetCardState` (on `/clear`) clears the loop guard so the
 * fresh conversation can be named again. These two pure functions encode
 * "is it the first rename, and is it safe to send now?" so the stateful Agent
 * stays thin and the logic is unit-testable.
 *
 * See docs/superpowers/specs/2026-05-21-instant-rename-echo-design.md.
 */

/** What the Agent should do with a candidate rename. */
export type RenameDecision = 'send' | 'queue' | 'skip';

/**
 * Decide what to do when Claude sets a new card title.
 *  - a `/rename` was already echoed this session -> 'skip'
 *  - user has typed into the input box           -> 'queue'
 *  - otherwise                                   -> 'send'
 *
 * The session is renamed at most once. Once any `/rename` has been echoed
 * (`lastSent` is non-null) every later title change is skipped — a different
 * title, a dirty input box, all of it. `/clear` resets `lastSent` to null
 * (via `resetCardState`), re-arming the echo for the new conversation.
 */
export function decideRename(opts: {
  inputDirty: boolean;
  lastSent: string | null;
}): RenameDecision {
  if (opts.lastSent !== null) return 'skip';
  if (opts.inputDirty) return 'queue';
  return 'send';
}

/**
 * Decide what to do with a queued rename when the input box goes clean (on submit).
 *  - nothing queued                              -> 'skip'
 *  - a `/rename` was already echoed this session -> 'skip'  (caller clears the queue)
 *  - user has typed into the box                 -> 'queue' (keep waiting)
 *  - otherwise                                   -> 'send'
 *
 * Caller contract: `'skip'` is returned for BOTH the null-pending case and
 * the already-renamed case. The caller MUST clear its pending-rename state
 * whenever this returns `'skip'` — otherwise a stale queued title stays
 * queued forever and the queue is permanently stuck.
 */
export function decideFlush(opts: {
  pending: string | null;
  inputDirty: boolean;
  lastSent: string | null;
}): RenameDecision {
  if (opts.pending === null) return 'skip';
  if (opts.lastSent !== null) return 'skip';
  if (opts.inputDirty) return 'queue';
  return 'send';
}
