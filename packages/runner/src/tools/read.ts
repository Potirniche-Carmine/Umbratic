import * as fs from "node:fs";
import * as path from "node:path";
import { ensureReadableText, normalizeRelativePath, resolveWorkspacePath, shouldSkipEntry, type ToolContext, type ToolResult } from "./common.js";

const maxReadOutputBytes = 60 * 1024;
const maxDirectoryDepth = 6;

function limitReadOutput(output: string): string {
  const buffer = Buffer.from(output, "utf8");
  if (buffer.length <= maxReadOutputBytes) return output;
  const clipped = buffer.subarray(0, maxReadOutputBytes).toString("utf8").replace(/\uFFFD$/u, "");
  return `${clipped}\n...[truncated: read output exceeded ${maxReadOutputBytes} bytes; use offset/limit to continue]`;
}

function directoryEntries(cwd: string, directory: string, depth: number): string[] {
  const rows: string[] = [];
  const root = path.resolve(directory);
  const walk = (current: string, currentDepth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries = entries
      .filter((entry) => {
        const workspaceRelative = `${normalizeRelativePath(path.relative(cwd, path.join(current, entry.name)))}${entry.isDirectory() ? "/" : ""}`;
        return !shouldSkipEntry(workspaceRelative);
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = normalizeRelativePath(path.relative(root, absolute));
      rows.push(`${relative}${entry.isDirectory() ? "/" : ""}`);
      if (entry.isDirectory() && currentDepth < depth) {
        walk(absolute, currentDepth + 1);
      }
    }
  };
  walk(root, 1);
  return rows;
}

export async function readTool(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const filePath = typeof input.filePath === "string" ? input.filePath : typeof input.path === "string" ? input.path : "";
  const offset = typeof input.offset === "number" && input.offset > 0 ? Math.floor(input.offset) : 1;
  const limit = typeof input.limit === "number" && input.limit > 0 ? Math.min(Math.floor(input.limit), 500) : 500;
  const depth = typeof input.depth === "number" && input.depth > 0 ? Math.min(Math.floor(input.depth), maxDirectoryDepth) : 1;
  const { absolute, relative } = resolveWorkspacePath(ctx.cwd, filePath);
  const stat = fs.statSync(absolute);
  if (stat.isDirectory()) {
    const entries = directoryEntries(ctx.cwd, absolute, depth);
    return {
      title: relative || ".",
      output: limitReadOutput(entries.slice(offset - 1, offset - 1 + limit).join("\n") || "(empty directory)"),
      status: "success",
    };
  }
  const lines = ensureReadableText(absolute).replace(/\r\n/g, "\n").split("\n");
  const selected = lines.slice(offset - 1, offset - 1 + limit).map((line, index) => `${offset + index}: ${line}`);
  return { title: relative, output: limitReadOutput(selected.join("\n")), status: "success" };
}
