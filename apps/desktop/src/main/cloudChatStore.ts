import { createHash } from "node:crypto";
import { isCloudProvider, type CloudChatRecord, type CloudProvider, type CloudWorkspace } from "../shared/cloud";
import { withAppDatabase } from "./storageDatabase";

export function cloudWorkspaceKey(provider: CloudProvider | "shared", paths: string[], chatId?: string): string {
  return createHash("sha256").update(`${provider}\0${[...paths].sort().join("\0")}${chatId ? `\0${chatId}` : ""}`).digest("hex");
}

/** Move the former shared conversation to its last provider, once, without replaying it to another. */
export function storedCloudWorkspaces(): CloudWorkspace[] {
  return withAppDatabase(db => {
    const rows = db.prepare("SELECT key, payload FROM settings WHERE key GLOB 'cloud:workspace:*'").all() as { key: string; payload: string }[];
    const result = new Map<string, CloudWorkspace>();
    for (const row of rows) {
      let workspace: CloudWorkspace;
      try { workspace = JSON.parse(row.payload); } catch { continue; }
      if (!workspace || !isCloudProvider(workspace.provider) || typeof workspace.path !== "string" || !Array.isArray(workspace.entries)) continue;
      const paths = workspace.paths?.length ? workspace.paths : [workspace.path];
      const sharedKey = cloudWorkspaceKey("shared", paths);
      if (row.key === `cloud:workspace:${sharedKey}`) {
        const key = cloudWorkspaceKey(workspace.provider, paths, "legacy-shared");
        workspace = { ...workspace, key, chatId: "legacy-shared", paths,
          sessions: workspace.sessions?.[workspace.provider] ? { [workspace.provider]: workspace.sessions[workspace.provider] } : undefined };
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("INSERT OR IGNORE INTO settings (key, payload) VALUES (?, ?)").run(`cloud:workspace:${key}`, JSON.stringify(workspace));
          db.prepare("DELETE FROM settings WHERE key = ?").run(row.key);
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      } else if (row.key !== `cloud:workspace:${workspace.key}`) continue;
      result.set(workspace.key, workspace);
    }
    return [...result.values()];
  });
}

export function cloudChatRecord(workspace: CloudWorkspace): CloudChatRecord {
  const prompt = workspace.entries.find(entry => entry.kind === "instruction")?.text.trim().replace(/\s+/g, " ");
  return { key: workspace.key, provider: workspace.provider, state: workspace.state,
    title: prompt ? prompt.slice(0, 100) : "New chat", paths: workspace.paths || [workspace.path], repositoryIds: workspace.repositoryIds,
    updatedAt: workspace.lastActiveAt || workspace.entries.at(-1)?.at || "" };
}
