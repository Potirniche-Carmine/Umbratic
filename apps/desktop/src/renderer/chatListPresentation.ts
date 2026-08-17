//! Pure presentation helpers for the chat list, worktree groups, delete
//! confirmations, and composer attachments. Extracted from `main.tsx` so the
//! App component is the only oversized file left in the renderer.

import { chatTitleFromFirstMessage } from "../shared/chatTitle";
import { parseUtcMs } from "../shared/utcDate";
import type {
  BackendUiEvent,
  ChatAttachment,
  ChatRecord,
  TaskState,
} from "../shared/desktopApi";

export { chatActivityUtcIso } from "../shared/utcDate";

export type WorktreeChatGroup = {
  key: string;
  rootTaskId: string;
  branch: string;
  path: string;
  baseCommit?: string;
  chats: ChatRecord[];
};

export type ChatProjectGroup = {
  key: string;
  name: string;
  path?: string;
  chats: ChatRecord[];
  worktrees: WorktreeChatGroup[];
};

export type ProjectDeleteTarget = {
  id: string;
  key: string;
  name: string;
  path: string;
  chatCount: number;
};

export type DeleteCandidate =
  | { kind: "chat"; chat: ChatRecord }
  | { kind: "projectChats"; project: ProjectDeleteTarget }
  | { kind: "project"; project: ProjectDeleteTarget };

export function eventTimelineTime(event: BackendUiEvent): string {
  return event.endedAt ?? event.at ?? "";
}

export function shortHash(value: string): string {
  return value ? value.slice(0, 12) : "unknown";
}

export function stateLabel(state?: TaskState): string {
  if (!state) return "idle";
  if (state === "awaiting_worktree_approval") return "awaiting worktree";
  if (state === "completed") return "answered";
  if (state === "review_ready") return "ready for review";
  if (state === "rejected") return "undone";
  return state.replace(/_/g, " ");
}

export function titleFromPrompt(prompt: string): string {
  return chatTitleFromFirstMessage(prompt);
}

export function chatDisplayTitle(chat: ChatRecord): string {
  return chat.title === "New chat" ? chat.title : titleFromPrompt(chat.title);
}

export function draftMatchesTaskPrompt(draftPrompt: string, taskPrompt: string): boolean {
  const draft = draftPrompt.trim();
  const prompt = taskPrompt.trim();
  return !!draft && (prompt === draft || prompt.startsWith(`${draft}\n\nAttached files:`));
}

export function relativeChatAge(value: string, now = Date.now()): string {
  const timestamp = parseUtcMs(value);
  if (timestamp === undefined) return "";
  const elapsedMs = Math.max(0, now - timestamp);
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 1) return "<1m";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMs / 3_600_000);
  if (elapsedHours < 24) return `${elapsedHours}h`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}d`;
  return `${Math.floor(elapsedDays / 7)}w`;
}

export function chatSubline(chat: ChatRecord, now = Date.now()): string {
  return chat.updatedAt ? relativeChatAge(chat.updatedAt, now) : "";
}

export function closedChatMessage(state?: TaskState): string | undefined {
  if (state === "merged") {
    return "This chat was closed after its approved merge. Start a new chat for more changes.";
  }
  return undefined;
}

export function folderName(pathValue?: string): string {
  if (!pathValue) return "No folder";
  return pathValue.split(/[\\/]/).filter(Boolean).pop() ?? pathValue;
}

export function chatProjectKey(chat: ChatRecord): string {
  return chat.repositoryPath || "__unassigned__";
}

export function chatWorktreeKey(chat: ChatRecord): string {
  if (!chat.worktreePath) return "";
  return `worktree:${chat.worktreeRootTaskId || chat.worktreePath}`;
}

export function worktreeTitle(group: WorktreeChatGroup): string {
  return group.branch || folderName(group.path);
}

export function worktreeSubline(group: WorktreeChatGroup): string {
  const count = chatCountLabel(group.chats.length);
  const base = group.baseCommit ? `base ${group.baseCommit.slice(0, 7)}` : folderName(group.path);
  return `${count} - ${base}`;
}

export function chatCountLabel(count: number): string {
  return `${count} chat${count === 1 ? "" : "s"}`;
}

export function deleteCandidateTitle(candidate: DeleteCandidate): string {
  if (candidate.kind === "chat") return "Delete chat?";
  if (candidate.kind === "projectChats") return `Delete all chats in ${candidate.project.name}?`;
  return `Delete project ${candidate.project.name}?`;
}

export function deleteCandidateDescription(candidate: DeleteCandidate): string {
  if (candidate.kind === "chat") {
    return `This removes "${chatDisplayTitle(candidate.chat)}" from the chat archive and deletes app-managed chat files. Project folders and task worktrees are left alone.`;
  }
  if (candidate.kind === "projectChats") {
    return `This removes all ${chatCountLabel(candidate.project.chatCount)} in "${candidate.project.name}" from the chat archive and deletes app-managed chat files. The project folder and task worktrees are left alone.`;
  }
  if (candidate.project.chatCount === 0) {
    return `This removes "${candidate.project.name}" from saved projects. The project folder and task worktrees are left alone.`;
  }
  return `This removes "${candidate.project.name}" from saved projects and deletes its ${chatCountLabel(candidate.project.chatCount)} from the chat archive. The project folder and task worktrees are left alone.`;
}

export function deleteCandidateActionLabel(candidate: DeleteCandidate): string {
  if (candidate.kind === "chat") return "Delete chat";
  if (candidate.kind === "projectChats") return "Delete chats";
  return "Delete project";
}

export function chatAttachmentsMatch(left: ChatAttachment[], right: ChatAttachment[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((file, index) => {
    const other = right[index];
    return (
      !!other &&
      file.path === other.path &&
      file.name === other.name &&
      file.kind === other.kind &&
      file.source === other.source &&
      file.storedPath === other.storedPath &&
      file.originalPath === other.originalPath
    );
  });
}

export function chatAttachmentsSignature(files: ChatAttachment[]): string {
  return JSON.stringify(
    files.map((file) => ({
      path: file.path,
      name: file.name,
      kind: file.kind,
      source: file.source,
      storedPath: file.storedPath,
      originalPath: file.originalPath,
    })),
  );
}

export function attachmentDetail(file: ChatAttachment): string {
  if (file.kind === "folder") return "Workspace folder";
  if (file.source === "workspace") return "Workspace file";
  return "Attached file";
}

export function isImageAttachment(file: ChatAttachment): boolean {
  return !!file.previewDataUrl || /\.(png|jpe?g|webp|gif)$/i.test(file.name || file.path);
}

export function samePathKey(left: string, right: string): boolean {
  const key = (value: string) => value.split("\\").join("/").replace(/\/+$/, "").toLowerCase();
  return key(left) === key(right);
}

export function normalizeAttachment(file: ChatAttachment): ChatAttachment {
  const normalized: ChatAttachment = { path: file.path, name: file.name || file.path.split(/[\\/]/).pop() || file.path };
  if (file.kind === "file" || file.kind === "folder") normalized.kind = file.kind;
  if (file.source === "chat" || file.source === "workspace") normalized.source = file.source;
  if (file.storedPath) normalized.storedPath = file.storedPath;
  if (file.originalPath) normalized.originalPath = file.originalPath;
  if (file.previewDataUrl?.startsWith("data:image/")) normalized.previewDataUrl = file.previewDataUrl;
  if (Number.isSafeInteger(file.contextTokens) && (file.contextTokens ?? -1) >= 0) normalized.contextTokens = file.contextTokens;
  return normalized;
}
