import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { AgentManager } from '../agents/AgentManager';
import type { HostToWebview, WebviewToHost } from '../shared/messages';

export class AgentPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'glancer.agents';

  private view: vscode.WebviewView | null = null;

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
      }
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

  focus(): void {
    this.view?.show(true);
  }

  private handle(m: WebviewToHost): void {
    switch (m.type) {
      case 'ready':
        this.view?.webview.postMessage({
          type: 'state',
          agents: this.manager.list(),
          activeId: this.manager.getActiveId(),
        } satisfies HostToWebview);
        break;
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
