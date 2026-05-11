import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { Agent } from './Agent';
import { nextAgentId } from './ids';
import type { AgentSnapshot, ClaudeModel } from '../shared/messages';

interface ManagerInit {
  context: vscode.ExtensionContext;
}

type ManagerEvent =
  | { type: 'added'; agent: AgentSnapshot }
  | { type: 'removed'; id: string }
  | { type: 'updated'; id: string; fields: Partial<AgentSnapshot> }
  | { type: 'active'; id: string | null };

/**
 * Hook script writes one JSON file per event into the events dir. We watch that dir
 * (chokidar, 'add'), parse, route to the right Agent. The script self-heals: it
 * never throws and never blocks Claude's turn.
 */
export class AgentManager implements vscode.Disposable {
  private readonly agents = new Map<string, Agent>();
  private activeId: string | null = null;

  private readonly storageDir: string;
  private readonly eventsDir: string;
  private readonly hookScriptPath: string;
  private readonly hookSettingsPath: string;
  private readonly eventsWatcher: FSWatcher;

  private readonly changeEmitter = new vscode.EventEmitter<ManagerEvent>();
  readonly onChange = this.changeEmitter.event;

  constructor(init: ManagerInit) {
    this.storageDir = init.context.globalStorageUri.fsPath;
    fs.mkdirSync(this.storageDir, { recursive: true });

    this.eventsDir = path.join(this.storageDir, 'events');
    fs.mkdirSync(this.eventsDir, { recursive: true });

    // Copy the hook script to storageDir so it has a stable absolute path
    // even when the extension is updated.
    this.hookScriptPath = path.join(this.storageDir, 'hook.mjs');
    const bundledHookPath = path.join(init.context.extensionPath, 'out', 'markers', 'hook.mjs');
    try {
      fs.copyFileSync(bundledHookPath, this.hookScriptPath);
      fs.chmodSync(this.hookScriptPath, 0o755);
    } catch (err) {
      console.warn('[glancer] failed to install hook script:', err);
    }

    this.hookSettingsPath = path.join(this.storageDir, 'hook-settings.json');
    fs.writeFileSync(
      this.hookSettingsPath,
      JSON.stringify(
        {
          hooks: {
            Stop: [{ command: this.hookScriptPath, type: 'command' }],
            UserPromptSubmit: [{ command: this.hookScriptPath, type: 'command' }],
            Notification: [{ command: this.hookScriptPath, type: 'command' }],
            SessionStart: [{ command: this.hookScriptPath, type: 'command' }],
          },
        },
        null,
        2,
      ),
    );

    this.eventsWatcher = chokidar.watch(this.eventsDir, {
      persistent: true,
      ignoreInitial: true,
    });
    this.eventsWatcher.on('add', (filePath: string) => this.handleHookEvent(filePath));
  }

  list(): AgentSnapshot[] {
    return Array.from(this.agents.values()).map((a) => a.snapshot());
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  newAgent(opts: { cwd: string; model?: ClaudeModel }): string {
    const id = nextAgentId(this.agents.keys());
    const agent = new Agent({
      id,
      cwd: opts.cwd,
      model: opts.model ?? 'default',
      hookSettingsPath: this.hookSettingsPath,
      eventsDir: this.eventsDir,
      hookScriptPath: this.hookScriptPath,
    });
    agent.onChange((fields) =>
      this.changeEmitter.fire({ type: 'updated', id, fields }),
    );
    agent.onExit(() => {
      this.changeEmitter.fire({ type: 'updated', id, fields: { streaming: false } });
    });
    this.agents.set(id, agent);
    this.changeEmitter.fire({ type: 'added', agent: agent.snapshot() });
    this.setActive(id);
    agent.reveal();
    return id;
  }

  kill(id: string): void {
    const a = this.agents.get(id);
    if (!a) return;
    a.dispose();
    this.agents.delete(id);
    this.changeEmitter.fire({ type: 'removed', id });
    if (this.activeId === id) {
      const next = this.agents.keys().next().value ?? null;
      this.setActive(next);
    }
  }

  select(id: string): void {
    const a = this.agents.get(id);
    if (!a) return;
    this.setActive(id);
    a.reveal();
  }

  rename(id: string, name: string): void {
    this.agents.get(id)?.setManualTitle(name);
  }

  resetTitle(id: string): void {
    this.agents.get(id)?.setManualTitle('');
  }

  private setActive(id: string | null): void {
    if (this.activeId === id) return;
    this.activeId = id;
    this.changeEmitter.fire({ type: 'active', id });
  }

  private handleHookEvent(filePath: string): void {
    let payload: unknown;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      payload = JSON.parse(raw);
    } catch {
      return;
    } finally {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // ignore
      }
    }
    if (typeof payload !== 'object' || payload === null) return;
    const wrapper = payload as {
      agentId?: string;
      payload?: { hook_event_name?: string; session_id?: string };
    };
    const agentId = wrapper.agentId;
    if (!agentId) return;
    const agent = this.agents.get(agentId);
    if (!agent) return;
    const hookEvent = wrapper.payload?.hook_event_name;
    const sessionId = wrapper.payload?.session_id;
    if (hookEvent === 'Stop' && sessionId) {
      agent.bindSession(sessionId);
    } else if (hookEvent === 'UserPromptSubmit') {
      agent.clearTransient();
    } else if (hookEvent === 'SessionStart' && sessionId) {
      agent.bindSession(sessionId);
    }
    // Notification left as a no-op for v0 — markers via JSONL are sufficient.
  }

  dispose(): void {
    for (const a of this.agents.values()) a.dispose();
    this.agents.clear();
    this.eventsWatcher.close();
    this.changeEmitter.dispose();
  }
}
