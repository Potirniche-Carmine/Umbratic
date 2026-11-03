/** Advance an append-only stream without splitting a UTF-16 surrogate pair. */
export function advanceStreamingText(current: string, target: string, fraction: number): string {
  if (!target.startsWith(current) || fraction >= 1) return target;
  let end = Math.min(target.length, current.length + Math.max(1, Math.ceil((target.length - current.length) * fraction)));
  const last = target.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff && end < target.length) end++;
  return target.slice(0, end);
}
