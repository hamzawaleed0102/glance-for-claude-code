/**
 * Pure marker extractor. Finds the five Glancer-specific markers Claude emits
 * at the END of a response message:
 *
 *   🔊 TL;DR: <speakable summary>
 *   🏷️ Title: <2-4 word session title>
 *   ⚠️ Needs input: <what the user has to decide>
 *   ❌ Error: <hard failure reason>
 *   📊 Progress: <0..1> — <present-tense activity label>
 *
 * **Tail anchoring** is the core defense against false positives: only marker
 * lines on the very tail of the message count. We walk lines from the bottom
 * up, accepting marker-shaped lines, and STOP the moment we hit a non-empty
 * non-marker line. So a `🔊 TL;DR: …` quoted inside the body of a code review
 * is never picked up — only the marker the agent itself appended at the end.
 *
 * The five regexes are deliberately whole-line (anchored with `^…$`) so a
 * single line can match at most one marker.
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
// treat the selector as optional so neither form silently misses.
const TLDR_LINE = /^🔊️?\s*TL;DR\s*:\s*(.+?)\s*$/u;
const TITLE_LINE = /^🏷️?\s*Title\s*:\s*(.+?)\s*$/iu;
const NEEDS_LINE = /^⚠️?\s*Needs input\s*:\s*(.+?)\s*$/iu;
const ERROR_LINE = /^❌️?\s*Error\s*:\s*(.+?)\s*$/iu;
const PROGRESS_LINE = /^📊️?\s*Progress\s*:\s*([0-9]*\.?[0-9]+)\s*[—-]\s*(.+?)\s*$/iu;

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

const STR_MAX_CHARS = 200;
const TITLE_MAX_CHARS = 40;

export function extractMarkers(text: string): MarkerSet {
  if (!text) return {};
  const lines = text.split('\n');
  const out: MarkerSet = {};

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
