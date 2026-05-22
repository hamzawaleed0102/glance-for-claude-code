# Glance In-Process HTTP Server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the file + `chokidar` IPC bridges with one localhost HTTP server hosted in the extension host, so Claude's `update_state` MCP calls and Claude Code hook events land directly in extension code.

**Architecture:** The extension host runs an `http.Server` on `127.0.0.1:<ephemeral port>`. `mcp-config.json` becomes a per-agent file registering an `http`-type MCP server, so `claude` connects straight to the extension; `hook.mjs` POSTs hook events to the same server. The MCP JSON-RPC logic moves in-process; `mcp-server.mjs`, both `chokidar` watchers, and the `chokidar` dependency are deleted.

**Tech Stack:** TypeScript, esbuild, Node `http`/`crypto`, `node:test`, VS Code extension API.

**Spec:** `docs/superpowers/specs/2026-05-22-glance-in-process-http-server-design.md`

**Hard constraints:**
- Files under `src/server/` MUST NOT import `vscode` — they are compiled per-file and unit-tested under `node --test`. They receive everything they need via constructor callbacks.
- esbuild does not type-check; there is no `tsc` gate. Type errors will not fail the build, so type correctness must be verified by reading, not relied on from a compiler.
- Test files must be registered in **both** `esbuild.config.mjs::testEntries` and the `package.json` `test` script — there is no glob.

---

## Task 1: Verification spike — confirm Claude Code accepts an `http` MCP server

This is a manual gate. The whole plan depends on `claude --mcp-config` accepting a `type: "http"` MCP server. Do this first; do not start Task 2 until it passes.

**Files:**
- Create (throwaway, deleted at end of task): `/tmp/glance-spike/server.mjs`, `/tmp/glance-spike/mcp-config.json`

- [ ] **Step 1: Write a minimal HTTP MCP server**

Create `/tmp/glance-spike/server.mjs`:

```js
import http from 'node:http';

const TOOL = {
  name: 'update_state',
  description: 'Spike tool.',
  inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
};

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let rpc = {};
    try { rpc = JSON.parse(body); } catch {}
    console.log('SPIKE recv:', req.method, req.url, 'method=', rpc.method);
    const id = rpc.id ?? null;
    let result = null;
    if (rpc.method === 'initialize') {
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'spike', version: '0.0.1' },
      };
    } else if (rpc.method === 'tools/list') {
      result = { tools: [TOOL] };
    } else if (rpc.method === 'tools/call') {
      console.log('SPIKE tools/call args:', JSON.stringify(rpc.params?.arguments));
      result = { content: [{ type: 'text', text: 'ok' }] };
    } else if (rpc.method?.startsWith('notifications/')) {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
});
server.listen(0, '127.0.0.1', () => {
  console.log('SPIKE listening on port', server.address().port);
});
```

- [ ] **Step 2: Start the spike server**

Run: `node /tmp/glance-spike/server.mjs`
Expected: prints `SPIKE listening on port <N>`. Note the port `<N>`.

- [ ] **Step 3: Write the http MCP config**

Create `/tmp/glance-spike/mcp-config.json` (substitute the real `<N>`):

```json
{
  "mcpServers": {
    "glancer": {
      "type": "http",
      "url": "http://127.0.0.1:<N>/mcp"
    }
  }
}
```

- [ ] **Step 4: Launch Claude pointed at the http MCP server**

In a second terminal, run:
`claude --dangerously-skip-permissions --mcp-config /tmp/glance-spike/mcp-config.json -p "Call the glancer update_state tool with title set to hello, then stop."`

Expected: the spike server terminal prints `SPIKE recv:` lines including `method= initialize`, `method= tools/list`, and `method= tools/call` with `SPIKE tools/call args: {"title":"hello"}`.

- [ ] **Step 5: Record the outcome**

- If the `tools/call` line appears → **PASS**. Approach 1 is viable. Proceed to Task 2.
- If `claude` rejects the config, never connects, or no `tools/call` arrives → **FAIL**. Stop. Report to the requester; the fallback is Approach 2 (stdio shim) from spec §4 — the plan needs revision before continuing.
- Also note from the logs whether `claude` issued a `GET /mcp` (SSE stream attempt) or a `DELETE`. If it did and the spike still worked, no action needed. If it *required* a streamed response, record that — `GlanceServer` in Task 3 will need a GET handler returning an empty `text/event-stream`.

- [ ] **Step 6: Clean up**

Run: `rm -rf /tmp/glance-spike` and stop the spike server (Ctrl+C).
No commit — this task produces no repo changes.

---

## Task 2: `mcpHandler` — MCP JSON-RPC protocol module

Transport-free MCP protocol logic, lifted from `mcp-server.mjs`. No `vscode` import.

**Files:**
- Create: `src/server/mcpHandler.ts`
- Test: `src/server/mcpHandler.test.ts`
- Modify: `esbuild.config.mjs` (add to `testEntries`), `package.json` (add to `test` script)

- [ ] **Step 1: Write the failing test**

Create `src/server/mcpHandler.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpRequest, TOOLS } from './mcpHandler';

const noopCtx = { instructions: 'INSTR', applyState: () => {} };

test('initialize returns protocol version and instructions', () => {
  const res = handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }, noopCtx);
  const result = res?.result as Record<string, unknown>;
  assert.equal(res?.id, 1);
  assert.equal(result.protocolVersion, '2024-11-05');
  assert.equal(result.instructions, 'INSTR');
});

test('tools/list returns the update_state tool', () => {
  const res = handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, noopCtx);
  const result = res?.result as { tools: { name: string }[] };
  assert.equal(result.tools[0].name, 'update_state');
  assert.equal(TOOLS[0].name, 'update_state');
});

test('tools/call update_state forwards present args to applyState', () => {
  let captured: unknown;
  const res = handleMcpRequest(
    {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: {
        name: 'update_state',
        arguments: { title: 'T', tldr: 'D', progress: null, needsInput: null, error: null, skill: null },
      },
    },
    { instructions: '', applyState: (s) => { captured = s; } },
  );
  assert.deepEqual(captured, {
    title: 'T', tldr: 'D', progress: null, needsInput: null, error: null, skill: null,
  });
  const result = res?.result as { content: { text: string }[] };
  assert.equal(result.content[0].text, 'Agent card updated.');
});

test('tools/call with an unknown tool returns a JSON-RPC error', () => {
  const res = handleMcpRequest(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } },
    noopCtx,
  );
  assert.equal(res?.error?.code, -32601);
});

test('notifications return null (no reply)', () => {
  const res = handleMcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, noopCtx);
  assert.equal(res, null);
});
```

- [ ] **Step 2: Register the test in the build**

In `esbuild.config.mjs`, in the `testEntries` array, add these two lines after the `extractMarkers` block (they will be cleaned up alongside in Task 6):

```js
  'src/server/mcpHandler.ts',
  'src/server/mcpHandler.test.ts',
```

In `package.json`, append to the `test` script command:
` out/server/mcpHandler.test.js`

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm run build && pnpm run test`
Expected: FAIL — `Cannot find module './mcpHandler'` (the source does not exist yet).

- [ ] **Step 4: Write `src/server/mcpHandler.ts`**

Create `src/server/mcpHandler.ts`:

```ts
// MCP JSON-RPC protocol handler for the Glance in-process MCP server.
// Transport-free: GlanceServer feeds it parsed JSON-RPC requests plus an
// applyState callback; this module owns only MCP protocol semantics.
// MUST NOT import `vscode` — it is unit-tested under `node --test`.

const PROTOCOL_VERSION = '2024-11-05';
const TOOL_NAME = 'update_state';
const STATE_KEYS = ['title', 'tldr', 'progress', 'needsInput', 'error', 'skill'] as const;

/**
 * Shape Claude sends via `update_state`. All fields optional so partial
 * writes are permitted; absent = "leave alone", explicit null = "clear".
 */
export interface AgentState {
  title?: string | null;
  tldr?: string | null;
  progress?: { value: number; label: string } | null;
  needsInput?: string | null;
  error?: string | null;
  skill?: string | null;
}

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpContext {
  instructions: string;
  applyState: (state: AgentState) => void;
}

// The single tool Glance exposes. The `description` and `inputSchema` text
// below is the verbatim contract from the pre-existing
// `src/markers/mcp-server.mjs` (`TOOLS` array, lines 56-150) — keep it
// byte-identical so the model-facing behaviour does not change.
export const TOOLS = [
  {
    name: TOOL_NAME,
    description:
      'Update the Glance agent card — the small UI panel showing this ' +
      "session's title, TL;DR, progress bar, needs-input/error flags, and " +
      'active-skill pill. You MUST call this as the LAST action of EVERY ' +
      'response (short, long, trivial, or mid-tool-chain), with ALL SIX ' +
      'fields populated. Use real values for fields that apply this turn ' +
      'and explicit `null` for fields that do not (e.g. {progress: null} ' +
      "on a trivial greeting, {error: null} when nothing's broken, " +
      "{needsInput: null} when you're not waiting on the user, {skill: " +
      'null} when no Skill is loaded). Never omit a field — omitted ' +
      'fields preserve their prior value, which silently desyncs the card ' +
      "from what's actually happening this turn.",
    inputSchema: {
      type: 'object',
      required: ['title', 'tldr', 'progress', 'needsInput', 'error', 'skill'],
      properties: {
        title: {
          type: 'string',
          description:
            "2-4 word descriptive title derived from the user's first " +
            "prompt, mirroring the user's writing style. Match THEIR " +
            'casing: lowercase prompt → lowercase title; sentence case ' +
            'prompt → sentence case title; Title Case → Title Case. ' +
            'Always preserve proper nouns / acronyms in canonical ' +
            'capitalization (React, OAuth, S3, IPC). Drop emphasis ' +
            'markers (ALL CAPS, "PLEASE", exclamation points). On the ' +
            'first turn, set this via your VERY FIRST call to ' +
            'update_state (before any other tool use), then keep it ' +
            'IDENTICAL on every subsequent call — the title reflects the ' +
            'session, not the current message.',
        },
        tldr: {
          type: 'string',
          description:
            'One short speakable sentence (≤15 spoken seconds) summarizing ' +
            'the latest outcome. Plain prose for the ear; no code, no ' +
            'markdown, no quotes. Write as a direct status line, NOT ' +
            'third-person narration: "Running on Opus 4.7" rather than ' +
            '"Told the user I am running Opus 4.7"; "Refactored the auth ' +
            'flow" rather than "Helped the user refactor the auth flow". ' +
            'The reader IS the user — there is no third party to refer ' +
            'to. Update on every call.',
        },
        progress: {
          oneOf: [
            {
              type: 'object',
              required: ['value', 'label'],
              properties: {
                value: { type: 'number', minimum: 0, maximum: 1 },
                label: { type: 'string' },
              },
            },
            { type: 'null' },
          ],
          description:
            'Set during multi-step or non-trivial work (investigation, ' +
            'refactors, debugging). On the first message of a turn use a ' +
            'low starting value like 0.1; update on each meaningful ' +
            'transition (0.1 → 0.3 → 0.6 → 1). End the turn with ' +
            '{"value": 1, "label": "<terminal label>"}. Pass null on ' +
            'trivial turns (pure greetings, one-line answers).',
        },
        needsInput: {
          oneOf: [{ type: 'string' }, { type: 'null' }],
          description:
            'Short clause when your response ends awaiting a user reply ' +
            '(a yes/no, value, path, confirmation, pick between options). ' +
            'null otherwise.',
        },
        error: {
          oneOf: [{ type: 'string' }, { type: 'null' }],
          description:
            'Short clause when a hard failure blocks progress and the user ' +
            'must intervene. null for normal turns.',
        },
        skill: {
          oneOf: [{ type: 'string' }, { type: 'null' }],
          description:
            'Slug of the Skill currently driving this turn, when one is ' +
            'active — e.g. "test-driven-development", "claude-api", ' +
            '"debugging". Set the moment you invoke a Skill, keep it set ' +
            "while operating under that Skill's guidance, and pass null " +
            'once you move on to plain work. Display only — Glance renders ' +
            'it as a small pill on the card so the user can see what kind ' +
            'of work the session is currently doing. Use the bare skill ' +
            'slug (no `superpowers:` prefix).',
        },
      },
    },
  },
];

/**
 * Handle one JSON-RPC request. Returns the response object, or `null` for
 * notifications (which take no reply).
 */
export function handleMcpRequest(
  req: JsonRpcRequest,
  ctx: McpContext,
): JsonRpcResponse | null {
  const id = req.id ?? null;
  switch (req.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'glancer', version: '0.0.1' },
          instructions: ctx.instructions,
        },
      };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call': {
      const params = req.params ?? {};
      if (params.name !== TOOL_NAME) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `unknown tool: ${params.name}` },
        };
      }
      const args = params.arguments ?? {};
      const state: Record<string, unknown> = {};
      for (const key of STATE_KEYS) {
        if (key in args) state[key] = args[key];
      }
      ctx.applyState(state as AgentState);
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: 'Agent card updated.' }] },
      };
    }
    default:
      // Notifications (no reply) — `notifications/*` or any id-less message.
      if (req.method?.startsWith('notifications/')) return null;
      if (req.id === undefined) return null;
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `method not found: ${req.method}` },
      };
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm run build && pnpm run test`
Expected: PASS — all five `mcpHandler` tests green.

- [ ] **Step 6: Commit**

```bash
git add src/server/mcpHandler.ts src/server/mcpHandler.test.ts esbuild.config.mjs package.json
git commit -m "feat: add transport-free MCP JSON-RPC handler"
```

---

## Task 3: `GlanceServer` — localhost HTTP server

The HTTP transport: auth, routing, MCP and hook endpoints. No `vscode` import.

**Files:**
- Create: `src/server/GlanceServer.ts`
- Test: `src/server/GlanceServer.test.ts`
- Modify: `esbuild.config.mjs` (`testEntries`), `package.json` (`test` script)

- [ ] **Step 1: Write the failing test**

Create `src/server/GlanceServer.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { GlanceServer } from './GlanceServer';

function mkServer(over: Partial<{
  applyState: (id: string, s: unknown) => void;
  handleHook: (id: string, p: unknown) => void;
}> = {}) {
  return new GlanceServer({
    instructions: 'INSTR',
    applyState: over.applyState ?? (() => {}),
    handleHook: over.handleHook ?? (() => {}),
  });
}

test('rejects a request without the bearer token', async () => {
  const server = mkServer();
  await server.start();
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp/AG-01`, {
      method: 'POST', body: '{}',
    });
    assert.equal(res.status, 401);
  } finally {
    server.dispose();
  }
});

test('POST /mcp routes update_state to applyState with the agent id', async () => {
  let capturedId: string | undefined;
  let capturedState: { title?: string } | undefined;
  const server = mkServer({
    applyState: (id, s) => { capturedId = id; capturedState = s as { title?: string }; },
  });
  await server.start();
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp/AG-07`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: {
          name: 'update_state',
          arguments: { title: 'X', tldr: 'Y', progress: null, needsInput: null, error: null, skill: null },
        },
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(capturedId, 'AG-07');
    assert.equal(capturedState?.title, 'X');
  } finally {
    server.dispose();
  }
});

test('POST /hook routes the payload to handleHook', async () => {
  let capturedId: string | undefined;
  let capturedPayload: { hook_event_name?: string } | undefined;
  const server = mkServer({
    handleHook: (id, p) => { capturedId = id; capturedPayload = p as { hook_event_name?: string }; },
  });
  await server.start();
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/hook/AG-03`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: { hook_event_name: 'Stop' } }),
    });
    assert.equal(res.status, 204);
    assert.equal(capturedId, 'AG-03');
    assert.equal(capturedPayload?.hook_event_name, 'Stop');
  } finally {
    server.dispose();
  }
});

test('unknown path returns 404', async () => {
  const server = mkServer();
  await server.start();
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/nope`, {
      method: 'POST', headers: { Authorization: `Bearer ${server.token}` }, body: '{}',
    });
    assert.equal(res.status, 404);
  } finally {
    server.dispose();
  }
});
```

- [ ] **Step 2: Register the test in the build**

In `esbuild.config.mjs::testEntries`, add:

```js
  'src/server/GlanceServer.ts',
  'src/server/GlanceServer.test.ts',
```

In `package.json` `test` script, append: ` out/server/GlanceServer.test.js`

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm run build && pnpm run test`
Expected: FAIL — `Cannot find module './GlanceServer'`.

- [ ] **Step 4: Write `src/server/GlanceServer.ts`**

Create `src/server/GlanceServer.ts`:

```ts
// Localhost-only HTTP server hosted in the extension host. Claude connects
// to it as an `http`-type MCP server; `hook.mjs` POSTs hook events to it.
// MUST NOT import `vscode` — it is unit-tested under `node --test` and
// receives all extension state through constructor callbacks.

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { handleMcpRequest, type AgentState } from './mcpHandler';

export interface GlanceServerCallbacks {
  /** Glance system instructions returned in the MCP `initialize` response. */
  instructions: string;
  /** Apply an `update_state` payload to the given agent's card. */
  applyState: (agentId: string, state: AgentState) => void;
  /** Route a Claude Code hook event payload to the given agent. */
  handleHook: (agentId: string, payload: unknown) => void;
}

export class GlanceServer {
  private server: http.Server | null = null;
  private _port = 0;
  /** Per-activation bearer token; every request must present it. */
  readonly token = randomBytes(32).toString('hex');

  constructor(private readonly cb: GlanceServerCallbacks) {}

  get port(): number {
    return this._port;
  }

  /** Bind an ephemeral port on 127.0.0.1. Retries once on bind failure. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const attempt = (retriesLeft: number): void => {
        const server = http.createServer((req, res) => this.handle(req, res));
        const onError = (err: Error): void => {
          server.close();
          if (retriesLeft > 0) attempt(retriesLeft - 1);
          else reject(err);
        };
        server.once('error', onError);
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', onError);
          server.on('error', (e) => console.error('[glancer] server error', e));
          const addr = server.address();
          this._port = typeof addr === 'object' && addr ? addr.port : 0;
          this.server = server;
          resolve();
        });
      };
      attempt(1);
    });
  }

  dispose(): void {
    this.server?.close();
    this.server = null;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      res.writeHead(401).end();
      return;
    }
    const url = req.url ?? '';
    const mcpMatch = /^\/mcp\/([^/?]+)/.exec(url);
    const hookMatch = /^\/hook\/([^/?]+)/.exec(url);
    if (req.method !== 'POST' || (!mcpMatch && !hookMatch)) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        if (mcpMatch) this.handleMcp(mcpMatch[1], body, res);
        else if (hookMatch) this.handleHookRoute(hookMatch[1], body, res);
      } catch (err) {
        console.error('[glancer] server request failed', err);
        if (!res.headersSent) res.writeHead(500).end();
      }
    });
  }

  private handleMcp(agentId: string, body: string, res: http.ServerResponse): void {
    const response = handleMcpRequest(JSON.parse(body), {
      instructions: this.cb.instructions,
      applyState: (state) => this.cb.applyState(agentId, state),
    });
    if (response === null) {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  private handleHookRoute(agentId: string, body: string, res: http.ServerResponse): void {
    const parsed = JSON.parse(body) as { payload?: unknown };
    this.cb.handleHook(agentId, parsed.payload);
    res.writeHead(204).end();
  }
}
```

> If Task 1 Step 5 recorded that `claude` *requires* a `GET /mcp` SSE stream, add to `handle()`, before the `req.method !== 'POST'` check: `if (req.method === 'GET' && mcpMatch) { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); return; }` (leaves the stream open, sends nothing). Only add this if the spike showed it is needed.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm run build && pnpm run test`
Expected: PASS — all four `GlanceServer` tests green, plus `mcpHandler` from Task 2.

- [ ] **Step 6: Commit**

```bash
git add src/server/GlanceServer.ts src/server/GlanceServer.test.ts esbuild.config.mjs package.json
git commit -m "feat: add localhost HTTP server for MCP and hook delivery"
```

---

## Task 4: Rewire `Agent`, `AgentManager`, and `extension.ts` to the HTTP server

The integration task — these three files must change together to stay runtime-correct, so they share one commit. No new tests; verified by `pnpm run build`, the existing suite, and the Task 7 manual check.

**Files:**
- Modify: `src/agents/Agent.ts`
- Modify: `src/agents/AgentManager.ts`
- Modify: `src/extension.ts`

- [ ] **Step 1: `Agent.ts` — swap the `stateWatcher` import for `AgentState`**

In `src/agents/Agent.ts`, replace line 4:

```ts
import { watchState, type StateWatcher, type AgentState } from '../markers/stateWatcher';
```

with:

```ts
import type { AgentState } from '../server/mcpHandler';
```

- [ ] **Step 2: `Agent.ts` — update the `AgentInit` interface**

In the `AgentInit` interface, **remove** these two fields: `eventsDir: string;` and `hookScriptPath: string;`. **Change** `mcpConfigPath`'s doc-comment to read `Per-agent JSON file registering the Glance MCP server (http transport).` and **add** these fields after `mcpConfigPath`:

```ts
  /** The live in-process MCP/hook server — read at spawn time for port + token. */
  server: { readonly port: number; readonly token: string };
  /** Directory hook.mjs writes its debug log into. */
  logDir: string;
```

- [ ] **Step 3: `Agent.ts` — drop the `stateWatcher` field**

Remove the field declaration (line ~149): `private stateWatcher: StateWatcher;`

- [ ] **Step 4: `Agent.ts` — seed from the state file once instead of watching it**

Replace the constructor tail (lines ~256-261):

```ts
    // Always watch the state file. For dormant agents it reads back the
    // persisted markers from the last session. For live agents it picks up
    // updates from Claude's MCP tool calls.
    this.stateWatcher = watchState(this.stateFilePath, (state) =>
      this.applyState(state),
    );
  }
```

with:

```ts
    // Seed the card from the persisted state file once. Dormant agents
    // restore their last-known markers this way; live agents thereafter
    // receive updates directly via applyState() from the HTTP server.
    try {
      const raw = fs.readFileSync(this.stateFilePath, 'utf8').trim();
      if (raw.length > 0) this.applyState(JSON.parse(raw) as AgentState);
    } catch {
      // No prior state file — fresh agent. Expected.
    }
  }
```

- [ ] **Step 5: `Agent.ts` — make `applyState` public**

Change the method signature (line ~791) from `private applyState(s: AgentState): void {` to `applyState(s: AgentState): void {`.

- [ ] **Step 6: `Agent.ts` — drop the `stateWatcher.dispose()` call**

In `dispose()` (line ~762), remove the line `this.stateWatcher.dispose();`.

- [ ] **Step 7: `Agent.ts` — write the per-agent config and new env in `spawn()`**

In `spawn()`, immediately after `const init = this.init;` (line ~272), insert:

```ts
    // Write this agent's MCP config: an http-transport server entry pointing
    // at the extension's in-process GlanceServer, scoped to this agent id.
    const mcpConfig = {
      mcpServers: {
        glancer: {
          type: 'http',
          url: `http://127.0.0.1:${init.server.port}/mcp/${init.id}`,
          headers: { Authorization: `Bearer ${init.server.token}` },
        },
      },
    };
    try {
      fs.writeFileSync(init.mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
    } catch (err) {
      console.warn('[glancer] failed to write mcp config', err);
    }
```

Then replace the `env` block of the `createClaudePty` call (lines ~292-300):

```ts
      env: {
        ...process.env,
        GLANCER_AGENT_ID: init.id,
        GLANCER_EVENTS_DIR: init.eventsDir,
        GLANCER_HOOK_SCRIPT: init.hookScriptPath,
        GLANCER_STATE_FILE: this.stateFilePath,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
```

with:

```ts
      env: {
        ...process.env,
        GLANCER_HOOK_URL: `http://127.0.0.1:${init.server.port}/hook/${init.id}`,
        GLANCER_TOKEN: init.server.token,
        GLANCER_LOG_DIR: init.logDir,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
```

- [ ] **Step 8: `AgentManager.ts` — swap the `chokidar` import for `GlanceServer`**

In `src/agents/AgentManager.ts`, remove line 4 (`import chokidar, { type FSWatcher } from 'chokidar';`) and add:

```ts
import { GlanceServer } from '../server/GlanceServer';
import type { AgentState } from '../server/mcpHandler';
```

- [ ] **Step 9: `AgentManager.ts` — replace watcher/path fields with the server field**

Remove these five field declarations (all are made dead by Step 10 / Step 14): `private readonly mcpConfigPath: string;`, `private readonly mcpServerPath: string;`, `private readonly instructionsPath: string;`, `private readonly eventsDir: string;`, and `private readonly eventsWatcher: FSWatcher;`. Add:

```ts
  private readonly glanceServer: GlanceServer;
```

- [ ] **Step 10: `AgentManager.ts` — gut the constructor's file/watcher setup**

In the constructor, **delete** the `mcp-server.mjs` copy block (lines ~121-133, `this.mcpServerPath = ...` through its `catch`). **Delete** the `glancer-instructions.txt` block (lines ~172-173, `this.instructionsPath = ...` and the `writeFileSync`). **Delete** the entire global `mcp-config.json` write (lines ~175-198, `this.mcpConfigPath = ...` through its closing `);`). **Delete** the events-watcher block (lines ~200-211, `this.eventsWatcher = chokidar.watch(...)` through the `.on('error', ...)` call).

Then **delete** the `eventsDir` setup (lines ~100-101, `this.eventsDir = path.join(dataDir, 'events');` and its `mkdirSync`) — it is no longer used.

In its place, after the `this.stateDir` setup (line ~108), construct the server:

```ts
    // In-process HTTP server: Claude's update_state MCP calls and Claude
    // Code hook events POST directly here — no files, no chokidar.
    this.glanceServer = new GlanceServer({
      instructions: summarySystemPrompt(''),
      applyState: (agentId, state) => this.applyAgentState(agentId, state),
      handleHook: (agentId, payload) => this.handleHookEvent(agentId, payload),
    });
```

> Note: `this.eventsDir`, `this.mcpConfigPath`, `this.mcpServerPath`, `this.instructionsPath` are now all removed. If any other line in `AgentManager.ts` still references them, the build's bundler step will surface it — fix each by deleting the reference (none are expected outside the constructor and `makeAgent`).

- [ ] **Step 11: `AgentManager.ts` — add an async `start()` method**

Add this public method to the `AgentManager` class (place it just after the constructor):

```ts
  /**
   * Start the in-process HTTP server. Must be awaited during extension
   * activation, before any agent can spawn — `Agent.spawn()` reads the
   * server's port at spawn time.
   */
  async start(): Promise<void> {
    try {
      await this.glanceServer.start();
    } catch (err) {
      console.error('[glancer] HTTP server failed to start', err);
      void vscode.window.showErrorMessage(
        'Glance: status server failed to start — agent cards will not update.',
      );
    }
  }
```

- [ ] **Step 12: `AgentManager.ts` — add `applyAgentState`**

Add this method to the `AgentManager` class:

```ts
  /**
   * Apply an MCP `update_state` payload: update the live card immediately,
   * and persist a merged snapshot to state/<id>.json so a dormant restore
   * re-seeds correctly. Called by GlanceServer on every update_state call.
   */
  private applyAgentState(agentId: string, state: AgentState): void {
    const agent = this.agents.get(agentId);
    if (!(agent instanceof Agent)) return;
    agent.applyState(state);
    const file = path.join(this.stateDir, `${agentId}.json`);
    let prev: Record<string, unknown> = {};
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (raw.length > 0) prev = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // First write for this agent — expected.
    }
    const merged: Record<string, unknown> = { ...prev };
    for (const key of ['title', 'tldr', 'progress', 'needsInput', 'error', 'skill']) {
      if (key in state) merged[key] = (state as Record<string, unknown>)[key];
    }
    try {
      fs.writeFileSync(file, JSON.stringify(merged, null, 2));
    } catch (err) {
      console.warn('[glancer] state persist failed', err);
    }
  }
```

- [ ] **Step 13: `AgentManager.ts` — change `handleHookEvent` to take `(agentId, payload)`**

Replace the `handleHookEvent` signature and its file-reading preamble. The current method (lines ~1095-1132) starts:

```ts
  private handleHookEvent(filePath: string): void {
    let payload: unknown;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      payload = JSON.parse(raw);
    } catch (err) {
      console.warn('[glancer] failed to read hook event', filePath, err);
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
      payload?: {
        hook_event_name?: string;
        session_id?: string;
        prompt?: string;
        message?: string;
        source?: 'startup' | 'resume' | 'clear' | 'compact';
      };
    };
    const agentId = wrapper.agentId;
    const hookEvent = wrapper.payload?.hook_event_name;
    const sessionId = wrapper.payload?.session_id;
    if (!agentId) return;
    const agent = this.agents.get(agentId);
```

Replace that entire span (from `private handleHookEvent(filePath: string): void {` through `const agent = this.agents.get(agentId);`) with:

```ts
  private handleHookEvent(agentId: string, payload: unknown): void {
    if (typeof payload !== 'object' || payload === null) return;
    const evt = payload as {
      hook_event_name?: string;
      session_id?: string;
      prompt?: string;
      message?: string;
      source?: 'startup' | 'resume' | 'clear' | 'compact';
    };
    const hookEvent = evt.hook_event_name;
    const sessionId = evt.session_id;
    const agent = this.agents.get(agentId);
```

Then, in the rest of the method body, replace every remaining `wrapper.payload` with `evt` (the `SessionStart` `source` read at line ~1150 becomes `evt.source`; the `Notification` branch's `const payload = wrapper.payload as ...` at line ~1183 becomes `const note = evt as { message?: string }` and the following `payload?.message` becomes `note.message`).

- [ ] **Step 14: `AgentManager.ts` — update `makeAgent` to pass the new `AgentInit`**

In `makeAgent` (lines ~644-658), replace the `new Agent({ ... })` field list. Remove `eventsDir: this.eventsDir,` and `hookScriptPath: this.hookScriptPath,`. Change `mcpConfigPath` and add `server` + `logDir`:

```ts
    const agent = new Agent({
      id: opts.id,
      cwd: opts.cwd,
      model: opts.model,
      hookSettingsPath: this.hookSettingsPath,
      mcpConfigPath: path.join(this.storageDir, `mcp-config-${opts.id}.json`),
      server: this.glanceServer,
      logDir: this.storageDir,
      stateFilePath: path.join(this.stateDir, `${opts.id}.json`),
      dormant: opts.dormant,
      sessionId: opts.sessionId,
      initialSnapshot: opts.initialSnapshot,
      hasUserPrompt: opts.hasUserPrompt,
      pinned: opts.pinned,
    });
```

- [ ] **Step 15: `AgentManager.ts` — close the server in `dispose()`**

In `dispose()`, replace the line `this.eventsWatcher.close();` (line ~1205) with `this.glanceServer.dispose();`.

- [ ] **Step 16: `extension.ts` — start the server before anything spawns**

In `src/extension.ts`, change the activate signature from `export function activate(context: vscode.ExtensionContext): void {` to `export async function activate(context: vscode.ExtensionContext): Promise<void> {`.

Then, immediately after `manager = new AgentManager({ context });` (line ~19), add:

```ts
  await manager.start();
```

- [ ] **Step 17: Build and run the existing tests**

Run: `pnpm run build && pnpm run test`
Expected: build succeeds; all tests pass (no test covers this wiring directly — it is verified manually in Task 7). If the build's bundle step reports an unresolved reference to a removed field/import, fix it by deleting that reference.

- [ ] **Step 18: Commit**

```bash
git add src/agents/Agent.ts src/agents/AgentManager.ts src/extension.ts
git commit -m "feat: route MCP state and hooks through the in-process HTTP server"
```

---

## Task 5: Rewrite `hook.mjs` to POST over HTTP

**Files:**
- Modify (full rewrite): `src/markers/hook.mjs`

- [ ] **Step 1: Replace `src/markers/hook.mjs` entirely**

Overwrite `src/markers/hook.mjs` with:

```js
#!/usr/bin/env node
// Invoked by Claude Code's hook system. Receives the event JSON on stdin and
// POSTs it to the Glance extension's in-process HTTP server.
//
// Never throws and never blocks Claude's turn — failure here is silent
// (recorded in the log). Retries a failed POST twice with backoff.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function log(line) {
  try {
    const dir = process.env.GLANCER_LOG_DIR;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'hook.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* never throw */
  }
}

async function postWithRetry(url, token, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) return true;
      log(`POST attempt ${attempt} got HTTP ${res.status}`);
    } catch (err) {
      log(`POST attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
  }
  return false;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', async () => {
  try {
    const payload = JSON.parse(raw);
    log(`event ${payload?.hook_event_name ?? '?'} session=${payload?.session_id ?? '?'}`);

    // For UserPromptSubmit, stdout text is injected as additional context for
    // the model (silent — not echoed in the terminal). Nudge the turn toward
    // calling update_state. Emitted regardless of POST success.
    if (payload?.hook_event_name === 'UserPromptSubmit') {
      process.stdout.write('Glance: end this turn with mcp__glancer__update_state.');
    }

    const url = process.env.GLANCER_HOOK_URL;
    const token = process.env.GLANCER_TOKEN;
    if (!url || !token) {
      log('skipping POST: GLANCER_HOOK_URL / GLANCER_TOKEN missing');
      process.exit(0);
    }
    const ok = await postWithRetry(url, token, JSON.stringify({ payload }));
    log(ok ? 'POST ok' : 'POST failed after retries');
  } catch (err) {
    log(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(0);
});
```

- [ ] **Step 2: Build**

Run: `pnpm run build`
Expected: build succeeds; `copyStatic()` copies the new `hook.mjs` to `out/markers/hook.mjs`.

- [ ] **Step 3: Commit**

```bash
git add src/markers/hook.mjs
git commit -m "feat: POST hook events to the HTTP server instead of writing files"
```

---

## Task 6: Delete `mcp-server.mjs`, the legacy chokidar code, and the dependency

**Files:**
- Delete: `src/markers/mcp-server.mjs`, `src/markers/stateWatcher.ts`, `src/markers/transcriptWatcher.ts`, `src/markers/transcriptWatcher.test.ts`, `src/markers/extractMarkers.ts`, `src/markers/extractMarkers.test.ts`
- Modify: `esbuild.config.mjs`, `package.json`

- [ ] **Step 1: Confirm the legacy modules are unreferenced**

Run: `grep -rn "transcriptWatcher\|extractMarkers\|stateWatcher\|mcp-server" src/`
Expected: matches only inside the six files about to be deleted (and comments). If `extension.ts`, `Agent.ts`, or `AgentManager.ts` still reference any of them, stop and fix that reference first — Task 4 should already have removed the `Agent.ts` `stateWatcher` import.

- [ ] **Step 2: Delete the files**

```bash
git rm src/markers/mcp-server.mjs \
       src/markers/stateWatcher.ts \
       src/markers/transcriptWatcher.ts src/markers/transcriptWatcher.test.ts \
       src/markers/extractMarkers.ts src/markers/extractMarkers.test.ts
```

- [ ] **Step 3: Update `esbuild.config.mjs`**

In `testEntries`, remove these four lines:

```js
  'src/markers/extractMarkers.ts',
  'src/markers/extractMarkers.test.ts',
  'src/markers/transcriptWatcher.ts',
  'src/markers/transcriptWatcher.test.ts',
```

In `copyStatic()`, remove the `mcp-server.mjs` copy block:

```js
  if (fs.existsSync('src/markers/mcp-server.mjs')) {
    fs.copyFileSync('src/markers/mcp-server.mjs', 'out/markers/mcp-server.mjs');
    fs.chmodSync('out/markers/mcp-server.mjs', 0o755);
  }
```

- [ ] **Step 4: Update `package.json`**

In the `test` script, remove `out/markers/extractMarkers.test.js` and `out/markers/transcriptWatcher.test.js` from the command. The script should now begin: `node --test out/agents/sessionScanner.test.js ...` and include the `out/server/mcpHandler.test.js` and `out/server/GlanceServer.test.js` entries added in Tasks 2-3.

In `dependencies`, remove the line `"chokidar": "^3.6.0",`.

- [ ] **Step 5: Refresh the lockfile and rebuild**

Run: `pnpm install && pnpm run build && pnpm run test`
Expected: `pnpm install` removes `chokidar` from `pnpm-lock.yaml`; build succeeds; all tests pass (`mcpHandler`, `GlanceServer`, and the surviving `agents/` + `view/` suites).

- [ ] **Step 6: Confirm `chokidar` is fully gone**

Run: `grep -rn "chokidar" src/ package.json`
Expected: no matches.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: delete mcp-server.mjs, legacy chokidar watchers, and the dependency"
```

---

## Task 7: Manual end-to-end verification

No automated test covers the PTY + VS Code wiring; verify it by hand.

**Files:** none.

- [ ] **Step 1: Build and launch the Extension Development Host**

Run: `pnpm run build`, then F5 in VS Code (or launch the Extension Development Host for this folder).

- [ ] **Step 2: Spawn an agent and run a multi-step turn**

In the Glance panel, press `g` to spawn an agent. In its terminal, give Claude a task that runs several steps (e.g. "read three files in this repo and summarise each").

Expected:
- The card title, TL;DR, and progress bar update **live** as Claude works.
- While Claude is working the card shows the working indicator (not the green check).
- When the turn ends the card shows the green check (`✓`).

- [ ] **Step 3: Verify the working/done indicator across a turn boundary**

Send a second prompt to the same agent.
Expected: the card flips from `✓` back to the working indicator **immediately** on submit (the `UserPromptSubmit` hook POST), and back to `✓` when the turn ends (the `Stop` hook POST). This is the stale-`✓` bug from the spec §1 — confirm it no longer reproduces.

- [ ] **Step 4: Verify dormant restore**

Reload the Extension Development Host window (Cmd+R). 
Expected: the agent card reappears as a dormant card showing its last-known title/TL;DR (seeded from `state/<id>.json`). Click it — it revives, spawns `claude --resume`, and resumes updating live.

- [ ] **Step 5: Inspect the hook log**

Open `hook.log` in the extension's global storage directory (`GLANCER_LOG_DIR`).
Expected: lines reading `POST ok` for hook events. No `POST failed` lines under normal operation.

- [ ] **Step 6: Bump the version and update the changelog**

In `package.json`, increment `version` (e.g. `0.0.28` → `0.0.29`). Add a `CHANGELOG.md` entry describing the in-process HTTP server change. (Marketplace publishing itself is a separate release step — see the `releasing-glance` skill — and is out of scope here.)

- [ ] **Step 7: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "chore: bump version for in-process HTTP server"
```

---

## Done

The card pipeline now has no files in the live path and no `chokidar`. `update_state` calls and hook events POST directly into the extension host. The stale-`✓` bug — caused by lost file-drop hook events — is structurally eliminated.
