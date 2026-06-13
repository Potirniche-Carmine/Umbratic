import * as fs from "node:fs";
import * as path from "node:path";
import { ensureReadableText, resolveWorkspacePath, shouldSkipEntry, type ToolContext, type ToolResult } from "./common.js";

function readPermissionSummary(relative: string, isDirectory: boolean, offset: number, limit: number): string {
  const target = relative || ".";
  const range = isDirectory
    ? `entries ${offset}-${offset + limit - 1}`
    : `lines ${offset}-${offset + limit - 1}`;
  return `read ${isDirectory ? "directory" : "file"} ${target} (${range})`;
}

export async function readTool(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const filePath = typeof input.filePath === "string" ? input.filePath : typeof input.path === "string" ? input.path : "";
  const offset = typeof input.offset === "number" && input.offset > 0 ? Math.floor(input.offset) : 1;
  const limit = typeof input.limit === "number" && input.limit > 0 ? Math.min(Math.floor(input.limit), 2000) : 2000;
  const { absolute, relative } = resolveWorkspacePath(ctx.cwd, filePath);
  const stat = fs.statSync(absolute);
  const decision = await ctx.askPermission({
    permissionKind: "read",
    summary: readPermissionSummary(relative, stat.isDirectory(), offset, limit),
    autoAllow: ctx.permissionMode === "bypass",
  });
  if (decision !== "allow") throw new Error("Read denied.");
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(absolute, { withFileTypes: true })
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .filter((entry) => !shouldSkipEntry(path.posix.join(relative, entry)))
      .sort((left, right) => left.localeCompare(right));
    return { title: relative || ".", output: entries.slice(offset - 1, offset - 1 + limit).join("\n") || "(empty directory)" };
  }
  const lines = ensureReadableText(absolute).replace(/\r\n/g, "\n").split("\n");
  const selected = lines.slice(offset - 1, offset - 1 + limit).map((line, index) => `${offset + index}: ${line}`);
  return { title: relative, output: selected.join("\n") };
}
