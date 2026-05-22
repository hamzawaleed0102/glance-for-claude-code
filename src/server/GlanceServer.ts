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
    // Streamable HTTP clients may open a GET stream for server-initiated
    // messages. Glance never sends any, so per the MCP spec we answer 405
    // Method Not Allowed rather than holding a stream open.
    if (req.method === 'GET' && mcpMatch) {
      res.writeHead(405).end();
      return;
    }
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
