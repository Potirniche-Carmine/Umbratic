import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureReadableText, normalizeRelativePath, shouldSkipEntry, type ToolContext, type ToolResult } from "./common.js";

function commandAvailable(command: string): boolean {
  const lookup =
    process.platform === "win32"
      ? spawnSync("where.exe", [command], { encoding: "utf8", windowsHide: true, timeout: 5000 })
      : spawnSync("sh", ["-c", `command -v '${command.replace(/'/g, "'\\''")}'`], { encoding: "utf8", timeout: 5000 });
  return lookup.status === 0;
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function fdCommand(): "fd" | "fdfind" | null {
  if (commandAvailable("fd")) return "fd";
  if (commandAvailable("fdfind")) return "fdfind";
  return null;
}

function pathMatchesWithFd(ctx: ToolContext, query: string, limit: number): string[] {
  const command = fdCommand();
  if (!command) return [];
  const result = spawnSync(
    command,
    [".", "--type", "f", "--hidden", "--exclude", ".git", "--exclude", "node_modules", "--exclude", ".aegis", "--exclude", ".venv"],
    { cwd: ctx.cwd, encoding: "utf8", windowsHide: true, timeout: 8000 },
  );
  if (result.status !== 0 && !result.stdout) return [];
  return splitLines(result.stdout)
    .map((file) => normalizeRelativePath(file))
    .filter((file) => !shouldSkipEntry(file) && file.toLowerCase().includes(query))
    .slice(0, limit)
    .map((file) => `${file}: path`);
}

function contentMatchesWithRg(ctx: ToolContext, query: string, limit: number): string[] {
  if (!commandAvailable("rg")) return [];
  const result = spawnSync(
    "rg",
    [
      "--line-number",
      "--ignore-case",
      "--fixed-strings",
      "--hidden",
      "--glob",
      "!.git/**",
      "--glob",
      "!node_modules/**",
      "--glob",
      "!.aegis/**",
      "--glob",
      "!.venv/**",
      query,
    ],
    { cwd: ctx.cwd, encoding: "utf8", windowsHide: true, timeout: 8000, maxBuffer: 512 * 1024 },
  );
  if (result.status !== 0 && !result.stdout) return [];
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const line of splitLines(result.stdout)) {
    const [file, lineNumber] = line.split(":", 3);
    const relative = normalizeRelativePath(file ?? "");
    if (!relative || shouldSkipEntry(relative) || seen.has(`${relative}:${lineNumber}`)) continue;
    seen.add(`${relative}:${lineNumber}`);
    matches.push(`${relative}:${lineNumber ?? "?"}: content`);
    if (matches.length >= limit) break;
  }
  return matches;
}

function fallbackSearch(ctx: ToolContext, query: string, limit: number): string[] {
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
  return results;
}

export async function searchTool(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const rawQuery = typeof input.query === "string" ? input.query.trim() : "";
  const query = rawQuery.toLowerCase();
  const limit = typeof input.limit === "number" ? Math.min(Math.max(Math.floor(input.limit), 1), 100) : 50;
  if (!query) throw new Error("search requires query");
  const fastResults = [...pathMatchesWithFd(ctx, query, limit), ...contentMatchesWithRg(ctx, rawQuery, limit)];
  const results = fastResults.length ? fastResults.slice(0, limit) : fallbackSearch(ctx, query, limit);
  return { title: "search", output: results.join("\n") || "No matches." };
}
