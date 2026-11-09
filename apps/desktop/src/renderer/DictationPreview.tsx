import React from "react";

export function dictationPromptParts(draft: string, caret: number | null, preview: string): [string, string, string] {
  const at = Math.max(0, Math.min(caret ?? draft.length, draft.length));
  const before = draft.slice(0, at); const after = draft.slice(at);
  return [before + (before && !/\s$/.test(before) ? " " : ""), preview, (after && !/^\s/.test(after) ? " " : "") + after];
}

/** Mirror the prompt, muting only the replaceable speech hypothesis. */
export function DictationPreview({ parts, scrollTop }: { parts: [string, string, string]; scrollTop: number }) {
  return <div className="promptSpeechPreview promptTextLayout" aria-hidden="true"><div style={{ transform: `translateY(-${scrollTop}px)` }}>
    {parts[0]}<span className="promptSpeechInterim">{parts[1]}</span>{parts[2]}
  </div></div>;
}
