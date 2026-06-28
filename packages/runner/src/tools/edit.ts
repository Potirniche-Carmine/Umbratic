import * as fs from "node:fs";
import { ensureReadableText, resolveWorkspacePath, toolError, type ToolContext, type ToolResult } from "./common.js";

export async function editTool(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const filePath = typeof input.filePath === "string" ? input.filePath : typeof input.path === "string" ? input.path : "";
  const oldText = typeof input.oldText === "string" ? input.oldText : "";
  const newText = typeof input.newText === "string" ? input.newText : "";
  if (!oldText) throw toolError("validation_error", "invalid_arguments", "edit requires oldText");
  const { absolute, relative } = resolveWorkspacePath(ctx.cwd, filePath);
  const current = ensureReadableText(absolute);
  if (!current.includes(oldText)) {
    throw toolError("validation_error", "invalid_arguments", `Text to replace was not found in ${relative}`);
  }
  const decision = await ctx.askPermission({
    permissionKind: "edit",
    summary: `edit ${relative}`,
    autoAllow: ctx.permissionMode === "bypass",
  });
  if (decision !== "allow") throw toolError("permission_denied", "permission_denied", `Edit denied: ${relative}`);
  fs.writeFileSync(absolute, current.replace(oldText, newText), "utf8");
  return { title: relative, output: "Edited file successfully.", status: "success" };
}
