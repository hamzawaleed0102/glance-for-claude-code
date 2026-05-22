import test from 'node:test';
import assert from 'node:assert/strict';
import { postWithRetry } from './hook.mjs';

// Swap global fetch for a stub for the duration of `fn`, then restore it.
async function withFetch(stub, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

test('postWithRetry returns true on a 2xx response in one attempt', async () => {
  let calls = 0;
  await withFetch(
    async () => { calls++; return { ok: true, status: 204 }; },
    async () => {
      const ok = await postWithRetry('http://127.0.0.1/hook', 'tok', '{}');
      assert.equal(ok, true);
      assert.equal(calls, 1);
    },
  );
});

test('postWithRetry gives up (false) after 3 failed attempts', async () => {
  let calls = 0;
  await withFetch(
    async () => { calls++; throw new Error('connection refused'); },
    async () => {
      const ok = await postWithRetry('http://127.0.0.1/hook', 'tok', '{}');
      assert.equal(ok, false);
      assert.equal(calls, 3);
    },
  );
});

test('postWithRetry succeeds once a later attempt returns 2xx', async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      if (calls < 3) throw new Error('boom');
      return { ok: true, status: 204 };
    },
    async () => {
      const ok = await postWithRetry('http://127.0.0.1/hook', 'tok', '{}');
      assert.equal(ok, true);
      assert.equal(calls, 3);
    },
  );
});

test('postWithRetry treats a non-2xx response as a failed attempt', async () => {
  let calls = 0;
  await withFetch(
    async () => { calls++; return { ok: false, status: 500 }; },
    async () => {
      const ok = await postWithRetry('http://127.0.0.1/hook', 'tok', '{}');
      assert.equal(ok, false);
      assert.equal(calls, 3);
    },
  );
});
