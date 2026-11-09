import React from "react";
import type { SourceToken } from "./syntaxTypes";
import { sourceTokenSpans, type SourceChange } from "./sourceTokenSpans";

export function SourceTokens({ text, tokens, changes }: { text: string; tokens?: SourceToken[]; changes?: SourceChange[] }) {
  if (!tokens && !changes?.length) return <>{text}</>;
  return <>{sourceTokenSpans(text, tokens, changes).map((group, index) => {
    const content = group.tokens.map((token, tokenIndex) => <span key={tokenIndex} className="sourceToken" style={{
      "--syntax-dark": token.dark, "--syntax-light": token.light,
      fontStyle: token.italic ? "italic" : undefined, fontWeight: token.bold ? 600 : undefined,
    } as React.CSSProperties}>{token.content}</span>);
    return group.changed === undefined ? <React.Fragment key={index}>{content}</React.Fragment>
      : <mark key={index} className={group.changed && group.text.trim() ? "intraLineChange" : "intraLineSame"}>{content}</mark>;
  })}</>;
}
