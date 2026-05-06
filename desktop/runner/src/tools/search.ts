import * as fs from "node:fs";
import * as path from "node:path";
import { ensureReadableText, normalizeRelativePath, shouldSkipEntry, type ToolContext, type ToolResult } from "./common.js";

export async function searchTool(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
  const limit = typeof input.limit === "number" ? Math.min(Math.max(Math.floor(input.limit), 1), 100) : 50;
  if (!query) throw new Error("search requires query");
  const results: string[] = [];
  const stack = [ctx.cwd];
  while (stack.length && results.length < limit) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = normalizeRelativePath(path.relative(ctx.cwd, absolute));
      if (shouldSkipEntry(relative)) continue;
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (relative.toLowerCase().includes(query)) {
        results.push(`${relative}: path`);
        continue;
      }
      try {
        const text = ensureReadableText(absolute).toLowerCase();
        if (text.includes(query)) results.push(`${relative}: content`);
      } catch {
        continue;
      }
      if (results.length >= limit) break;
    }
  }
  return { title: "search", output: results.join("\n") || "No matches." };
}
