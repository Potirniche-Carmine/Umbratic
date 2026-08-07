//! Renderer-local type declarations shared by `main.tsx` and its extracted
//! helper modules.

import type { CommandRun } from "./commandDisplay";
import type { ReviewFile as NormalizedReviewFile } from "../shared/reviewDiff";
import type { ReviewCommentDraft, ReviewFeedbackReference } from "./review/reviewComments";
import type { ResponseFeedbackReason, ResponseRating } from "../shared/responseFeedback";
import type { TaskPermissionRequest } from "./taskEventReducer";
import type { ChatAttachment, IdeInfo } from "../shared/desktopApi";

export type AppearanceTheme = "system" | "light" | "dark";
export type RunnerToolId = "read" | "ls" | "find" | "search" | "write" | "edit" | "lsp" | "command";
export type RequiredToolContractRequirement = "file_change";
export type RequiredToolContractReason =
  | "file_tools_disabled"
  | "missing_tool_call"
  | "agent_reported_blocker"
  | "attempted_tool_failed"
  | "no_review_changes";
export type ToolResultStatus = "success" | "permission_denied" | "policy_blocked" | "validation_error" | "runtime_error" | "timeout";
export type ToolErrorCode =
  | "tool_disabled"
  | "unknown_tool"
  | "invalid_arguments"
  | "permission_denied"
  | "policy_blocked"
  | "workspace_boundary"
  | "blocked_path"
  | "command_exit_nonzero"
  | "process_timeout"
  | "process_error"
  | "missing_dependency"
  | "runtime_error";
export type ReviewFile = NormalizedReviewFile;

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
  | { type: "reasoning"; id: string; text: string; durationMs: number | null; finished: boolean }
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
  | { type: "assistant"; id: string; text: string; streaming?: boolean };

export type SkillSourceFilter = "local" | "system";
export type PromptMention = { kind: "file" | "skill"; query: string; start: number; end: number };
