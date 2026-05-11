import * as vscode from 'vscode';
import * as pty from 'node-pty';

export interface ClaudePtyOpts {
  cwd: string;
  shell: string;
  env: NodeJS.ProcessEnv;
  /** Initial command to run after the shell starts (the `clear && claude …` line). */
  initialCommand: string;
}

export interface ClaudePty {
  pty: vscode.Pseudoterminal;
  /** Fires for every chunk written by node-pty. */
  onData: vscode.Event<string>;
  /** Fires once when node-pty exits. */
  onExit: vscode.Event<{ exitCode: number; signal?: number }>;
  /** Force-kill the underlying process. */
  dispose(): void;
}

export function createClaudePty(opts: ClaudePtyOpts): ClaudePty {
  const writeEmitter = new vscode.EventEmitter<string>();
  const closeEmitter = new vscode.EventEmitter<number>();
  const dataEmitter = new vscode.EventEmitter<string>();
  const exitEmitter = new vscode.EventEmitter<{ exitCode: number; signal?: number }>();

  let proc: pty.IPty | null = null;
  let cols = 100;
  let rows = 30;
  let started = false;

  const start = () => {
    if (started) return;
    started = true;
    proc = pty.spawn(opts.shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: opts.cwd,
      env: opts.env,
    });
    proc.onData((data) => {
      writeEmitter.fire(data);
      dataEmitter.fire(data);
    });
    proc.onExit(({ exitCode, signal }) => {
      exitEmitter.fire({ exitCode, signal });
      closeEmitter.fire(exitCode);
    });
    proc.write(opts.initialCommand + '\r');
  };

  const pseudoterminal: vscode.Pseudoterminal = {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,
    open(initialDimensions) {
      if (initialDimensions) {
        cols = Math.max(20, initialDimensions.columns);
        rows = Math.max(5, initialDimensions.rows);
      }
      start();
    },
    close() {
      proc?.kill();
      proc = null;
    },
    handleInput(data) {
      proc?.write(data);
    },
    setDimensions(dim) {
      cols = Math.max(20, dim.columns);
      rows = Math.max(5, dim.rows);
      try {
        proc?.resize(cols, rows);
      } catch {
        // proc may have exited
      }
    },
  };

  return {
    pty: pseudoterminal,
    onData: dataEmitter.event,
    onExit: exitEmitter.event,
    dispose() {
      try {
        proc?.kill();
      } catch {
        // ignore
      }
    },
  };
}
