const PREFIX = 'AG-';

export function nextAgentId(existingIds: Iterable<string>): string {
  const used = new Set<number>();
  for (const id of existingIds) {
    const n = Number(id.slice(PREFIX.length));
    if (Number.isInteger(n) && n >= 1) used.add(n);
  }
  let i = 1;
  while (used.has(i)) i++;
  return PREFIX + String(i).padStart(2, '0');
}
