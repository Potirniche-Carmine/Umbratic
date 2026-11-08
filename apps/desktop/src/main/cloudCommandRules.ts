import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CloudAllowedCommand, CloudApproval, CloudWorkspace } from "../shared/cloud";
import { withAppDatabase } from "./storageDatabase";

// Exact commands only. A shell prefix is not enough to authorize a compound command.
export function commandRule(workspace: CloudWorkspace, request: Omit<CloudApproval, "id">): CloudAllowedCommand | undefined {
  const command = request.command;
  if (request.questions || !command || typeof command.command !== "string" || !command.command.trim() || command.command.length > 100_000 ||
      typeof command.cwd !== "string" || !path.isAbsolute(command.cwd) || command.context !== undefined && typeof command.context !== "string") return;
  let cwd: string;
  try { cwd = fs.realpathSync(command.cwd); } catch { return; }
  const roots = [...new Set(workspace.paths || [workspace.path])].sort();
  const identity = { provider: workspace.provider, account: workspace.account, roots, cwd, command: command.command, context: command.context || "" };
  return { ...identity, id: createHash("sha256").update(JSON.stringify(identity)).digest("hex"), createdAt: new Date().toISOString() };
}
export function listCloudAllowedCommands(): CloudAllowedCommand[] {
  return withAppDatabase(db => {
    const rows = db.prepare("SELECT payload FROM settings WHERE key GLOB 'cloud:command-rule:*'").all() as { payload: string }[];
    return rows.flatMap(row => { try { return [JSON.parse(row.payload) as CloudAllowedCommand]; } catch { return []; } }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
}
export function allowedCloudCommand(rule: CloudAllowedCommand): boolean {
  return withAppDatabase(db => !!db.prepare("SELECT key FROM settings WHERE key = ?").get(`cloud:command-rule:${rule.id}`));
}
export function rememberCloudCommand(rule: CloudAllowedCommand): void {
  withAppDatabase(db => db.prepare("INSERT OR REPLACE INTO settings (key, payload) VALUES (?, ?)").run(`cloud:command-rule:${rule.id}`, JSON.stringify(rule)));
}
export function revokeCloudAllowedCommand(input: { id: string }): void {
  if (typeof input?.id !== "string" || !/^[a-f0-9]{64}$/.test(input.id)) throw new Error("Choose a saved command.");
  withAppDatabase(db => db.prepare("DELETE FROM settings WHERE key = ?").run(`cloud:command-rule:${input.id}`));
}
