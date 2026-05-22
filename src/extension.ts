import * as vscode from 'vscode';
import { AgentManager } from './agents/AgentManager';
import { AgentPanelProvider } from './view/AgentPanelProvider';

let manager: AgentManager | null = null;
const WALKTHROUGH_ID = 'hamzawaleed.glance-claude-code#glancer.welcome';
const WALKTHROUGH_SEEN_KEY = 'glancer.walkthrough.seen';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  try {
    // Sanity-check node-pty can load in this Electron runtime.
    require('node-pty');
  } catch (err) {
    console.error('[glancer] node-pty failed to load', err);
    vscode.window.showErrorMessage(
      `Glance: failed to load node-pty — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  manager = new AgentManager({ context });
  await manager.start();
  const provider = new AgentPanelProvider(context, manager);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentPanelProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('glancer.focusPanel', async () => {
      await vscode.commands.executeCommand(`${AgentPanelProvider.viewId}.focus`);
    }),
    vscode.commands.registerCommand('glancer.newAgent', () => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!cwd) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      manager?.newAgent({ cwd });
    }),
    vscode.commands.registerCommand('glancer.newTerminal', () => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!cwd) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      manager?.newTerminal({ cwd });
    }),
    vscode.commands.registerCommand('glancer.killActive', () => {
      const id = manager?.getActiveId();
      if (id) manager?.kill(id);
    }),
    { dispose: () => manager?.dispose() },
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('glancer.showWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID, false),
    ),
  );

  if (!context.globalState.get<boolean>(WALKTHROUGH_SEEN_KEY)) {
    // Defer one tick so the activity bar paints before the walkthrough
    // opens. The third arg `toSide=false` opens it as a full editor tab.
    setTimeout(() => {
      void vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        WALKTHROUGH_ID,
        false,
      );
      void context.globalState.update(WALKTHROUGH_SEEN_KEY, true);
    }, 0);
  }
}

export function deactivate(): void {
  // Order matters: flip the shutdown flag BEFORE disposing. VS Code fires
  // onDidClose on every terminal as the host tears down — without the flag
  // those would route through AgentManager's onUserClose handler into
  // kill(id), wiping sessions.json on every Cmd+R.
  manager?.markShuttingDown();
  manager?.dispose();
  manager = null;
}
