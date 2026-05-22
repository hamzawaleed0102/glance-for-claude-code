// Derives a one-line card label for a subagent from the `Agent` tool's
// `tool_input`. A verification spike confirmed `tool_input` carries a short
// `description` and a `subagent_type`; this checks them in priority order and
// always returns a non-empty string. MUST NOT import `vscode` — unit-tested
// under `node --test`.

/** Longest label rendered on a row before truncation (incl. the ellipsis). */
const MAX = 60;

export function subagentLabel(toolInput: unknown): string {
  if (typeof toolInput !== 'object' || toolInput === null) return 'subagent';
  const t = toolInput as Record<string, unknown>;
  const desc = typeof t.description === 'string' ? t.description.trim() : '';
  if (desc) return desc.length > MAX ? desc.slice(0, MAX - 1) + '…' : desc;
  const type = typeof t.subagent_type === 'string' ? t.subagent_type.trim() : '';
  if (type) return type;
  return 'subagent';
}
