import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { OldSession } from '../shared/messages';

export type { OldSession };

const MAX_PROMPT_CHARS = 200;
const MAX_SCAN_LINES = 200;

/**
 * Convert an absolute filesystem path into the slug Claude Code uses
 * for its per-project directory under ~/.claude/projects/. Verified
 * against the actual directory layout: every `/` becomes `-`, dots
 * and other characters pass through unchanged.
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

/**
 * List Claude Code sessions for `cwd`, omitting any session whose id is
 * in `excludeSessionIds`. Reads ~/.claude/projects/<encoded-cwd>/*.jsonl,
 * extracting the first user-typed prompt (truncated to 200 chars) and
 * the file mtime. Returns sorted by mtimeMs descending.
 *
 * Failure modes are silent: missing dir, unreadable files, malformed
 * JSONL lines — each yields the safest fallback (empty list, skipped
 * file, skipped line). Throwing here would break the picker; the user
 * just sees a shorter list.
 */
export async function listOldSessions(
  cwd: string,
  excludeSessionIds: Set<string>,
): Promise<OldSession[]> {
  const projectDir = path.join(
    os.homedir(),
    '.claude',
    'projects',
    encodeCwd(cwd),
  );

  let entries: string[];
  try {
    entries = fs.readdirSync(projectDir);
  } catch {
    return [];
  }

  const candidates = entries
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => ({ name, sessionId: name.slice(0, -'.jsonl'.length) }))
    .filter((c) => !excludeSessionIds.has(c.sessionId));

  const results = await Promise.all(
    candidates.map(async ({ name, sessionId }) => {
      const filePath = path.join(projectDir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(filePath).mtimeMs;
      } catch {
        return null;
      }
      let firstPrompt: string | null = null;
      try {
        firstPrompt = await readFirstUserPrompt(filePath);
      } catch (err) {
        console.warn('[glancer] scanner: failed to read', filePath, err);
      }
      // `name` is filled in later by AgentManager from sessions.json —
      // the scanner has no access to Glance's title bookkeeping.
      const session: OldSession = { sessionId, firstPrompt, name: null, mtimeMs };
      return session;
    }),
  );

  return results
    .filter((r): r is OldSession => r !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Stream the JSONL line-by-line until we hit the first record that
 * qualifies as a user-authored prompt, or until MAX_SCAN_LINES is
 * exhausted. Returns the trimmed + truncated content, or null if
 * nothing qualifies. The early-stop avoids reading multi-MB transcripts
 * end-to-end just to surface their first prompt.
 */
function readFirstUserPrompt(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let scanned = 0;
    let found: string | null = null;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      rl.close();
      stream.destroy();
      resolve(found);
    };

    rl.on('line', (line) => {
      scanned++;
      if (scanned > MAX_SCAN_LINES) {
        finish();
        return;
      }
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        return; // skip malformed line
      }
      const prompt = extractPrompt(record);
      if (prompt !== null) {
        found = prompt;
        finish();
      }
    });
    rl.on('close', () => finish());
    rl.on('error', () => finish());
    stream.on('error', () => finish());
  });
}

/**
 * Tag prefixes that Claude Code injects into user records when the user
 * invokes a slash command (or its harness emits a caveat). They are not
 * user-authored prompts — surfacing them in the picker shows noise like
 * "<command-name>/clear</command-name>" instead of the real first ask
 * that usually follows in the next record.
 */
const SLASH_COMMAND_TAG_PREFIXES = [
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<command-name>',
  '<command-message>',
  '<command-args>',
];

function extractPrompt(record: unknown): string | null {
  if (typeof record !== 'object' || record === null) return null;
  const r = record as {
    type?: unknown;
    isMeta?: unknown;
    message?: { content?: unknown };
  };
  if (r.type !== 'user') return null;
  if (r.isMeta === true) return null;
  const content = r.message?.content;
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  if (!trimmed) return null;
  for (const prefix of SLASH_COMMAND_TAG_PREFIXES) {
    if (trimmed.startsWith(prefix)) return null;
  }
  return trimmed.slice(0, MAX_PROMPT_CHARS);
}
