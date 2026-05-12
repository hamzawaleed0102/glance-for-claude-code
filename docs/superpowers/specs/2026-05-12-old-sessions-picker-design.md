# Old Sessions Picker — Design

A dropdown at the top of the Glance sidebar that lists Claude Code sessions previously run in the current workspace and reopens any of them as a new agent card via `claude --resume <sessionId>`.

## Goals

- Let the user reopen any prior Claude Code session for the current workspace without leaving the panel.
- Don't manage or duplicate session storage — Claude already keeps the JSONL transcripts. Read from `~/.claude/projects/<encoded-cwd>/*.jsonl` on demand.
- Handle the "no human-supplied title" reality: synthesize a label from the first user prompt + relative time, fall back to `untitled session` when there's no usable prompt.

## Non-goals

- Cross-workspace browsing. Only the current workspace's encoded cwd directory is scanned.
- Real-time freshness. The list refreshes when the user reopens the dropdown, not on filesystem events.
- Renaming, deleting, or otherwise managing past sessions. Claude owns those files.
- Multi-root workspace support beyond `workspaceFolders[0]` (mirrors existing `newAgent` behavior).

## User-facing behavior

A new row labelled `Open old session ▾` sits above the existing `Agents` panel header in the sidebar. Clicking the row toggles a popover styled to match the existing model picker.

The popover contains:
- A filter input (`⌕ filter…`, autofocus on open).
- A scrollable list of past sessions, sorted by file mtime descending.
- Each item is two lines:
  - **Top line:** the first user prompt, truncated to roughly 60 visible characters (200 chars on the wire). If no usable prompt is found, the line reads `untitled session` in muted italic.
  - **Bottom line:** `<short-sessionId> · <relative-time>` in muted text.
- `↑` / `↓` move highlight, `Enter` opens the highlighted session, `Esc` closes, click-outside closes.

Sessions whose `sessionId` matches an agent already open in the panel are excluded from the list (prevents double-opening the same JSONL).

If the workspace's encoded cwd directory doesn't exist, or every past session is already open, the row is rendered disabled with a tooltip explaining "no past sessions in this workspace".

Selecting an item creates a new agent card, sets it active, and spawns `claude --dangerously-skip-permissions --resume <sessionId> …` in a fresh PTY — identical to how dormant agents are revived today.

## Architecture

```
User clicks "Open old session ▾"
  → webview posts { type: 'listOldSessions' }
  → host (sessionScanner):
      • encode current workspace cwd → ~/.claude/projects/<encoded>/
      • readdir, for each *.jsonl: stat (mtime) + stream-scan first qualifying user record
      • drop sessionIds matching an open agent
      • sort by mtime desc, return list
  → webview receives { type: 'oldSessions'; sessions: [...] }, renders popover

User picks a session
  → webview posts { type: 'openOldSession', sessionId }
  → AgentManager.openOldSession:
      • new id via nextAgentId, makeAgent({ sessionId, hasUserPrompt: true })
      • setActive; reveal() spawns claude with --resume
      • persist() writes sessions.json
      • 'added' event → webview renders new card
```

**Key invariants.** The scanner never throws on a malformed JSONL line (per-line try/catch, scan continues). A session with no user message becomes "untitled session" — it is **not** filtered out, because `claude --resume` works on it. The host always filters out already-open sessionIds before responding.

## New module: `src/agents/sessionScanner.ts`

Pure module, no VS Code imports — unit-testable against a tmp dir.

```ts
export interface OldSession {
  sessionId: string;        // basename without .jsonl
  firstPrompt: string | null; // null → "untitled session" in UI
  mtimeMs: number;          // for sort + relative-time rendering
}

export function encodeCwd(cwd: string): string;
export async function listOldSessions(
  cwd: string,
  excludeSessionIds: Set<string>,
): Promise<OldSession[]>;
```

### `encodeCwd`

Single replacement: `/` → `-`. Verified against the actual directory structure (e.g. `/Users/hamzawaleed/Documents/Projects/glancer-vscode` → `-Users-hamzawaleed-Documents-Projects-glancer-vscode`). No other transformations.

### `listOldSessions`

1. `projectsRoot = path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd))`.
2. If `projectsRoot` doesn't exist → return `[]`.
3. `fs.readdir(projectsRoot)`, keep entries ending in `.jsonl`, drop entries whose basename (sans `.jsonl`) is in `excludeSessionIds`.
4. For each remaining file in parallel (`Promise.all`):
   - `fs.stat` for `mtimeMs`.
   - Stream-read using `readline` over `fs.createReadStream`; for each line:
     - Try `JSON.parse(line)`; on parse error, skip line.
     - Accept the line if and only if all of:
       - `type === "user"`
       - `isMeta` is `false` or `undefined`
       - `message.content` is a `string`
       - The trimmed content is non-empty
       - The trimmed content does **not** start with `<local-command-caveat>`
     - Truncate to 200 chars and return as `firstPrompt`.
   - If no line qualifies within the first 200 lines, abort the scan for that file and return `firstPrompt: null`.
5. Sort results by `mtimeMs` descending.

### Skipped content shapes

Treat as "no usable first prompt" (→ `untitled session`):
- Content wrapped in `<local-command-caveat>` (CLI metadata, not a real user ask).
- Content that's an array (tool-use payloads) rather than a plain string.
- Content that's empty after trim.

### Per-file failure handling

Any single-file failure (stat error, stream error, etc.) is caught and the file is silently skipped after a `console.warn`. Whole-directory failures bubble up as an empty list with a warning — the picker simply shows "no past sessions".

## `AgentManager` additions

Two new public methods, both thin wrappers around existing internals:

```ts
listOldSessions(cwd: string): Promise<OldSession[]> {
  const open = new Set<string>();
  for (const a of this.agents.values()) if (a.sessionId) open.add(a.sessionId);
  return listOldSessions(cwd, open);
}

openOldSession(sessionId: string, cwd: string): string {
  const id = nextAgentId(this.agents.keys());
  const agent = this.makeAgent({
    id, cwd, model: 'default',
    sessionId,
    hasUserPrompt: true,    // it's a real resume target
    dormant: false,
  });
  this.agents.set(id, agent);
  this.changeEmitter.fire({ type: 'added', agent: agent.snapshot() });
  this.setActive(id);
  agent.reveal();           // spawns PTY with --resume <sessionId>
  this.persist();
  return id;
}
```

The existing `Agent` constructor already accepts `sessionId` and uses it for `--resume`. No `Agent.ts` changes are required.

## Message protocol

In `src/shared/messages.ts`:

```ts
export interface OldSession {
  sessionId: string;
  firstPrompt: string | null;
  mtimeMs: number;
}

// HostToWebview
| { type: 'oldSessions'; sessions: OldSession[] }

// WebviewToHost
| { type: 'listOldSessions' }
| { type: 'openOldSession'; sessionId: string }
```

`OldSession` lives in `messages.ts` so both runtimes share the type. The scanner re-exports the type alias for its own consumers.

## `AgentPanelProvider` wiring

Handle the two new inbound messages:

- `listOldSessions`: resolve workspace cwd via `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath` (same source `newAgent` uses today). If absent, reply with `{ type: 'oldSessions', sessions: [] }`. Otherwise call `manager.listOldSessions(cwd)` and post the result.
- `openOldSession`: resolve cwd the same way; if absent, ignore. Otherwise call `manager.openOldSession(sessionId, cwd)`.

## Webview

### New component: `src/view/webview/OldSessionsPicker.tsx`

Renders a single row above `<AgentList>`. Mounted from `main.tsx`. The component owns:

- `open: boolean` — popover visibility.
- `sessions: OldSession[] | null` — list (null = loading).
- `filter: string` — current filter input.
- `highlightIdx: number` — keyboard nav index into the filtered list.

On open, posts `listOldSessions` and shows `loading sessions…` until `oldSessions` arrives. Each open re-fetches; there is no client-side cache so the list reflects sessions that finished since the last open.

When `sessions` resolves to an empty array, the row is rendered disabled with the "no past sessions" tooltip.

### Inbound message handling in `main.tsx`

`main.tsx` already holds `agents` / `activeId` in `useState` and forwards them as props. Add a sibling `oldSessions` state, handle `case 'oldSessions':` in the existing message dispatcher to `setOldSessions(msg.sessions)`, and pass the value down to `<OldSessionsPicker sessions={oldSessions} />`. The picker resets to `null` (loading state) every time it opens so subsequent fetches always reflect fresh disk state.

### Relative time

Pure helper inside the picker file:

```ts
function formatRelativeTime(mtimeMs: number, now = Date.now()): string;
```

Returns: `just now` (<60s), `Nm ago` (<60min), `Nh ago` (<24h), `yesterday` (<48h), `Mon D` (this year), `Mon D, YYYY` (older).

### Styling

New rules go into the existing `src/view/webview/styles.css` under a `.old-sessions-*` namespace, reusing the tokens already used by `.panel-header`, `.model-picker`, and `.tree-search`. No new design tokens.

## Edge cases

| Case | Behavior |
|---|---|
| No workspace folder open | Picker row hidden entirely (same gate as `newAgent`). |
| `~/.claude/projects/<encoded>/` doesn't exist | Picker row visible but disabled; tooltip "no past sessions in this workspace". |
| Dir exists but all sessions are already open as cards | Same as above — empty after filter → disabled row. |
| Session with no `type:"user"` record | Listed as `untitled session`; not excluded — `--resume` still works. |
| First user content is a `<local-command-caveat>` block | Skipped; scan continues to the next line. |
| Malformed JSONL line | Caught per-line; scan continues. |
| File-level read failure | Skipped silently with a `console.warn`. |
| User picks a session whose JSONL was deleted between list and open | Claude exits with "No conversation found"; existing `Agent.onExit` → `becomeDormant` handles it. Card stays in panel; user can kill it. |
| Popover open while an agent is added/removed | List is **not** auto-refreshed; closing and reopening fetches fresh. (Matches the existing model picker.) |
| Very long first prompts (multi-KB pasted content) | Truncated to 200 chars host-side; UI ellipsises further to ~60 chars on a single line. |
| Multi-root workspace | Use `workspaceFolders[0]` — mirrors `newAgent`. Out of scope. |

## Persistence interaction

A session opened via the picker goes through the normal `makeAgent` path with `hasUserPrompt: true`, so `persist()` writes it to `sessions.json` immediately. After VS Code reload it restores as a dormant agent like any other — no special case needed.

## Title source

Reopened sessions start with `titleSource: 'default'` and name `glance-NN`. The MCP `update_state` tool reclaims the title on the next turn (existing flow). The picker does **not** prefill the agent's display name from the first prompt — that would race with AI-supplied titles. The picker label inside the dropdown is enough context for the user to find the session before opening.

## Testing

Add `src/agents/sessionScanner.test.ts` covering the pure scanner:

- Empty directory → `[]`.
- Non-existent directory → `[]`.
- Finds first user prompt in a multi-record JSONL.
- Skips `<local-command-caveat>` and array-content records.
- Session with no qualifying user message → `firstPrompt: null`.
- Malformed JSON lines don't abort the scan.
- `excludeSessionIds` filter excludes matching files.
- Sort order is `mtimeMs` descending.

Tests use a tmp dir + hand-written JSONL fixtures. No chokidar, no VS Code APIs.

Per the CLAUDE.md test convention, register the new files in **both** `esbuild.config.mjs::testEntries` and `package.json::scripts.test`. There is no glob. Note that esbuild runs the test config with `bundle: false`, so both the module and its test file must appear in `testEntries` — matching the existing `extractMarkers.ts` + `extractMarkers.test.ts` pairing.

## Files touched

New:
- `src/agents/sessionScanner.ts`
- `src/agents/sessionScanner.test.ts`
- `src/view/webview/OldSessionsPicker.tsx`

Edited:
- `src/shared/messages.ts` — add `OldSession` type and three new message variants.
- `src/agents/AgentManager.ts` — add `listOldSessions` and `openOldSession`.
- `src/view/AgentPanelProvider.ts` — handle the two new inbound messages.
- `src/view/webview/main.tsx` — mount `OldSessionsPicker`, dispatch `oldSessions` inbound.
- `src/view/webview/styles.css` — `.old-sessions-*` rules.
- `esbuild.config.mjs` — add both `src/agents/sessionScanner.ts` and `src/agents/sessionScanner.test.ts` to `testEntries`.
- `package.json` — add `out/sessionScanner.test.js` to the `scripts.test` command line.
