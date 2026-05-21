# Plain Terminal Panels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second Glance card kind — a plain shell terminal, spawned with the `t` key — alongside the existing Claude Code session cards.

**Architecture:** A shell card wraps an ordinary VS Code integrated terminal (not the node-pty `Pseudoterminal` Claude cards use). VS Code's shell-integration events supply the card title (first command) and the in-progress dot (command running). A `ManagedAgent` interface defines the kind-agnostic surface; `Agent` (Claude) and a new `ShellAgent` both implement it; `AgentManager` narrows with `instanceof Agent` for Claude-only paths.

**Tech Stack:** TypeScript, esbuild, VS Code Extension API (`window.createTerminal`, `onDidStartTerminalShellExecution`), React 18 webview, `node:test`.

---

## Working directory

All paths are relative to the `glancer-vscode/` project directory. All commands run from there. The feature branch `feat/plain-terminal-panels` already exists and is checked out (the design spec lives at `docs/superpowers/specs/2026-05-21-plain-terminal-panels-design.md`).

## Verify command

Several tasks end with this build + typecheck (esbuild does not type-check; `tsc --noEmit` is the real net):

```bash
pnpm run build && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.webview.json --noEmit
```

Expected: esbuild prints no errors; both `tsc` invocations exit 0 with no output.

## File Structure

**New files:**
- `src/agents/shellTitle.ts` — pure `deriveShellTitle()` helper (title from a command line). One responsibility, unit-tested.
- `src/agents/shellTitle.test.ts` — `node:test` cases for the above.
- `src/agents/ManagedAgent.ts` — the `ManagedAgent` interface (shared surface of both card kinds).
- `src/agents/ShellAgent.ts` — the shell-terminal-backed agent.

**Modified files:**
- `src/shared/messages.ts` — `AgentKind` type, `kind` on `AgentSnapshot`, `newTerminal` message.
- `src/agents/Agent.ts` — `kind: 'claude'`, `implements ManagedAgent`, `clearConversation` → `clearActive` rename.
- `src/agents/AgentManager.ts` — `Map<string, ManagedAgent>`, `newTerminal()`, `instanceof Agent` guards.
- `src/view/AgentPanelProvider.ts` — `newTerminal` message handler.
- `src/view/webview/AgentList.tsx` — `t` key handler.
- `src/view/webview/AgentCard.tsx` — `kind-shell` class + `>_` title prefix.
- `src/view/webview/styles.css` — `.agent-card.kind-shell` styles.
- `src/extension.ts` — register `glancer.newTerminal` command.
- `package.json` — command contribution, walkthrough shortcut line, test-file entry.
- `esbuild.config.mjs` — `shellTitle` test entries.
- `CLAUDE.md` — document the shell-agent path.

---

### Task 1: AgentKind type + snapshot plumbing

Adds the `kind` discriminant. `kind` is a **required** field on `AgentSnapshot`, so `Agent.snapshot()` must set it in the same task or the build breaks.

**Files:**
- Modify: `src/shared/messages.ts`
- Modify: `src/agents/Agent.ts`

- [ ] **Step 1: Add the `AgentKind` type and `kind` field in `messages.ts`**

Find:

```ts
export type ClaudeModel = 'default' | 'opus' | 'sonnet' | 'haiku';
export type TitleSource = 'default' | 'ai' | 'rename' | 'manual';

export interface AgentSnapshot {
  id: string;
  name: string;
```

Replace with:

```ts
export type ClaudeModel = 'default' | 'opus' | 'sonnet' | 'haiku';
export type TitleSource = 'default' | 'ai' | 'rename' | 'manual';
/** Which kind of card this is: a Claude Code session, or a plain shell terminal. */
export type AgentKind = 'claude' | 'shell';

export interface AgentSnapshot {
  id: string;
  /** 'claude' = a Claude Code session; 'shell' = a plain shell terminal. */
  kind: AgentKind;
  name: string;
```

- [ ] **Step 2: Add the `newTerminal` message in `messages.ts`**

Find:

```ts
export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'newAgent'; model?: ClaudeModel }
```

Replace with:

```ts
export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'newAgent'; model?: ClaudeModel }
  /**
   * User pressed `t` on the focused panel. Host spawns a plain shell
   * terminal card (no Claude process) via `AgentManager.newTerminal`.
   */
  | { type: 'newTerminal' }
```

- [ ] **Step 3: Import `AgentKind` in `Agent.ts`**

Find (line ~5):

```ts
import type { AgentSnapshot, ClaudeModel, TitleSource } from '../shared/messages';
```

Replace with:

```ts
import type { AgentSnapshot, AgentKind, ClaudeModel, TitleSource } from '../shared/messages';
```

- [ ] **Step 4: Add the `kind` field to the `Agent` class**

Find:

```ts
export class Agent implements vscode.Disposable {
  readonly id: string;
  private _name: string;
```

Replace with:

```ts
export class Agent implements vscode.Disposable {
  readonly id: string;
  readonly kind: AgentKind = 'claude';
  private _name: string;
```

- [ ] **Step 5: Include `kind` in `Agent.snapshot()`**

Find:

```ts
  snapshot(): AgentSnapshot {
    return {
      id: this.id,
      name: this._name,
```

Replace with:

```ts
  snapshot(): AgentSnapshot {
    return {
      id: this.id,
      kind: this.kind,
      name: this._name,
```

- [ ] **Step 6: Build + typecheck**

Run:

```bash
pnpm run build && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.webview.json --noEmit
```

Expected: no errors. (The webview consumes `AgentSnapshot` but never constructs one, so the new required field doesn't break it.)

- [ ] **Step 7: Commit**

```bash
git add src/shared/messages.ts src/agents/Agent.ts
git commit -m "feat: add AgentKind discriminant and newTerminal message" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `deriveShellTitle` pure helper (TDD)

The one piece of unit-testable logic — derives a card title from a command line.

**Files:**
- Create: `src/agents/shellTitle.ts`
- Test: `src/agents/shellTitle.test.ts`
- Modify: `esbuild.config.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the failing test**

Create `src/agents/shellTitle.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveShellTitle } from './shellTitle';

test('returns a plain command unchanged', () => {
  assert.equal(deriveShellTitle('npm run dev'), 'npm run dev');
});

test('trims surrounding whitespace', () => {
  assert.equal(deriveShellTitle('  git status  '), 'git status');
});

test('returns null for an empty string', () => {
  assert.equal(deriveShellTitle(''), null);
});

test('returns null for a whitespace-only string', () => {
  assert.equal(deriveShellTitle('   \t  '), null);
});

test('truncates an over-long command with an ellipsis', () => {
  const result = deriveShellTitle('x'.repeat(200));
  assert.equal(result?.length, 120);
  assert.ok(result?.endsWith('…'));
});

test('returns a 120-char command unchanged (boundary)', () => {
  const exact = 'y'.repeat(120);
  assert.equal(deriveShellTitle(exact), exact);
});
```

- [ ] **Step 2: Register the test files with esbuild**

In `esbuild.config.mjs`, find:

```js
  'src/agents/neighborSelection.ts',
  'src/agents/neighborSelection.test.ts',
```

Replace with:

```js
  'src/agents/neighborSelection.ts',
  'src/agents/neighborSelection.test.ts',
  'src/agents/shellTitle.ts',
  'src/agents/shellTitle.test.ts',
```

- [ ] **Step 3: Register the test file with the test runner**

In `package.json`, find the `"test"` script and append `out/agents/shellTitle.test.js` to the end of the file list:

```json
    "test": "node --test out/markers/extractMarkers.test.js out/markers/transcriptWatcher.test.js out/agents/sessionScanner.test.js out/agents/ids.test.js out/agents/pinSort.test.js out/agents/neighborSelection.test.js out/view/webview/reconcileOrder.test.js out/view/webview/flipGeometry.test.js out/agents/shellTitle.test.js",
```

- [ ] **Step 4: Build and run the test to verify it fails**

Run:

```bash
pnpm run build && pnpm run test
```

Expected: FAIL — `shellTitle.test.js` cannot resolve `./shellTitle` (`Cannot find module`), because `shellTitle.ts` does not exist yet.

- [ ] **Step 5: Write the minimal implementation**

Create `src/agents/shellTitle.ts`:

```ts
/**
 * Derive a shell card's title from a command line the user just ran.
 *
 * Returns `null` when the command line is empty / whitespace-only — the
 * caller (`ShellAgent`) treats `null` as "don't adopt a title", so pressing
 * Enter at an empty prompt never burns the one-time first-command slot.
 *
 * Long command lines are truncated to `MAX_TITLE_LEN` characters (with a
 * trailing ellipsis) so an accidental paste of a huge one-liner can't blow
 * out the card layout.
 */
const MAX_TITLE_LEN = 120;

export function deriveShellTitle(commandLine: string): string | null {
  const trimmed = commandLine.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_TITLE_LEN) {
    return trimmed.slice(0, MAX_TITLE_LEN - 1) + '…';
  }
  return trimmed;
}
```

- [ ] **Step 6: Build and run the test to verify it passes**

Run:

```bash
pnpm run build && pnpm run test
```

Expected: PASS — all six `shellTitle` tests pass, and the pre-existing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add src/agents/shellTitle.ts src/agents/shellTitle.test.ts esbuild.config.mjs package.json
git commit -m "feat: add deriveShellTitle helper for shell card titles" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `ManagedAgent` interface + `Agent` conformance

Defines the shared interface and makes `Agent` implement it. Renames `clearConversation` → `clearActive` so the method name is uniform across both kinds.

**Files:**
- Create: `src/agents/ManagedAgent.ts`
- Modify: `src/agents/Agent.ts`
- Modify: `src/agents/AgentManager.ts`

- [ ] **Step 1: Create the `ManagedAgent` interface**

Create `src/agents/ManagedAgent.ts`:

```ts
import type * as vscode from 'vscode';
import type { AgentSnapshot, AgentKind } from '../shared/messages';

/**
 * The kind-agnostic surface `AgentManager` and `AgentPanelProvider` rely on.
 * Implemented by `Agent` (a Claude Code session — kind 'claude') and
 * `ShellAgent` (a plain shell terminal — kind 'shell').
 *
 * Claude-only behaviour (hooks, MCP state file, dormancy, sessionId) lives
 * on `Agent` only; the manager narrows with `instanceof Agent` on the few
 * code paths that need it (hook routing, persistence, kill-time archival).
 */
export interface ManagedAgent {
  readonly id: string;
  readonly kind: AgentKind;
  readonly pinned: boolean;
  readonly name: string;
  /** True when the card is requesting user attention. Always false for shell cards. */
  readonly needsAttention: boolean;
  /** Per-turn snapshot diffs — drives the webview card. */
  readonly onChange: vscode.Event<Partial<AgentSnapshot>>;
  snapshot(): AgentSnapshot;
  reveal(): void;
  focusTerminal(): void;
  isTerminalActive(): boolean;
  ownsTerminal(t: vscode.Terminal): boolean;
  setPinned(pinned: boolean): void;
  setManualTitle(name: string): void;
  /** `/clear` for a Claude card; terminal scrollback clear for a shell card. */
  clearActive(): void;
  dispose(): void;
}
```

- [ ] **Step 2: Make `Agent` implement `ManagedAgent`**

In `src/agents/Agent.ts`, find:

```ts
import type { AgentSnapshot, AgentKind, ClaudeModel, TitleSource } from '../shared/messages';
```

Replace with:

```ts
import type { AgentSnapshot, AgentKind, ClaudeModel, TitleSource } from '../shared/messages';
import type { ManagedAgent } from './ManagedAgent';
```

Then find:

```ts
export class Agent implements vscode.Disposable {
```

Replace with:

```ts
export class Agent implements vscode.Disposable, ManagedAgent {
```

- [ ] **Step 3: Rename `clearConversation` to `clearActive`**

In `src/agents/Agent.ts`, find the method signature:

```ts
  clearConversation(): void {
    this.focusTerminal();
    this.terminal?.sendText('/clear');
    this.resetCardState();
  }
```

Replace with:

```ts
  clearActive(): void {
    this.focusTerminal();
    this.terminal?.sendText('/clear');
    this.resetCardState();
  }
```

(The doc comment block directly above the method may keep its existing text — it still describes the behaviour accurately. Only the method name changes.)

- [ ] **Step 4: Update the call site in `AgentManager`**

In `src/agents/AgentManager.ts`, find:

```ts
  clearActive(): void {
    if (!this.activeId) return;
    this.agents.get(this.activeId)?.clearConversation();
  }
```

Replace with:

```ts
  clearActive(): void {
    if (!this.activeId) return;
    this.agents.get(this.activeId)?.clearActive();
  }
```

- [ ] **Step 5: Build + typecheck**

Run:

```bash
pnpm run build && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.webview.json --noEmit
```

Expected: no errors. `Agent` already provides every `ManagedAgent` member (`id`, `kind`, `pinned`, `name`, `needsAttention`, `onChange`, `snapshot`, `reveal`, `focusTerminal`, `isTerminalActive`, `ownsTerminal`, `setPinned`, `setManualTitle`, `clearActive`, `dispose`).

- [ ] **Step 6: Commit**

```bash
git add src/agents/ManagedAgent.ts src/agents/Agent.ts src/agents/AgentManager.ts
git commit -m "refactor: extract ManagedAgent interface, rename clearConversation" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `ShellAgent` class

The shell-terminal-backed agent. Unused until Task 5 wires it into `AgentManager`, but it compiles standalone.

**Files:**
- Create: `src/agents/ShellAgent.ts`

- [ ] **Step 1: Create `ShellAgent.ts`**

Create `src/agents/ShellAgent.ts`:

```ts
import * as vscode from 'vscode';
import type { AgentSnapshot, TitleSource } from '../shared/messages';
import type { ManagedAgent } from './ManagedAgent';
import { deriveShellTitle } from './shellTitle';

export interface ShellAgentInit {
  id: string;
  cwd: string;
}

/**
 * A Glance card backed by a plain shell terminal — no Claude, no MCP, no
 * hooks, no state file, no dormancy, never persisted. Spawned by pressing
 * `t` in the panel.
 *
 * The card title is taken from the FIRST command the user runs; a working
 * dot shows while a command executes. Both signals come from VS Code's
 * terminal shell-integration events. On a VS Code build / shell without
 * shell integration the card stays titled "shell" with no dot — degraded
 * but still a fully usable terminal.
 */
export class ShellAgent implements ManagedAgent {
  readonly id: string;
  readonly kind = 'shell' as const;

  private _name = 'shell';
  private _titleSource: TitleSource = 'default';
  /** True once the first non-empty command has set the title (or a manual rename has). */
  private _titleFromCommand = false;
  /** True while a command is executing — mapped to snapshot.streaming (the working dot). */
  private _running = false;
  private _pinned = false;
  /** Set before our own terminal.dispose() so the resulting close event is ignored. */
  private _disposing = false;

  private readonly terminal: vscode.Terminal;
  private readonly subscriptions: vscode.Disposable[] = [];

  private readonly changeEmitter = new vscode.EventEmitter<Partial<AgentSnapshot>>();
  readonly onChange = this.changeEmitter.event;

  /** Fires once when the terminal closes (user closed the tab, or the shell exited). */
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  readonly onClose = this.closeEmitter.event;

  constructor(init: ShellAgentInit) {
    this.id = init.id;

    this.terminal = vscode.window.createTerminal({
      name: 'shell',
      cwd: init.cwd,
      // Don't let VS Code revive this terminal across a window reload —
      // shell cards are ephemeral ("disappear on reload").
      isTransient: true,
      iconPath: new vscode.ThemeIcon('terminal'),
      // Cyan tab marker distinguishes a shell from a Claude card (green).
      color: new vscode.ThemeColor('terminal.ansiCyan'),
    });

    // Shell-integration events are global; filter to our own terminal.
    // They are stabilised in VS Code 1.93 but the extension's engine floor
    // is 1.90 — extract to consts and guard so an older host degrades to a
    // title-less, dot-less (but working) card rather than throwing.
    const onStart = vscode.window.onDidStartTerminalShellExecution;
    const onEnd = vscode.window.onDidEndTerminalShellExecution;
    if (onStart && onEnd) {
      this.subscriptions.push(
        onStart((e) => {
          if (e.terminal !== this.terminal) return;
          this.onCommandStart(e.execution.commandLine.value);
        }),
        onEnd((e) => {
          if (e.terminal !== this.terminal) return;
          this.setRunning(false);
        }),
      );
    }
    this.subscriptions.push(
      vscode.window.onDidCloseTerminal((t) => {
        if (t !== this.terminal) return;
        if (this._disposing) return;
        this.closeEmitter.fire();
      }),
    );
  }

  private onCommandStart(commandLine: string): void {
    this.setRunning(true);
    if (this._titleFromCommand) return;
    const title = deriveShellTitle(commandLine);
    if (title === null) return;
    this._name = title;
    this._titleFromCommand = true;
    this.changeEmitter.fire({ name: this._name });
  }

  private setRunning(running: boolean): void {
    if (this._running === running) return;
    this._running = running;
    this.changeEmitter.fire({ streaming: running });
  }

  get pinned(): boolean {
    return this._pinned;
  }

  get name(): string {
    return this._name;
  }

  /** Shell cards never request attention — no badge, no toast. */
  get needsAttention(): boolean {
    return false;
  }

  snapshot(): AgentSnapshot {
    return {
      id: this.id,
      kind: this.kind,
      name: this._name,
      titleSource: this._titleSource,
      // Shell cards have no model; 'default' makes the card hide the model chip.
      model: 'default',
      // No update_state pipeline — these stay null so the progress bar,
      // skill pill, subtitle, and starting indicator all stay hidden.
      tldr: null,
      attentionReason: null,
      errorReason: null,
      progress: null,
      skill: null,
      streaming: this._running,
      starting: false,
      pinned: this._pinned,
    };
  }

  reveal(): void {
    this.terminal.show(true);
  }

  focusTerminal(): void {
    this.terminal.show(false);
  }

  isTerminalActive(): boolean {
    return vscode.window.activeTerminal === this.terminal;
  }

  ownsTerminal(t: vscode.Terminal): boolean {
    return t === this.terminal;
  }

  setPinned(pinned: boolean): void {
    if (this._pinned === pinned) return;
    this._pinned = pinned;
    this.changeEmitter.fire({ pinned: this._pinned });
  }

  setManualTitle(name: string): void {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      // Empty rename clears the override; let a future command re-title.
      this._titleSource = 'default';
      this._name = 'shell';
      this._titleFromCommand = false;
    } else {
      this._titleSource = 'manual';
      this._name = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
      // A manual title wins permanently — stop first-command titling.
      this._titleFromCommand = true;
    }
    this.changeEmitter.fire({ name: this._name, titleSource: this._titleSource });
  }

  /** `c c` on a shell card: clear the terminal scrollback (the Cmd+K equivalent). */
  clearActive(): void {
    // `workbench.action.terminal.clear` targets the active terminal, so
    // focus this one first. Clearing scrollback does NOT reset the title.
    this.terminal.show(false);
    void vscode.commands.executeCommand('workbench.action.terminal.clear');
  }

  dispose(): void {
    this._disposing = true;
    for (const s of this.subscriptions) s.dispose();
    this.subscriptions.length = 0;
    try {
      this.terminal.dispose();
    } catch {
      // already disposed by VS Code
    }
    this.changeEmitter.dispose();
    this.closeEmitter.dispose();
  }
}
```

- [ ] **Step 2: Build + typecheck**

Run:

```bash
pnpm run build && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.webview.json --noEmit
```

Expected: no errors. `ShellAgent` satisfies `ManagedAgent`; it is not referenced anywhere yet.

- [ ] **Step 3: Commit**

```bash
git add src/agents/ShellAgent.ts
git commit -m "feat: add ShellAgent backed by a plain VS Code terminal" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Wire `ShellAgent` into `AgentManager`

Widens the agents map to `ManagedAgent`, adds `newTerminal()`, and guards the three Claude-only code paths with `instanceof Agent`.

**Files:**
- Modify: `src/agents/AgentManager.ts`

- [ ] **Step 1: Import `ManagedAgent` and `ShellAgent`**

Find:

```ts
import { Agent } from './Agent';
import { nextAgentId } from './ids';
```

Replace with:

```ts
import { Agent } from './Agent';
import { ShellAgent } from './ShellAgent';
import type { ManagedAgent } from './ManagedAgent';
import { nextAgentId } from './ids';
```

- [ ] **Step 2: Widen the agents map type**

Find:

```ts
  private readonly agents = new Map<string, Agent>();
```

Replace with:

```ts
  private readonly agents = new Map<string, ManagedAgent>();
```

- [ ] **Step 3: Add the `newTerminal` method**

In `src/agents/AgentManager.ts`, find the end of the `newAgent` method:

```ts
    this.agents.set(id, agent);
    this.changeEmitter.fire({ type: 'added', agent: agent.snapshot() });
    this.setActive(id);
    agent.reveal();
    this.persist();
    return id;
  }
```

Insert the following method directly after that closing brace:

```ts

  /**
   * Spawn a plain shell terminal card (the `t` key). Unlike `newAgent` this
   * starts no Claude process — `ShellAgent` wraps an ordinary VS Code
   * integrated terminal. Shell cards are never persisted, so there is no
   * `persist()` call and no orphan state file to wipe.
   */
  newTerminal(opts: { cwd: string }): string {
    const id = nextAgentId(this.agents.keys());
    const agent = new ShellAgent({ id, cwd: opts.cwd });
    agent.onChange((fields) => {
      this.changeEmitter.fire({ type: 'updated', id, fields });
      this.emitUnreadCount();
    });
    // A shell card can't be revived — closing its terminal removes the card.
    agent.onClose(() => this.removeAgent(id));
    this.agents.set(id, agent);
    this.changeEmitter.fire({ type: 'added', agent: agent.snapshot() });
    this.setActive(id);
    agent.reveal();
    return id;
  }
```

- [ ] **Step 4: Guard hook routing with `instanceof Agent`**

Find:

```ts
    const agent = this.agents.get(agentId);
    if (!agent) {
      console.warn('[glancer] hook event for unknown agent', agentId);
      return;
    }
    if (hookEvent === 'SessionStart') {
```

Replace with:

```ts
    const agent = this.agents.get(agentId);
    if (!agent) {
      console.warn('[glancer] hook event for unknown agent', agentId);
      return;
    }
    // Shell-terminal cards have no hooks wired, so a hook event addressed
    // to one would be a bug. Narrowing to the Claude `Agent` also lets the
    // Claude-only calls below (setSessionId, notifyTurnComplete, …) typecheck.
    if (!(agent instanceof Agent)) {
      console.warn('[glancer] hook event for non-Claude agent', agentId);
      return;
    }
    if (hookEvent === 'SessionStart') {
```

- [ ] **Step 5: Guard `persist()` with an `instanceof Agent` type predicate**

Find:

```ts
    const entries = Array.from(this.agents.values())
      .filter((a) => a.hasUserPrompt)
      .map((a) => ({
```

Replace with:

```ts
    const entries = Array.from(this.agents.values())
      // Only Claude agents are persisted — shell cards are ephemeral.
      .filter((a): a is Agent => a instanceof Agent && a.hasUserPrompt)
      .map((a) => ({
```

- [ ] **Step 6: Guard the kill-time state archival with `instanceof Agent`**

Find:

```ts
    a.dispose();
    // Promote the state file into the by-session archive (keyed by the
    // Claude sessionId) so a future openOldSession can re-seed a new
    // card with the previous tldr/progress/skill. If there's no
    // sessionId yet (kill happened before SessionStart), fall through
    // to the unconditional delete so we don't strand an orphan file
    // under the same glance id.
    this.archiveStateOnKill(a);
    a.purgePersistentState();
    this.persist();
```

Replace with:

```ts
    a.dispose();
    // State archival / purge is Claude-only — shell agents have no
    // sessionId and no state file. For a Claude agent, promote the state
    // file into the by-session archive (keyed by the Claude sessionId) so
    // a future openOldSession can re-seed a new card with the previous
    // tldr/progress/skill; if there's no sessionId yet (kill before
    // SessionStart), purgePersistentState does the unconditional delete.
    if (a instanceof Agent) {
      this.archiveStateOnKill(a);
      a.purgePersistentState();
    }
    this.persist();
```

- [ ] **Step 7: Fix the `reorder()` local-array type**

`reorder()` builds a local array typed `[string, Agent][]`, which no longer
accepts the `ManagedAgent` values now stored in `this.agents`. Find:

```ts
  reorder(ids: string[]): void {
    const entries: [string, Agent][] = [];
```

Replace with:

```ts
  reorder(ids: string[]): void {
    const entries: [string, ManagedAgent][] = [];
```

- [ ] **Step 8: Build + typecheck**

Run:

```bash
pnpm run build && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.webview.json --noEmit
```

Expected: no errors. Note `partitionPinnedFirst` is generic over `{ pinned: boolean }`, so `applyPinnedFirst()` accepts `Map<string, ManagedAgent>` unchanged.

- [ ] **Step 9: Commit**

```bash
git add src/agents/AgentManager.ts
git commit -m "feat: AgentManager.newTerminal spawns shell cards" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `newTerminal` message handler in `AgentPanelProvider`

**Files:**
- Modify: `src/view/AgentPanelProvider.ts`

- [ ] **Step 1: Add the `newTerminal` case**

In `src/view/AgentPanelProvider.ts`, find the end of the `newAgent` case:

```ts
      case 'newAgent': {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!cwd) {
          vscode.window.showWarningMessage('Open a workspace folder first.');
          return;
        }
        const id = this.manager.newAgent({ cwd, model: m.model });
        // Pull focus into the new agent's terminal so the user can type
        // immediately. Same multi-retry as the auto-spawn path because
        // the PTY needs a beat to attach before show(false) takes effect.
        this.pendingFocusTerminalId = id;
        this.scheduleFocusRetries(id);
        break;
      }
```

Insert directly after that case's closing brace:

```ts
      case 'newTerminal': {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!cwd) {
          vscode.window.showWarningMessage('Open a workspace folder first.');
          return;
        }
        const id = this.manager.newTerminal({ cwd });
        // Drop focus into the new shell, same as `newAgent`.
        this.pendingFocusTerminalId = id;
        this.scheduleFocusRetries(id);
        break;
      }
```

- [ ] **Step 2: Build + typecheck**

Run:

```bash
pnpm run build && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.webview.json --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/view/AgentPanelProvider.ts
git commit -m "feat: handle newTerminal message in the panel provider" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `glancer.newTerminal` command

**Files:**
- Modify: `src/extension.ts`
- Modify: `package.json`

- [ ] **Step 1: Register the command in `extension.ts`**

In `src/extension.ts`, find:

```ts
    vscode.commands.registerCommand('glancer.newAgent', () => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!cwd) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      manager?.newAgent({ cwd });
    }),
```

Insert directly after that (before the next `registerCommand`):

```ts
    vscode.commands.registerCommand('glancer.newTerminal', () => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!cwd) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      manager?.newTerminal({ cwd });
    }),
```

- [ ] **Step 2: Contribute the command in `package.json`**

In `package.json`, find the `contributes.commands` array:

```json
      {
        "command": "glancer.newAgent",
        "title": "Glance: New Agent"
      },
```

Insert directly after that object (before the next one):

```json
      {
        "command": "glancer.newTerminal",
        "title": "Glance: New Terminal"
      },
```

- [ ] **Step 3: Build + typecheck**

Run:

```bash
pnpm run build && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.webview.json --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/extension.ts package.json
git commit -m "feat: add glancer.newTerminal command" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `t` key handler in the webview

**Files:**
- Modify: `src/view/webview/AgentList.tsx`

- [ ] **Step 1: Add the `t` branch to `onKeyDown`**

In `src/view/webview/AgentList.tsx`, find the `g` branch:

```ts
    } else if (e.key === 'g' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Plain `g` spawns a new agent (the second half of the Cmd+Shift+G,G
      // chord — first press focuses the panel, second `g` opens a session).
      e.preventDefault();
      postToHost({ type: 'newAgent' });
    } else if (e.key === 'f' && !e.metaKey && !e.ctrlKey && !e.altKey) {
```

Replace with:

```ts
    } else if (e.key === 'g' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Plain `g` spawns a new agent (the second half of the Cmd+Shift+G,G
      // chord — first press focuses the panel, second `g` opens a session).
      e.preventDefault();
      postToHost({ type: 'newAgent' });
    } else if (e.key === 't' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Plain `t` spawns a plain shell terminal card — the sibling of `g`,
      // which spawns a Claude session.
      e.preventDefault();
      postToHost({ type: 'newTerminal' });
    } else if (e.key === 'f' && !e.metaKey && !e.ctrlKey && !e.altKey) {
```

- [ ] **Step 2: Build + typecheck**

Run:

```bash
pnpm run build && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.webview.json --noEmit
```

Expected: no errors. (`t` is not currently bound in `onKeyDown`; the top-of-handler `e.target !== e.currentTarget` guard already stops it firing while a rename input is focused.)

- [ ] **Step 3: Commit**

```bash
git add src/view/webview/AgentList.tsx
git commit -m "feat: t key spawns a plain shell terminal" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Shell card styling

`kind-shell` class on the card root, a `>_` title prefix, and the CSS that makes shell cards visually distinct (dashed border, faint tint, monospace title).

**Files:**
- Modify: `src/view/webview/AgentCard.tsx`
- Modify: `src/view/webview/styles.css`

- [ ] **Step 1: Add `kind-shell` to the card root className**

In `src/view/webview/AgentCard.tsx`, find:

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

Replace with:

```tsx
      className={
        'agent-card' +
        (agent.kind === 'shell' ? ' kind-shell' : '') +
        (active ? ' active' : '') +
        (agent.starting ? ' starting' : '') +
        (dragging ? ' dragging' : '') +
        (dragOver ? ' drag-over' : '') +
        (agent.pinned ? ' pinned' : '') +
        ` status-${status}`
      }
```

- [ ] **Step 2: Add the `>_` prefix to the title row**

In `src/view/webview/AgentCard.tsx`, find:

```tsx
        ) : (
          <>
            <span className="agent-name">{agent.name}</span>
            {isLocked && <span className="agent-title-lock" title="Manually set">●</span>}
            {agent.model !== 'default' && (
              <span className="agent-model-chip">{agent.model}</span>
            )}
          </>
        )}
```

Replace with:

```tsx
        ) : (
          <>
            {agent.kind === 'shell' && (
              <span className="agent-shell-prefix" aria-hidden="true">{'>_'}</span>
            )}
            <span className="agent-name">{agent.name}</span>
            {isLocked && <span className="agent-title-lock" title="Manually set">●</span>}
            {agent.model !== 'default' && (
              <span className="agent-model-chip">{agent.model}</span>
            )}
          </>
        )}
```

- [ ] **Step 3: Add the shell-card CSS**

In `src/view/webview/styles.css`, find the status-stripe block:

```css
.agent-card.status-idle::before     { background: rgba(255, 255, 255, 0.10); }
.agent-card.status-starting::before { background: var(--accent); animation: stripe-pulse 1.5s ease-in-out infinite; }
.agent-card.status-streaming::before{ background: var(--accent); animation: stripe-pulse 1.5s ease-in-out infinite; }
.agent-card.status-attention::before{ background: var(--warn); }
.agent-card.status-error::before    { background: var(--danger); }
.agent-card.status-done::before     { background: var(--done); }
```

Insert directly after that block:

```css

/* Shell-terminal cards — a plain shell, not a Claude session. A dashed
 * border, a faint blue tint, and a monospace `>_` title set them apart at
 * a glance. `:not(.active)` keeps the active-card highlight (background +
 * ring) winning cleanly when a shell card is selected. */
.agent-card.kind-shell {
  border-style: dashed;
}
.agent-card.kind-shell:not(.active) {
  background: linear-gradient(
    180deg,
    rgba(120, 200, 255, 0.055) 0%,
    rgba(120, 200, 255, 0.02) 100%
  );
}
.agent-card.kind-shell:not(.active):hover {
  background: linear-gradient(
    180deg,
    rgba(120, 200, 255, 0.08) 0%,
    rgba(120, 200, 255, 0.035) 100%
  );
  border-color: rgba(120, 200, 255, 0.30);
}
.agent-card.kind-shell .agent-name {
  font-family: var(--vscode-editor-font-family, monospace);
}
.agent-shell-prefix {
  font-family: var(--vscode-editor-font-family, monospace);
  color: var(--muted);
  font-weight: 600;
  margin-right: 6px;
  flex-shrink: 0;
}
```

- [ ] **Step 4: Build + typecheck**

Run:

```bash
pnpm run build && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.webview.json --noEmit
```

Expected: no errors. (`copyStatic()` in the build copies the updated `styles.css` to `out/webview/`.)

- [ ] **Step 5: Commit**

```bash
git add src/view/webview/AgentCard.tsx src/view/webview/styles.css
git commit -m "feat: distinct dashed/monospace styling for shell cards" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Documentation — walkthrough shortcut + CLAUDE.md

**Files:**
- Modify: `package.json`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add `t` to the walkthrough shortcut list**

In `package.json`, inside the `glancer.welcome` walkthrough's "more" step `description`, find this substring:

```
- **g** — spawn a new agent\n- **c c** (press `c` twice) — run `/clear` in the highlighted agent
```

Replace it with:

```
- **g** — spawn a new agent\n- **t** — open a plain shell terminal\n- **c c** (press `c` twice) — run `/clear` (Claude) or clear the screen (shell)
```

- [ ] **Step 2: Document the shell-agent path in `CLAUDE.md`**

In `CLAUDE.md`, find the end of the "### 1. Extension host" section — the paragraph that ends:

```
The same walkthrough can be re-opened any time via `Glance: Show Welcome Tour` in the Command Palette.
```

Insert directly after that paragraph:

```

#### Card kinds: Claude agents vs shell terminals

A card is one of two kinds, discriminated by `AgentSnapshot.kind`:

- **`'claude'`** — the original `Agent`: a node-pty `Pseudoterminal` running
  `claude …`, with the MCP state pipeline, hooks, dormancy, and `--resume`.
- **`'shell'`** — `ShellAgent` (`src/agents/ShellAgent.ts`): an ordinary
  `vscode.window.createTerminal` shell, spawned with the `t` key. No MCP, no
  hooks, no state file, no `sessionId`, never persisted. Its card title comes
  from the first command (`onDidStartTerminalShellExecution`) and its
  in-progress dot from command start/end; `c c` clears the scrollback instead
  of running `/clear`. `isTransient: true` makes shell terminals vanish on
  reload.

Both implement the `ManagedAgent` interface (`src/agents/ManagedAgent.ts`) —
the kind-agnostic surface `AgentManager` uses. The manager stores
`Map<string, ManagedAgent>` and narrows with `instanceof Agent` on the three
Claude-only paths: hook routing, `persist()`, and the kill-time state archive.
```

- [ ] **Step 3: Build (sanity check — no code changed, confirms `package.json` is still valid JSON)**

Run:

```bash
pnpm run build
```

Expected: build succeeds. (A malformed `package.json` edit would make `node esbuild.config.mjs` fail to start.)

- [ ] **Step 4: Commit**

```bash
git add package.json CLAUDE.md
git commit -m "docs: document shell terminal cards (walkthrough + CLAUDE.md)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Manual smoke test

After all tasks, launch the Extension Development Host (`pnpm run build`, then **F5**) and verify:

1. **Spawn** — focus the Glance panel, press `t`. A new card appears with a dashed border, a faint blue tint, and a monospace `>_ shell` title; a plain shell opens in the terminal panel with focus.
2. **Title** — run `npm run dev` (or any command). The card title becomes the full command line and stops changing on later commands.
3. **In-progress dot** — while a long command runs, the card shows the working dot; back at the prompt, the dot clears. No progress bar, no skill pill, no subtitle line ever appear.
4. **`c c`** — with the shell card selected, press `c` twice quickly. The terminal scrollback clears (Cmd+K behaviour); no `/clear` text is sent; the title is unchanged.
5. **Coexistence** — press `g` for a Claude card; both kinds sit in the same list, drag-reorder, pin (`p p`), and arrow-navigate together.
6. **Close** — close the shell terminal tab (or type `exit`); the card disappears. Kill via the card's X / `Cmd+Backspace` also works.
7. **Reload** — `Developer: Reload Window`. Shell cards are gone; Claude cards restore as before.

## Spec coverage check

Every numbered goal in the spec maps to a task: `t` shortcut (Tasks 1, 5, 6, 7, 8), first-command title (Tasks 2, 4), in-progress dot only / no progress bar (Tasks 4, 9), `c c` scrollback clear (Tasks 3, 4), distinct card style (Task 9), ephemeral on reload (Task 4 `isTransient` + Task 5 no-persist), `ManagedAgent` split (Tasks 3, 4, 5), docs (Task 10).
