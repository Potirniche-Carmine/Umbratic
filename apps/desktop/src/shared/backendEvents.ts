import type { ReviewFile as NormalizedReviewFile } from "./reviewDiff";
import {
  isResponseFeedbackReason,
  type ResponseFeedbackReason,
  type ResponseRating,
} from "./responseFeedback";

export type BackendChatAttachment = {
  path: string;
  name: string;
  source?: "workspace" | "chat";
  storedPath?: string;
  originalPath?: string;
  previewDataUrl?: string;
  contextTokens?: number;
};

export type BackendPermissionRequest = {
  id: string;
  kind: "read" | "edit" | "bash";
  summary: string;
  command: string;
  commandClass?: BackendCommandClass;
  cwd: string;
  consequence?: string;
  riskyFragment?: string;
  suggestion?: string;
};

export type BackendCommandClass =
  | "read" | "edit" | "shell" | "python-runtime" | "markdown" | "cmake-build" | "compiler"
  | "package-manager" | "git-read" | "git-write" | "destructive-file" | "network"
  | "external-directory" | "blocked-path" | "unknown";

export type BackendTestResult = {
  command: string;
  output: string;
  passed: boolean;
  exitCode: number | null;
  completedAt: string;
};

/// Per-category estimates over the assembled request. Only the headline total
/// is measured, so these rows are deliberately not required to sum to
/// `contentTokens` — reconciling them would spread the estimator's error across
/// every category instead of leaving each row as true as it can be.
export type BackendContextBreakdown = {
  systemPromptTokens: number;
  systemPromptExact: boolean;
  toolDefinitionTokens: number;
  skillTokens: number;
  conversationTokens: number;
  toolResultTokens: number;
  imageTokens: number;
};

type BackendEventMeta = { at?: string; endedAt?: string };

export type BackendUiEvent = BackendEventMeta & (
  | { type: "user.message"; taskId: string; text: string; attachedFiles?: BackendChatAttachment[] }
  // kind "status" is harness-emitted work narration (the run's opening status
  // line); it renders inside the working timeline, never as answer text.
  | { type: "assistant.delta"; taskId: string; text: string; kind?: "status" }
  | { type: "assistant.progress.delta"; taskId: string; text: string }
  | { type: "assistant.done"; taskId: string }
  | { type: "worktree.requested"; taskId: string; branch: string; path: string; baseCommit: string }
  | { type: "worktree.created"; taskId: string; branch: string; path: string }
  | { type: "command.started"; taskId: string; id: string; command: string; cwd: string; kind?: BackendPermissionRequest["kind"]; commandClass?: BackendCommandClass; toolKind?: string; input?: unknown }
  | { type: "command.output"; taskId: string; id: string; stream: "stdout" | "stderr"; text: string }
  | { type: "command.finished"; taskId: string; id: string; exitCode: number | null; status?: string; errorCode?: string; errorMessage?: string; durationMs?: number; details?: Record<string, unknown>; continuation?: Record<string, unknown> }
  | { type: "context.usage"; taskId: string; contextLength: number; contentTokens: number; promptTokens?: number; completionTokens?: number; reserveTokens: number; protectedTokens?: number; estimatedTokens: number; phase?: "preflight" | "observed"; source?: "heuristic" | "provider"; confidence?: "low" | "high"; anchored?: boolean; compactionBlocked?: boolean; awaitingMeasurement?: boolean; breakdown?: BackendContextBreakdown }
  | { type: "context.threshold"; taskId: string; threshold: 75 | 90; contextLength: number; estimatedTokens: number }
  | { type: "context.compressed"; taskId: string; toolCallId: string; toolKind: string; kind: string; strategy: string; hash?: string; originalBytes: number; outputBytes: number }
  | { type: "context.retrieved"; taskId: string; toolCallId: string; hash: string; offset: number; bytesShown: number; totalBytes: number }
  | { type: "permission.requested"; taskId: string; request: BackendPermissionRequest }
  | { type: "permission.resolved"; taskId: string; id: string; decision: "allow" | "deny" }
  | { type: "review.ready"; taskId: string; changedFiles: string[]; reviewFiles: NormalizedReviewFile[]; latestTest?: BackendTestResult }
  | { type: "review.changed_since_ready"; taskId: string; previousPatchHash: string; currentPatchHash: string; changedFileCount: number }
  | { type: "approval.check"; taskId: string; name: string; status: "running" | "passed" | "failed"; detail?: string }
  | { type: "merge.approval"; taskId: string; decision: "approved" | "rejected"; cleanup?: boolean; reason?: string }
  | { type: "approval.completed"; taskId: string; target: string; patchHash: string }
  | { type: "merge.completed"; taskId: string; targetBranch: string; commit: string; patchHash: string }
  | { type: "ide.opened"; taskId: string; ideId: string; target: "workspace" | "file"; filePath?: string; result: "success" | "failed"; message?: string }
  | { type: "response.feedback"; taskId: string; messageId: string; rating: ResponseRating; reason?: ResponseFeedbackReason; comment?: string }
  | { type: "tool.failed"; taskId: string; id: string; toolKind: string; input: unknown; response: { stdout: string; stderr: string; toolResponse?: string; exitCode: number | null; status?: string; errorCode?: string; errorMessage?: string }; details?: Record<string, unknown> }
  | { type: "tool.policy.stage"; taskId: string; toolCallId: string; stage: string; outcome: string; reason?: string }
  | { type: "skill.requested"; taskId: string; sessionId: string; runId: string; requestId: string; skillId: string; source: string; origin: "harness" | "model" }
  | { type: "skill.loaded"; taskId: string; sessionId: string; runId: string; requestId: string; skillId: string; source: string; origin: "harness" | "model"; contentHash: string; bytes: number }
  | { type: "skill.failed"; taskId: string; sessionId: string; runId: string; requestId: string; skillId: string; source: string; origin: "harness" | "model"; code: string; message: string }
  | { type: "turn.outcome"; taskId: string; outcome: "completed" | "model_gave_up" | "safety_limit" | "aborted" }
  | { type: "required_tool.failed"; taskId: string; requirement: "file_change"; reason: string; requiredTools: string[]; attemptedTools?: string[]; attempt?: number; detail?: string }
  | { type: "task.error"; taskId: string; message: string; category?: string; code?: string; detail?: string }
);

export type BackendEventParseFailure = {
  ok: false;
  code: "not_an_object" | "unknown_type" | "invalid_field";
  message: string;
  type?: string;
};

export type BackendEventParseResult =
  | { ok: true; event: BackendUiEvent }
  | BackendEventParseFailure;

const eventTypes = new Set([
  "user.message",
  "assistant.delta",
  "assistant.progress.delta",
  "assistant.done",
  "worktree.requested",
  "worktree.created",
  "command.started",
  "command.output",
  "command.finished",
  "context.usage",
  "context.threshold",
  "context.compressed",
  "context.retrieved",
  "permission.requested",
  "permission.resolved",
  "review.ready",
  "review.changed_since_ready",
  "approval.check",
  "merge.approval",
  "approval.completed",
  "merge.completed",
  "ide.opened",
  "response.feedback",
  "tool.failed",
  "tool.policy.stage",
  "skill.requested",
  "skill.loaded",
  "skill.failed",
  "turn.outcome",
  "required_tool.failed",
  "task.error",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string";
}

function hasNumber(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "number" && Number.isFinite(value[key]);
}

function hasNonNegativeNumber(value: Record<string, unknown>, key: string): boolean {
  return hasNumber(value, key) && Number(value[key]) >= 0;
}

function hasStringArray(value: Record<string, unknown>, key: string): boolean {
  return Array.isArray(value[key]) && (value[key] as unknown[]).every((item) => typeof item === "string");
}

const breakdownTokenFields = [
  "systemPromptTokens", "toolDefinitionTokens", "skillTokens",
  "conversationTokens", "toolResultTokens", "imageTokens",
] as const;

// Every row is a non-negative token count and the exactness claim is a
// boolean. Nothing here requires the rows to add up to the headline: they are
// per-category estimates over a measured total, by design.
export function isContextBreakdown(value: unknown): boolean {
  return isRecord(value)
    && typeof value.systemPromptExact === "boolean"
    && breakdownTokenFields.every((field) => hasNonNegativeNumber(value, field));
}

function validPayload(value: Record<string, unknown>, type: string): boolean {
  switch (type) {
    case "user.message":
    case "assistant.delta":
    case "assistant.progress.delta":
    case "task.error":
      return hasString(value, type === "task.error" ? "message" : "text")
        && (type !== "task.error" || (
          (value.category === undefined || hasString(value, "category"))
          && (value.code === undefined || hasString(value, "code"))
          && (value.detail === undefined || hasString(value, "detail"))
        ));
    case "assistant.done":
      return true;
    case "worktree.requested":
      return hasString(value, "branch") && hasString(value, "path") && hasString(value, "baseCommit");
    case "worktree.created":
      return hasString(value, "branch") && hasString(value, "path");
    case "command.started":
      return hasString(value, "id") && hasString(value, "command") && hasString(value, "cwd");
    case "command.output":
      return hasString(value, "id") && (value.stream === "stdout" || value.stream === "stderr") && hasString(value, "text");
    case "command.finished":
      return hasString(value, "id") && (value.exitCode === null || hasNumber(value, "exitCode"));
    case "context.usage":
      return hasNumber(value, "contextLength") && Number(value.contextLength) > 0
        && hasNonNegativeNumber(value, "contentTokens")
        && hasNonNegativeNumber(value, "reserveTokens")
        && (value.protectedTokens === undefined || (hasNonNegativeNumber(value, "protectedTokens") && Number(value.protectedTokens) <= Number(value.contentTokens)))
        && hasNonNegativeNumber(value, "estimatedTokens")
        && Number(value.estimatedTokens) === Number(value.contentTokens) + Number(value.reserveTokens)
        && (value.promptTokens === undefined || (hasNonNegativeNumber(value, "promptTokens") && value.promptTokens === value.contentTokens))
        && (value.completionTokens === undefined || hasNonNegativeNumber(value, "completionTokens"))
        && (value.phase === undefined || value.phase === "preflight" || value.phase === "observed")
        && (value.source === undefined || value.source === "heuristic" || value.source === "provider")
        && (value.confidence === undefined || value.confidence === "low" || value.confidence === "high")
        && (value.anchored === undefined || typeof value.anchored === "boolean")
        && (value.compactionBlocked === undefined || typeof value.compactionBlocked === "boolean")
        && (value.awaitingMeasurement === undefined || typeof value.awaitingMeasurement === "boolean")
        && (value.breakdown === undefined || isContextBreakdown(value.breakdown));
    case "context.threshold":
      return (value.threshold === 75 || value.threshold === 90)
        && hasNumber(value, "contextLength") && hasNumber(value, "estimatedTokens");
    case "context.compressed":
      return hasString(value, "toolCallId") && hasString(value, "toolKind") && hasString(value, "kind")
        && hasString(value, "strategy") && hasNumber(value, "originalBytes") && hasNumber(value, "outputBytes");
    case "context.retrieved":
      return hasString(value, "toolCallId") && hasString(value, "hash") && hasNumber(value, "offset")
        && hasNumber(value, "bytesShown") && hasNumber(value, "totalBytes");
    case "permission.requested":
      return isRecord(value.request) && hasString(value.request, "id") && hasString(value.request, "kind")
        && hasString(value.request, "summary") && hasString(value.request, "command") && hasString(value.request, "cwd")
        && (value.request.consequence === undefined || hasString(value.request, "consequence"))
        && (value.request.riskyFragment === undefined || hasString(value.request, "riskyFragment"))
        && (value.request.suggestion === undefined || hasString(value.request, "suggestion"));
    case "permission.resolved":
      return hasString(value, "id") && (value.decision === "allow" || value.decision === "deny");
    case "review.ready":
      return hasStringArray(value, "changedFiles") && Array.isArray(value.reviewFiles);
    case "review.changed_since_ready":
      return hasString(value, "previousPatchHash") && hasString(value, "currentPatchHash") && hasNumber(value, "changedFileCount");
    case "approval.check":
      return hasString(value, "name") && ["running", "passed", "failed"].includes(String(value.status));
    case "merge.approval":
      return value.decision === "approved" || value.decision === "rejected";
    case "approval.completed":
      return hasString(value, "target") && hasString(value, "patchHash");
    case "merge.completed":
      return hasString(value, "targetBranch") && hasString(value, "commit") && hasString(value, "patchHash");
    case "ide.opened":
      return hasString(value, "ideId") && ["workspace", "file"].includes(String(value.target))
        && ["success", "failed"].includes(String(value.result));
    case "response.feedback":
      return hasString(value, "messageId") && (value.rating === "good" || value.rating === "bad")
        && (value.reason === undefined || isResponseFeedbackReason(value.rating, value.reason))
        && (value.comment === undefined || hasString(value, "comment"));
    case "tool.failed":
      return hasString(value, "id") && hasString(value, "toolKind") && isRecord(value.response)
        && hasString(value.response, "stdout") && hasString(value.response, "stderr")
        && (value.response.exitCode === null || hasNumber(value.response, "exitCode"));
    case "tool.policy.stage":
      return hasString(value, "toolCallId") && hasString(value, "stage") && hasString(value, "outcome")
        && (value.reason === undefined || hasString(value, "reason"));
    case "skill.requested":
      return hasString(value, "sessionId") && hasString(value, "runId") && hasString(value, "requestId")
        && hasString(value, "skillId") && hasString(value, "source")
        && (value.origin === "harness" || value.origin === "model");
    case "skill.loaded":
      return hasString(value, "sessionId") && hasString(value, "runId") && hasString(value, "requestId")
        && hasString(value, "skillId") && hasString(value, "source")
        && (value.origin === "harness" || value.origin === "model")
        && hasString(value, "contentHash") && hasNonNegativeNumber(value, "bytes");
    case "skill.failed":
      return hasString(value, "sessionId") && hasString(value, "runId") && hasString(value, "requestId")
        && hasString(value, "skillId") && hasString(value, "source")
        && (value.origin === "harness" || value.origin === "model")
        && hasString(value, "code") && hasString(value, "message");
    case "turn.outcome":
      return value.outcome === "completed" || value.outcome === "model_gave_up" || value.outcome === "safety_limit" || value.outcome === "aborted";
    case "required_tool.failed":
      return hasString(value, "requirement") && hasString(value, "reason") && hasStringArray(value, "requiredTools");
    default:
      return false;
  }
}

export function parseBackendUiEvent(value: unknown): BackendEventParseResult {
  if (!isRecord(value)) return { ok: false, code: "not_an_object", message: "Backend event must be an object." };
  if ("version" in value) {
    return { ok: false, code: "invalid_field", message: "Backend events do not carry a version field." };
  }
  if (!hasString(value, "type") || !eventTypes.has(value.type as string)) {
    return { ok: false, code: "unknown_type", message: "Backend event type is missing or unknown.", ...(hasString(value, "type") ? { type: value.type as string } : {}) };
  }
  if (!hasString(value, "taskId") || !validPayload(value, value.type as string)) {
    return { ok: false, code: "invalid_field", message: `Backend event ${String(value.type)} has invalid fields.`, type: value.type as string };
  }
  if ((value.at !== undefined && typeof value.at !== "string") || (value.endedAt !== undefined && typeof value.endedAt !== "string")) {
    return { ok: false, code: "invalid_field", message: `Backend event ${String(value.type)} has invalid timestamps.`, type: value.type as string };
  }
  return { ok: true, event: value as BackendUiEvent };
}

export function backendEventDiagnostic(failure: BackendEventParseFailure): string {
  return `[invalid-event:${failure.code}] ${failure.message}`;
}
