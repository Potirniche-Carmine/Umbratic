import * as fs from "node:fs";
import * as path from "node:path";
import { resolveWorkspacePath, throwIfToolAborted, toolError, type ToolContext, type ToolResult } from "./common.js";

export async function writeTool(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  throwIfToolAborted(ctx);
  const filePath = typeof input.filePath === "string" ? input.filePath : typeof input.path === "string" ? input.path : "";
  const content = typeof input.content === "string" ? input.content : "";
  const { absolute, relative } = resolveWorkspacePath(ctx.cwd, filePath);
  const decision = await ctx.askPermission({
    permissionKind: "edit",
    summary: `write ${relative}`,
    autoAllow: ctx.permissionMode === "bypass",
  });
  if (decision !== "allow") throw toolError("permission_denied", "permission_denied", `Write denied: ${relative}`);
  throwIfToolAborted(ctx);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, "utf8");
  return { title: relative, output: "Wrote file successfully.", status: "success" };
}
