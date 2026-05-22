# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

VS Code extension ("Glance — Claude Code", publisher `hamzawaleed`, view id `glancer.agents`) that runs multiple Claude Code sessions in real VS Code terminals and surfaces per-session status cards (title, TL;DR, progress, needs-input/error) in a sidebar webview. The product is branded "Glance"; internal symbols / commands / settings are still `glancer.*` — do not rename them.

## Commands

Package manager is **pnpm** (`.npmrc` pins `node-linker=hoisted` and lists `esbuild` + `node-pty` as the only built deps). Do not use npm/yarn — `postinstall` runs `scripts/fix-pty-perms.mjs`, which depends on the hoisted layout.

```bash
pnpm install          # also runs scripts/fix-pty-perms.mjs (chmod +x node-pty's spawn-helper)
pnpm run build        # esbuild: extension host + webview + per-file test compile
pnpm run watch        # all three esbuild contexts in watch mode + copyStatic polling
pnpm run test         # node --test on the compiled test files in out/
pnpm run fix-pty      # re-run the spawn-helper chmod (if a pnpm rebuild stripped it)
```

Launch the Extension Development Host from VS Code with **F5** after `pnpm run build` (or while `pnpm run watch` is running).

### Tests

Tests are plain `node:test` files compiled by esbuild to CJS (the `src/` tree is preserved under `out/`) and executed against the JS in `out/`. The test command is a hard-coded file list — see `scripts.test` in `package.json`:

```bash
node --test out/server/mcpHandler.test.js out/server/GlanceServer.test.js out/agents/ids.test.js …
```

Run a single test file: `node --test out/server/mcpHandler.test.js` (after `pnpm run build`). Run one named test: `node --test --test-name-pattern='<name>' out/server/mcpHandler.test.js`. Tests must be added to both the `testEntries` array in `esbuild.config.mjs` (the test source **and** its non-test deps, compiled per-file) and the `scripts.test` command in `package.json` — there is no glob.

## Architecture

Three runtimes cooperate per agent. Understand all three before changing the marker / state pipeline.

### 1. Extension host (`src/extension.ts`, `src/agents/`, `src/view/AgentPanelProvider.ts`)

- `AgentManager` owns the `Map<id, ManagedAgent>`, the in-process `GlanceServer` (see §2), and on-disk persistence. Persistence is **workspace-scoped**: `sessions.json` + `session-titles.json` + `state/<id>.json` live under `context.storageUri` (per-workspace) so two VS Code windows don't collide on the short `AG-NN` ids. Install-once binaries (`hook.mjs`, `hook-settings.json`, `mcp-config-<id>.json`) stay under `globalStorageUri`. Three one-shot `maybeMigrateGlobal*` helpers move legacy global data into the workspace dir on first run.
- On activation it copies `out/markers/hook.mjs` into `globalStorageUri`, starts the `GlanceServer`, and writes:
  - `hook-settings.json` — registers `hook.mjs` for `Stop`, `UserPromptSubmit`, `Notification`, `SessionStart` (passed to `claude --settings`). The command carries no per-agent data; the agent id rides in the POST URL the hook reads from `$GLANCER_HOOK_URL`.
  - `mcp-config-<id>.json` (one per agent) — an `http`-transport MCP entry pointing at `http://127.0.0.1:<port>/mcp/<id>` with the server's bearer token (passed to `claude --mcp-config`). Written by `Agent.spawn()`, which reads the live server's port + token.
- The Glance system prompt is returned in the MCP server's `initialize` response `instructions` field — no file, no `--append-system-prompt` (that path was removed because shell echo leaked the prompt into the terminal). The text is `summarySystemPrompt('')` from `src/markers/systemPrompt.ts`, passed into `GlanceServer` at construction.
- `Agent` spawns a `node-pty` child shell that runs `clear && claude --dangerously-skip-permissions [--model X] --settings … --mcp-config … [--resume <sessionId>]`. The PTY is wrapped in a `vscode.Pseudoterminal` so VS Code owns scrollback. See `src/agents/pseudoterminal.ts` — it holds a "Starting session…" placeholder until Claude emits the alt-screen escape (`\x1b[?1049h` / `1047h` / `47h`) or a 5s deadline elapses, then flushes; this hides the shell echo of the launch command.

On activation, `extension.ts` also checks `context.globalState.get('glancer.walkthrough.seen')` and, if unset, opens the `glancer.welcome` walkthrough exactly once via `workbench.action.openWalkthrough`. This is the only reason `activationEvents` includes `onStartupFinished` alongside `onView:glancer.agents` — without it the first-install user wouldn't trigger activation until they opened the panel manually. The same walkthrough can be re-opened any time via `Glance: Show Welcome Tour` in the Command Palette.

#### Card kinds: Claude agents vs shell terminals

A card is one of two kinds, discriminated by `AgentSnapshot.kind`:

- **`'claude'`** — the original `Agent`: a node-pty `Pseudoterminal` running
  `claude …`, with the MCP state pipeline, hooks, dormancy, and `--resume`.
- **`'shell'`** — `ShellAgent` (`src/agents/ShellAgent.ts`): an ordinary
  `vscode.window.createTerminal` shell, spawned with the `t` key. No MCP, no
  hooks, no state file, no `sessionId`, never persisted. Its card title comes
  from the first command (`onDidStartTerminalShellExecution`) and its
  in-progress dot from command start/end; `c c` clears the scrollback instead
  of running `/clear`. `isTransient: true` makes shell terminals vanish on
  reload.

Both implement the `ManagedAgent` interface (`src/agents/ManagedAgent.ts`) —
the kind-agnostic surface `AgentManager` uses. The manager stores
`Map<string, ManagedAgent>` and narrows with `instanceof Agent` on the
Claude-only paths: MCP state routing (`applyAgentState`), hook routing,
`persist()`, the kill-time state archive, and `listOldSessions()`.

### 2. Marker / state pipeline (the load-bearing flow)

Claude updates the agent card **exclusively** via the MCP tool `glancer - update_state`. The MCP server is **in-process**: `GlanceServer` (`src/server/GlanceServer.ts`) is a localhost-only HTTP server hosted in the extension host, and `mcpHandler.ts` owns the JSON-RPC / MCP protocol semantics. Neither imports `vscode` — both are unit-tested under `node --test`. The pipeline is:

```
Claude update_state tool call
  → POST /mcp/<id> to GlanceServer (127.0.0.1, ephemeral port, per-activation bearer token)
  → mcpHandler.handleMcpRequest() parses the JSON-RPC, runs the applyState callback
  → AgentManager.applyAgentState() → Agent.applyState() diffs, emits Partial<AgentSnapshot>,
    and merges a snapshot to state/<id>.json (so a dormant restore re-seeds correctly)
  → AgentManager forwards it as agentUpdate to the webview
```

Six required fields on every call: `title`, `tldr`, `progress`, `needsInput`, `error`, `skill`. The system prompt (`src/markers/systemPrompt.ts`) hammers on "all six, every call" — the schema enforces it via `required` in `mcpHandler.ts::TOOLS`. Missing fields preserve prior value (silent desync); explicit `null` clears.

Hook events flow over the same server:

```
Claude fires hook → hook.mjs reads the event JSON on stdin, POSTs it to $GLANCER_HOOK_URL
  (/hook/<id>, bearer token, retries twice) → GlanceServer → AgentManager.handleHookEvent
  SessionStart → setSessionId; if source='clear'|'compact', resetCardState (wipes title + markers)
  UserPromptSubmit → markUserPrompted + clearTransient (streaming on, wipes tldr/needs/error/progress)
  Stop → notifyTurnComplete (streaming off, toast + tone via webview)
  Notification → setNeedsAttention (gated on streaming=true to ignore Claude's 60s idle ping)
```

`hook.mjs` never throws and never blocks Claude's turn — a failed POST is logged to `$GLANCER_LOG_DIR/hook.log` and swallowed. On `UserPromptSubmit` it also writes a one-line nudge to stdout (injected as silent model context) telling the turn to end with `update_state`.

### 3. Persistence and dormant agents

- `sessions.json` only contains agents where `hasUserPrompt === true`. Agents created but never prompted have no JSONL on disk, so `claude --resume <id>` would fail with "No conversation found" — they're filtered out.
- On reload, restored entries become **dormant** Agents: the card renders from `state/<id>.json` (the `Agent` constructor reads the file directly and calls `applyState` once) but no PTY is spawned. `reveal()` / `select` / `focusTerminal` calls `revive()` which spawns Claude with `--resume <sessionId>`.
- `Agent.onExit` (PTY exit) calls `becomeDormant()` — it does **not** remove the agent from the map. Cmd+R reload and accidental terminal closes both fire exit; deleting on those would wipe `sessions.json`. Permanent removal only happens via `AgentManager.kill()` → `removeAgent()` (also calls `purgePersistentState()` to delete the state file).
- The activity-bar badge is a derived count of `agents.where(needsAttention)` — recomputed on **every** `agentUpdate`, never tracked incrementally (avoids drift bugs).

### 4. Webview (`src/view/webview/`)

React 18 mounted into a `WebviewView` with `retainContextWhenHidden: true`. Communicates over typed `postMessage` envelopes defined in `src/shared/messages.ts` (`HostToWebview` / `WebviewToHost`) — keep both unions in sync when adding messages.

Focus race notes: `AgentPanelProvider.scheduleFocusRetries` fires `focusTerminal` at 150/400/900/1600ms after auto-spawn because a single call gets eaten during VS Code launch. `pendingFocusTerminalId` is the backup path consumed by the first `panelFocus(true)` message from the webview. Don't simplify these without testing the "VS Code launched with Glance already the active view" case.

## Conventions and gotchas

- **Marker sanitization**: every model-supplied string goes through `sanitizeMarkerString` in `src/agents/Agent.ts`, which strips `null`/`undefined`/`true`/`false`/`n/a`/`na` literals. Add new bad values to `MARKER_STRING_BAD_VALUES` rather than gating per call site.
- **Shell quoting**: paths get baked into hook commands run by Claude via `/bin/sh -c`. macOS `globalStorageUri` lives under `~/Library/Application Support/…` (contains a space). All such paths go through `shellQuote` in `Agent.ts` / inline POSIX quoting in `AgentManager.ts`. Don't pass unquoted paths.
- **Streaming flag**: only flipped by `clearTransient` (UserPromptSubmit → true) and `notifyTurnComplete` / `setNeedsAttention` (→ false). **Do not** wire `onData` to flip it — typed characters echo through `onData` and would falsely toggle streaming on while the user is typing.
- **node-pty is `external`** in `esbuild.config.mjs::hostConfig` — the native binding can't be bundled. `fsevents` is also external. The `postinstall` hook chmod+x's `node_modules/node-pty/prebuilds/<platform>/spawn-helper` because npm tarballs strip the executable bit and VS Code's hardened runtime won't `posix_spawnp` a non-executable.
- **Build outputs the host expects at runtime**: `out/extension.js` (main), `out/webview/{main.js,index.html,styles.css,mixkit-correct-answer-tone-2870.wav}` (loaded via `webview.asWebviewUri`), `out/markers/hook.mjs` (copied to `globalStorageUri` on activation). `copyStatic()` in `esbuild.config.mjs` re-copies them and chmods `hook.mjs` to 0755 — preserve that on changes.
- **TypeScript split**: `tsconfig.json` covers the host (CJS, excludes `src/view/webview/**`); `tsconfig.webview.json` is `noEmit: true` and covers the webview + shared. esbuild does the actual compilation for both.
- **Title source precedence** (`Agent.applyState`): `'manual'` and `'rename'` block AI-supplied titles; `'ai'` and `'default'` accept them. `/clear` (SessionStart source=`clear`) resets the title back to `glance-XX` so the next turn's `update_state` can re-claim it. Manual renames and AI titles both get first-letter capitalization via `capitalizeFirstLetter`.
