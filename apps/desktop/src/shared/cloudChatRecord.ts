import type { CloudChatRecord, CloudWorkspace } from "./cloud";
import { chatTitleFromFirstMessage } from "./chatTitle";

/** The archive and incoming stream share the same summary and local chat title rules. */
export function cloudChatRecord(workspace: CloudWorkspace): CloudChatRecord {
  return { key: workspace.key, provider: workspace.provider, state: workspace.state,
    title: chatTitleFromFirstMessage(workspace.entries.find(entry => entry.kind === "instruction")?.text || ""),
    paths: workspace.paths || [workspace.path], repositoryIds: workspace.repositoryIds,
    updatedAt: workspace.lastActiveAt || workspace.entries.at(-1)?.at || "" };
}
