#!/usr/bin/env node
// Invoked by Claude Code's hook system on Stop / UserPromptSubmit / Notification /
// SessionStart events. Receives the event JSON on stdin; writes one JSON file per
// event into GLANCER_EVENTS_DIR for the extension host to pick up.
//
// Never throws and never blocks Claude's turn — failure here must be silent.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(raw);
    const agentId = process.env.GLANCER_AGENT_ID;
    const eventsDir = process.env.GLANCER_EVENTS_DIR;
    if (!agentId || !eventsDir) {
      process.exit(0);
    }
    const filename = `${Date.now()}-${process.pid}.json`;
    writeFileSync(
      join(eventsDir, filename),
      JSON.stringify({ agentId, payload }) + '\n',
    );
  } catch {
    // Silent — never block Claude.
  }
  process.exit(0);
});
