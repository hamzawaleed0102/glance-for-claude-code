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
