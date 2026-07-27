import type { BackendUiEvent, TaskInfo } from "../shared/desktopApi";

export type TaskPermissionRequest = Extract<
  BackendUiEvent,
  { type: "permission.requested" }
>["request"];

export type ApprovalCheck = {
  name: string;
  status: "running" | "passed" | "failed";
  detail?: string;
};

export type TaskEventEffects = {
  reloadChats: boolean;
  refreshReview: boolean;
  resetExpandedReview: boolean;
  errorMessage?: string;
};

export function reduceVisibleTask(
  current: TaskInfo | null,
  event: BackendUiEvent,
): TaskInfo | null {
  if (!current || current.id !== event.taskId) return current;
  switch (event.type) {
    case "assistant.done":
      return current.state === "running"
        ? { ...current, state: "completed" }
        : current;
    case "worktree.requested":
      return {
        ...current,
        state: "awaiting_worktree_approval",
        workspaceMode: "worktree",
        worktreePath: event.path,
        agentBranch: event.branch,
      };
    case "worktree.created":
      return {
        ...current,
        state: "running",
        workspaceMode: "worktree",
        worktreePath: event.path,
        agentBranch: event.branch,
      };
    case "review.ready":
      return {
        ...current,
        state: "review_ready",
        changedFiles: event.changedFiles,
        reviewFiles: event.reviewFiles,
        latestTest: event.latestTest,
      };
    case "approval.completed":
      return { ...current, state: "approved", patchHash: event.patchHash };
    case "merge.completed":
      return { ...current, state: "merged", patchHash: event.patchHash };
    case "task.error":
      return { ...current, state: "failed", error: event.message };
    default:
      return current;
  }
}

export function reducePendingPermission(
  current: TaskPermissionRequest | null,
  event: BackendUiEvent,
): TaskPermissionRequest | null {
  if (event.type === "permission.requested") return event.request;
  if (event.type === "permission.resolved" && current?.id === event.id) return null;
  return current;
}

export function reduceApprovalChecks(
  current: ApprovalCheck[],
  event: BackendUiEvent,
): ApprovalCheck[] {
  if (event.type !== "approval.check") return current;
  return [
    ...current.filter((check) => check.name !== event.name),
    { name: event.name, status: event.status, detail: event.detail },
  ];
}

export function taskEventEffects(event: BackendUiEvent): TaskEventEffects {
  switch (event.type) {
    case "review.ready":
      return {
        reloadChats: true,
        refreshReview: true,
        resetExpandedReview: true,
      };
    case "task.error":
      return {
        reloadChats: true,
        refreshReview: false,
        resetExpandedReview: false,
        errorMessage: event.message,
      };
    case "assistant.done":
    case "worktree.requested":
    case "worktree.created":
    case "approval.completed":
    case "merge.completed":
      return {
        reloadChats: true,
        refreshReview: false,
        resetExpandedReview: false,
      };
    default:
      return {
        reloadChats: false,
        refreshReview: false,
        resetExpandedReview: false,
      };
  }
}
