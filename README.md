# Glance - Claude Code

A VS Code extension that brings a multi-session Claude Code agent
panel into VS Code. Each agent runs in a real VS Code terminal; markers
(`🔊 TL;DR`, `🏷️ Title`, `⚠️ Needs input`, `❌ Error`, `📊 Progress`) are
read from Claude Code's JSONL transcript and surfaced on per-agent cards in
the sidebar.

## Requirements

- VS Code 1.90+
- Claude Code (`claude` binary on PATH)
- A workspace folder open in VS Code

## Install (development)

```bash
git clone <repo>
cd glancer-vscode
pnpm install
pnpm run build
code .
# Press F5 to launch the Extension Development Host.
```

In the dev host window, open any local project folder, then click the
Glance icon in the activity bar.

## Keybindings

| Action | Shortcut |
| --- | --- |
| Focus panel | `Cmd+Shift+G` / `Ctrl+Shift+G` |
| New agent (panel focused) | `Cmd+Shift+G` / `Ctrl+Shift+G` |
| New agent (global) | `Cmd+Alt+N` / `Ctrl+Alt+N` |
| Kill active (panel focused) | `Cmd+Backspace` / `Ctrl+Backspace` |
| Cycle agents (panel focused) | `↑` / `↓` |

## Out of scope (v0)

- Agents do not persist across VS Code restarts.
- No `--resume` rehydration if an agent crashes mid-session.
- No context% / cost / diff-count pills.

## Architecture

Three layers:

1. **Extension host** — owns `node-pty` per agent + a `chokidar` transcript
   watcher per agent + a global hook events watcher. See `src/agents/`.
2. **VS Code terminal pane** — each agent is a `vscode.Pseudoterminal` so
   VS Code handles scrollback and terminal state.
3. **Webview (React)** — sidebar agent list, talks to the host over typed
   `postMessage` envelopes. See `src/view/webview/`.

Marker pipeline:

- `claude` is launched with `--append-system-prompt` + `--settings <hooks>`.
- The Stop hook fires with the session UUID; we then watch the JSONL
  transcript and run `extractMarkers` on the last assistant message.
- `UserPromptSubmit` clears transient pills (needs-input / error / progress).
