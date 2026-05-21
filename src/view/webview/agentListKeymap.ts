/**
 * Pure decision logic for the Glance panel's keyboard navigation.
 *
 * `AgentList`'s keydown handler is a thin shell: it reads the event plus the
 * current chord state, calls `resolveAgentListKey`, then applies the returned
 * action as side effects (postMessage, focus, dispatchEvent). Keeping the
 * decision pure makes every shortcut — including the two-press `c c` / `p p`
 * chords, whose timing is otherwise awkward to exercise — unit-testable
 * without a DOM.
 */

/** Maximum gap between the two presses of a chord (`c c`, `p p`). */
export const CHORD_WINDOW_MS = 400;

/** The subset of a `KeyboardEvent` the resolver needs. */
export interface KeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Panel state the resolver reads. */
export interface KeyContext {
  /** Currently highlighted card id, or null if none. */
  activeId: string | null;
  /** Visible card ids, top-to-bottom (after filtering + ordering). */
  ids: string[];
  /** Timestamp (ms) of an unpaired `c` press, or null. */
  lastC: number | null;
  /** Timestamp (ms) of an unpaired `p` press, or null. */
  lastP: number | null;
  /** Current time (ms) — injected so chord timing is testable. */
  now: number;
}

/** What the panel should do in response to a keystroke. */
export type KeyAction =
  | { type: 'none' }
  | { type: 'select'; id: string }
  | { type: 'focusTerminal'; id: string }
  | { type: 'newAgent' }
  | { type: 'newTerminal' }
  | { type: 'rename'; id: string }
  | { type: 'toggleMaximizedPanel' }
  | { type: 'togglePin'; id: string }
  | { type: 'clearActive' }
  | { type: 'blurPanel' }
  | { type: 'kill'; id: string };

export interface KeyResult {
  /** The action to perform. */
  action: KeyAction;
  /** Whether the handler should call `event.preventDefault()`. */
  preventDefault: boolean;
  /** Unpaired-`c` timestamp to store next (null clears it). */
  lastC: number | null;
  /** Unpaired-`p` timestamp to store next (null clears it). */
  lastP: number | null;
}

/** True for `<key>` pressed with no command/control/option modifier. */
function plain(e: KeyInput, key: string): boolean {
  return e.key === key && !e.metaKey && !e.ctrlKey && !e.altKey;
}

/**
 * Map a keystroke to a panel action. Pure: the caller owns the refs that
 * hold `lastC` / `lastP` and the side effects named by `KeyAction`.
 */
export function resolveAgentListKey(e: KeyInput, ctx: KeyContext): KeyResult {
  const isPlainC =
    e.key === 'c' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
  const isPlainP =
    e.key === 'p' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
  // Any keystroke that isn't a plain version of a chord key cancels that
  // key's pending chord. These carry forward only inside the matching
  // chord branch below; every other branch leaves them as-is (cancelled).
  const lastC = isPlainC ? ctx.lastC : null;
  const lastP = isPlainP ? ctx.lastP : null;

  const none: KeyResult = {
    action: { type: 'none' },
    preventDefault: false,
    lastC,
    lastP,
  };

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (ctx.ids.length === 0) return none;
    const i = ctx.activeId ? ctx.ids.indexOf(ctx.activeId) : -1;
    const step = e.key === 'ArrowDown' ? 1 : -1;
    const len = ctx.ids.length;
    const next = i < 0 ? (step > 0 ? 0 : len - 1) : (i + step + len) % len;
    return {
      action: { type: 'select', id: ctx.ids[next] },
      preventDefault: true,
      lastC,
      lastP,
    };
  }

  if (e.key === 'Enter') {
    if (!ctx.activeId) return none;
    return {
      action: { type: 'focusTerminal', id: ctx.activeId },
      preventDefault: true,
      lastC,
      lastP,
    };
  }

  if (plain(e, 'g')) {
    return { action: { type: 'newAgent' }, preventDefault: true, lastC, lastP };
  }

  if (plain(e, 't')) {
    return {
      action: { type: 'newTerminal' },
      preventDefault: true,
      lastC,
      lastP,
    };
  }

  if (plain(e, 'f')) {
    return {
      action: { type: 'toggleMaximizedPanel' },
      preventDefault: true,
      lastC,
      lastP,
    };
  }

  if (plain(e, 'r')) {
    if (!ctx.activeId) return none;
    return {
      action: { type: 'rename', id: ctx.activeId },
      preventDefault: true,
      lastC,
      lastP,
    };
  }

  if (isPlainP) {
    if (!ctx.activeId) return none;
    // Second press within the window completes the chord; otherwise (re)arm.
    if (ctx.lastP !== null && ctx.now - ctx.lastP < CHORD_WINDOW_MS) {
      return {
        action: { type: 'togglePin', id: ctx.activeId },
        preventDefault: true,
        lastC,
        lastP: null,
      };
    }
    return {
      action: { type: 'none' },
      preventDefault: true,
      lastC,
      lastP: ctx.now,
    };
  }

  if (isPlainC) {
    if (!ctx.activeId) return none;
    if (ctx.lastC !== null && ctx.now - ctx.lastC < CHORD_WINDOW_MS) {
      return {
        action: { type: 'clearActive' },
        preventDefault: true,
        lastC: null,
        lastP,
      };
    }
    return {
      action: { type: 'none' },
      preventDefault: true,
      lastC: ctx.now,
      lastP,
    };
  }

  if (e.key === 'Escape') {
    return {
      action: { type: 'blurPanel' },
      preventDefault: true,
      lastC,
      lastP,
    };
  }

  if ((e.metaKey || e.ctrlKey) && (e.key === 'Backspace' || e.key === 'Delete')) {
    if (!ctx.activeId) return none;
    return {
      action: { type: 'kill', id: ctx.activeId },
      preventDefault: true,
      lastC,
      lastP,
    };
  }

  return none;
}
