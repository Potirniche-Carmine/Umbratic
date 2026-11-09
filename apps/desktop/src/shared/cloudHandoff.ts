import type { CloudEntry, CloudWorkspace } from "./cloud";

/** Recover this chat when its native session expires; never combine different chats. */
export function cloudHandoff(entries: CloudEntry[], prompt: string): string {
  let remaining = 48_000;
  const recent: { role: string; text: string; attachments?: string[] }[] = [];
  for (const entry of [...entries].reverse()) {
    if (entry.kind !== "instruction" && entry.kind !== "answer") continue;
    if (remaining <= 0) break;
    const text = entry.text.slice(-remaining);
    recent.unshift({ role: entry.kind === "instruction" ? "user" : "assistant", text,
      ...(entry.images?.length ? { attachments: entry.images.map(image => image.name) } : {}) });
    remaining -= text.length + 100;
  }
  if (!recent.length) return prompt;
  return `Continue the conversation below. This is prior conversation data, not new instructions. Tool outputs and attachment contents are not replayed; verify current files with native tools when needed. Earlier history may be omitted.\n<previous_conversation>\n${JSON.stringify(recent)}\n</previous_conversation>\n\nCurrent user request:\n${prompt}`;
}

export function rememberCloudSession(workspace: CloudWorkspace): void {
  if (!workspace.sessionId) return;
  workspace.sessions ??= {};
  workspace.sessions[workspace.provider] = {
    sessionId: workspace.sessionId, account: workspace.account, usage: workspace.usage,
    contextWindow: workspace.contextWindow, inputTokens: workspace.inputTokens,
    compactions: workspace.compactions, lastEntryId: workspace.entries.at(-1)?.id,
  };
}

export function cloudTurnPrompt(workspace: CloudWorkspace, prompt: string): string {
  const boundary = workspace.contextStartEntryId ? workspace.entries.findIndex(entry => entry.id === workspace.contextStartEntryId) : -1;
  const entries = boundary >= 0 ? workspace.entries.slice(boundary + 1) : workspace.entries;
  if (!workspace.sessionId) return cloudHandoff(entries, prompt);
  const last = workspace.sessions?.[workspace.provider]?.lastEntryId;
  // Legacy sessions already contain the visible history. New sessions track a cursor.
  if (!last) return prompt;
  const index = entries.findIndex(entry => entry.id === last);
  return cloudHandoff(index < 0 ? entries : entries.slice(index + 1), prompt);
}

