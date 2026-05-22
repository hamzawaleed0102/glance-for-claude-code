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

test('GET /mcp returns 405 (no server-initiated stream)', async () => {
  const server = mkServer();
  await server.start();
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp/AG-01`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${server.token}` },
    });
    assert.equal(res.status, 405);
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
