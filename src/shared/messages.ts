export type ClaudeModel = 'default' | 'opus' | 'sonnet' | 'haiku';
export type TitleSource = 'default' | 'ai' | 'rename' | 'manual';

export interface AgentSnapshot {
  id: string;
  name: string;
  titleSource: TitleSource;
  model: ClaudeModel;
  tldr: string | null;
  attentionReason: string | null;
  errorReason: string | null;
  progress: { value: number; label: string } | null;
  streaming: boolean;
  /**
   * True from the moment the agent is spawned until Claude's TUI is on
   * screen (alt-screen entered, or 2s fallback). While true the renderer
   * shows a "Starting session…" indicator on the card instead of the usual
   * model/flag rows, and the terminal display is held on a placeholder so
   * the user doesn't see the shell echo of the `claude …` invocation.
   */
  starting: boolean;
}

export type HostToWebview =
  | { type: 'state'; agents: AgentSnapshot[]; activeId: string | null }
  | { type: 'agentAdded'; agent: AgentSnapshot }
  | { type: 'agentRemoved'; id: string }
  | { type: 'agentUpdate'; id: string; fields: Partial<AgentSnapshot> }
  | { type: 'activeChanged'; id: string | null }
  /**
   * Sent by the host after `focusPanel` runs (Cmd+Shift+G or any reveal).
   * The webview dispatches a `glancer:focus` window event so AgentList can
   * pull keyboard focus into its container, enabling Up/Down/Enter/G to be
   * handled by React without VS Code keybinding contexts.
   */
  | { type: 'focus' };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'newAgent'; model?: ClaudeModel }
  | { type: 'select'; id: string }
  | { type: 'kill'; id: string }
  | { type: 'rename'; id: string; name: string }
  | { type: 'resetTitle'; id: string }
  /**
   * User pressed Enter while a card was focused — bring the agent's
   * terminal into view AND steal focus into it (unlike `select`, which
   * uses preserveFocus so the panel keeps keyboard nav).
   */
  | { type: 'focusTerminal'; id: string }
  /**
   * Webview reports its own focus/blur state. Used by the host to suppress
   * turn-complete toasts when the user is already looking at the panel.
   */
  | { type: 'panelFocus'; focused: boolean };
