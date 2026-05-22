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

test('an unknown method returns a method-not-found error', () => {
  const res = handleMcpRequest({ jsonrpc: '2.0', id: 9, method: 'bogus/method' }, noopCtx);
  assert.equal(res?.error?.code, -32601);
});
