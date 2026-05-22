# Glance — In-Process HTTP Server for State & Hook Delivery

**Status:** Approved design — ready for implementation planning
**Date:** 2026-05-22
**Project:** `glancer-vscode` ("Glance — Claude Code" VS Code extension)

---

## 1. Problem

A Glance card can show a stale state while Claude is still working — most
visibly, a green "done" check (`✓`) on a card whose session is mid-turn.

The card has two independent input channels, and **neither delivers into the
extension directly**:

1. **MCP state** — Claude calls the `update_state` tool. The call lands in
   `mcp-server.mjs`, a stdio child process of the `claude` CLI (a different
   process tree from the extension host). That process writes
   `state/<id>.json`; the extension watches the file with `chokidar`.
2. **Hook events** — `UserPromptSubmit` / `Stop` / `SessionStart` /
   `Notification` run `hook.mjs` (a fresh short-lived process per event),
   which writes a JSON file into an `events/` directory; the extension
   watches that directory with `chokidar`.

The working-vs-done indicator is driven by the `streaming` flag, which is
flipped **on** by `UserPromptSubmit` and **off** by `Stop` — i.e. entirely by
the hook channel. The MCP channel (tldr/title/progress) is separate.

Two concrete defects make the hook channel lossy:

- **Non-atomic writes** — `hook.mjs` does `writeFileSync` straight to the
  final path. The events watcher (`chokidar`, `usePolling`, no
  `awaitWriteFinish`) can observe the file between *create* and
  *write-complete* and fire `add` on an empty/partial file.
- **Lost on parse failure** — `AgentManager.handleHookEvent` reads the file,
  and on a `JSON.parse` error it `return`s but **still `unlinkSync`s the file
  in its `finally` block**. A partially-read event is deleted, never retried.

Result: a dropped `UserPromptSubmit` leaves `streaming` false for the whole
turn, so the card keeps the previous turn's `✓` while `update_state` (on the
other channel) keeps refreshing the tldr. Stale check, fresh summary.

The file + `chokidar` bridge is the root cause. This design removes it.

## 2. Goals & non-goals

**Goals**

- Deliver both `update_state` MCP calls and Claude Code hook events
  **directly into the extension host process**, with no intermediate file
  and no `chokidar`.
- Eliminate the lost-event / partial-read bug class (and therefore the
  stale-`✓` symptom).
- Remove the `mcp-server.mjs` child process and the `chokidar` dependency.
- Remove the ~250 ms polling latency on every card update.

**Non-goals**

- No idle-timer / transcript-watcher self-healing fallback for the
  `streaming` flag (considered and explicitly deferred — see §14).
- No change to the card UI, the snapshot shape, or the `state/<id>.json`
  on-disk format.
- No change to dormant-agent persistence behaviour.

## 3. Background — current pipeline

```
Claude tool call → mcp-server.mjs (child of claude) → writes state/<id>.json
  → chokidar stateWatcher (usePolling 250ms) → Agent.applyState() → webview

Claude hook → hook.mjs (per-event process) → writes events/<ts>-<pid>.json
  → chokidar eventsWatcher (usePolling) → AgentManager.handleHookEvent → Agent → webview
```

Key facts that constrain the design:

- `mcp-config.json` and `hook-settings.json` are **global** files written
  once at activation. Per-agent identity (`GLANCER_AGENT_ID`,
  `GLANCER_STATE_FILE`, `GLANCER_EVENTS_DIR`) is injected as **PTY env vars**
  at spawn time (`Agent.spawn()`).
- The MCP server is a stdio JSON-RPC server implementing `initialize`,
  `tools/list`, `tools/call`, and `notifications/*`. It returns the Glance
  system prompt in the `initialize` response's `instructions` field.
- `claude` is spawned as:
  `claude --dangerously-skip-permissions [--model X] --settings <hook-settings.json> --mcp-config <mcp-config.json> [--resume <id>]`.
- The `state/<id>.json` file is **also** the persistence layer: on reload,
  dormant agents render from it (currently seeded by the state watcher's
  initial `add` event).
- `transcriptWatcher.ts` is the only other `chokidar` importer; it is legacy
  and not wired into `AgentManager`.

## 4. Approaches considered

**Approach 1 — true direct HTTP MCP (CHOSEN).** The extension host runs one
local HTTP server. `mcp-config.json` registers an `http`-type MCP server
pointing at it, so the `claude` CLI connects directly to the extension;
`update_state` tool calls execute in extension-host JS. `hook.mjs` POSTs
hook events to the same server.
*Pro:* truly direct — no `mcp-server.mjs` child, no state file as a channel,
no `events/` files, no `chokidar`.
*Con:* depends on the installed Claude Code supporting `type: "http"` MCP
servers via `--mcp-config`. This is the load-bearing assumption (see §13).

**Approach 2 — stdio shim proxy (FALLBACK ONLY).** Keep a tiny
`mcp-server.mjs`, but gut it: instead of writing files it forwards JSON-RPC
to the extension's HTTP server and relays the reply.
*Pro:* no dependency on HTTP MCP support; still removes `chokidar` and the
file channel.
*Con:* keeps one child process per session — not "direct."

**Decision:** build Approach 1. If the §13 verification spike fails, fall
back to Approach 2 — all extension-side code is reused; only the last hop
(`hook.mjs` / `mcp-config.json` shape) changes.

## 5. Chosen architecture

One HTTP server in the extension host. Two route families. No files in the
live path.

```
extension host
 ├─ GlanceServer  (http, 127.0.0.1:<ephemeral port>)
 │    POST /mcp/:agentId    — MCP JSON-RPC (Streamable HTTP, JSON responses)
 │    POST /hook/:agentId   — hook event ingestion
 └─ node-pty → claude       — connects back to GlanceServer over HTTP
        └─ hook.mjs (per event) → POST → GlanceServer
```

New units:

- **`GlanceServer`** (`src/server/GlanceServer.ts`) — owns the
  `http.Server`. Created and bound (`listen(0, '127.0.0.1')`) during
  `AgentManager` construction. Holds the ephemeral port and a random
  per-activation bearer token. Parses/authenticates requests, routes by
  path, delegates to `AgentManager`. Closed in `dispose()`.
- **`mcpHandler`** (`src/server/mcpHandler.ts`) — the JSON-RPC logic lifted
  out of `mcp-server.mjs`: `initialize` (returns the instructions string),
  `tools/list` (the `update_state` tool + schema), `tools/call`, and
  `notifications/*` no-ops. Transport-free and pure: given a parsed
  JSON-RPC request plus an `applyState` callback, it returns a JSON-RPC
  response. Independently unit-testable.

Each unit has one job: `GlanceServer` = HTTP transport + auth + routing;
`mcpHandler` = MCP protocol semantics; `AgentManager` = agent lookup and
state application. They communicate through plain function calls.

## 6. Components — detail

### `GlanceServer`
- `start()`: `listen(0, '127.0.0.1')`; on success record `port`. On
  `EADDRINUSE` or other bind error, retry once; if it still fails, log and
  surface a one-line error (cards simply won't update — rare).
- Generates `token` = 32 bytes of `crypto.randomBytes`, hex.
- Request handling: reject anything without `Authorization: Bearer <token>`
  with `401`. Route on method + path:
  - `POST /mcp/:agentId` — read the JSON body, hand to `mcpHandler` with an
    `applyState` callback bound to `:agentId`, write the JSON-RPC response.
  - `POST /hook/:agentId` — read the JSON body (`{ payload }`), call
    `AgentManager.handleHookEvent(agentId, payload)`, respond `204`.
  - Anything else — `404`.
- No CORS headers (browsers cannot meaningfully cross-origin POST here).
- `dispose()` closes the server.

### `mcpHandler`
- Exports the `TOOLS` array (the `update_state` tool, schema, and
  descriptions — moved verbatim from `mcp-server.mjs`).
- `handle(request, ctx)` where `ctx` carries `instructions` and an
  `applyState(stateObject)` callback:
  - `initialize` → `{ protocolVersion, capabilities, serverInfo,
    instructions }`.
  - `tools/list` → `{ tools: TOOLS }`.
  - `tools/call` for `update_state` → validate the tool name, build the
    partial state object from the six keys present in `arguments`, call
    `applyState`, return `{ content: [{ type: 'text', text: 'Agent card
    updated.' }] }`.
  - `notifications/*` → no response.
  - unknown method with an `id` → JSON-RPC error `-32601`.
- The field-merge (partial update preserves prior values) moves to the
  Agent's existing `applyState` path — `mcpHandler` only passes through the
  keys that were present in the call.

### `AgentManager`
- Constructs and owns `GlanceServer`; starts it before any agent spawns;
  closes it in `dispose()`.
- `mcp-config.json` (global) → **per-agent `mcp-config-<id>.json`**, written
  at spawn/revive once the server port is known:
  ```json
  {
    "mcpServers": {
      "glancer": {
        "type": "http",
        "url": "http://127.0.0.1:<port>/mcp/<agentId>",
        "headers": { "Authorization": "Bearer <token>" }
      }
    }
  }
  ```
- `hook-settings.json` stays global (still registers `hook.mjs` for the four
  hooks); the port and token reach `hook.mjs` via PTY env vars.
- `glancer-instructions.txt` — **deleted**; instructions are served
  in-process from `systemPrompt.ts` (`summarySystemPrompt('')`).
- `handleHookEvent` keeps its event-routing logic (`SessionStart` /
  `UserPromptSubmit` / `Stop` / `Notification`) but takes `(agentId,
  payload)` arguments directly instead of reading and unlinking a file.
- New `applyAgentState(agentId, state)` — finds the agent, applies the
  state to the live `Agent`, and writes `state/<id>.json` as the durable
  persistence snapshot.
- The `events/` directory and its `chokidar` watcher are removed.

### `Agent`
- `spawn()` writes the per-agent `mcp-config-<id>.json` with the live port;
  adds `GLANCER_HOOK_URL` (`http://127.0.0.1:<port>/hook/<id>`) and
  `GLANCER_TOKEN` to the PTY env. `GLANCER_STATE_FILE` is still used
  internally for the persistence write but is no longer an IPC channel.
- The per-agent `stateWatcher` (`watchState`) is removed. `applyState` is
  exposed as a public `Agent` method and invoked directly by
  `AgentManager.applyAgentState`.
- Dormant restore: `AgentManager` reads `state/<id>.json` once at restore
  time to seed the card, replacing the state watcher's initial `add` event.

### `hook.mjs`
- Stays a tiny script invoked per hook event (hooks are always shell
  commands).
- Reads the event JSON from stdin (unchanged).
- Reads `GLANCER_HOOK_URL` and `GLANCER_TOKEN` from env.
- `POST`s `{ payload }` with the `Authorization` header via `fetch`, with a
  short timeout (e.g. 2 s) and **2 retries with backoff** on failure.
- On total failure: log to `hook.log` and `exit 0` — never throw, never
  block Claude's turn.
- Keeps the `UserPromptSubmit` stdout nudge ("Glance: end this turn with
  `mcp__glancer__update_state`.") and the `hook.log` sidecar.

## 7. Data flow (after)

```
update_state:
  Claude tools/call → POST /mcp/<id> → GlanceServer (auth, route)
    → mcpHandler.handle → AgentManager.applyAgentState(id, state)
    → Agent applies + emits snapshot patch → webview
    → AgentManager writes state/<id>.json (persistence only; unwatched)

hook:
  Claude fires hook → hook.mjs → POST /hook/<id> → GlanceServer (auth, route)
    → AgentManager.handleHookEvent(id, payload)
    → Agent.clearTransient / notifyTurnComplete / setNeedsAttention /
      setSessionId / resetCardState → webview
```

No files in either live path; the 250 ms polling latency is gone.

## 8. Security

- The server binds `127.0.0.1` only — never `0.0.0.0`.
- A random per-activation bearer token is validated on every request;
  this stops other local processes from poking the server.
- No CORS handler is registered, so a browser page cannot perform a
  meaningful cross-origin POST.
- `:agentId` in the path must resolve to a live agent; otherwise the
  request gets a JSON-RPC error (`/mcp`) or `404` (`/hook`).

## 9. Error handling

| Failure | Behaviour |
|---|---|
| Server bind fails | Retry once on a fresh ephemeral port; if still failing, log + surface a one-line error. Cards won't update (rare). |
| Missing/bad token | `401`. |
| `tools/call` for unknown agentId | JSON-RPC error; Claude's turn continues (MCP tool failure is non-fatal). |
| `state/<id>.json` write fails | Logged; the live card already updated — only the dormant snapshot is missed. |
| hook POST fails after retries | `hook.mjs` logs + `exit 0` — never blocks Claude. That card misses the event and self-corrects at the next turn boundary. Now a loud logged error, not silent file corruption. |
| MCP server unreachable (extension reloading) | `update_state` calls error; card stale until the server is back. |

## 10. Files added / changed / deleted

**Added**
- `src/server/GlanceServer.ts`
- `src/server/mcpHandler.ts`
- `src/server/mcpHandler.test.ts`
- `src/server/GlanceServer.test.ts`

**Changed**
- `src/agents/AgentManager.ts` — owns `GlanceServer`; per-agent MCP config;
  `handleHookEvent(agentId, payload)`; `applyAgentState`; events watcher
  removed.
- `src/agents/Agent.ts` — `spawn()` writes per-agent config + new env vars;
  `stateWatcher` removed; `applyState` reachable from the manager; dormant
  restore reads the state file once.
- `src/markers/hook.mjs` — POSTs over HTTP with retry instead of writing a
  file.
- `esbuild.config.mjs` — drop the `mcp-server.mjs` copy; update
  `testEntries`.
- `package.json` — remove `chokidar`; update the `test` script.

**Deleted**
- `src/markers/mcp-server.mjs`
- `src/markers/stateWatcher.ts`
- `src/markers/transcriptWatcher.ts` + `transcriptWatcher.test.ts`
- `src/markers/extractMarkers.ts` + `extractMarkers.test.ts`
  (legacy and unwired; `transcriptWatcher` is the last `chokidar` importer,
  and `extractMarkers` is used only by `transcriptWatcher`)
- `glancer-instructions.txt` generation

## 11. Testing

- **`mcpHandler` unit tests** (`node:test`): `initialize` returns the
  instructions; `tools/list` returns the `update_state` tool; `tools/call
  update_state` passes through the present fields; unknown tool / unknown
  method → JSON-RPC error.
- **`GlanceServer` tests**: missing/bad token → `401`; `POST /hook/:id`
  routes to the handler; `POST /mcp/:id` round-trips a JSON-RPC call;
  unknown path → `404`.
- New test files are added to `esbuild.config.mjs::testEntries` **and** the
  `package.json` `test` script (no glob — per `CLAUDE.md`); the deleted
  legacy tests are removed from both.
- **Manual:** `pnpm run build`, F5 the Extension Development Host, run a
  real multi-step turn, confirm the card updates live and the
  working/done indicator is correct across turn boundaries.

## 12. Migration & release

- Config files are regenerated each activation, so the next spawn uses the
  HTTP config — no user-facing migration.
- `sessions.json` and `state/<id>.json` formats are unchanged, so dormant
  restore keeps working.
- The `mcp-server.mjs` copy step is dropped from esbuild `copyStatic` and
  from activation.
- A version bump + `CHANGELOG.md` entry is required (handled separately as
  a release step, not part of this implementation).

## 13. Risks & the verification spike

**The one real risk:** Approach 1 assumes the installed Claude Code accepts
a `type: "http"` MCP server entry via `--mcp-config` and connects to it.

**Mitigation — implementation step 1 is a verification spike:** hand-write
an `http`-type `mcp-config.json` pointing at a trivial throwaway HTTP MCP
server, launch a `claude` session with it, and confirm the server receives
`initialize` / `tools/list` / `tools/call`. Only proceed with Approach 1
once the spike passes. If it fails, fall back to Approach 2 (stdio shim);
the extension-side code (`GlanceServer`, `mcpHandler`,
`AgentManager`/`Agent` changes) is reused unchanged.

Secondary note: `hook.mjs` uses `fetch`, which requires the Node runtime
Claude Code invokes hooks with to be Node 18+. This is expected to hold but
should be confirmed during the spike.

## 14. Out of scope

- **Self-healing `streaming` fallback** — an idle-timer or transcript-JSONL
  liveness reconciliation so a genuinely-failed hook POST auto-corrects
  before the next turn boundary. Considered; deferred. HTTP delivery plus
  `hook.mjs` retry is the agreed reliability bar; a persistent POST failure
  self-corrects on the next turn, the same window as today.
- Any change to the card UI, the snapshot schema, or the persistence
  format.
