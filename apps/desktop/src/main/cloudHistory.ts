import type { CloudProvider, CloudWorkspace } from "../shared/cloud";
import { deleteCloudImages } from "./cloudImages";
import { withAppDatabase } from "./storageDatabase";

/** Remove only this chat. Other providers and chats may still reference its attachments. */
export function deleteCloudHistory(workspace: CloudWorkspace, liveWorkspaces: Iterable<CloudWorkspace>, pendingImageIds: string[] = []): void {
  const keys = new Set([`cloud:workspace:${workspace.key}`]);
  const removed = new Set<string>();
  const retained = new Set<string>(pendingImageIds);
  function collect(value: Pick<CloudWorkspace, "entries">, into: Set<string>): void {
    for (const entry of value.entries || []) for (const image of entry.images || []) into.add(image.id);
  }
  collect(workspace, removed);
  for (const other of liveWorkspaces) if (other.key !== workspace.key) collect(other, retained);
  withAppDatabase(db => {
    const rows = db.prepare("SELECT key, payload FROM settings WHERE key GLOB 'cloud:workspace:*'").all() as { key: string; payload: string }[];
    for (const row of rows) collect(JSON.parse(row.payload), keys.has(row.key) ? removed : retained);
    // Delete only this conversation's unused copies. Drafts and other chats stay intact.
    deleteCloudImages([...removed].filter(id => !retained.has(id)));
    const secureDelete = Number((db.prepare("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete);
    db.exec("PRAGMA secure_delete = ON; BEGIN IMMEDIATE;");
    try {
      const remove = db.prepare("DELETE FROM settings WHERE key = ?");
      for (const key of keys) remove.run(key);
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    } finally {
      db.exec(`PRAGMA secure_delete = ${secureDelete};`);
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  });
}

export function forgetCloudProviderSession(workspace: CloudWorkspace, provider: CloudProvider): void {
  if (workspace.sessions) delete workspace.sessions[provider];
  if (workspace.provider !== provider) return;
  workspace.sessionId = undefined; workspace.account = undefined; workspace.usage = undefined;
  workspace.contextWindow = undefined; workspace.inputTokens = undefined; workspace.compactions = 0;
}

export function forgetStoredCloudProvider(provider: CloudProvider): void {
  withAppDatabase(db => {
    const rows = db.prepare("SELECT key, payload FROM settings WHERE key GLOB 'cloud:workspace:*'").all() as { key: string; payload: string }[];
    const update = db.prepare("UPDATE settings SET payload = ? WHERE key = ?");
    for (const row of rows) {
      let workspace: CloudWorkspace;
      try { workspace = JSON.parse(row.payload); } catch { continue; }
      if (!workspace || !Array.isArray(workspace.entries)) continue;
      forgetCloudProviderSession(workspace, provider);
      update.run(JSON.stringify(workspace), row.key);
    }
    db.prepare("DELETE FROM settings WHERE key GLOB ?").run(`cloud:usage:${provider}:*`);
  });
}
