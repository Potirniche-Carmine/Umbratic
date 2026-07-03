import * as fs from "node:fs";
import { ensureReadableText, resolveWorkspacePath, type ToolContext, type ToolResult } from "./common.js";
import { parseLocationSuffix } from "./searchQuery.js";
import { getWorkspaceIndex, listIndexedDirectoryEntries } from "./workspaceIndex.js";

const maxReadOutputBytes = 60 * 1024;
const maxDirectoryDepth = 6;

function limitReadOutput(output: string): string {
  const buffer = Buffer.from(output, "utf8");
  if (buffer.length <= maxReadOutputBytes) return output;
  const clipped = buffer.subarray(0, maxReadOutputBytes).toString("utf8").replace(/\uFFFD$/u, "");
  return `${clipped}\n...[truncated: read output exceeded ${maxReadOutputBytes} bytes; use offset/limit to continue]`;
}

function directoryOutput(relative: string, depth: number, entries: string[]): string {
  const title = relative || ".";
  const body = entries.join("\n") || "(empty directory)";
  return `Directory: ${title}\nDepth: ${depth}\nEntries:\n${body}`;
}

export async function readTool(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  let filePath = typeof input.filePath === "string" ? input.filePath : typeof input.path === "string" ? input.path : "";
  const hasExplicitOffset = typeof input.offset === "number" && input.offset > 0;
  let offset = hasExplicitOffset ? Math.floor(input.offset as number) : 1;
  const limit = typeof input.limit === "number" && input.limit > 0 ? Math.min(Math.floor(input.limit), 500) : 500;
  const depth = typeof input.depth === "number" && input.depth > 0 ? Math.min(Math.floor(input.depth), maxDirectoryDepth) : 1;

  if (!hasExplicitOffset) {
    const location = parseLocationSuffix(filePath);
    if (location) {
      try {
        const resolved = resolveWorkspacePath(ctx.cwd, location.pathQuery);
        if (fs.statSync(resolved.absolute).isFile()) {
          filePath = location.pathQuery;
          offset = Math.max(1, location.line - 5);
        }
      } catch {
        // If the suffix is not a readable workspace file, fall back to normal path resolution.
      }
    }
  }

  const { absolute, relative } = resolveWorkspacePath(ctx.cwd, filePath);
  const stat = fs.statSync(absolute);
  if (stat.isDirectory()) {
    const index = getWorkspaceIndex(ctx.cwd);
    const entries = listIndexedDirectoryEntries(index, relative, depth);
    const selected = entries.slice(offset - 1, offset - 1 + limit);
    return {
      title: relative || ".",
      output: limitReadOutput(directoryOutput(relative, depth, selected)),
      status: "success",
    };
  }
  const lines = ensureReadableText(absolute).replace(/\r\n/g, "\n").split("\n");
  getWorkspaceIndex(ctx.cwd).recordRead(relative);
  const selected = lines.slice(offset - 1, offset - 1 + limit).map((line, index) => `${offset + index}: ${line}`);
  return { title: relative, output: limitReadOutput(selected.join("\n")), status: "success" };
}
