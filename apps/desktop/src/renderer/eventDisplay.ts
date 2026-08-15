import type { BackendUiEvent } from "../shared/desktopApi";

const shortHash = (value: string) => value.slice(0, 8);

export function eventTitle(event: BackendUiEvent): string {
  switch (event.type) {
    case "user.message": return "user";
    case "assistant.delta": return "assistant";
    case "assistant.progress.delta": return event.kind === "thinking" ? "thinking" : "progress";
    case "assistant.done": return "assistant done";
    case "worktree.requested": return "worktree requested";
    case "worktree.created": return "worktree created";
    case "command.started": return "command started";
    case "command.output": return event.stream;
    case "command.finished": return "command finished";
    case "permission.requested": return "permission requested";
    case "permission.resolved": return `permission ${event.decision}`;
    case "review.ready": return "review ready";
    case "review.changed_since_ready": return "review changed";
    case "approval.check": return `check ${event.status}`;
    case "merge.approval": return event.decision === "approved" ? "accepted" : "rejected";
    case "approval.completed": return "approved";
    case "merge.completed": return "merged";
    case "ide.opened": return event.result === "success" ? "opened editor" : "editor open failed";
    case "response.feedback": return event.rating === "good" ? "liked response" : "disliked response";
    case "skill.requested": return "skill requested";
    case "skill.loaded": return "skill loaded";
    case "skill.failed": return "skill failed";
    case "tool.failed": return "tool failed";
    case "tool.policy.stage": return "tool policy";
    case "turn.outcome": return "turn outcome";
    case "required_tool.failed": return "required tool failed";
    case "task.error": return "task event";
    default: return "context";
  }
}

export function eventDetail(event: BackendUiEvent): string {
  switch (event.type) {
    case "user.message":
    case "assistant.delta":
    case "assistant.progress.delta":
      return event.text.trim();
    case "assistant.done": return "stream complete";
    case "worktree.requested":
    case "worktree.created":
      return `${event.branch} at ${event.path}`;
    case "command.started": return `${event.command}${event.commandClass ? ` - ${event.commandClass}` : ""} - ${event.cwd}`;
    case "command.output": return event.text.trim();
    case "command.finished": return `exit ${event.exitCode ?? "unknown"}`;
    case "permission.requested": return event.request.summary;
    case "permission.resolved": return event.id;
    case "review.ready": return `${event.changedFiles.length} changed file${event.changedFiles.length === 1 ? "" : "s"}`;
    case "review.changed_since_ready": return `${event.changedFileCount} file${event.changedFileCount === 1 ? "" : "s"} changed after review became ready`;
    case "approval.check": return event.detail ?? event.name;
    case "merge.approval": return event.reason ?? (event.cleanup === undefined ? event.decision : `${event.decision}, cleanup ${event.cleanup ? "on" : "off"}`);
    case "approval.completed": return `${event.target} ${shortHash(event.patchHash)}`;
    case "merge.completed": return `${event.targetBranch} ${shortHash(event.commit)}`;
    case "ide.opened": return [event.ideId, event.target, event.filePath, event.message].filter(Boolean).join(" - ");
    case "response.feedback": return event.messageId;
    case "skill.requested": return `${event.skillId} - ${event.origin}`;
    case "skill.loaded": return `${event.skillId} - ${event.bytes} bytes`;
    case "skill.failed": return `${event.skillId} - ${event.code}`;
    case "tool.failed": return `${event.toolKind} - ${event.response.errorCode ?? event.response.status ?? "failed"}`;
    case "tool.policy.stage": return [event.stage, event.outcome, event.reason].filter(Boolean).join(" - ");
    case "turn.outcome": return event.outcome;
    case "required_tool.failed": return [event.requirement, event.reason, event.detail].filter(Boolean).join(" - ");
    case "task.error": return event.message;
    default: return "Workspace context updated.";
  }
}
