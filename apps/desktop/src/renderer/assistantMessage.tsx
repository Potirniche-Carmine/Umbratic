import { Copy, ThumbsDown, ThumbsUp } from "lucide-react";
import type { ReactNode } from "react";

import { consumeHeldAnswerRect } from "./answerLift";
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
  /** True when this text just left the Working block and is becoming the answer. */
  lifted?: boolean;
};

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function liftFromWorkingBlock(node: HTMLElement | null) {
  if (!node || prefersReducedMotion()) return;
  const from = consumeHeldAnswerRect();
  if (!from) return;
  const to = node.getBoundingClientRect();
  const dy = from.top - to.top;
  if (Math.abs(dy) < 1) return;
  node.style.transform = `translateY(${dy}px)`;
  node.style.transition = "none";
  window.requestAnimationFrame(() => {
    node.style.transition = "transform 480ms cubic-bezier(0.22, 1, 0.32, 1)";
    node.style.transform = "none";
  });
}

/**
 * One assistant message.
 *
 * A turn reads: Working (thinking, tools, and narration inside it), then the
 * answer. After tools, live prose stays in that block until the turn ends, then
 * this message is the same words promoted out — the lift animation is what
 * keeps that from reading as a pop.
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
  lifted = false,
}: AssistantMessageProps) {
  const isAnswer = item.final === true;
  // Actions belong to a finished answer. Offering them mid-run would invite a
  // copy of half a response, and a rating of one the model has not finished.
  const showActions = isAnswer && settled;

  return (
    <article
      ref={lifted ? liftFromWorkingBlock : undefined}
      className={`timelineMessage assistantMessage ${isAnswer ? "assistantAnswer" : "assistantProgress"} ${lifted ? "isLifted" : ""}`}
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
