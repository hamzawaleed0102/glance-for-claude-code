import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { AgentManager } from '../agents/AgentManager';
import type { HostToWebview, WebviewToHost } from '../shared/messages';

export class AgentPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'glancer.agents';

  private view: vscode.WebviewView | null = null;
  /**
   * Becomes true after we've auto-spawned the first agent for this extension
   * activation. Re-mounting the webview (e.g., the user toggles the Glancer
   * activity-bar away and back) shouldn't keep adding agents; if they killed
   * every session deliberately, we respect that and leave the panel empty.
   */
  private autoStarted = false;
  /**
   * Tracks whether the webview iframe currently has focus. Updated from
   * `panelFocus` messages the webview posts on its own window focus/blur.
   * Used to suppress turn-complete toasts when the user is already looking
   * at the panel.
   */
  private panelFocused = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: AgentManager,
  ) {
    manager.onChange((evt) => {
      if (!this.view) return;
      let msg: HostToWebview;
      switch (evt.type) {
        case 'added':
          msg = { type: 'agentAdded', agent: evt.agent };
          break;
        case 'removed':
          msg = { type: 'agentRemoved', id: evt.id };
          break;
        case 'updated':
          msg = { type: 'agentUpdate', id: evt.id, fields: evt.fields };
          break;
        case 'active':
          msg = { type: 'activeChanged', id: evt.id };
          break;
        case 'turnComplete':
          // Toast notification with a "Show" action that jumps to the
          // agent's terminal. The notification body itself isn't clickable
          // in VS Code — the action button is the supported affordance.
          // Also bumps the activity-bar badge if the user wasn't watching.
          this.handleTurnComplete(evt.snapshot);
          return;
        case 'unread':
          // Activity-bar badge. `undefined` removes it entirely so a stale
          // "0" never lingers on the icon.
          if (this.view) {
            this.view.badge = evt.total > 0
              ? {
                  value: evt.total,
                  tooltip: `${evt.total} agent update${evt.total === 1 ? '' : 's'} waiting`,
                }
              : undefined;
          }
          return;
      }
      console.log('[glancer] postMessage →', msg);
      this.view.webview.postMessage(msg);
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: WebviewToHost) => this.handle(m));
  }

  /**
   * Single decision point for turn-complete reactions:
   *   - If user is watching this agent → do nothing.
   *   - Otherwise → bump unread badge + show toast.
   * "Watching" means VS Code is focused AND either the panel is focused
   * (active card visible) or the agent's terminal is the active one. If
   * VS Code itself is unfocused, the user is in another app — always
   * surface the alert.
   */
  private handleTurnComplete(snapshot: import('../shared/messages').AgentSnapshot): void {
    if (this.userIsWatching(snapshot.id)) return;
    this.manager.markUnread(snapshot.id);

    // Prefer attentionReason (Notification hook) over tldr (Stop hook) —
    // an "awaiting input" message is more actionable than a turn summary.
    const detail = snapshot.attentionReason ?? snapshot.tldr;
    const body = detail
      ? `${snapshot.name} — ${detail}`
      : `${snapshot.name} is ready`;
    vscode.window.showInformationMessage(body, 'Show').then((picked) => {
      if (picked === 'Show') this.manager.focusTerminal(snapshot.id);
    });
  }

  private userIsWatching(id: string): boolean {
    if (!vscode.window.state.focused) return false;
    if (this.panelFocused) return true;
    return this.manager.isAgentTerminalActive(id);
  }

  focus(): void {
    // `show(true)` here means `preserveFocus = true` for the *view* — i.e.
    // expand & reveal it but don't yank focus to it. Counter-intuitive name,
    // but matches WebviewView.show's signature. We then post `focus` so the
    // webview itself pulls keyboard focus into AgentList's container, where
    // Up/Down/Enter/G are handled.
    this.view?.show(true);
    this.view?.webview.postMessage({ type: 'focus' } satisfies HostToWebview);
  }

  private handle(m: WebviewToHost): void {
    switch (m.type) {
      case 'ready': {
        // Auto-spawn the first agent on initial launch so the user doesn't
        // have to click "New Session" to get started. Send `state` first so
        // the webview clears any stale list, then `newAgent` triggers a
        // separate `agentAdded` postMessage from the manager.
        this.view?.webview.postMessage({
          type: 'state',
          agents: this.manager.list(),
          activeId: this.manager.getActiveId(),
        } satisfies HostToWebview);
        if (!this.autoStarted && this.manager.list().length === 0) {
          const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (cwd) {
            this.autoStarted = true;
            const id = this.manager.newAgent({ cwd });
            // newAgent's internal reveal uses preserveFocus=true so the side
            // panel still owns focus. For the auto-spawn case the user is
            // opening Glancer expecting to start typing immediately — pull
            // focus into the terminal so the cursor lands in Claude.
            this.manager.focusTerminal(id);
          }
        }
        break;
      }
      case 'newAgent': {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!cwd) {
          vscode.window.showWarningMessage('Open a workspace folder first.');
          return;
        }
        this.manager.newAgent({ cwd, model: m.model });
        break;
      }
      case 'select':
        this.manager.select(m.id);
        break;
      case 'focusTerminal':
        this.manager.focusTerminal(m.id);
        break;
      case 'panelFocus':
        this.panelFocused = m.focused;
        // Panel just became focused — the user is now looking at the
        // active card, so clear its unread mark. Other agents with unread
        // turn-completes stay marked until the user navigates to them.
        if (m.focused) {
          const activeId = this.manager.getActiveId();
          if (activeId) this.manager.markRead(activeId);
        }
        break;
      case 'kill':
        this.manager.kill(m.id);
        break;
      case 'rename':
        this.manager.rename(m.id, m.name);
        break;
      case 'resetTitle':
        this.manager.resetTitle(m.id);
        break;
    }
  }

  private html(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview', 'main.js'),
    );
    const stylesUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview', 'styles.css'),
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
    ].join('; ');
    const indexHtmlPath = path.join(
      this.context.extensionPath,
      'out',
      'webview',
      'index.html',
    );
    let template: string;
    try {
      template = fs.readFileSync(indexHtmlPath, 'utf8');
    } catch {
      template = `<!DOCTYPE html>
<html><head><meta http-equiv="Content-Security-Policy" content="__CSP__"><link rel="stylesheet" href="__STYLES__"></head>
<body><div id="root"></div><script src="__SCRIPT__"></script></body></html>`;
    }
    return template
      .replace(/__CSP__/g, csp)
      .replace(/__SCRIPT__/g, scriptUri.toString())
      .replace(/__STYLES__/g, stylesUri.toString());
  }
}
