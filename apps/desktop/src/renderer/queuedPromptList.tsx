import React from "react";
import { CornerUpRight, MessageSquareText, Pencil, Trash2 } from "lucide-react";

import { visibleReviewPrompt, type ReviewFeedbackReference } from "./review/reviewComments";
import type { QueuedComposerPrompt } from "./rendererTypes";

export function QueuedPromptList({
  items,
  isGenerating,
  steerPending,
  onEdit,
  onSteer,
  onDelete,
  onPreviewFeedback,
}: {
  items: QueuedComposerPrompt[];
  isGenerating: boolean;
  steerPending: boolean;
  onEdit: (item: QueuedComposerPrompt) => void;
  onSteer: (item: QueuedComposerPrompt) => void;
  onDelete: (id: string) => void;
  onPreviewFeedback: (feedback: ReviewFeedbackReference[]) => void;
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
              <span className="queuedPromptText">{visiblePrompt.text || item.prompt}</span>
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
            {isGenerating ? (
              <button
                className="queuedPromptSteer"
                type="button"
                onClick={() => onSteer(item)}
                disabled={steerPending}
                aria-label="Steer with queued prompt"
              >
                <CornerUpRight size={13} />
                <span>Steer</span>
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
