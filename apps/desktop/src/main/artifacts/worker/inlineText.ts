export type InlineRun = { text: string; bold?: boolean; italic?: boolean; code?: boolean };

/** Inline markup shared by DOCX, PDF and PPTX generation. */
export function inlineRuns(value: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let cursor = 0;
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    if (match.index > cursor) runs.push({ text: value.slice(cursor, match.index) });
    const token = match[0];
    if (token.startsWith("**")) runs.push({ text: token.slice(2, -2), bold: true });
    else if (token.startsWith("`")) runs.push({ text: token.slice(1, -1), code: true });
    else runs.push({ text: token.slice(1, -1), italic: true });
    cursor = match.index + token.length;
  }
  if (cursor < value.length) runs.push({ text: value.slice(cursor) });
  return runs.length > 0 ? runs : [{ text: value }];
}
