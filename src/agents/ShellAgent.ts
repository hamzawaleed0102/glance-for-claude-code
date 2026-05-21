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
