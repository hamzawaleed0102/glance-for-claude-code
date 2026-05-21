import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAgentListKey,
  CHORD_WINDOW_MS,
  type KeyInput,
  type KeyContext,
} from './agentListKeymap';

/** A plain keystroke (no modifiers) unless overridden. */
function key(k: string, mods: Partial<KeyInput> = {}): KeyInput {
  return {
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  };
}

/** A three-card panel with AG-01 highlighted, no pending chords, t=1000. */
function ctx(over: Partial<KeyContext> = {}): KeyContext {
  return {
    activeId: 'AG-01',
    ids: ['AG-01', 'AG-02', 'AG-03'],
    lastC: null,
    lastP: null,
    now: 1000,
    ...over,
  };
}

// ---- r: rename ----------------------------------------------------------

test('r opens rename on the highlighted card', () => {
  const r = resolveAgentListKey(key('r'), ctx({ activeId: 'AG-02' }));
  assert.deepEqual(r.action, { type: 'rename', id: 'AG-02' });
  assert.equal(r.preventDefault, true);
});

test('r does nothing when no card is highlighted', () => {
  const r = resolveAgentListKey(key('r'), ctx({ activeId: null }));
  assert.deepEqual(r.action, { type: 'none' });
  assert.equal(r.preventDefault, false);
});

test('r with a modifier is ignored so VS Code keybindings pass through', () => {
  for (const mod of ['metaKey', 'ctrlKey', 'altKey'] as const) {
    const r = resolveAgentListKey(key('r', { [mod]: true }), ctx());
    assert.deepEqual(r.action, { type: 'none' }, `${mod} should be ignored`);
    assert.equal(r.preventDefault, false, `${mod} should not be swallowed`);
  }
});

// ---- g / t / f ----------------------------------------------------------

test('g spawns a new agent', () => {
  const r = resolveAgentListKey(key('g'), ctx());
  assert.deepEqual(r.action, { type: 'newAgent' });
  assert.equal(r.preventDefault, true);
});

test('t spawns a new shell terminal', () => {
  assert.deepEqual(resolveAgentListKey(key('t'), ctx()).action, {
    type: 'newTerminal',
  });
});

test('f toggles the maximized panel', () => {
  assert.deepEqual(resolveAgentListKey(key('f'), ctx()).action, {
    type: 'toggleMaximizedPanel',
  });
});

// ---- arrow navigation ---------------------------------------------------

test('ArrowDown selects the next card', () => {
  const r = resolveAgentListKey(key('ArrowDown'), ctx({ activeId: 'AG-01' }));
  assert.deepEqual(r.action, { type: 'select', id: 'AG-02' });
  assert.equal(r.preventDefault, true);
});

test('ArrowUp selects the previous card', () => {
  assert.deepEqual(
    resolveAgentListKey(key('ArrowUp'), ctx({ activeId: 'AG-02' })).action,
    { type: 'select', id: 'AG-01' },
  );
});

test('ArrowDown wraps from the last card to the first', () => {
  assert.deepEqual(
    resolveAgentListKey(key('ArrowDown'), ctx({ activeId: 'AG-03' })).action,
    { type: 'select', id: 'AG-01' },
  );
});

test('ArrowUp wraps from the first card to the last', () => {
  assert.deepEqual(
    resolveAgentListKey(key('ArrowUp'), ctx({ activeId: 'AG-01' })).action,
    { type: 'select', id: 'AG-03' },
  );
});

test('ArrowDown anchors on the first card when nothing is highlighted', () => {
  assert.deepEqual(
    resolveAgentListKey(key('ArrowDown'), ctx({ activeId: null })).action,
    { type: 'select', id: 'AG-01' },
  );
});

test('ArrowUp anchors on the last card when nothing is highlighted', () => {
  assert.deepEqual(
    resolveAgentListKey(key('ArrowUp'), ctx({ activeId: null })).action,
    { type: 'select', id: 'AG-03' },
  );
});

test('arrows do nothing in an empty list', () => {
  const r = resolveAgentListKey(
    key('ArrowDown'),
    ctx({ ids: [], activeId: null }),
  );
  assert.deepEqual(r.action, { type: 'none' });
  assert.equal(r.preventDefault, false);
});

// ---- Enter / Escape / kill ---------------------------------------------

test('Enter focuses the highlighted card terminal', () => {
  assert.deepEqual(
    resolveAgentListKey(key('Enter'), ctx({ activeId: 'AG-02' })).action,
    { type: 'focusTerminal', id: 'AG-02' },
  );
});

test('Enter does nothing when no card is highlighted', () => {
  const r = resolveAgentListKey(key('Enter'), ctx({ activeId: null }));
  assert.deepEqual(r.action, { type: 'none' });
  assert.equal(r.preventDefault, false);
});

test('Escape blurs the panel', () => {
  assert.deepEqual(resolveAgentListKey(key('Escape'), ctx()).action, {
    type: 'blurPanel',
  });
});

test('Cmd+Backspace kills the highlighted card', () => {
  assert.deepEqual(
    resolveAgentListKey(key('Backspace', { metaKey: true }), ctx()).action,
    { type: 'kill', id: 'AG-01' },
  );
});

test('Ctrl+Delete kills the highlighted card', () => {
  assert.deepEqual(
    resolveAgentListKey(key('Delete', { ctrlKey: true }), ctx({ activeId: 'AG-03' }))
      .action,
    { type: 'kill', id: 'AG-03' },
  );
});

test('Backspace without a modifier does not kill', () => {
  assert.deepEqual(resolveAgentListKey(key('Backspace'), ctx()).action, {
    type: 'none',
  });
});

test('Cmd+Backspace does nothing when no card is highlighted', () => {
  const r = resolveAgentListKey(
    key('Backspace', { metaKey: true }),
    ctx({ activeId: null }),
  );
  assert.deepEqual(r.action, { type: 'none' });
  assert.equal(r.preventDefault, false);
});

// ---- c c chord (run /clear) --------------------------------------------

test('first c arms the clear chord without acting', () => {
  const r = resolveAgentListKey(key('c'), ctx({ lastC: null, now: 1000 }));
  assert.deepEqual(r.action, { type: 'none' });
  assert.equal(r.preventDefault, true);
  assert.equal(r.lastC, 1000);
});

test('second c within the window runs clear and disarms', () => {
  const r = resolveAgentListKey(
    key('c'),
    ctx({ lastC: 1000, now: 1000 + CHORD_WINDOW_MS - 1 }),
  );
  assert.deepEqual(r.action, { type: 'clearActive' });
  assert.equal(r.lastC, null);
});

test('second c after the window re-arms instead of clearing', () => {
  const r = resolveAgentListKey(
    key('c'),
    ctx({ lastC: 1000, now: 1000 + CHORD_WINDOW_MS }),
  );
  assert.deepEqual(r.action, { type: 'none' });
  assert.equal(r.lastC, 1000 + CHORD_WINDOW_MS);
});

test('a non-chord keystroke cancels a pending clear chord', () => {
  const r = resolveAgentListKey(key('ArrowDown'), ctx({ lastC: 1000, now: 1100 }));
  assert.equal(r.lastC, null);
});

test('c does nothing when no card is highlighted', () => {
  const r = resolveAgentListKey(
    key('c'),
    ctx({ activeId: null, lastC: null }),
  );
  assert.deepEqual(r.action, { type: 'none' });
  assert.equal(r.preventDefault, false);
});

// ---- p p chord (pin / unpin) -------------------------------------------

test('first p arms the pin chord without acting', () => {
  const r = resolveAgentListKey(key('p'), ctx({ lastP: null, now: 2000 }));
  assert.deepEqual(r.action, { type: 'none' });
  assert.equal(r.preventDefault, true);
  assert.equal(r.lastP, 2000);
});

test('second p within the window toggles the pin and disarms', () => {
  const r = resolveAgentListKey(
    key('p'),
    ctx({ activeId: 'AG-02', lastP: 2000, now: 2100 }),
  );
  assert.deepEqual(r.action, { type: 'togglePin', id: 'AG-02' });
  assert.equal(r.lastP, null);
});

test('pressing c cancels a pending pin chord and arms the clear chord', () => {
  const r = resolveAgentListKey(
    key('c'),
    ctx({ lastC: null, lastP: 2000, now: 2100 }),
  );
  assert.equal(r.lastP, null, 'pin chord cancelled');
  assert.equal(r.lastC, 2100, 'clear chord armed');
});
