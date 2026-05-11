import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import chokidar, { type FSWatcher } from 'chokidar';

/**
 * Walk the JSONL bottom-up, find the last well-formed assistant record,
 * return its concatenated text content. Resilient to a partial trailing line
 * (transcripts are appended live).
 */
export function lastAssistantText(jsonl: string): string {
  const lines = jsonl.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      typeof rec !== 'object' ||
      rec === null ||
      (rec as { role?: unknown }).role !== 'assistant'
    ) {
      continue;
    }
    const content = (rec as { content?: unknown }).content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((b) =>
          typeof b === 'object' && b && (b as { type?: string }).type === 'text'
            ? String((b as { text?: string }).text ?? '')
            : '',
        )
        .join('');
    }
    return '';
  }
  return '';
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
    watcher = chokidar.watch(filePath, { persistent: true });
    const read = () => {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        onText(lastAssistantText(raw));
      } catch {
        // file may not exist yet
      }
    };
    watcher.on('add', read);
    watcher.on('change', read);
  };

  const tryDiscover = () => {
    if (disposed) return;
    const p = findInProjects(sessionId) ?? findInSessions(sessionId);
    if (p) {
      attach(p);
      return;
    }
    if (Date.now() >= discoveryDeadline) return;
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
