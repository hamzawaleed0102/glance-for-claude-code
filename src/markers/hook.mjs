#!/usr/bin/env node
// Invoked by Claude Code's hook system. Receives the event JSON on stdin;
// writes one JSON file per event into GLANCER_EVENTS_DIR for the extension
// host to pick up. Also appends to a log file for debugging.
//
// Never throws and never blocks Claude's turn — failure here must be silent
// (but is recorded in the log).

import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

function log(line) {
  try {
    const dir = process.env.GLANCER_EVENTS_DIR;
    if (!dir) return;
    mkdirSync(dirname(dir), { recursive: true });
    appendFileSync(join(dirname(dir), 'hook.log'), `${new Date().toISOString()} ${line}\n`);
  } catch { /* never throw */ }
}

log(`hook.mjs invoked pid=${process.pid} agentId=${process.env.GLANCER_AGENT_ID ?? '<unset>'} eventsDir=${process.env.GLANCER_EVENTS_DIR ?? '<unset>'}`);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(raw);
    const agentId = process.env.GLANCER_AGENT_ID;
    const eventsDir = process.env.GLANCER_EVENTS_DIR;
    log(`event ${payload?.hook_event_name ?? '?'} session=${payload?.session_id ?? '?'} agent=${agentId ?? '?'}`);
    if (!agentId || !eventsDir) {
      log('skipping write: env vars missing');
      process.exit(0);
    }
    const filename = `${Date.now()}-${process.pid}.json`;
    const out = join(eventsDir, filename);
    mkdirSync(eventsDir, { recursive: true });
    writeFileSync(out, JSON.stringify({ agentId, payload }) + '\n');
    log(`wrote ${out}`);
  } catch (err) {
    log(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(0);
});
