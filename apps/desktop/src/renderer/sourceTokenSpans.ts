import type { SourceToken } from "./syntaxTypes";

export type SourceChange = { text: string; changed: boolean };
/** Intersect syntax and diff boundaries without changing text or losing marks. */
export function sourceTokenSpans(text: string, tokens?: SourceToken[], changes?: SourceChange[]) {
  const source = tokens?.map(token => token.content).join("") === text ? tokens! : [{ content: text }];
  const spans = changes?.map(span => span.text).join("") === text ? changes! : [{ text, changed: undefined }];
  let tokenIndex = 0, tokenOffset = 0;
  return spans.map(span => {
    let remaining = span.text.length;
    const pieces: SourceToken[] = [];
    while (remaining > 0 && tokenIndex < source.length) {
      const token = source[tokenIndex];
      const length = Math.min(remaining, token.content.length - tokenOffset);
      if (length) pieces.push({ ...token, content: token.content.slice(tokenOffset, tokenOffset + length) });
      remaining -= length; tokenOffset += length;
      if (tokenOffset === token.content.length) { tokenIndex++; tokenOffset = 0; }
    }
    return { ...span, tokens: pieces };
  });
}
