import React, { forwardRef, useLayoutEffect, useRef, useState } from "react";
import { DictationPreview, dictationPromptParts } from "./DictationPreview";
import type { DictationStatus } from "./dictation";

/** Shared input surface. Native field sizing grows with text in both modes. */
type Props = React.TextareaHTMLAttributes<HTMLTextAreaElement> & { dictation?: DictationStatus; previewCaret?: number | null };
export const PromptTextarea = forwardRef<HTMLTextAreaElement, Props>(function PromptTextarea({ className = "", dictation, previewCaret, ...props }, ref) {
  const [scrollTop, setScrollTop] = useState(0);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const followSpeech = useRef(true);
  const preview = dictation?.state !== "idle" ? dictation?.preview : "";
  useLayoutEffect(() => {
    if (!preview) { followSpeech.current = true; return; }
    const node = input.current;
    if (!node) return;
    if (followSpeech.current && (previewCaret ?? String(props.value ?? "").length) >= String(props.value ?? "").length) node.scrollTop = node.scrollHeight;
    setScrollTop(node.scrollTop);
  }, [preview, previewCaret, props.value]);
  if (!preview) return <textarea {...props} ref={ref} className={`promptTextarea ${className}`} rows={1}/>;
  const parts = dictationPromptParts(String(props.value ?? ""), previewCaret ?? null, preview);
  // Partial speech is a display projection. Commit only the final transcript,
  // and keep selection events from moving the insertion point into a hypothesis.
  return <div className="promptSpeechSurface">
    <textarea {...props} ref={node => { input.current = node; if (typeof ref === "function") return ref(node); if (ref) ref.current = node; }} className={`promptTextarea isSpeechPreview ${className}`} rows={1}
      value={parts.join("")} readOnly onChange={undefined} onSelect={undefined} onClick={undefined} onKeyUp={undefined} onPaste={event => event.preventDefault()}
      onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }}
      onScroll={event => { const node = event.currentTarget; followSpeech.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24; setScrollTop(node.scrollTop); props.onScroll?.(event); }}/>
    <DictationPreview parts={parts} scrollTop={scrollTop}/>
  </div>;
});
