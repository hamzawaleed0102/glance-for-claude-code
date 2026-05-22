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
