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
