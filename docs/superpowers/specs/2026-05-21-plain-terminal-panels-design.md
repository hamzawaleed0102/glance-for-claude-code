# Plain terminal panels — design

**Status:** approved
**Date:** 2026-05-21

## Problem

Every Glance card is a Claude Code session. Sometimes the user just wants a
plain shell next to their agents — to run `npm run dev`, tail a log, poke at
git — without the Claude TUI, the MCP state pipeline, or the hook machinery.
Today they have to leave Glance and open a regular VS Code terminal, which
then has no card and no place in the panel's keyboard flow.

## Goal

Add a second kind of card backed by a **plain shell**:

1. Pressing **`t`** with the Agents panel focused spawns a shell card (mirrors
   how `g` spawns a Claude card). It joins the same list.
2. The card starts titled **"shell"**; on the **first command** the user runs,
   the title becomes that **full command line**, then locks. Manual rename
   still works; `c c` does not re-unlock it.
3. While a command is executing, the card shows the **working dot**; idle at
   the prompt shows **no indicator**.
4. **`c c`** on a shell card clears the terminal scrollback (the Cmd+K
   equivalent) — it does **not** send `/clear`.
5. The card has a visually distinct style — dashed border, faint background
   tint, monospace `>_`-prefixed title.

Non-goals (v1):

- **Progress bar, skill pill, TL;DR / subtitle line.** A shell has no
  `update_state` pipeline; these fields are simply never populated.
- **Persistence across reload.** Shell processes can't be resumed the way
  `claude --resume` resumes a chat — shell cards are ephemeral and disappear
  on VS Code reload/restart.
- **Exit-code coloring of the status dot.** The exit code is available from
  the shell-integration API but surfacing it well needs a subtitle line,
  which v1 deliberately drops.
- **Turn-complete toast / attention tone / activity-bar badge.** Those are
  Claude-turn concepts; shell cards never trigger them.
- **A global keybinding or `+`-menu entry.** The `t` key (panel focused) plus
  a Command Palette command are the entry points; `t` mirrors `g`, which is
  likewise webview-keydown-only.
- **Renaming the VS Code terminal *tab*.** Only the *card* title is ours; a
  regular terminal can't be renamed after creation.

## Approach

The shell terminal is an **ordinary VS Code integrated terminal**
(`window.createTerminal`), not the node-pty `Pseudoterminal` that Claude cards
use. VS Code auto-injects **shell integration** for common shells, exposing
`onDidStartTerminalShellExecution` / `onDidEndTerminalShellExecution` — which
give the exact command line (for the title) and a running/finished signal
(for the in-progress dot) with no input parsing or idle-timer heuristics.

The node-pty `Pseudoterminal` wrapper exists almost entirely to hide the
`claude …` launch echo behind a startup placeholder; a bare shell has nothing
to hide, so reusing it would add complexity for no benefit.

## Architecture — two agent kinds, one interface

`Agent` (`src/agents/Agent.ts`, ~790 lines) is entirely Claude-specific: MCP
state file, hooks, dormancy, `--resume`, title-source precedence. Branching
shell logic into it inline would tangle two responsibilities in an already
large file. Instead:

### `AgentKind` (`src/shared/messages.ts`)

```ts
export type AgentKind = 'claude' | 'shell';
```

### `AgentSnapshot` (`src/shared/messages.ts`)

```ts
export interface AgentSnapshot {
  // ...existing fields
  kind: AgentKind;
}
```

`kind` is the discriminant the webview uses to style the card. Existing
`Agent` snapshots report `'claude'`; `ShellAgent` reports `'shell'`.

### `ManagedAgent` interface (`src/agents/ManagedAgent.ts`, new)

The kind-agnostic surface `AgentManager` and `AgentPanelProvider` rely on:

```ts
export interface ManagedAgent extends vscode.Disposable {
  readonly id: string;
  readonly kind: AgentKind;
  readonly pinned: boolean;
  readonly name: string;
  snapshot(): AgentSnapshot;
  reveal(): void;
  focusTerminal(): void;
  isTerminalActive(): boolean;
  ownsTerminal(t: vscode.Terminal): boolean;
  setPinned(pinned: boolean): void;
  setManualTitle(name: string): void;
  /** `/clear` for Claude cards; scrollback clear for shell cards. */
  clearActive(): void;
  readonly onChange: vscode.Event<Partial<AgentSnapshot>>;
}
```

`Agent` already structurally satisfies all of this except `kind` and the
`clearConversation` → `clearActive` rename (below). It becomes
`Agent implements ManagedAgent` with `readonly kind = 'claude'`.

`AgentManager.agents` becomes `Map<string, ManagedAgent>`. Claude-only code
paths narrow on `kind`:

- `handleHookEvent()` — `if (agent.kind !== 'claude') return;` at the top of
  routing, after which `agent` is the concrete `Agent`. (Shell agents never
  produce hook events anyway — they get no hook-settings file — so this is a
  type guard, not a behavior change.)
- `persist()` — filters `a.kind === 'claude' && a.hasUserPrompt`.
- `removeAgent()` — the kill-time state archive (`archiveStateOnKill`,
  `purgePersistentState`) runs only for `kind === 'claude'`; shell agents
  have no `sessionId` and no state file.

## `ShellAgent` (`src/agents/ShellAgent.ts`, new)

A small, focused class — no MCP, no hooks, no state file, no `sessionId`, no
dormancy, never persisted.

### Construction

```ts
this.terminal = vscode.window.createTerminal({
  name: 'shell',
  cwd: opts.cwd,
  isTransient: true,                              // not restored across reload
  iconPath: new vscode.ThemeIcon('terminal'),
  color: new vscode.ThemeColor('terminal.ansiCyan'), // Claude cards use green
});
```

`isTransient: true` is what delivers "disappear on reload" — VS Code does not
revive the terminal, and `ShellAgent` is never written to `sessions.json`, so
nothing reconstructs the card.

### State

| Field | Meaning |
| --- | --- |
| `_name` | Card title. Defaults to `'shell'`. |
| `_titleFromCommand` | `false` until the first non-empty command sets the title. Once `true`, later commands no longer change the title. |
| `_titleSource` | `'default'` initially and after first-command titling (no lock dot); `'manual'` after a user rename. |
| `_running` | A command is currently executing. Mapped to `snapshot.streaming`. |

`snapshot()` returns `kind: 'shell'`, `model: 'default'`, and `null` for
`tldr` / `progress` / `skill` / `errorReason` / `attentionReason`, with
`starting: false`. Those nulls are what make the progress bar, skill pill,
subtitle, model chip, and starting indicator stay hidden (see "Card
rendering").

### Shell-integration signals

Subscribes to the global events, filtering to its own terminal:

- **`window.onDidStartTerminalShellExecution`** — if
  `e.terminal === this.terminal`:
  - `_running = true` → fire `onChange({ streaming: true })`.
  - If `!_titleFromCommand`, derive a title from `e.execution.commandLine.value`
    via `deriveShellTitle()` (below). If non-null: set `_name`,
    `_titleFromCommand = true`, fire `onChange({ name })`.
- **`window.onDidEndTerminalShellExecution`** — if
  `e.terminal === this.terminal`: `_running = false` → fire
  `onChange({ streaming: false })`. (`e.exitCode` is intentionally unused.)
- **`window.onDidCloseTerminal`** — if `t === this.terminal`: fire the close
  event (below). Guarded by `_disposing` so our own `terminal.dispose()`
  doesn't loop back.

If the user's shell has integration disabled, the start/end events never
fire: the card stays titled "shell" with no working dot — degraded but a
fully usable terminal. The very first command can also be missed if
integration hasn't finished activating; accepted.

### Close semantics

Shell cards cannot be revived (no resume), so closing the terminal — whether
the user clicks the tab's X, or types `exit` — means the card is gone.
`ShellAgent` exposes a single `onClose` event; `AgentManager` wires it to
`removeAgent(id)`. Killing the card from Glance (X button / `Cmd+Backspace`)
goes the other direction: `removeAgent` → `dispose()` → `terminal.dispose()`,
with `_disposing` set so the resulting `onDidCloseTerminal` is ignored.

### Methods

- `reveal()` → `terminal.show(true)` (no focus steal).
- `focusTerminal()` → `terminal.show(false)` (focus steal).
- `isTerminalActive()` → `vscode.window.activeTerminal === this.terminal`.
- `ownsTerminal(t)` → `t === this.terminal`.
- `setManualTitle(name)` → sets `_name` / `_titleSource = 'manual'` (or back
  to `'default'` on empty), fires `onChange({ name, titleSource })`.
- `setPinned(p)` → fires `onChange({ pinned })`. Pinning is kind-agnostic and
  kept for shell cards (sort-to-top + kill protection still apply).
- `clearActive()` → `terminal.show(false)` then
  `vscode.commands.executeCommand('workbench.action.terminal.clear')`. The
  command targets the active terminal, so the terminal is focused first.
  Clearing scrollback does **not** reset the title.
- `dispose()` → set `_disposing`, dispose the shell-integration subscriptions
  and the terminal, dispose emitters.

## Title derivation — `src/agents/shellTitle.ts` (new, pure)

The one piece of pure, unit-testable logic:

```ts
/** Card title from a shell command line. `null` = don't adopt (keep prior). */
export function deriveShellTitle(commandLine: string): string | null {
  const trimmed = commandLine.trim();
  if (!trimmed) return null;          // bare Enter — don't burn the first slot
  const MAX = 120;
  return trimmed.length > MAX ? trimmed.slice(0, MAX - 1) + '…' : trimmed;
}
```

Because an empty command returns `null`, pressing Enter at an empty prompt
does not consume the first-command title slot.

## The `t` shortcut & entry points

### New message (`src/shared/messages.ts`)

```ts
| { type: 'newTerminal' }
```

Added to `WebviewToHost`. No `id` / `model` — it's a plain "spawn a shell".

### Keyboard handler (`src/view/webview/AgentList.tsx`)

In `onKeyDown`, a branch alongside the `g` case:

```ts
} else if (e.key === 't' && !e.metaKey && !e.ctrlKey && !e.altKey) {
  e.preventDefault();
  postToHost({ type: 'newTerminal' });
}
```

The existing `if (e.target !== e.currentTarget) return;` guard at the top of
`onKeyDown` already prevents `t` from firing while a rename input is focused.
`t` is currently unbound, so no conflict.

### Host handler (`src/view/AgentPanelProvider.ts`)

```ts
case 'newTerminal': {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) { vscode.window.showWarningMessage('Open a workspace folder first.'); return; }
  const id = this.manager.newTerminal({ cwd });
  this.pendingFocusTerminalId = id;
  this.scheduleFocusRetries(id);
  break;
}
```

Reuses the same focus-into-terminal path as `newAgent` so the user lands
ready to type. (A regular terminal attaches faster than a Claude PTY, but
reusing the retry logic costs nothing and keeps the two paths consistent.)

### `AgentManager.newTerminal()`

```ts
newTerminal(opts: { cwd: string }): string {
  const id = nextAgentId(this.agents.keys());
  const agent = new ShellAgent({ id, cwd: opts.cwd });
  agent.onChange((fields) => {
    this.changeEmitter.fire({ type: 'updated', id, fields });
    this.emitUnreadCount();
  });
  agent.onClose(() => this.removeAgent(id));
  this.agents.set(id, agent);
  this.changeEmitter.fire({ type: 'added', agent: agent.snapshot() });
  this.setActive(id);
  agent.reveal();
  return id;                          // no persist() — shell cards aren't saved
}
```

`nextAgentId` shares the `AG-NN` namespace across both kinds — they're all
cards in one list. No `wipeStateFile` (shell agents have no state file).

### Command Palette command

`extension.ts` registers `glancer.newTerminal` (parity with
`glancer.newAgent`); `package.json` contributes the command. **No
keybinding** — discoverability is the `t` key and the walkthrough.

### Walkthrough

`package.json`'s walkthrough "Keyboard shortcuts" step gains a line:
`**t** — open a plain shell terminal`.

## `c c` on a shell card

The webview already sends `{ type: 'clearActive' }` (no id — the manager uses
`activeId`). `AgentManager.clearActive()` becomes polymorphic:

```ts
clearActive(): void {
  if (!this.activeId) return;
  this.agents.get(this.activeId)?.clearActive();
}
```

`Agent.clearActive()` is the existing `clearConversation()` body (sends
`/clear`), renamed to satisfy the interface. `ShellAgent.clearActive()` clears
scrollback. No webview or message change needed — the chord already works on
"whatever the active agent is".

## Card rendering (`src/view/webview/AgentCard.tsx`)

When `agent.kind === 'shell'`:

- Card root className gains `kind-shell`.
- The title row renders a `>_` prefix span (`agent-shell-prefix`) before the
  name, and the name span gets a monospace modifier class.

Everything else needs **no special-casing** — it already keys off fields a
shell agent leaves null/default:

| Element | Already gated on | Shell value | Result |
| --- | --- | --- | --- |
| Progress bar | `agent.progress && status !== 'done'` | `progress: null` | hidden |
| Skill pill | `agent.skill && !agent.starting` | `skill: null` | hidden |
| Subtitle / TL;DR | `description` (error ?? attention ?? tldr) | all null | hidden |
| Model chip | `agent.model !== 'default'` | `'default'` | hidden |
| Starting indicator | `agent.starting` | `false` | hidden |

`statusOf()` for a shell agent yields only `'streaming'` (working dot, while
`_running`) or `'idle'` (no icon) — `'done'` requires `tldr || progress`,
which a shell never has. This is exactly the "just an in-progress indicator"
behavior.

## CSS (`src/view/webview/styles.css`)

New `.agent-card.kind-shell` rules:

- Dashed border (replacing the solid card border).
- Faint background tint distinct from the Claude card background.
- `.kind-shell .agent-name` — monospace font family.
- `.agent-shell-prefix` — dim monospace `>_` glyph before the title.

Scoped under `.kind-shell` so Claude cards are untouched.

## Persistence and reload

- `ShellAgent` is never added to `sessions.json` (`persist()` filters on
  `kind === 'claude'`).
- `restorePersistedAgents()` only ever reads Claude entries — unchanged.
- `isTransient: true` stops VS Code from reviving the terminal.
- `disposeOrphanGlanceTerminals()` matches by persisted name; shell terminals
  are transient and absent after reload, so there's nothing to dispose.

Net: after a reload, no shell terminal and no shell card. Matches the chosen
"disappear" behavior.

## Interaction with existing systems

- **Hook routing** — shell agents get no hook-settings file, so `hook.mjs`
  never fires for them; `handleHookEvent`'s `kind` guard is belt-and-braces.
- **`update_state` MCP** — shell agents get no `mcp-config.json`; no state
  file, no `stateWatcher`.
- **Activity-bar badge** — `ShellAgent.needsAttention` is always false (no
  such concept); `unreadCount()` is unaffected.
- **Turn-complete toast / tone** — shell agents never fire `onTurnComplete`.
- **`syncActiveFromTerminal`** — clicking the shell terminal tab fires
  `onDidChangeActiveTerminal`; the manager scans `ownsTerminal()` and finds
  the `ShellAgent`, highlighting its card. Works via the interface.
- **Drag-reorder, pin, rename, kill, arrow-nav, Enter-to-focus** — all
  kind-agnostic; they operate on `ManagedAgent` and need no changes.

## Testing

`src/agents/shellTitle.test.ts` (new) — `node:test` coverage of
`deriveShellTitle()`:

1. Plain command → returned trimmed: `"npm run dev"` → `"npm run dev"`.
2. Surrounding whitespace trimmed: `"  git status  "` → `"git status"`.
3. Empty string → `null`.
4. Whitespace-only string → `null`.
5. Over-long command → truncated to 120 chars with an ellipsis.
6. Exactly-120-char command → returned unchanged (boundary).

Wired into `esbuild.config.mjs::testEntries` and `package.json::scripts.test`
(the repo has no test glob — both lists are explicit).

The rest of the feature is VS Code-API glue (terminal lifecycle,
shell-integration events) — not unit-testable in the `node:test` harness, and
consistent with how the existing I/O layer (`Agent`, `AgentManager`,
`pseudoterminal`) is left untested. Manual verification: press `t`, run a
command, confirm title + working dot; run `c c`, confirm scrollback clears;
reload the window, confirm the shell card is gone.

## File changes summary

| File | Change |
| --- | --- |
| `src/shared/messages.ts` | `+ AgentKind` type; `+ kind` on `AgentSnapshot`; `+ newTerminal` in `WebviewToHost` |
| `src/agents/ManagedAgent.ts` | **New** — `ManagedAgent` interface |
| `src/agents/ShellAgent.ts` | **New** — shell-backed agent |
| `src/agents/shellTitle.ts` | **New** — pure `deriveShellTitle()` |
| `src/agents/shellTitle.test.ts` | **New** — `node:test` cases |
| `src/agents/Agent.ts` | `implements ManagedAgent`; `kind = 'claude'`; `snapshot()` adds `kind`; `clearConversation()` → `clearActive()` |
| `src/agents/AgentManager.ts` | `agents` typed `Map<string, ManagedAgent>`; `newTerminal()`; `kind` guards in `handleHookEvent` / `persist` / `removeAgent`; polymorphic `clearActive()` |
| `src/view/AgentPanelProvider.ts` | `newTerminal` message case |
| `src/view/webview/AgentList.tsx` | `t` key branch in `onKeyDown` |
| `src/view/webview/AgentCard.tsx` | `kind-shell` class; `>_` prefix; monospace title |
| `src/view/webview/styles.css` | `.agent-card.kind-shell` styles |
| `src/extension.ts` | Register `glancer.newTerminal` command |
| `package.json` | `glancer.newTerminal` command contribution; walkthrough shortcut line; test file in `scripts.test` |
| `esbuild.config.mjs` | `shellTitle.test.ts` in `testEntries` |
| `CLAUDE.md` | Document the shell-agent path under Architecture |

## Open questions

None. All ambiguities resolved during brainstorming:

- Title text: **full first command line**, then locked.
- Subtitle line: **none**.
- Reload behavior: **shell cards disappear**.
- Card style: **dashed border + tinted background + monospace `>_` title**.
- Spawn mechanism: **regular VS Code terminal + shell-integration API**.
