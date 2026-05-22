/**
 * Pure decision logic for the terminal `/rename` echo feature.
 *
 * When Claude sets a new card title via `update_state`, Glance echoes
 * `/rename <title>` into the terminal — but only when the user has not typed
 * into the input box. These two pure functions encode "is it safe?" so the
 * stateful Agent stays thin and the logic is unit-testable.
 *
 * See docs/superpowers/specs/2026-05-21-instant-rename-echo-design.md.
 */

/** What the Agent should do with a candidate rename. */
export type RenameDecision = 'send' | 'queue' | 'skip';

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

/**
 * Decide what to do with a queued rename when the input box goes clean (on submit).
 *  - nothing queued                  -> 'skip'
 *  - queued title already echoed      -> 'skip'  (caller clears the queue)
 *  - user has typed into the box      -> 'queue' (keep waiting)
 *  - otherwise                        -> 'send'
 *
 * Caller contract: `'skip'` is returned for BOTH the null-pending case and
 * the already-echoed case. The caller MUST clear its pending-rename state
 * whenever this returns `'skip'` — otherwise an already-echoed title stays
 * queued forever and the queue is permanently stuck.
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
