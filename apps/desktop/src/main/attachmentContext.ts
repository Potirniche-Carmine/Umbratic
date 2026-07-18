import type { BackendUiEvent, ChatAttachment } from "./types";

function attachmentKey(file: ChatAttachment): string {
  return file.storedPath || `${file.source ?? "unknown"}:${file.path}`;
}

export function priorChatAttachments(
  events: readonly BackendUiEvent[],
  currentUserPrompt = "",
  limit = 16,
): ChatAttachment[] {
  if (limit <= 0) return [];

  const currentPrompt = currentUserPrompt.trim();
  let currentMessageIndex = -1;
  if (currentPrompt) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.type !== "user.message") continue;
      if (event.text.trim() === currentPrompt) currentMessageIndex = index;
      break;
    }
  }

  const seen = new Set<string>();
  const files: ChatAttachment[] = [];
  for (let eventIndex = events.length - 1; eventIndex >= 0 && files.length < limit; eventIndex -= 1) {
    if (eventIndex === currentMessageIndex) continue;
    const event = events[eventIndex];
    if (event.type !== "user.message") continue;
    const attachedFiles = event.attachedFiles ?? [];
    for (let fileIndex = attachedFiles.length - 1; fileIndex >= 0 && files.length < limit; fileIndex -= 1) {
      const file = attachedFiles[fileIndex];
      const key = attachmentKey(file);
      if (seen.has(key)) continue;
      seen.add(key);
      files.unshift(file);
    }
  }
  return files;
}

function normalizedReviewPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * Returns only the exact paths that older project-less chats copied into their
 * scratch workspace. Real repository tasks always return an empty exclusion so
 * a user file with the same path remains reviewable.
 */
export function materializedChatAttachmentReviewPaths(
  events: readonly BackendUiEvent[],
  hiddenChat: boolean,
): Set<string> {
  const paths = new Set<string>();
  if (!hiddenChat) return paths;
  for (const event of events) {
    if (event.type !== "user.message") continue;
    for (const file of event.attachedFiles ?? []) {
      if (file.source !== "chat" || !file.storedPath) continue;
      const relative = normalizedReviewPath(file.path);
      if (relative.startsWith("attachments/") && relative.length > "attachments/".length) {
        paths.add(relative);
      }
    }
  }
  return paths;
}
