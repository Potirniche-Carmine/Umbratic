import type { ChatAttachment, DesktopApi } from "../shared/desktopApi";

/**
 * Composer-side handling for the draft of a chat that does not exist yet.
 *
 * A saved chat keeps its draft in its own row. A new one has no row until the
 * first message is sent, so without this its text was lost the moment the user
 * looked at another chat. The store behind it is main-process memory, not
 * SQLite: scratch work should survive moving around the app and nothing more.
 */

/** Which new-chat draft the composer is editing: the workspace it belongs to. */
export function unsavedDraftScopeFor(repositoryRootPath: string | undefined): string {
  return repositoryRootPath ?? "";
}

type RestoreTargets = {
  activeChatId: () => string | null;
  setPrompt: (update: (current: string) => string) => void;
  setAttachedFiles: (update: (current: ChatAttachment[]) => ChatAttachment[]) => void;
};

/**
 * Puts back whatever was typed into this workspace's new chat.
 *
 * The read is asynchronous, so it re-checks on arrival that the composer is
 * still on an unsaved chat and still empty. Without that, a user who started
 * typing immediately would have their first keystrokes overwritten by a restore
 * that resolved a moment later.
 */
export async function restoreUnsavedDraft(
  api: Pick<DesktopApi, "getUnsavedDraft">,
  scope: string,
  targets: RestoreTargets,
): Promise<void> {
  try {
    const draft = await api.getUnsavedDraft({ scope });
    if (!draft.draftPrompt && draft.attachedFiles.length === 0) return;
    if (targets.activeChatId() !== null) return;
    targets.setPrompt((current) => (current ? current : draft.draftPrompt));
    targets.setAttachedFiles((current) => (current.length ? current : draft.attachedFiles));
  } catch {
    // A draft that cannot be read is the same as not having one.
  }
}
