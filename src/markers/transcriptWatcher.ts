import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import chokidar, { type FSWatcher } from 'chokidar';

/**
 * Walk the JSONL bottom-up and return the **concatenated text of every
 * assistant message in the current turn**, in chronological order, separated
 * by blank lines.
 *
 * "Current turn" = everything from the most recent real user prompt down to
 * the end of the file. Tool-result user messages (content is an array of
 * `tool_result` blocks with no text) are NOT turn boundaries — they live
 * inside the turn alongside the assistant's tool-use messages. Only a user
 * message that carries text (a string `content`, or an array containing a
 * `type:"text"` block) terminates the walk.
 *
 * Why concatenate instead of "last message"? When Claude makes one or more
 * tool calls, a single turn spans several assistant messages. The `🏷️ Title:`
 * marker sits on the FIRST assistant message; the tail markers (TL;DR,
 * Progress, etc.) sit on the LAST. Returning only the last message loses the
 * title. By concatenating, head-scan finds the title near the top, tail-scan
 * finds the other markers near the bottom — both work.
 *
 * Claude Code's JSONL records look like:
 *   { "type": "assistant", "message": { "role": "assistant", "content": [...] }, ... }
 * Older Anthropic-API-shaped records use { "role": "assistant", "content": "..." }
 * — we accept both.
 *
 * Resilient to a partial trailing line (transcripts are appended live).
 */
export function lastAssistantText(jsonl: string): string {
  const lines = jsonl.split('\n');
  const collected: string[] = [];

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof rec !== 'object' || rec === null) continue;
    const top = rec as { type?: unknown; role?: unknown; content?: unknown; message?: unknown };

    // Resolve the "message body" — either a nested `message` object or the
    // record itself when the schema is flat. Anything without a role/content
    // shape (system events, sidecar metadata) is skipped.
    let body: { role?: unknown; content?: unknown } | null = null;
    if (typeof top.message === 'object' && top.message !== null) {
      body = top.message as { role?: unknown; content?: unknown };
    } else if (top.role !== undefined || top.content !== undefined) {
      body = top as { role?: unknown; content?: unknown };
    }
    if (!body) continue;

    if (body.role === 'user') {
      // Real user prompts terminate the walk; tool_result user messages do
      // not. Distinguish by content shape: a string or a text block means
      // it's a prompt the human typed.
      const c = body.content;
      const hasText =
        (typeof c === 'string' && c.trim().length > 0) ||
        (Array.isArray(c) &&
          c.some(
            (b) =>
              typeof b === 'object' &&
              b !== null &&
              (b as { type?: string }).type === 'text',
          ));
      if (hasText) break;
      continue;
    }

    if (body.role !== 'assistant' && top.type !== 'assistant') continue;

    const content = body.content;
    let text = '';
    if (typeof content === 'string' && content.length > 0) {
      text = content;
    } else if (Array.isArray(content)) {
      // Only `type: "text"` blocks carry user-facing prose. `thinking` and
      // `tool_use` blocks are intermediate-turn artifacts — skip them.
      text = content
        .map((b) =>
          typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text'
            ? String((b as { text?: string }).text ?? '')
            : '',
        )
        .join('');
    }
    if (text.length > 0) collected.unshift(text);
  }

  return collected.join('\n\n');
}

function findInProjects(sessionId: string): string | null {
  const root = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(root)) return null;
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const sub of entries) {
    const candidate = path.join(root, sub, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findInSessions(sessionId: string): string | null {
  const p = path.join(os.homedir(), '.claude', 'sessions', sessionId, 'transcript.jsonl');
  return fs.existsSync(p) ? p : null;
}

export interface TranscriptWatcher {
  dispose(): void;
}

export function watchTranscript(
  sessionId: string,
  onText: (text: string) => void,
  opts?: { discoveryTimeoutMs?: number },
): TranscriptWatcher {
  const timeoutMs = opts?.discoveryTimeoutMs ?? 3000;
  let watcher: FSWatcher | null = null;
  let disposed = false;
  const discoveryDeadline = Date.now() + timeoutMs;
  let discoveryTimer: NodeJS.Timeout | null = null;

  const attach = (filePath: string) => {
    watcher = chokidar.watch(filePath, {
      persistent: true,
      usePolling: true,
      interval: 250,
    });
    const read = (label: string) => {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const text = lastAssistantText(raw);
        onText(text);
      } catch (err) {
        console.warn('[glancer] transcriptWatcher: read failed', err);
      }
    };
    watcher.on('add', () => read('add'));
    watcher.on('change', () => read('change'));
    watcher.on('ready', () => read('ready-initial'));
    watcher.on('error', (err) => console.error('[glancer] transcriptWatcher error', err));
  };

  const tryDiscover = () => {
    if (disposed) return;
    const p = findInProjects(sessionId) ?? findInSessions(sessionId);
    if (p) {
      attach(p);
      return;
    }
    if (Date.now() >= discoveryDeadline) {
      console.warn(`[glancer] transcriptWatcher: gave up looking for session ${sessionId}`);
      return;
    }
    discoveryTimer = setTimeout(tryDiscover, 200);
  };

  tryDiscover();

  return {
    dispose() {
      disposed = true;
      if (discoveryTimer) clearTimeout(discoveryTimer);
      watcher?.close();
    },
  };
}
