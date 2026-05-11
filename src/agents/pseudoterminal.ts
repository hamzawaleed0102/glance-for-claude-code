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
  /**
   * Fires once when Claude's TUI has finished booting (alt-screen entered)
   * or the 2s fallback elapses. Until then the terminal display is held on a
   * "starting session…" placeholder so the user never sees the shell echo of
   * the `claude --append-system-prompt …` invocation.
   */
  onStartupComplete: vscode.Event<void>;
  /**
   * Update the VS Code terminal tab title. The Pseudoterminal API surfaces
   * this via `onDidChangeName`; firing it makes VS Code repaint the tab.
   */
  setName(name: string): void;
  /** Force-kill the underlying process. */
  dispose(): void;
}

// 5s is long enough for a cold-start Claude on a busy machine (the 2nd
// agent in a freshly-opened VS Code window often takes 3-4s to reach
// alt-screen because of CPU/IO contention with the first agent's startup),
// but short enough that a genuinely broken `claude` binary surfaces an
// actionable screen instead of a hung placeholder.
const STARTUP_TIMEOUT_MS = 5000;
const ALT_SCREEN_MARKERS = ['\x1b[?1049h', '\x1b[?1047h', '\x1b[?47h'];
// Clear the entire screen + scrollback and park the cursor at home before we
// hand control to Claude's TUI. Without the scrollback wipe (\x1b[3J) the
// user can scroll up and see the buffered system-prompt invocation.
const SCREEN_RESET = '\x1b[2J\x1b[3J\x1b[H';
const STARTUP_PLACEHOLDER = `${SCREEN_RESET}\x1b[2;90mStarting Claude session…\x1b[0m\r\n`;

export function createClaudePty(opts: ClaudePtyOpts): ClaudePty {
  const writeEmitter = new vscode.EventEmitter<string>();
  const closeEmitter = new vscode.EventEmitter<number>();
  const dataEmitter = new vscode.EventEmitter<string>();
  const exitEmitter = new vscode.EventEmitter<{ exitCode: number; signal?: number }>();
  const startupCompleteEmitter = new vscode.EventEmitter<void>();
  const nameEmitter = new vscode.EventEmitter<string>();

  let proc: pty.IPty | null = null;
  let cols = 100;
  let rows = 30;
  let started = false;

  // Phase machine: buffer PTY output until Claude enters alt-screen, then
  // emit only the alt-screen-onward portion to the VS Code terminal. This
  // hides the shell echo of `clear && claude --append-system-prompt …` from
  // the user.
  let phase: 'starting' | 'ready' = 'starting';
  let startupBuf = '';
  let startupTimer: NodeJS.Timeout | null = null;
  let placeholderShown = false;

  const showPlaceholderOnce = () => {
    if (placeholderShown) return;
    placeholderShown = true;
    writeEmitter.fire(STARTUP_PLACEHOLDER);
  };

  const completeStartup = (flushFrom: number) => {
    if (phase === 'ready') return;
    phase = 'ready';
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = null;
    }
    // Wipe the placeholder, then emit everything from flushFrom onward.
    //
    // - Alt-screen path: flushFrom is the marker index, so the terminal
    //   sees the enter-alt-screen sequence cleanly and Claude paints on a
    //   fresh buffer (anything echoed by the shell before the marker is
    //   discarded).
    // - Timeout path: flushFrom is 0. We flush the whole buffer. With the
    //   variable-expansion trick in Agent.ts, the only thing the shell
    //   echoes is a short one-line command like
    //     `_GP="$(cat '<path>')" && clear && claude --settings '<path>' …`
    //   — no system-prompt content. A brief leak of that line is far
    //   better than a totally blank terminal that hides whatever Claude
    //   was about to paint.
    const tail = startupBuf.slice(flushFrom);
    startupBuf = '';
    if (tail.length > 0) writeEmitter.fire(SCREEN_RESET + tail);
    else writeEmitter.fire(SCREEN_RESET);
    startupCompleteEmitter.fire();
  };

  const start = () => {
    if (started) return;
    started = true;
    showPlaceholderOnce();
    try {
      proc = pty.spawn(opts.shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: opts.cwd,
        env: opts.env,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      writeEmitter.fire(
        `\x1b[31m[glancer] pty.spawn failed:\x1b[0m\r\n${msg.replace(/\n/g, '\r\n')}\r\n`,
      );
      console.error('[glancer] pty.spawn failed', err);
      // Spawn failed entirely — we already wrote the error banner above.
      // Flip phase to ready without flushing so the banner stays put.
      phase = 'ready';
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }
      startupCompleteEmitter.fire();
      return;
    }
    proc.onData((data) => {
      dataEmitter.fire(data);
      if (phase === 'ready') {
        writeEmitter.fire(data);
        return;
      }
      startupBuf += data;
      for (const marker of ALT_SCREEN_MARKERS) {
        const idx = startupBuf.indexOf(marker);
        if (idx >= 0) {
          completeStartup(idx);
          return;
        }
      }
    });
    proc.onExit(({ exitCode, signal }) => {
      exitEmitter.fire({ exitCode, signal });
      closeEmitter.fire(exitCode);
    });
    startupTimer = setTimeout(() => {
      // Deadline reached. Flush whatever's in the buffer (now just a short
      // shell command line, not the system prompt — see Agent.ts for the
      // variable-expansion trick) so the user sees something rather than a
      // hung "Starting…" placeholder. If Claude paints alt-screen shortly
      // after, its content will simply overlay the flushed shell echo.
      completeStartup(0);
    }, STARTUP_TIMEOUT_MS);
    // Give the shell a brief moment to come up before injecting the command.
    setTimeout(() => {
      try {
        proc?.write(opts.initialCommand + '\r');
      } catch (err) {
        console.error('[glancer] failed to write initial command', err);
      }
    }, 50);
  };

  const pseudoterminal: vscode.Pseudoterminal = {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,
    onDidChangeName: nameEmitter.event,
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
    onStartupComplete: startupCompleteEmitter.event,
    setName(name: string) {
      nameEmitter.fire(name);
    },
    dispose() {
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }
      try {
        proc?.kill();
      } catch {
        // ignore
      }
      startupCompleteEmitter.dispose();
      nameEmitter.dispose();
    },
  };
}
