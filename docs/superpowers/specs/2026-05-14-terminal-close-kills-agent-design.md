# Terminal close from VS Code panel kills the agent card

Date: 2026-05-14
Status: Approved for implementation

## Problem

When a user clicks the trash/X icon on an agent's terminal in VS Code's bottom panel, the corresponding agent card in the Glance sidebar stays alive as a dormant entry. The user's mental model is "I closed this terminal because I'm done with it" — they expect the card to disappear, matching the trash button in the Glance panel.

Today's behaviour: any PTY exit (terminal-trash, Cmd+R reload, accidental close, `/exit` inside Claude) routes through `Agent.onExit → becomeDormant()`. The card persists in `sessions.json` and can be revived. This is deliberate, because Cmd+R also tears down terminals and we don't want reloads to wipe sessions.

## Goal

Make the trash/X on a VS Code terminal call `AgentManager.kill(id)` — the same path the Glance trash button uses — while preserving dormancy for every other reason a PTY might exit.

Non-destructive in practice: `removeAgent()` already archives state by `sessionId` into `state/by-session/`, so the session is reopenable via the picker UI.

## Detection signal

`Pseudoterminal.close()` (the method on the `vscode.Pseudoterminal` we hand to VS Code) is the load-bearing signal. VS Code invokes it in exactly these cases:

| Case | Should kill? | Disambiguator |
|------|--------------|---------------|
| User clicks trash/X on terminal in panel | ✅ yes | neither flag set |
| We called `terminal.dispose()` internally (becomeDormant, Agent.dispose) | ❌ no | `_selfDisposing` flag set on the Agent before our `terminal.dispose()` call |
| Extension host shutting down (Cmd+R, window close, quit) | ❌ no | `shuttingDown` flag set in `AgentManager` from `deactivate()` |

VS Code awaits the return of `deactivate()` before disposing terminals, so a flag set inside `deactivate()` is observed by the close handlers that fire afterwards.

The "user types `/exit` inside Claude" case does NOT call `Pseudoterminal.close()` directly — the PTY exits, our `closeEmitter` signals VS Code that the pty side is done, VS Code marks the terminal dead but doesn't invoke our `close()`. Our own `Agent.onExit → becomeDormant → terminal.dispose()` then does cause `close()` to fire, but `_selfDisposing` is set first, so the handler skips it. Agent stays dormant — current behaviour preserved.

## Component changes

### `src/agents/pseudoterminal.ts`

Add an `onCloseRequested` event fired from the existing `close()` method body. This is the only signal that "VS Code is asking us to close the terminal from the outside." Consumers (Agent) decide whether to act on it based on their own state.

```ts
const closeRequestEmitter = new vscode.EventEmitter<void>();
// ...
const pseudoterminal: vscode.Pseudoterminal = {
  // ...existing fields
  close() {
    closeRequestEmitter.fire();
    proc?.kill();
    proc = null;
  },
};
return {
  // ...existing returns
  onCloseRequested: closeRequestEmitter.event,
};
```

The wrapper's `dispose()` should also dispose `closeRequestEmitter` to match the other emitter cleanups already there.

### `src/agents/Agent.ts`

Add:
- `private _selfDisposing = false`
- `private readonly userCloseEmitter = new vscode.EventEmitter<void>()`
- `readonly onUserClose = this.userCloseEmitter.event`

Wire it inside the constructor, alongside the existing `this.claude.onExit(...)` subscription:

```ts
this.claude.onCloseRequested(() => {
  if (this._selfDisposing) return;
  if (this._dormant) return;
  this.userCloseEmitter.fire();
});
```

Set `_selfDisposing = true` immediately before each of the two internal `terminal?.dispose()` calls:
1. Inside `becomeDormant()` (line ~319)
2. Inside `dispose()` (line ~605)

Dispose `userCloseEmitter` in `Agent.dispose()` along with the other emitters.

### `src/agents/AgentManager.ts`

Add:
- `private shuttingDown = false`
- `markShuttingDown(): void { this.shuttingDown = true; }`

Wire the new event when an Agent is created. Find the existing `makeAgent` (or whichever method is the single place where Agent event subscriptions are attached) and add:

```ts
agent.onUserClose(() => {
  if (this.shuttingDown) return;
  this.kill(agent.id);
});
```

### `src/extension.ts`

Update `deactivate()` to mark shutdown before disposing:

```ts
export function deactivate(): void {
  manager?.markShuttingDown();
  manager?.dispose();
  manager = null;
}
```

## Edge-case walkthrough

- **Cmd+R reload**: `deactivate → markShuttingDown → shuttingDown=true`, then VS Code disposes terminals → `Pseudoterminal.close()` fires `onCloseRequested` on each → Agent's subscription fires `userCloseEmitter` (since `_selfDisposing` and `_dormant` are still false at that moment) → manager handler sees `shuttingDown=true` and returns. Agents are persisted then restored as dormant. ✅
- **Window close / VS Code quit**: same flow as reload. ✅
- **User clicks trash on terminal**: `shuttingDown=false`, `_selfDisposing=false`, `_dormant=false` → `userCloseEmitter` fires → `manager.kill(id) → removeAgent` (which archives state, purges live file, removes from sessions.json). ✅
- **User types `/exit` inside Claude**: PTY exits naturally. `proc.onExit` fires → `exitEmitter` fires → `Agent.onExit` handler runs → `becomeDormant()` sets `_selfDisposing=true` before calling `terminal.dispose()` → that triggers `Pseudoterminal.close() → onCloseRequested` → handler sees `_selfDisposing` and skips. Stays dormant. ✅
- **Glance panel trash button (`manager.kill(id)`)**: `removeAgent → a.dispose()` sets `_selfDisposing=true` → `terminal.dispose() → close() → onCloseRequested` → skipped. Agent is already removed from the map. ✅
- **Dormant agent (no terminal)**: no event can fire; only removable via Glance trash. ✅
- **Race in `removeAgent`**: existing code deletes from the map first, so any re-entrant `kill(id)` from the close event would early-return. With our new flag-based skip this can't happen anyway, but the defensive ordering remains.

## Files touched

- `src/agents/pseudoterminal.ts` — add `onCloseRequested` event, fire from `close()`, dispose emitter
- `src/agents/Agent.ts` — add `_selfDisposing` flag, `onUserClose` event, subscribe to `onCloseRequested`, set flag before internal `terminal.dispose()` calls (becomeDormant + dispose)
- `src/agents/AgentManager.ts` — add `shuttingDown` flag, `markShuttingDown()`, subscribe to each agent's `onUserClose`
- `src/extension.ts` — call `markShuttingDown()` before `dispose()` in `deactivate()`

No webview, marker, hook, or MCP changes. No new messages on the `HostToWebview` / `WebviewToHost` unions. No `package.json` changes.

## Test plan

There's no good way to faithfully simulate VS Code's `Pseudoterminal` lifecycle from `node:test`, so this is a manual test plan. The compiled-test suite is unchanged.

1. **Kill via terminal trash**
   - Create agent, send a user prompt, wait for `sessions.json` to include it
   - Click trash on the terminal in VS Code's panel
   - Expected: card disappears immediately, agent is removed from `sessions.json`, `state/<id>.json` is deleted, `state/by-session/<sessionId>.json` exists
2. **Reload preserves agents**
   - Create agent, user-prompt it, Cmd+R
   - Expected: card returns as dormant, terminal not spawned until click
3. **`/exit` inside Claude stays dormant**
   - Create agent, send a user prompt, type `/exit` in the Claude TUI
   - Expected: card becomes dormant (current behaviour preserved)
4. **Glance trash button regression check**
   - Click the trash icon on an agent card in the Glance panel
   - Expected: card disappears, behaviour identical to today
5. **Quit / reopen VS Code**
   - With active agents, fully quit VS Code, reopen the workspace
   - Expected: agents restored as dormant
6. **Trash on a never-prompted agent**
   - Open a fresh agent (no user prompt yet), click trash on its terminal
   - Expected: card disappears immediately (these agents aren't in `sessions.json` anyway, so this is essentially identical to today's "removed from in-memory map" path)
