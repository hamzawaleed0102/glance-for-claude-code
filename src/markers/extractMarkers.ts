/**
 * Pure marker extractor for the five Glancer-specific markers:
 *
 *   🏷️ Title:        — head-anchored (first non-empty line, first response only)
 *   🔊 TL;DR:         — tail-anchored
 *   ⚠️ Needs input:   — tail-anchored
 *   ❌ Error:         — tail-anchored
 *   📊 Progress:      — tail-anchored
 *
 * The title is emitted at the START of the first response so the agent card
 * updates immediately when Claude begins streaming, rather than waiting for
 * the response to finish. We look at the first non-empty line for it.
 *
 * The other four markers are TAIL-ANCHORED — we walk lines from the bottom
 * up, accepting marker-shaped lines, and STOP the moment we hit a non-empty
 * non-marker line. So a `🔊 TL;DR: …` quoted inside a code review body is
 * never picked up — only the marker Claude appended at the end.
 *
 * The five regexes are deliberately whole-line (anchored with `^…$`) so a
 * single line can match at most one marker. The tail-scan ALSO accepts a
 * Title line as a fallback, in case Claude tail-emits it (older behavior).
 */
export interface MarkerSet {
  tldr?: string;
  title?: string;
  /**
   * `string` — marker present at the tail of the scanned message.
   * `null` — caller has confirmed the message was scanned in full and the
   *   marker is absent.
   * `undefined` — not inspected; caller leaves prior value untouched.
   */
  needsInput?: string | null;
  error?: string | null;
  progress?: { value: number; label: string } | null;
}

// Emoji presentation selectors (U+FE0F) are optional in Unicode; the model
// sometimes emits the bare base codepoint without the selector. The regexes
// treat the selector as optional so neither form silently misses. We also
// allow common markdown wrappers (`**`, `> `, `# `, list bullets) and leading
// whitespace, since Claude occasionally emits the title under a heading or
// inside emphasis.
const LINE_PREFIX = /^[\s#>*_\-]*\**\s*/u;
const TRAIL_EMPHASIS = /\s*\**\s*$/u;
const TLDR_LINE = /^🔊️?\s*TL;DR\s*:\s*(.+?)\s*$/u;
const TITLE_LINE = /^🏷️?\s*\**\s*Title\s*\**\s*:\s*\**\s*(.+?)\s*\**\s*$/iu;
const NEEDS_LINE = /^⚠️?\s*Needs input\s*:\s*(.+?)\s*$/iu;
const ERROR_LINE = /^❌️?\s*Error\s*:\s*(.+?)\s*$/iu;
const PROGRESS_LINE = /^📊️?\s*Progress\s*:\s*([0-9]*\.?[0-9]+)\s*[—-]\s*(.+?)\s*$/iu;

const HEAD_SCAN_MAX_LINES = 8;

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

const STR_MAX_CHARS = 200;
const TITLE_MAX_CHARS = 40;

export function extractMarkers(text: string): MarkerSet {
  if (!text) return {};
  const lines = text.split('\n');
  const out: MarkerSet = {};

  // Head scan: the title is emitted early in the first response, but it may
  // not be on the literal first non-empty line — competing hooks (e.g. a
  // global auto-rename instruction that asks Claude to emit `/rename …` at
  // the top of the reply) can push it down a line or two. So we scan the
  // first few non-empty lines and accept the first one that matches the
  // title pattern. We bail at the first line that looks like real prose
  // (not a slash-command, not markdown decoration) so a body line like
  // "We could call this the 🏷️ Title: pattern" doesn't leak in.
  let inspected = 0;
  for (let i = 0; i < lines.length && inspected < HEAD_SCAN_MAX_LINES; i++) {
    const raw = lines[i].replace(ANSI_REGEX, '').trim();
    if (raw.length === 0) continue;
    inspected++;
    // Strip markdown wrappers so `**🏷️ Title: foo**` and `### 🏷️ Title: foo`
    // both reach the regex in their canonical shape.
    const cleaned = raw.replace(LINE_PREFIX, '').replace(TRAIL_EMPHASIS, '');
    const m = TITLE_LINE.exec(cleaned);
    if (m) {
      out.title = clamp(m[1], TITLE_MAX_CHARS);
      break;
    }
    // Skip transparent / hook-only lines and keep scanning.
    if (raw.startsWith('/')) continue;
    // Real prose — stop scanning so we don't pick up a fake marker further
    // down in the body.
    break;
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i].replace(ANSI_REGEX, '').trim();
    if (raw.length === 0) continue;

    let m: RegExpExecArray | null;

    m = TLDR_LINE.exec(raw);
    if (m) {
      if (out.tldr === undefined) out.tldr = clamp(m[1], STR_MAX_CHARS);
      continue;
    }
    m = TITLE_LINE.exec(raw);
    if (m) {
      if (out.title === undefined) out.title = clamp(m[1], TITLE_MAX_CHARS);
      continue;
    }
    m = NEEDS_LINE.exec(raw);
    if (m) {
      if (out.needsInput === undefined) out.needsInput = clamp(m[1], STR_MAX_CHARS);
      continue;
    }
    m = ERROR_LINE.exec(raw);
    if (m) {
      if (out.error === undefined) out.error = clamp(m[1], STR_MAX_CHARS);
      continue;
    }
    m = PROGRESS_LINE.exec(raw);
    if (m) {
      if (out.progress === undefined) {
        const value = Number(m[1]);
        const label = clamp(m[2], STR_MAX_CHARS);
        if (Number.isFinite(value) && value >= 0 && value <= 1 && label.length > 0) {
          out.progress = { value, label };
        }
      }
      continue;
    }

    // Non-empty, non-marker line at the tail — anything above this is body
    // prose and we stop scanning.
    //
    // Question-mark fallback: if Claude forgot the `⚠️ Needs input:` marker
    // but ended its message with a direct `?`-question to the user, infer
    // needsInput from this line.
    if (out.needsInput === undefined && endsWithUserQuestion(raw)) {
      out.needsInput = clamp(raw.replace(/^[\s>*\-\d.)]+/, ''), STR_MAX_CHARS);
    }
    break;
  }

  return out;
}

function endsWithUserQuestion(line: string): boolean {
  if (!line.endsWith('?')) return false;
  const words = line.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/);
  return words.length >= 3;
}

function clamp(s: string, maxLen: number): string {
  const t = s.trim();
  return t.length > maxLen ? t.slice(0, maxLen).trim() : t;
}
