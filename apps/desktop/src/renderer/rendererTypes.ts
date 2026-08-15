//! Renderer-local type declarations shared by `main.tsx` and its extracted
//! helper modules.

import type { CommandRun } from "./commandDisplay";
import type { ReviewCommentDraft, ReviewFeedbackReference } from "./review/reviewComments";
import type { ResponseFeedbackReason, ResponseRating } from "../shared/responseFeedback";
import type { TaskPermissionRequest } from "./taskEventReducer";
import type { ChatAttachment, IdeInfo, ReviewFile } from "../shared/desktopApi";

export type { ReviewFile };

export type AppearanceTheme = "system" | "light" | "dark";

export type IdeChoice = IdeInfo;

export type ResponseFeedbackDialogState = {
  messageId: string;
  rating: ResponseRating;
  reason?: ResponseFeedbackReason;
  comment: string;
};
export type ComposerSubmission = {
  prompt: string;
  attachedFiles: ChatAttachment[];
  reviewFeedback: ReviewCommentDraft[];
};
export type QueuedComposerPrompt = ComposerSubmission & {
  id: string;
  taskId: string;
  /// The runner's id for this queued message. The runner holds the queue and
  /// releases it only after a turn delivers its final answer, so this list is
  /// for display and editing, never for deciding when a message runs.
  actionId: string;
};

export type AppearanceSettings = {
  theme: AppearanceTheme;
  uiFont: string;
  monoFont: string;
};

export type PermissionRequest = TaskPermissionRequest;

export type ComposerActivitySegment =
  | { type: "reasoning"; id: string; text: string; durationMs: number | null; finished: boolean; kind?: "thinking" }
  | {
      type: "skill";
      id: string;
      skillId: string;
      source: string;
      origin: "harness" | "model";
      status: "requested" | "loaded" | "failed";
      requestId: string;
      contentHash?: string;
      bytes?: number;
      code?: string;
      message?: string;
    }
  | { type: "command"; id: string; run: CommandRun };

export type ComposerTimelineItem =
  | { type: "user"; id: string; text: string; rawText: string; reviewFeedback: ReviewFeedbackReference[]; attachedFiles: ChatAttachment[] }
  | {
      type: "activity";
      id: string;
      segments: ComposerActivitySegment[];
      startedAt?: string;
      endedAt?: string;
      finished: boolean;
    }
  // Context compaction is a boundary in the conversation, not a step of the
  // model's plan: it replaces the transcript the model is working from. So it
  // sits at the top level of the timeline, in the open where nothing has to be
  // expanded to see it, and it stays in scrollback afterwards marking where the
  // earlier turns stopped being verbatim.
  | {
      type: "compaction";
      id: string;
      status: "running" | "compacted" | "unchanged" | "failed";
      startedAt?: string;
      endedAt?: string;
      reclaimedTokens?: number;
    }
  // `final` marks the prose nothing follows: the turn's answer. Everything
  // earlier — the opening sentence, narration between rounds of work — is
  // progress, and reads that way. It is decided by position rather than by the
  // run being over, so it is settled the moment a Working block opens beneath a
  // message and never changes back.
  | { type: "assistant"; id: string; text: string; streaming?: boolean; final?: boolean };

export type SkillSourceFilter = "local" | "system";
export type PromptMention = { kind: "file" | "skill"; query: string; start: number; end: number };
