# Pin agent cards — design

**Status:** approved
**Date:** 2026-05-14

## Problem

There's no way to protect an important agent from accidental kill (`Cmd+Backspace`, X button) or to keep a long-running agent visually anchored at the top of the list. With a few dozen agents over a day, the order shifts every time a new one is spawned and the user has to hunt for the one they care about.

## Goal

Add a per-agent **pin** that:

1. Toggles via the `p` key when the card is focused, or by clicking the corner button on a pinned card.
2. Blocks deletion (`Cmd+Backspace`, X button) until the card is unpinned.
3. Auto-moves the card to the top of the list (above any unpinned cards). Multiple pins follow **FIFO** order — newest pin appends to the bottom of the pinned section.
4. Persists across reloads.

Non-goals (v1):
- Drag-reorder within the pinned section. FIFO only; reorder among pinned cards requires unpin + re-pin in the desired order.
- A right-click / context-menu pin entry. Keyboard (`p`) + corner-button click are the two supported paths.
- Any change to `/clear` (`c c`) behavior. Pin gates kill only; `/clear` still works on pinned cards.

## Data model

One new boolean propagates through three layers:

### `AgentSnapshot` (`src/shared/messages.ts`)
```ts
export interface AgentSnapshot {
  // ...existing fields
  pinned: boolean;
}
```

### `Agent` (`src/agents/Agent.ts`)
- Private field `_pinned: boolean` (default `false`).
- Public getter `pinned`.
- `setPinned(pinned: boolean)`: assigns `_pinned`, fires `onMetaChange` (so AgentManager persists and the snapshot diff reaches the webview).
- `snapshot()` includes `pinned: this._pinned`.
- Constructor accepts `pinned?: boolean` in `AgentInit` for rehydration.

### `sessions.json` entry
```json
{
  "id": "AG-01",
  "cwd": "/abs/path",
  "model": "default",
  "sessionId": "uuid",
  "name": "Glance-01",
  "titleSource": "ai",
  "hasUserPrompt": true,
  "pinned": false
}
```

`pinned` is optional on read for backwards compatibility — missing reads as `false`. Always written by `persist()`.

## Ordering invariant

New private method `AgentManager.resortPinnedFirst()`: stable-partition `this.agents` into pinned-then-unpinned, preserving current Map order within each partition. Implementation:

```ts
private resortPinnedFirst(): void {
  const pinned: [string, Agent][] = [];
  const unpinned: [string, Agent][] = [];
  for (const entry of this.agents) {
    (entry[1].pinned ? pinned : unpinned).push(entry);
  }
  this.agents.clear();
  for (const [id, a] of pinned) this.agents.set(id, a);
  for (const [id, a] of unpinned) this.agents.set(id, a);
}
```

Called from:
- `togglePin(id)` — after the flag flips.
- `reorder(ids)` — after the webview's drag order is applied verbatim. If the user dragged across the pinned/unpinned boundary, the resort silently corrects it.
- `restorePersistedAgents()` — after rehydration, so a hand-edited `sessions.json` can't violate the invariant.

Tests assert that the Map order returned by `list()` always satisfies: every pinned agent appears before every unpinned agent.

## Pin/unpin flow

### New message type (`src/shared/messages.ts`)
```ts
| { type: 'togglePin'; id: string }
```
Added to `WebviewToHost`.

### Host handler (`src/view/AgentPanelProvider.ts`)
```ts
case 'togglePin':
  this.manager.togglePin(msg.id);
  break;
```

### `AgentManager.togglePin(id)`
```ts
togglePin(id: string): void {
  const a = this.agents.get(id);
  if (!a) return;
  a.setPinned(!a.pinned);
  this.resortPinnedFirst();
  this.persist();
}
```

`setPinned` already fires `onMetaChange`, which triggers `persist()` on its own — the explicit `persist()` after `resortPinnedFirst()` ensures the *order* is also written (onMetaChange persists the agent's own flag but doesn't trigger a re-serialize triggered by the Map reordering).

A `state` broadcast (full agent list with new order + `pinned: true` on the target) follows naturally from the existing change pipeline.

## Kill blocking

`AgentManager.kill(id)` and `AgentManager.removeAgent(id)`: early-return if `agent.pinned`.

```ts
kill(id: string): void {
  const a = this.agents.get(id);
  if (!a || a.pinned) return;
  this.removeAgent(id);
}
```

No toast, no log entry — the pin icon in place of the X is the visual cue. The webview-side guard is unnecessary because the manager is the single chokepoint for both `kill` messages and `Cmd+Backspace` keyboard kills (both route through `onKill → postToHost({ type: 'kill' }) → manager.kill()`).

## Keyboard handler

In `AgentList.tsx::onKeyDown`, add a branch after the `f` case:

```ts
else if (e.key === 'p' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
  if (!activeId) return;
  e.preventDefault();
  postToHost({ type: 'togglePin', id: activeId });
}
```

The existing `if (e.target !== e.currentTarget) return;` guard at the top of `onKeyDown` already prevents `p` from firing when the rename input or any nested child owns focus.

## Webview UI

In `AgentCard.tsx`, the corner button at the end of the card renders conditionally on `agent.pinned`:

- **Unpinned** (existing behavior): `<button class="agent-kill">` with the X SVG, `onClick={onKill}`, `title="Close session"`.
- **Pinned**: same button slot, `<button class="agent-kill pinned">`, pin glyph SVG (24x24 viewBox, single stroke matching the X), `onClick={() => postToHost({ type: 'togglePin', id: agent.id })}`, `title="Unpin"`, `aria-label="Unpin session"`.

CSS additions in `styles.css`:
- `.agent-kill.pinned:hover` — neutral/accent color (not the red the close X uses on hover).
- `.agent-kill.pinned` — possibly slightly more visible at rest than the X (the X is dim until hover; the pin icon doubles as the indicator that the card is pinned, so it should be readable without hover).

The card root also gets a `pinned` modifier class (`'agent-card pinned'`) for future styling hooks. No other visual changes in v1 — the icon swap is the indicator.

## Drag-and-drop semantics

No changes to `AgentList.tsx` drag handlers. The host's `resortPinnedFirst()` after `reorder()` is the single point of enforcement. Three cases:

1. **Drag unpinned card up into pinned region**: applied verbatim, then resort snaps it to the top of the unpinned section. Local optimistic state in the webview gets overwritten by the next `state` broadcast.
2. **Drag pinned card down into unpinned region**: same as above — resort snaps it back to its FIFO slot.
3. **Drag within either section**: no boundary crossed; resort is a no-op; reorder takes effect.

A small visual "bounce" is acceptable for v1. If it's distracting, future v2 sets `draggable={!agent.pinned}` on the card (since drag-reorder of pinned cards is a non-goal anyway).

## Persistence and rehydration

`persist()` writes the new `pinned` field for every entry.

`restorePersistedAgents()` reads `entry.pinned ?? false` and passes it through `AgentInit` to the `Agent` constructor. After all agents are restored, `resortPinnedFirst()` runs once to normalize the order in case the on-disk file was hand-edited.

`sessions.json` schema bump is non-breaking: existing entries without `pinned` read as unpinned.

## Testing

Add `src/agents/pinning.test.ts` (compiled to `out/agents/pinning.test.js`), wired into:
- `esbuild.config.mjs::testEntries`
- `package.json::scripts.test`

Cases:
1. **Pin moves to top of list**: agents `[A, B, C]`, all unpinned. `togglePin(B)` → `list()` returns `[B, A, C]`.
2. **Pin FIFO ordering**: pin A, then pin C → `list()` returns `[A, C, B]` (A first by insertion order, C appended to bottom of pinned section).
3. **Kill blocked on pinned**: `togglePin(A); kill(A);` — `list()` still contains A, no `agentRemoved` event fired.
4. **Kill works after unpin**: `togglePin(A); togglePin(A); kill(A);` — A is removed.
5. **Persist round-trip**: serialize → deserialize → ordering and `pinned` flags preserved.
6. **Backwards compat**: deserialize a `sessions.json` without `pinned` keys → all agents read as `pinned: false`.

## Backwards compatibility

- `sessions.json` without `pinned` reads as unpinned. No migration step needed.
- Webview built against old `AgentSnapshot` would receive an extra field — TypeScript-only concern, runtime ignores extra properties. Since host + webview ship together in the same `.vsix`, no version skew in practice.

## File changes summary

| File | Change |
| --- | --- |
| `src/shared/messages.ts` | `+ pinned: boolean` on `AgentSnapshot`; `+ togglePin` to `WebviewToHost` |
| `src/agents/Agent.ts` | `_pinned` field, getter, `setPinned()`, `AgentInit.pinned`, snapshot includes pinned |
| `src/agents/AgentManager.ts` | `togglePin()`, `resortPinnedFirst()`, kill/removeAgent guards, `persist()`/restore reads/writes pinned, `reorder()` calls resort, `restorePersistedAgents()` calls resort |
| `src/view/AgentPanelProvider.ts` | `togglePin` case in the message handler |
| `src/view/webview/AgentList.tsx` | `p` key branch in `onKeyDown` |
| `src/view/webview/AgentCard.tsx` | Conditional pin-icon vs X-icon corner button; `pinned` class on card root |
| `src/view/webview/styles.css` | `.agent-kill.pinned` and `.agent-kill.pinned:hover` styles |
| `src/agents/pinning.test.ts` | New test file |
| `esbuild.config.mjs` | Add new test file to `testEntries` |
| `package.json` | Add new test file to `scripts.test` |

## Open questions

None. All ambiguities resolved during brainstorming:
- Pin order in pinned section: **FIFO** (newest at bottom).
- Unpin button visual: **X swaps to pin icon** in same slot.
- `/clear` on pinned: **still works** (pin only blocks deletion).
