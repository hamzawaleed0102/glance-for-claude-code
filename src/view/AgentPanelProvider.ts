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
  /**
   * Whether we've already widened the panel for this VS Code session. The
   * first time the user focuses Glancer, we call `increaseViewSize` a few
   * times to give the agent cards more breathing room — but we only do it
   * once per session so subsequent focuses don't keep stacking the width
   * (and so a user who manually resized smaller doesn't get stomped on
   * every time they Cmd+Shift+G back).
   */
  private hasExpanded = false;
  /**
   * Tracks whether we've toggled the bottom panel into its maximized
   * state. `workbench.action.toggleMaximizedPanel` is a TOGGLE, so we
   * can't safely call it twice in a row — we'd un-maximize. We flip this
   * true after maximizing, and reset it to false on every blur because
   * VS Code automatically un-maximizes when the user focuses an editor.
   * That way each return to Glancer re-maxes the panel for them.
   */
  private weMaximizedPanel = false;

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
          this.updateBadge();
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
    // Seed the badge from current state. Agents may have been restored
    // (with persisted attention/error markers) BEFORE this view resolved,
    // so the `unread` events fired during restore would have hit a null
    // view and been dropped.
    this.updateBadge();
  }

  /**
   * Single point that pushes the current attention-count to the
   * activity-bar badge. Called from both the `unread` event handler and
   * `resolveWebviewView` so the badge stays in sync with manager state.
   */
  private updateBadge(): void {
    if (!this.view) return;
    const total = this.manager.unreadCount();
    console.log('[glancer] badge update → total =', total);
    this.view.badge = total > 0
      ? {
          value: total,
          tooltip: `${total} agent${total === 1 ? '' : 's'} need attention`,
        }
      : undefined;
  }

  /**
   * Toast-only turn-complete handler. The activity-bar badge is driven
   * separately by `unread` events the manager emits whenever any agent's
   * attentionReason/errorReason changes — no explicit mark-as-read
   * bookkeeping here.
   */
  private handleTurnComplete(snapshot: import('../shared/messages').AgentSnapshot): void {
    if (this.userIsWatching(snapshot.id)) return;

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

  /**
   * "Is the user actively watching THIS agent right now?" — used to gate
   * both the toast and the unread badge. Strict per-agent check: panel
   * focus alone isn't enough (the user might be looking at a different
   * card), only panel-focused + this-agent-is-active counts. This means
   * an agent finishing in the background still bumps the badge even when
   * you're in Glancer looking at a different session.
   */
  private userIsWatching(id: string): boolean {
    if (!vscode.window.state.focused) return false;
    if (this.manager.isAgentTerminalActive(id)) return true;
    if (this.panelFocused && this.manager.getActiveId() === id) return true;
    return false;
  }

  /**
   * Drive the bottom-panel maximize state to match `want`. The underlying
   * `workbench.action.toggleMaximizedPanel` command is a pure toggle, so
   * we cache our last-applied state and skip the call when no transition
   * is needed. This keeps focus/blur paired (max on focus, un-max on
   * blur) without double-toggling.
   */
  private async setPanelMaximized(want: boolean): Promise<void> {
    if (this.weMaximizedPanel === want) return;
    this.weMaximizedPanel = want;
    try {
      await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
    } catch {
      // Command unavailable on older VS Code builds — skip silently.
    }
  }

  /**
   * Widen the sidebar so the agent cards have more horizontal room. VS
   * Code doesn't expose a "set view width" API, only the +30px-per-call
   * `workbench.action.increaseViewSize` command — so we call it a fixed
   * number of times to reach roughly 240px wider than the default. Caps
   * automatically once the view hits its configured max width.
   */
  private async expandPanelOnce(): Promise<void> {
    if (this.hasExpanded) return;
    this.hasExpanded = true;
    for (let i = 0; i < 8; i++) {
      try {
        await vscode.commands.executeCommand('workbench.action.increaseViewSize');
      } catch {
        // Command unavailable in older VS Code builds — skip silently.
        return;
      }
    }
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
        if (m.focused) {
          this.expandPanelOnce();
          // Ensure the bottom panel is visible — if Cmd+J hid it, calling
          // terminal.show() on the active agent un-hides the panel and
          // brings that terminal into view without stealing focus.
          this.manager.revealActiveTerminal();
          this.setPanelMaximized(true);
        } else {
          // Restore the panel to its original position when Glancer loses
          // focus, so the editor isn't hidden by a stale maximized panel.
          this.setPanelMaximized(false);
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
