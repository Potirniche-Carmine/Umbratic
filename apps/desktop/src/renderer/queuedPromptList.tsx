import React from "react";
import { CornerUpRight, MessageSquareText, Pencil, Trash2 } from "lucide-react";

import { visibleReviewPrompt, type ReviewFeedbackReference } from "./review/reviewComments";
export function QueuedPromptList<T extends { id: string; prompt: string }>({
  items,
  isGenerating,
  steerPending,
  onEdit,
  onSteer,
  onDelete,
  onPreviewFeedback,
  sendWhenIdle = false,
}: {
  items: T[];
  isGenerating: boolean;
  steerPending: boolean;
  onEdit: (item: T) => void;
  onSteer: (item: T) => void;
  onDelete: (id: string) => void;
  onPreviewFeedback: (feedback: ReviewFeedbackReference[]) => void;
  sendWhenIdle?: boolean;
}) {
  if (!items.length) return null;
  return (
    <div className="queuedPromptList" aria-label="Queued prompts">
      {items.map((item) => {
        const visiblePrompt = visibleReviewPrompt(item.prompt);
        return (
          <div className="queuedPrompt" key={item.id}>
            <button
              className="queuedPromptEdit"
              type="button"
              onClick={() => onEdit(item)}
              disabled={steerPending}
              aria-label="Edit queued prompt"
              title="Edit queued prompt"
            >
              <span className="queuedPromptText">{visiblePrompt.text || item.prompt || "Attached files"}</span>
              <Pencil className="queuedPromptEditIcon" aria-hidden="true" size={13} />
            </button>
            {visiblePrompt.feedback.length ? (
              <button
                className="queuedPromptFeedback"
                type="button"
                onClick={() => onPreviewFeedback(visiblePrompt.feedback)}
                aria-haspopup="dialog"
                title={`${visiblePrompt.feedback.length} review comment${visiblePrompt.feedback.length === 1 ? "" : "s"} attached`}
              >
                <MessageSquareText size={12} />
                <span>{visiblePrompt.feedback.length}</span>
              </button>
            ) : null}
            {isGenerating || sendWhenIdle ? (
              <button
                className="queuedPromptSteer"
                type="button"
                onClick={() => onSteer(item)}
                disabled={steerPending}
                aria-label={isGenerating ? "Steer with queued prompt" : "Send queued prompt"}
              >
                <CornerUpRight size={13} />
                <span>{isGenerating ? "Steer" : "Send"}</span>
              </button>
            ) : null}
            <button
              className="queuedPromptDelete"
              type="button"
              onClick={() => onDelete(item.id)}
              disabled={steerPending}
              aria-label="Delete queued prompt"
              title="Delete queued prompt"
            >
              <Trash2 aria-hidden="true" size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
