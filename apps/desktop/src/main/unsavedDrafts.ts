import type { ChatAttachment } from "./types";
import { isRecord } from "./utils";

/**
 * What the user typed into a chat that does not exist yet.
 *
 * A saved chat has a row to hold its draft, so switching away and back keeps the
 * text. A brand-new chat has no row until the first message is sent, so the same
 * switch used to throw the text away — the one case where losing a draft was
 * possible.
 *
 * This is deliberately memory only. A draft for a chat that was never created is
 * scratch work, not user data: it should survive moving around the app, and it
 * should not outlive the app itself or leave anything behind on disk to clean up.
 * That is why it does not go to SQLite alongside the saved-chat drafts.
 */
export type UnsavedDraft = {
  draftPrompt: string;
  attachedFiles: ChatAttachment[];
};

/**
 * Keyed by workspace, because "New chat" is per project in the sidebar: a draft
 * started against one folder should still be there after visiting another.
 * The empty string is the no-folder-selected scope.
 */
const drafts = new Map<string, UnsavedDraft>();

/** Enough for every project a user has open, small enough to stay incidental. */
const maxScopes = 64;
const maxDraftChars = 100_000;

const emptyDraft: UnsavedDraft = { draftPrompt: "", attachedFiles: [] };

function scopeKey(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function readUnsavedDraft(input: unknown): UnsavedDraft {
  if (!isRecord(input)) return emptyDraft;
  return drafts.get(scopeKey(input.scope)) ?? emptyDraft;
}

export function writeUnsavedDraft(input: unknown): UnsavedDraft {
  if (!isRecord(input)) return emptyDraft;
  const scope = scopeKey(input.scope);
  const draftPrompt = typeof input.draftPrompt === "string" ? input.draftPrompt.slice(0, maxDraftChars) : "";
  const attachedFiles = Array.isArray(input.attachedFiles) ? (input.attachedFiles as ChatAttachment[]) : [];

  // An empty draft is the absence of one. Keeping the entry would mean the map
  // only ever grew, one row per folder the user ever opened.
  if (!draftPrompt && attachedFiles.length === 0) {
    drafts.delete(scope);
    return emptyDraft;
  }

  // Re-insert so the map stays in least-recently-written order and the oldest
  // scope is the one evicted at the cap.
  drafts.delete(scope);
  drafts.set(scope, { draftPrompt, attachedFiles });
  while (drafts.size > maxScopes) {
    const oldest = drafts.keys().next();
    if (oldest.done) break;
    drafts.delete(oldest.value);
  }
  return drafts.get(scope) ?? emptyDraft;
}

/** Called once the draft has become a real chat with a row of its own. */
export function clearUnsavedDraft(input: unknown): { ok: true } {
  if (isRecord(input)) drafts.delete(scopeKey(input.scope));
  return { ok: true };
}
