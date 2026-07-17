import * as fs from "node:fs";
import * as path from "node:path";

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

export function materializeChatAttachments(rootPath: string, attachments: readonly ChatAttachment[]): ChatAttachment[] {
  const root = path.resolve(rootPath);
  const attachmentDirectory = path.join(root, "attachments");
  let directoryCreated = false;

  return attachments.map((file) => {
    if (file.source !== "chat" || !file.storedPath) return file;
    const source = path.resolve(file.storedPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(source);
    } catch {
      return file;
    }
    if (!stat.isFile()) return file;
    if (!directoryCreated) {
      fs.mkdirSync(attachmentDirectory, { recursive: true });
      directoryCreated = true;
    }
    const storedName = path.basename(source);
    const destination = path.join(attachmentDirectory, storedName);
    if (source !== destination) fs.copyFileSync(source, destination);
    return { ...file, path: `attachments/${storedName}` };
  });
}
