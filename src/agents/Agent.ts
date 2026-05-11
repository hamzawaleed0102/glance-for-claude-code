import * as vscode from 'vscode';
import { createClaudePty, type ClaudePty } from './pseudoterminal';
import { extractMarkers, type MarkerSet } from '../markers/extractMarkers';
import { SUMMARY_SYSTEM_PROMPT } from '../markers/systemPrompt';
import { watchTranscript, type TranscriptWatcher } from '../markers/transcriptWatcher';
import type { AgentSnapshot, ClaudeModel, TitleSource } from '../shared/messages';

const STREAM_IDLE_MS = 600;

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe';
  return process.env.SHELL || '/bin/zsh';
}

export interface AgentInit {
  id: string;
  cwd: string;
  model: ClaudeModel;
  hookSettingsPath: string;
  eventsDir: string;
  hookScriptPath: string;
}

export class Agent implements vscode.Disposable {
  readonly id: string;
  private _name: string;
  private _titleSource: TitleSource = 'default';
  private _model: ClaudeModel;
  private _tldr: string | null = null;
  private _attentionReason: string | null = null;
  private _errorReason: string | null = null;
  private _progress: { value: number; label: string } | null = null;
  private _streaming = false;
  private _streamTimer: NodeJS.Timeout | null = null;

  private claude: ClaudePty;
  private terminal: vscode.Terminal;
  private watcher: TranscriptWatcher | null = null;

  private readonly changeEmitter = new vscode.EventEmitter<Partial<AgentSnapshot>>();
  readonly onChange = this.changeEmitter.event;

  private readonly exitEmitter = new vscode.EventEmitter<void>();
  readonly onExit = this.exitEmitter.event;

  constructor(init: AgentInit) {
    this.id = init.id;
    this._name = `shell-${init.id.slice(3)}`;
    this._model = init.model;

    const modelFlag = init.model === 'default' ? '' : ` --model ${init.model}`;
    const initialCommand =
      `clear && claude --dangerously-skip-permissions${modelFlag}` +
      ` --settings ${shellQuote(init.hookSettingsPath)}` +
      ` --append-system-prompt ${shellQuote(SUMMARY_SYSTEM_PROMPT)}`;

    this.claude = createClaudePty({
      cwd: init.cwd,
      shell: defaultShell(),
      env: {
        ...process.env,
        GLANCER_AGENT_ID: init.id,
        GLANCER_EVENTS_DIR: init.eventsDir,
        GLANCER_HOOK_SCRIPT: init.hookScriptPath,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
      initialCommand,
    });

    this.terminal = vscode.window.createTerminal({
      name: this._name,
      pty: this.claude.pty,
    });

    this.claude.onData(() => this.markStreaming());
    this.claude.onExit(() => this.exitEmitter.fire());
  }

  bindSession(sessionId: string): void {
    if (this.watcher) return;
    this.watcher = watchTranscript(sessionId, (text) => {
      this.applyMarkers(extractMarkers(text));
    });
  }

  clearTransient(): void {
    const patch: Partial<AgentSnapshot> = {};
    if (this._attentionReason !== null) {
      this._attentionReason = null;
      patch.attentionReason = null;
    }
    if (this._errorReason !== null) {
      this._errorReason = null;
      patch.errorReason = null;
    }
    if (this._progress !== null) {
      this._progress = null;
      patch.progress = null;
    }
    if (Object.keys(patch).length > 0) this.changeEmitter.fire(patch);
  }

  setManualTitle(name: string): void {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      this._titleSource = 'ai';
      this._name = `shell-${this.id.slice(3)}`;
    } else {
      this._titleSource = 'manual';
      this._name = trimmed;
    }
    this.changeEmitter.fire({ name: this._name, titleSource: this._titleSource });
  }

  reveal(): void {
    this.terminal.show(true);
  }

  snapshot(): AgentSnapshot {
    return {
      id: this.id,
      name: this._name,
      titleSource: this._titleSource,
      model: this._model,
      tldr: this._tldr,
      attentionReason: this._attentionReason,
      errorReason: this._errorReason,
      progress: this._progress,
      streaming: this._streaming,
    };
  }

  dispose(): void {
    this.watcher?.dispose();
    this.watcher = null;
    this.claude.dispose();
    this.terminal.dispose();
    if (this._streamTimer) clearTimeout(this._streamTimer);
    this.changeEmitter.dispose();
    this.exitEmitter.dispose();
  }

  private applyMarkers(m: MarkerSet): void {
    const patch: Partial<AgentSnapshot> = {};

    if (m.tldr !== undefined && m.tldr !== this._tldr) {
      this._tldr = m.tldr;
      patch.tldr = m.tldr;
    }
    if (
      m.title !== undefined &&
      this._titleSource !== 'manual' &&
      this._titleSource !== 'rename' &&
      m.title !== this._name
    ) {
      this._name = m.title;
      this._titleSource = 'ai';
      patch.name = m.title;
      patch.titleSource = 'ai';
    }
    if (m.needsInput !== undefined && m.needsInput !== this._attentionReason) {
      this._attentionReason = m.needsInput;
      patch.attentionReason = m.needsInput;
    }
    if (m.error !== undefined && m.error !== this._errorReason) {
      this._errorReason = m.error;
      patch.errorReason = m.error;
    }
    if (m.progress !== undefined) {
      const same =
        this._progress &&
        m.progress &&
        this._progress.value === m.progress.value &&
        this._progress.label === m.progress.label;
      if (!same) {
        this._progress = m.progress;
        patch.progress = m.progress;
      }
    }

    if (Object.keys(patch).length > 0) this.changeEmitter.fire(patch);
  }

  private markStreaming(): void {
    if (!this._streaming) {
      this._streaming = true;
      this.changeEmitter.fire({ streaming: true });
    }
    if (this._streamTimer) clearTimeout(this._streamTimer);
    this._streamTimer = setTimeout(() => {
      this._streamTimer = null;
      this._streaming = false;
      this.changeEmitter.fire({ streaming: false });
    }, STREAM_IDLE_MS);
  }
}
