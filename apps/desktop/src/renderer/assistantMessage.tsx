import { Copy } from "lucide-react";
import type { ReactNode } from "react";

import type { ComposerTimelineItem } from "./rendererTypes";

type AssistantItem = Extract<ComposerTimelineItem, { type: "assistant" }>;

type AssistantMessageProps = {
  item: AssistantItem;
  /** False while the run is still going: an answer is not finished being written. */
  settled: boolean;
  /** The turn's answer text, which is what copying a response should yield. */
  copyText: string;
  onCopy: (text: string) => void;
  /** Rendered body — streaming or settled markdown is the caller's choice. */
  children: ReactNode;
  /** Links to any documents the answer produced. */
  documents?: ReactNode;
};

/**
 * One assistant message.
 *
 * A turn reads: Working (thinking, tools, and narration inside it), then the
 * answer. The answer streams here from its first token and settling only stops
 * the caret — the element never moves or remounts, so the end of a stream
 * changes nothing the reader can see.
 */
export function AssistantMessage({
  item,
  settled,
  copyText,
  onCopy,
  children,
  documents,
}: AssistantMessageProps) {
  const isAnswer = item.final === true;
  // Actions belong to a finished answer. Offering them mid-run would invite a
  // copy of a response the model has not finished.
  const showActions = isAnswer && settled;

  return (
    // Every passage wears the same styling — what the run says between rounds
    // of work is prose, not a demoted aside. Only the affordances differ.
    <article
      className="timelineMessage assistantMessage assistantAnswer"
      aria-label={isAnswer ? "Answer" : "Assistant message"}
    >
      {children}
      {documents}
      {showActions ? (
        <div className="responseFeedbackControls">
          <div className="messageActions">
            <button
              className="messageAction"
              type="button"
              onClick={() => onCopy(copyText || item.text)}
              title="Copy answer"
            >
              <Copy size={14} />
            </button>

          </div>
        </div>
      ) : null}
    </article>
  );
}
