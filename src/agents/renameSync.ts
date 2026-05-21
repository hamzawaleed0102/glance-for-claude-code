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
