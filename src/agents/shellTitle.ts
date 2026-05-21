/**
 * Derive a shell card's title from a command line the user just ran.
 *
 * Returns `null` when the command line is empty / whitespace-only — the
 * caller (`ShellAgent`) treats `null` as "don't adopt a title", so pressing
 * Enter at an empty prompt never burns the one-time first-command slot.
 *
 * Long command lines are truncated to `MAX_TITLE_LEN` characters (with a
 * trailing ellipsis) so an accidental paste of a huge one-liner can't blow
 * out the card layout.
 */
const MAX_TITLE_LEN = 120;

export function deriveShellTitle(commandLine: string): string | null {
  const trimmed = commandLine.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_TITLE_LEN) {
    // Spread to iterate by code point so the cut never splits a surrogate
    // pair (e.g. an emoji) into an invalid lone surrogate.
    return [...trimmed].slice(0, MAX_TITLE_LEN - 1).join('') + '…';
  }
  return trimmed;
}
