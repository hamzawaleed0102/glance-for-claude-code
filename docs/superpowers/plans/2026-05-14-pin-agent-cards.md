# Pin Agent Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-agent **pin** flag toggled via the `p` key (or by clicking the corner button on a pinned card). Pinned agents auto-move to the top of the list in FIFO order, can't be killed (`Cmd+Backspace` / X), and survive reloads via `sessions.json`. Unpinning happens by pressing `p` again or clicking the pin icon.

**Architecture:** Boolean field on `Agent` and `AgentSnapshot`, persisted in `sessions.json`. `AgentManager.togglePin()` flips the flag, then `resortPinnedFirst()` stable-partitions the agents Map (pinned first, unpinned second). `AgentManager.kill()` early-returns on pinned agents. The webview also applies a pinned-first stable sort at render so the order updates correctly even while `localOrder` (drag optimism) is held. Snapshot diffs flow through the existing `changeEmitter → 'updated' → agentUpdate` pipeline — no new host→webview message type.

**Tech Stack:** TypeScript · React 18 · `vscode.EventEmitter` · existing `chokidar` watchers · `node:test` for the pure ordering helper.

**Spec reference:** `docs/superpowers/specs/2026-05-14-pin-agent-cards-design.md`

---

## File Map

**Create:**
- `src/agents/pinSort.ts` — pure helper `partitionPinnedFirst(entries)` so the ordering logic is testable without spinning up an AgentManager.
- `src/agents/pinSort.test.ts` — unit tests for the helper.

**Modify:**
- `src/shared/messages.ts` — `pinned: boolean` on `AgentSnapshot`; `togglePin` variant on `WebviewToHost`.
- `src/agents/Agent.ts` — `_pinned` field, getter, `setPinned()`, `AgentInit.pinned`, constructor wiring, snapshot includes `pinned`.
- `src/agents/AgentManager.ts` — `togglePin()`, kill guard, `resortPinnedFirst()` calls from `togglePin` / `reorder` / `restorePersistedAgents`, `persist()` writes `pinned`, `restorePersistedAgents` reads `pinned`, `makeAgent` accepts and forwards `pinned`.
- `src/view/AgentPanelProvider.ts` — `togglePin` case in `handle()`.
- `src/view/webview/AgentList.tsx` — `p` key branch in `onKeyDown`; render-time pinned-first stable sort in `orderedAgents`.
- `src/view/webview/AgentCard.tsx` — conditional X / pin icon in the corner button; `pinned` modifier class on the card root.
- `src/view/webview/styles.css` — `.agent-kill.pinned` and `.agent-kill.pinned:hover` rules.
- `esbuild.config.mjs` — add `src/agents/pinSort.ts` + `src/agents/pinSort.test.ts` to `testEntries`.
- `package.json` — add `out/agents/pinSort.test.js` to `scripts.test`.
- `CHANGELOG.md` — entry under a new version header (the user bumps the version when shipping).
- `README.md` — single line about `p` to pin under "Keyboard shortcuts → With the Glance panel focused".

---

## Task 1: Add `pinned` field to `AgentSnapshot` and the `togglePin` message

**Files:**
- Modify: `src/shared/messages.ts`

- [ ] **Step 1: Add `pinned` field to `AgentSnapshot`**

In `src/shared/messages.ts`, in the `AgentSnapshot` interface, insert this field after `starting`:

```ts
  /**
   * True when the user has pinned this card. Pinned cards auto-sort to
   * the top of the list (FIFO within the pinned group) and refuse kill
   * (Cmd+Backspace / X button). Toggled via the `p` key on a focused
   * card or by clicking the pin icon. Persists in sessions.json.
   */
  pinned: boolean;
```

- [ ] **Step 2: Add `togglePin` to `WebviewToHost`**

Append this variant to the `WebviewToHost` union (after `clearActive`):

```ts
  /**
   * User pressed `p` on a focused card, or clicked the pin icon on a
   * pinned card. Host flips the agent's `pinned` flag, resorts the list
   * (pinned-first FIFO), and persists. Snapshot diff propagates via the
   * existing agentUpdate path.
   */
  | { type: 'togglePin'; id: string };
```

- [ ] **Step 3: Build to verify the type changes compile**

Run: `pnpm run build`
Expected: build succeeds with no TS errors. The new field on `AgentSnapshot` will trigger downstream errors in `Agent.snapshot()` (Task 2) and in the webview (Tasks 7+8) — but at this point, `Agent.ts` still satisfies the interface only if it produces all listed fields. Since `pinned` is required, expect ONE compile failure in `src/agents/Agent.ts:581` (`snapshot()` missing `pinned`).

That's expected and gets fixed in Task 2. If you see errors elsewhere, stop and re-check.

- [ ] **Step 4: Commit**

```bash
git add src/shared/messages.ts
git commit -m "feat(messages): add pinned field + togglePin message type"
```

---

## Task 2: Wire `pinned` into `Agent`

**Files:**
- Modify: `src/agents/Agent.ts`

- [ ] **Step 1: Add `pinned` to `AgentInit`**

In `src/agents/Agent.ts`, in the `AgentInit` interface (around line 99, right after `hasUserPrompt?: boolean;`), add:

```ts
  /**
   * Whether this agent should restore in the pinned state. Read from
   * sessions.json. Defaults to false on fresh spawns.
   */
  pinned?: boolean;
```

- [ ] **Step 2: Add the `_pinned` field**

In the `Agent` class body, immediately after the `_hasUserPrompt` declaration (around line 141), add:

```ts
  private _pinned: boolean;
```

- [ ] **Step 3: Initialize `_pinned` in the constructor**

In the constructor, after `this._hasUserPrompt = init.hasUserPrompt === true;` (around line 200), add:

```ts
    this._pinned = init.pinned === true;
```

- [ ] **Step 4: Add the `pinned` getter**

Find the `streaming` getter (around line 187). Immediately after it, add:

```ts
  /**
   * True when the user has pinned this card. Pinned cards stay at the
   * top of the list (FIFO) and are protected from kill. Toggled via
   * the `p` key or the pin button on the card.
   */
  get pinned(): boolean {
    return this._pinned;
  }
```

- [ ] **Step 5: Add `setPinned()`**

Find `setManualTitle` (around line 519). Immediately after its closing brace (around line 537), add:

```ts
  /**
   * Toggle the pinned flag. Fires changeEmitter so the webview snapshot
   * updates and metaChangeEmitter so AgentManager re-persists sessions.json.
   * Short-circuits if the flag is unchanged (avoids redundant writes and
   * an empty snapshot diff). Matches the dual-emitter pattern from
   * setManualTitle.
   */
  setPinned(pinned: boolean): void {
    if (this._pinned === pinned) return;
    this._pinned = pinned;
    this.changeEmitter.fire({ pinned: this._pinned });
    this.metaChangeEmitter.fire();
  }
```

- [ ] **Step 6: Include `pinned` in `snapshot()`**

Find `snapshot()` (around line 581). Add `pinned: this._pinned,` to the returned object — alphabetical/grouping is irrelevant, just keep it readable. Result:

```ts
  snapshot(): AgentSnapshot {
    return {
      id: this.id,
      name: this._name,
      titleSource: this._titleSource,
      model: this._model,
      tldr: this._tldr,
      attentionReason: this._attentionReason,
      errorReason: this._errorReason,
      progress: this._progress,
      skill: this._skill,
      streaming: this._streaming,
      starting: this._starting,
      pinned: this._pinned,
    };
  }
```

- [ ] **Step 7: Build to verify**

Run: `pnpm run build`
Expected: build succeeds. The compile error from Task 1 step 3 is now resolved.

- [ ] **Step 8: Commit**

```bash
git add src/agents/Agent.ts
git commit -m "feat(agent): add pinned flag, getter, setter (dual-emitter)"
```

---

## Task 3: Extract pure pinned-first partition helper + tests

**Files:**
- Create: `src/agents/pinSort.ts`
- Create: `src/agents/pinSort.test.ts`

This task isolates the ordering logic into a pure function so it can be unit-tested without setting up a full `AgentManager`. The function operates on `Map<string, { pinned: boolean }>` entries and is shape-compatible with `Map<string, Agent>`.

- [ ] **Step 1: Write the failing test**

Create `src/agents/pinSort.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionPinnedFirst } from './pinSort';

test('partitionPinnedFirst preserves order when nothing is pinned', () => {
  const input = new Map<string, { pinned: boolean }>([
    ['A', { pinned: false }],
    ['B', { pinned: false }],
    ['C', { pinned: false }],
  ]);
  const out = partitionPinnedFirst(input);
  assert.deepEqual([...out.keys()], ['A', 'B', 'C']);
});

test('partitionPinnedFirst moves a single pinned to the front', () => {
  const input = new Map<string, { pinned: boolean }>([
    ['A', { pinned: false }],
    ['B', { pinned: true }],
    ['C', { pinned: false }],
  ]);
  const out = partitionPinnedFirst(input);
  assert.deepEqual([...out.keys()], ['B', 'A', 'C']);
});

test('partitionPinnedFirst keeps pinned in insertion order (FIFO)', () => {
  // A pinned, then C pinned. Expected order: A, C, then unpinned B.
  const input = new Map<string, { pinned: boolean }>([
    ['A', { pinned: true }],
    ['B', { pinned: false }],
    ['C', { pinned: true }],
  ]);
  const out = partitionPinnedFirst(input);
  assert.deepEqual([...out.keys()], ['A', 'C', 'B']);
});

test('partitionPinnedFirst keeps unpinned in insertion order within their group', () => {
  const input = new Map<string, { pinned: boolean }>([
    ['A', { pinned: false }],
    ['B', { pinned: true }],
    ['C', { pinned: false }],
    ['D', { pinned: true }],
    ['E', { pinned: false }],
  ]);
  const out = partitionPinnedFirst(input);
  assert.deepEqual([...out.keys()], ['B', 'D', 'A', 'C', 'E']);
});

test('partitionPinnedFirst is a no-op when input already satisfies the invariant', () => {
  const input = new Map<string, { pinned: boolean }>([
    ['B', { pinned: true }],
    ['D', { pinned: true }],
    ['A', { pinned: false }],
    ['C', { pinned: false }],
  ]);
  const out = partitionPinnedFirst(input);
  assert.deepEqual([...out.keys()], ['B', 'D', 'A', 'C']);
});

test('partitionPinnedFirst returns a new Map (does not mutate input)', () => {
  const input = new Map<string, { pinned: boolean }>([
    ['A', { pinned: false }],
    ['B', { pinned: true }],
  ]);
  const before = [...input.keys()];
  partitionPinnedFirst(input);
  assert.deepEqual([...input.keys()], before, 'input Map should be unchanged');
});

test('partitionPinnedFirst preserves the same value references', () => {
  const aVal = { pinned: false };
  const bVal = { pinned: true };
  const input = new Map<string, { pinned: boolean }>([
    ['A', aVal],
    ['B', bVal],
  ]);
  const out = partitionPinnedFirst(input);
  assert.equal(out.get('A'), aVal);
  assert.equal(out.get('B'), bVal);
});
```

- [ ] **Step 2: Add the test file to `esbuild.config.mjs::testEntries`**

In `esbuild.config.mjs`, in the `testEntries` array (lines 34–43), append two entries (the helper itself + the test):

```js
const testEntries = [
  'src/markers/extractMarkers.ts',
  'src/markers/extractMarkers.test.ts',
  'src/markers/transcriptWatcher.ts',
  'src/markers/transcriptWatcher.test.ts',
  'src/agents/sessionScanner.ts',
  'src/agents/sessionScanner.test.ts',
  'src/agents/ids.ts',
  'src/agents/ids.test.ts',
  'src/agents/pinSort.ts',
  'src/agents/pinSort.test.ts',
];
```

- [ ] **Step 3: Add the compiled test file to `package.json::scripts.test`**

In `package.json`, change the `scripts.test` line from:

```
"test": "node --test out/markers/extractMarkers.test.js out/markers/transcriptWatcher.test.js out/agents/sessionScanner.test.js out/agents/ids.test.js",
```

to:

```
"test": "node --test out/markers/extractMarkers.test.js out/markers/transcriptWatcher.test.js out/agents/sessionScanner.test.js out/agents/ids.test.js out/agents/pinSort.test.js",
```

- [ ] **Step 4: Build and run the test to verify it fails**

Run: `pnpm run build`
Expected: build fails because `pinSort.ts` doesn't exist yet (esbuild errors on missing entrypoint).

That's the failing-test state for this task — we have a test importing a module that doesn't exist. Move to Step 5.

- [ ] **Step 5: Implement the helper**

Create `src/agents/pinSort.ts`:

```ts
/**
 * Pure helper: return a new Map with all pinned entries first (in their
 * original relative order) followed by all unpinned entries (also in
 * original relative order). Stable partition. Does not mutate the input.
 *
 * Lifted out of AgentManager so we can unit-test the ordering invariant
 * without spinning up a real Agent (which spawns a node-pty child shell
 * and is unfit for node:test runs).
 *
 * Operates on the structural shape `{ pinned: boolean }` so callers can
 * pass either `Map<string, Agent>` or test fixtures.
 */
export function partitionPinnedFirst<V extends { pinned: boolean }>(
  entries: Map<string, V>,
): Map<string, V> {
  const pinned: [string, V][] = [];
  const unpinned: [string, V][] = [];
  for (const entry of entries) {
    (entry[1].pinned ? pinned : unpinned).push(entry);
  }
  const out = new Map<string, V>();
  for (const [k, v] of pinned) out.set(k, v);
  for (const [k, v] of unpinned) out.set(k, v);
  return out;
}
```

- [ ] **Step 6: Build and run the tests to verify they pass**

Run: `pnpm run build && pnpm run test`
Expected output includes:
```
✔ partitionPinnedFirst preserves order when nothing is pinned
✔ partitionPinnedFirst moves a single pinned to the front
✔ partitionPinnedFirst keeps pinned in insertion order (FIFO)
✔ partitionPinnedFirst keeps unpinned in insertion order within their group
✔ partitionPinnedFirst is a no-op when input already satisfies the invariant
✔ partitionPinnedFirst returns a new Map (does not mutate input)
✔ partitionPinnedFirst preserves the same value references
```
All previously-existing tests should still pass too.

- [ ] **Step 7: Commit**

```bash
git add src/agents/pinSort.ts src/agents/pinSort.test.ts esbuild.config.mjs package.json
git commit -m "feat(agents): partitionPinnedFirst helper + tests"
```

---

## Task 4: Wire pinning into `AgentManager`

**Files:**
- Modify: `src/agents/AgentManager.ts`

- [ ] **Step 1: Import `partitionPinnedFirst`**

In `src/agents/AgentManager.ts`, near the existing `import` for `./Agent` (top of file), add:

```ts
import { partitionPinnedFirst } from './pinSort';
```

- [ ] **Step 2: Make `kill()` honor pinned**

Find the `kill(id: string)` method (around line 842). Change it from:

```ts
  kill(id: string): void {
    this.removeAgent(id);
  }
```

to:

```ts
  kill(id: string): void {
    const a = this.agents.get(id);
    // Pinned cards refuse kill until the user unpins them. No toast or
    // log — the pin icon (rendered in place of the X) is the visible
    // cue. Cmd+Backspace and the on-card pin button both route here.
    if (!a || a.pinned) return;
    this.removeAgent(id);
  }
```

- [ ] **Step 3: Add `togglePin()` and a private `applyPinnedFirst()` helper next to `kill()`**

`this.agents` is declared `private readonly` (line 29: `private readonly agents = new Map<string, Agent>();`). `readonly` blocks **reassignment**, not in-place mutation, so we'll mirror the pattern used by `reorder()`: clear the Map and repopulate it from the partitioned copy. This keeps the field declaration untouched.

Immediately after the `kill()` method's closing brace, add:

```ts
  /**
   * Flip the pinned flag for `id`, then re-stable-partition the agents
   * Map so pinned entries lead and unpinned follow. Setter on the Agent
   * already triggers a persist via metaChangeEmitter — the explicit
   * persist() here writes the *order* after resort (the
   * metaChange-driven persist captured the pre-resort order). Two small
   * writes per toggle is acceptable; the file is tiny.
   */
  togglePin(id: string): void {
    const a = this.agents.get(id);
    if (!a) return;
    a.setPinned(!a.pinned);
    this.applyPinnedFirst();
    this.persist();
  }

  /**
   * In-place pinned-first resort. Used after any operation that could
   * leave the Map order violating the invariant (togglePin, reorder
   * from the webview, hand-edited sessions.json on restore). Keeps the
   * `private readonly agents` field declaration intact — Map's `clear`
   * + `set` mutate in place, no reassignment needed.
   */
  private applyPinnedFirst(): void {
    const sorted = partitionPinnedFirst(this.agents);
    this.agents.clear();
    for (const [id, agent] of sorted) this.agents.set(id, agent);
  }
```

- [ ] **Step 4: Call resort from `reorder()`**

Find `reorder(ids: string[])` (around line 956). At the end of the method (after the final `this.persist();`), the existing implementation already rebuilds `this.agents` from the webview-supplied order. Append the resort:

```ts
  reorder(ids: string[]): void {
    const entries: [string, Agent][] = [];
    for (const id of ids) {
      const a = this.agents.get(id);
      if (a) entries.push([id, a]);
    }
    for (const [id, a] of this.agents) {
      if (!entries.some(([eid]) => eid === id)) entries.push([id, a]);
    }
    this.agents.clear();
    for (const [id, a] of entries) this.agents.set(id, a);
    // Enforce pinned-first invariant even if the user dragged across
    // the boundary. Snaps offending cards back to their legal slot.
    this.applyPinnedFirst();
    this.persist();
  }
```

- [ ] **Step 5: Write `pinned` to `sessions.json` in `persist()`**

Find `persist()` (around line 505). Add `pinned: a.pinned` to the mapped entry:

```ts
    const entries = Array.from(this.agents.values())
      .filter((a) => a.hasUserPrompt)
      .map((a) => ({
        id: a.id,
        cwd: a.cwd,
        model: a.model,
        sessionId: a.sessionId,
        name: a.name,
        titleSource: a.titleSource,
        hasUserPrompt: true,
        pinned: a.pinned,
      }));
```

- [ ] **Step 6: Read `pinned` in `restorePersistedAgents()`**

Find `restorePersistedAgents()` (where it calls `new Agent({ … hasUserPrompt: e.hasUserPrompt ?? true })`, around line 460–490). Add `pinned: e.pinned === true` to the construction args:

```ts
      const agent = new Agent({
        id: e.id,
        cwd: e.cwd,
        model: e.model,
        // … other existing fields …
        hasUserPrompt: e.hasUserPrompt ?? true,
        pinned: e.pinned === true,
      });
```

(Use the exact existing arg names — match the surrounding code.)

After the restore loop completes (after `this.emitUnreadCount()` at the end of the method, around line 497), add a resort pass:

```ts
    // Normalize pinned-first even if sessions.json was hand-edited.
    this.applyPinnedFirst();
```

- [ ] **Step 7: Forward `pinned` through `makeAgent()`**

Find `makeAgent()` (around line 614–625). Add `pinned?: boolean;` to the opts type:

```ts
  private makeAgent(opts: {
    id: string;
    cwd: string;
    model: ClaudeModel;
    dormant?: boolean;
    sessionId?: string | null;
    initialSnapshot?: { name?: string; titleSource?: AgentSnapshot['titleSource'] };
    hasUserPrompt?: boolean;
    pinned?: boolean;
  }): Agent {
```

And pass it into the `new Agent({ … })` call inside `makeAgent`:

```ts
      hasUserPrompt: opts.hasUserPrompt,
      pinned: opts.pinned,
```

This keeps `newAgent` (fresh spawn) and `openOldSession` (resume) working — both go through `makeAgent` and won't pass `pinned`, so it defaults to `false`. Restored agents bypass `makeAgent` and call `new Agent(...)` directly (Step 6 handled that path).

- [ ] **Step 8: Build to verify all wiring compiles**

Run: `pnpm run build`
Expected: build succeeds. The compile error chain from Tasks 1–2 should be fully resolved.

- [ ] **Step 9: Commit**

```bash
git add src/agents/AgentManager.ts
git commit -m "feat(agent-manager): togglePin, kill-guard, persist + restore pinned"
```

---

## Task 5: Route `togglePin` messages in `AgentPanelProvider`

**Files:**
- Modify: `src/view/AgentPanelProvider.ts`

- [ ] **Step 1: Add the message handler case**

In `src/view/AgentPanelProvider.ts`, find the `handle()` method's switch (around line 230–280). Locate the `case 'kill':` block. Immediately after it, add:

```ts
      case 'togglePin':
        this.manager.togglePin(msg.id);
        break;
```

- [ ] **Step 2: Build to verify**

Run: `pnpm run build`
Expected: build succeeds, no TS errors. The compiler now knows `togglePin` is exhaustively handled (the `WebviewToHost` union added it in Task 1).

- [ ] **Step 3: Commit**

```bash
git add src/view/AgentPanelProvider.ts
git commit -m "feat(panel-provider): route togglePin to AgentManager"
```

---

## Task 6: Add `p` key binding to the webview

**Files:**
- Modify: `src/view/webview/AgentList.tsx`

- [ ] **Step 1: Add the `p` branch to `onKeyDown`**

In `src/view/webview/AgentList.tsx`, find the `onKeyDown` handler (around line 109). Insert a new `else if` after the `f` branch (around line 144) and before the `c` branch (around line 145):

```ts
    } else if (e.key === 'p' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      // Plain `p` toggles the pin on the active card. The
      // `e.target !== e.currentTarget` guard at the top of onKeyDown
      // already prevents this firing while the rename input owns focus,
      // so typing `p` in the rename box doesn't trigger.
      if (!activeId) return;
      e.preventDefault();
      postToHost({ type: 'togglePin', id: activeId });
```

(Match the closing brace style of the existing branches — there is no closing brace on this one because it's an `else if` that continues into the next.)

- [ ] **Step 2: Build to verify**

Run: `pnpm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/view/webview/AgentList.tsx
git commit -m "feat(webview): bind p key to togglePin on the active card"
```

---

## Task 7: Apply pinned-first sort at render time in the webview

**Files:**
- Modify: `src/view/webview/AgentList.tsx`

The webview already maintains an optimistic `localOrder` (set on drag-drop). The reset effect only clears `localOrder` when the agent **set** changes, not when the **order** changes. Without a render-time sort, a `togglePin` after a drag wouldn't visibly reorder the cards.

- [ ] **Step 1: Wrap `orderedAgents` with a stable pinned-first sort**

Find the `orderedAgents` definition (around line 56–61):

```ts
  // Apply the local order if active; otherwise use the props' order.
  const orderedAgents = localOrder
    ? localOrder
        .map((id) => agents.find((a) => a.id === id))
        .filter((a): a is AgentSnapshot => !!a)
    : agents;
```

Replace it with:

```ts
  // Apply the local order if active; otherwise use the props' order.
  // Then enforce pinned-first as a stable sort on top — mirrors the
  // host's invariant so toggling pin updates the order even while
  // localOrder (drag optimism) is still held. Stable sort means
  // within-section order from the chosen base is preserved.
  const baseOrder = localOrder
    ? localOrder
        .map((id) => agents.find((a) => a.id === id))
        .filter((a): a is AgentSnapshot => !!a)
    : agents;
  const orderedAgents = [...baseOrder].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned),
  );
```

- [ ] **Step 2: Build to verify**

Run: `pnpm run build`
Expected: build succeeds. No behavior change yet — no card is pinned in the wild, so the sort is a no-op.

- [ ] **Step 3: Commit**

```bash
git add src/view/webview/AgentList.tsx
git commit -m "feat(webview): pinned-first stable sort at render"
```

---

## Task 8: Pin icon in the card corner button + CSS

**Files:**
- Modify: `src/view/webview/AgentCard.tsx`
- Modify: `src/view/webview/styles.css`

- [ ] **Step 1: Add `pinned` modifier class to the card root**

In `src/view/webview/AgentCard.tsx`, find the root `div`'s className composition (around line 140–147):

```tsx
      className={
        'agent-card' +
        (active ? ' active' : '') +
        (agent.starting ? ' starting' : '') +
        (dragging ? ' dragging' : '') +
        (dragOver ? ' drag-over' : '') +
        ` status-${status}`
      }
```

Change to:

```tsx
      className={
        'agent-card' +
        (active ? ' active' : '') +
        (agent.starting ? ' starting' : '') +
        (dragging ? ' dragging' : '') +
        (dragOver ? ' drag-over' : '') +
        (agent.pinned ? ' pinned' : '') +
        ` status-${status}`
      }
```

- [ ] **Step 2: Swap the corner button between X and pin icon based on `pinned`**

Find the kill button at the bottom of the JSX (around line 263–280):

```tsx
      <button
        className="agent-kill"
        title="Close session"
        aria-label="Close session"
        onClick={(e) => { e.stopPropagation(); onKill(); }}
      >
        <svg
          viewBox="0 0 12 12"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        >
          <line x1="3" y1="3" x2="9" y2="9" />
          <line x1="9" y1="3" x2="3" y2="9" />
        </svg>
      </button>
```

Replace with:

```tsx
      {agent.pinned ? (
        <button
          className="agent-kill pinned"
          title="Unpin"
          aria-label="Unpin session"
          onClick={(e) => {
            e.stopPropagation();
            postToHost({ type: 'togglePin', id: agent.id });
          }}
        >
          {/* Pin glyph — stroked, matches the X button's 12-unit viewBox
              so positioning and stroke weight align with the unpinned state. */}
          <svg
            viewBox="0 0 12 12"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {/* Pin body: small triangle pin head over a needle. Sized to
                read at 12px without anti-aliasing mush. */}
            <path d="M6 1.5 L8.5 4 L7.5 5 L4.5 5 L3.5 4 Z" />
            <line x1="6" y1="5" x2="6" y2="9.5" />
            <line x1="4" y1="9.5" x2="8" y2="9.5" />
          </svg>
        </button>
      ) : (
        <button
          className="agent-kill"
          title="Close session"
          aria-label="Close session"
          onClick={(e) => { e.stopPropagation(); onKill(); }}
        >
          <svg
            viewBox="0 0 12 12"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          >
            <line x1="3" y1="3" x2="9" y2="9" />
            <line x1="9" y1="3" x2="3" y2="9" />
          </svg>
        </button>
      )}
```

- [ ] **Step 3: Add CSS for the pin button**

In `src/view/webview/styles.css`, find the existing `.agent-kill` rules. Right after them, append:

```css
/* Pin button — same slot as the close X, different visual semantics.
   Pinned state means "do not close" — color stays neutral (no red
   hover), and the icon is readable at rest (the X is faded at rest
   and only colors up on hover). The pin glyph doubles as the
   "this card is pinned" indicator, so it must be visible without
   hover. */
.agent-kill.pinned {
  opacity: 0.85;
  color: var(--vscode-foreground);
}
.agent-kill.pinned:hover {
  opacity: 1;
  color: var(--vscode-foreground);
  background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.08));
}
```

(If you grep the file and find existing `--vscode-*` tokens already in use, prefer those over the fallback. The fallback `rgba(255,255,255,0.08)` only kicks in if VS Code doesn't expose `--vscode-toolbar-hoverBackground` in this webview context — most current versions do.)

- [ ] **Step 4: Import `postToHost` if not already in scope**

`AgentCard.tsx` already imports `postToHost` at the top (around line 3) — verify with `grep "postToHost" src/view/webview/AgentCard.tsx`. If the import is missing, add `import { postToHost } from './api';`.

- [ ] **Step 5: Build to verify**

Run: `pnpm run build`
Expected: build succeeds with no TS errors. The webview bundle includes the new conditional rendering.

- [ ] **Step 6: Commit**

```bash
git add src/view/webview/AgentCard.tsx src/view/webview/styles.css
git commit -m "feat(webview): pin icon corner button + pinned modifier"
```

---

## Task 9: Manual verification in the Extension Development Host

**Files:** none modified — verification only.

VS Code extensions for this codebase are not unit-tested at the integration level (only the pure helpers are). The acceptance test is hands-on. Run through every case.

- [ ] **Step 1: Launch the EDH**

Run from the project root:

```bash
/Applications/Visual\ Studio\ Code.app/Contents/MacOS/Code --extensionDevelopmentPath="$PWD"
```

(Per the user's preference saved in memory — do NOT use the `code` shell alias.)

A new VS Code window opens with the dev build of Glance loaded. Open the Glance panel via the activity bar or `Cmd+Shift+G`.

- [ ] **Step 2: Pin via keyboard**

Spawn three agents (press `g` three times with the panel focused). Submit any short prompt to each so they pass the `hasUserPrompt` filter and persist.

Use `↑`/`↓` to select the middle card. Press `p`.

Expected:
- The card moves to the top of the list.
- The X close button becomes a pin icon.
- The card has the `pinned` class on its root (inspect via DevTools: `Cmd+Shift+I` in EDH → check the card root `<div>`).

- [ ] **Step 3: Pin FIFO ordering**

With one card already pinned at the top, press `p` on another card.

Expected: the newly pinned card lands **below** the existing pinned card (FIFO — appended to bottom of pinned section), not above it. Unpinned cards remain below both.

- [ ] **Step 4: Kill blocking via `Cmd+Backspace`**

Select a pinned card. Press `Cmd+Backspace`.

Expected: the card stays. No toast, no error in the dev console. The activity-bar badge (if any) is unchanged.

- [ ] **Step 5: Kill blocking via the corner button**

Click the pin icon on a pinned card.

Expected: the card unpins (icon flips back to X, card slides down to its pre-pin position among unpinned cards in their existing order). The card is NOT killed.

- [ ] **Step 6: Kill works after unpin**

Press `p` again on a pinned card to unpin it. Then press `Cmd+Backspace`.

Expected: the card is killed. `sessions.json` no longer lists it.

- [ ] **Step 7: `/clear` (`c c`) still works on a pinned card**

Pin a card. Press `c` twice within 400 ms.

Expected: Claude's `/clear` runs in the agent's terminal, the card resets its TL;DR/progress/title to defaults, but the card stays pinned and stays at the top of the list.

- [ ] **Step 8: Drag-and-drop respects the pinned/unpinned boundary**

Pin one card. Try to drag an unpinned card above the pinned card.

Expected: the visual drop indicator may show above the pinned card briefly, but on drop the unpinned card snaps to the top of the unpinned section (immediately below all pinned cards). No card ordering ever has an unpinned-above-pinned violation.

Try the reverse: drag a pinned card down into the unpinned section. Same result — snaps back to its FIFO slot.

- [ ] **Step 9: Persistence across reload**

With at least one card pinned, run `Cmd+R` to reload the dev window.

Expected: after reload, the pinned card is still pinned (pin icon, at top of list) and `sessions.json` (in the global storage dir) contains `"pinned": true` for that agent.

To find the file:
```bash
ls ~/Library/Application\ Support/Code/User/globalStorage/hamzawaleed.glance-claude-code/workspaces/
# pick the matching workspace hash, then:
cat "~/Library/Application Support/Code/User/globalStorage/hamzawaleed.glance-claude-code/workspaces/<hash>/sessions.json"
```

- [ ] **Step 10: Rename input doesn't eat the `p` key**

Pin a card, then double-click its title to enter rename mode. Type "pizza" in the rename input.

Expected: the text "pizza" lands in the input. The `p` key does NOT toggle pin while the input has focus (the `e.target !== e.currentTarget` guard at the top of `onKeyDown` handles this).

- [ ] **Step 11: Filter input doesn't eat the `p` key**

If the agent-list filter input is visible, focus it and type "p".

Expected: same — `p` lands in the input, no pin toggle fires.

- [ ] **Step 12: Backwards-compat with old `sessions.json`**

Quit EDH. Hand-edit the `sessions.json` to remove all `pinned` fields from every entry. Re-launch EDH.

Expected: every restored card reads as unpinned (X corner button), in whatever order the file specified. No crash, no error in the console.

- [ ] **Step 13: Resort on restore corrects hand-edited violations**

Quit EDH. Hand-edit `sessions.json` to put an unpinned agent above a pinned one (manually set one entry's `pinned: true` but leave it below an unpinned entry). Re-launch.

Expected: on restore, the pinned card surfaces to the top of the list. The next `persist()` call (any agent action) rewrites the file in pinned-first order.

- [ ] **Step 14: Quit EDH cleanly**

Close the dev window. Verify the original VS Code window (if you have one open with Glance installed) is untouched.

If any step fails, **stop and fix before continuing.** Do not commit a "mostly works" pin feature — kill-blocking and persistence are the two correctness-critical paths.

---

## Task 10: Update README + CHANGELOG

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add `p` to the README shortcut table**

In `README.md`, find the "With the Glance panel focused" shortcut table (around line 84–92). Insert a new row after the "Drop back to the panel" row:

```
| Pin / unpin the highlighted agent | `p` |
```

So the table becomes:

```
| Action | Shortcut |
| --- | --- |
| Cycle agents | `↑` / `↓` |
| Jump into the highlighted agent's terminal | `Enter` |
| Drop back to the panel | `Esc` |
| Pin / unpin the highlighted agent | `p` |
| New agent | `g` (or `Cmd+Shift+G` again) |
| Run `/clear` on the highlighted agent | `c` `c` (press `c` twice within 400 ms) |
| Toggle bottom-panel maximize (full-screen the terminal) | `f` |
| Kill the highlighted agent | `Cmd+Backspace` / `Ctrl+Backspace` |
```

- [ ] **Step 2: Add a one-line description above the table, in the section body**

Find the line that ends the "Per-agent model picker" section, and add a new subsection just before "Keyboard shortcuts":

```markdown
### Pin a card you don't want to lose

Press `p` with a card focused to pin it. Pinned cards jump to the top of the list (FIFO when you pin a second/third), can't be killed with `Cmd+Backspace` or the X (the X is replaced by a pin icon), and survive reloads. Press `p` again (or click the pin icon) to unpin.
```

- [ ] **Step 3: Add a CHANGELOG entry**

The user owns version bumps and CHANGELOG header lines (per memory: "publish only on explicit request"). Add an entry at the top of `CHANGELOG.md` under a new header that the user will fill in when they ship:

```markdown
## 0.0.X — YYYY-MM-DD

- **New: pin agent cards.** Press `p` with a card focused to pin it. Pinned cards sort to the top of the list (FIFO), refuse `Cmd+Backspace` / X deletion, and persist across reloads. Press `p` again or click the pin icon to unpin. `/clear` still works on pinned cards.
```

Leave the `0.0.X` and `YYYY-MM-DD` placeholders — the user fills them in at release time.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: pin/unpin shortcut + CHANGELOG entry"
```

---

## Verification

After all tasks complete, run the full test suite once and confirm a clean build:

```bash
pnpm run build && pnpm run test
```

Expected output: all tests pass (including the seven new `partitionPinnedFirst` cases), no TypeScript errors, no esbuild warnings.

A final manual smoke test in EDH (steps 2, 4, 9 from Task 9 minimum) confirms the feature works end-to-end.
