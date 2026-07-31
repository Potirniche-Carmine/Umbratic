import * as fs from "node:fs";

import { estimateAttachmentTextTokens } from "../shared/contextWindow";
import type { BackendUiEvent, ChatAttachment } from "./types";

const chatAttachmentByteLimit = 25 * 1024 * 1024;

export function readAttachmentTextIfSafe(filePath: string): string | null {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > chatAttachmentByteLimit) return null;
    const buffer = fs.readFileSync(filePath);
    if (buffer.includes(0)) return null;
    return buffer.toString("utf8");
  } catch {
    return null;
  }
}

export function attachmentContextTokens(filePath: string): number | undefined {
  const text = readAttachmentTextIfSafe(filePath);
  return text === null ? undefined : estimateAttachmentTextTokens(text);
}

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
