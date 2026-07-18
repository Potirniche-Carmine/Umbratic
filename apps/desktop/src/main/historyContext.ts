export function boundedRecentLines(
  lines: readonly string[],
  maxLines = 60,
  maxCharacters = 14_000,
): string {
  const lineLimit = Math.max(0, Math.floor(maxLines));
  if (lineLimit === 0 || maxCharacters <= 0) return "";
  const selected = lines.slice(-lineLimit);
  const kept: string[] = [];
  let remaining = Math.max(0, maxCharacters);
  for (let index = selected.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const line = selected[index].slice(0, remaining);
    kept.unshift(line);
    remaining -= line.length + 1;
  }
  return kept.join("\n");
}
