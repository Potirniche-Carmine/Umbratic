import type { TaskInfo } from "../shared/desktopApi";
import { stateLabel } from "./chatListPresentation";

export function taskStatusTitle(task: TaskInfo): string {
  if (task.state === "completed") return "Answered";
  if (task.state === "review_ready") return "Ready to review";
  if (task.state === "approved") return "Approved";
  if (task.state === "merged") return task.workspaceMode === "worktree" ? "Merged" : "Approved";
  if (task.state === "approving") return "Running approval checks";
  if (task.state === "running") return "Working";
  if (task.state === "failed") return "Needs attention";
  if (task.state === "rejected") return "Undone";
  if (task.state === "awaiting_worktree_approval") return "Waiting for setup approval";
  return stateLabel(task.state);
}

export function taskStatusDetail(task: TaskInfo): string {
  if (task.state === "review_ready") {
    const changed = task.changedFiles.length;
    return `${changed} changed file${changed === 1 ? "" : "s"} ready in Review.`;
  }
  if (task.state === "merged") {
    return task.workspaceMode === "worktree"
      ? "This chat was closed after its approved merge."
      : "This chat was closed after its workspace changes were approved.";
  }
  if (task.state === "approved") return "Changes are saved on disk.";
  if (task.state === "completed") return "No file changes for this turn.";
  if (task.state === "rejected") return "Changes were undone.";
  if (task.latestTest?.passed) return `Verified: ${task.latestTest.output.trim() || task.latestTest.command}`;
  if (task.error) return task.error;
  if (task.state === "running") return "Umbratic is working.";
  return task.workspaceMode === "worktree" ? task.agentBranch : task.worktreePath;
}

export function formatFileSize(bytes: number): string {
  const value = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 2 : 1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
