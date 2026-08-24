import { Copy, ThumbsDown, ThumbsUp } from "lucide-react";
import type { ReactNode } from "react";

import type { ComposerTimelineItem } from "./rendererTypes";
import type { ResponseRating } from "../shared/responseFeedback";

type AssistantItem = Extract<ComposerTimelineItem, { type: "assistant" }>;

type AssistantMessageProps = {
  item: AssistantItem;
  /** False while the run is still going: an answer is not finished being written. */
  settled: boolean;
  rating: ResponseRating | undefined;
  /** The turn's answer text, which is what copying a response should yield. */
  copyText: string;
  onCopy: (text: string) => void;
  onRate: (messageId: string, rating: ResponseRating, anchor: HTMLButtonElement) => void;
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
  rating,
  copyText,
  onCopy,
  onRate,
  children,
  documents,
}: AssistantMessageProps) {
  const isAnswer = item.final === true;
  // Actions belong to a finished answer. Offering them mid-run would invite a
  // copy of half a response, and a rating of one the model has not finished.
  const showActions = isAnswer && settled;

  return (
    <article
      className={`timelineMessage assistantMessage ${isAnswer ? "assistantAnswer" : "assistantProgress"}`}
      aria-label={isAnswer ? "Answer" : "Progress update"}
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
            <button
              className={`messageAction feedbackGood ${rating === "good" ? "active" : ""}`}
              type="button"
              onClick={(event) => onRate(item.id, "good", event.currentTarget)}
              aria-pressed={rating === "good"}
              title={rating === "good" ? "Edit good response feedback" : "Good response"}
              aria-haspopup="dialog"
            >
              <ThumbsUp size={14} />
            </button>
            <button
              className={`messageAction feedbackBad ${rating === "bad" ? "active" : ""}`}
              type="button"
              onClick={(event) => onRate(item.id, "bad", event.currentTarget)}
              aria-pressed={rating === "bad"}
              title={rating === "bad" ? "Edit bad response feedback" : "Bad response"}
              aria-haspopup="dialog"
            >
              <ThumbsDown size={14} />
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}
