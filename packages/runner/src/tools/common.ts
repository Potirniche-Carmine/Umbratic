import * as fs from "node:fs";
import * as path from "node:path";
import { isBlockedPath, isGeneratedRuntimePath } from "../policy.js";
import type { RunnerToolName } from "../config.js";

export type ToolContext = {
  taskId: string;
  cwd: string;
  permissionMode: "normal" | "bypass";
  enabledTools: readonly RunnerToolName[];
  askPermission(input: { permissionKind: string; summary: string; autoAllow: boolean }): Promise<"allow" | "deny">;
  emitToolOutput(toolCallId: string, stream: "stdout" | "stderr", text: string): void;
};

export type ToolResult = {
  title: string;
  output: string;
  exitCode?: number | null;
};

export function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

export function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveWorkspacePath(cwd: string, filePath: string): { absolute: string; relative: string } {
  let requestedPath = normalizeRelativePath(filePath);
  let absolute = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd, requestedPath);
  if (!path.isAbsolute(filePath) && !fs.existsSync(absolute)) {
    const rootName = path.basename(path.resolve(cwd)).toLowerCase();
    const parts = requestedPath.split("/").filter(Boolean);
    if (parts[0]?.toLowerCase() === rootName) {
      const withoutRootName = parts.slice(1).join("/");
      const fallbackAbsolute = path.resolve(cwd, withoutRootName);
      if (fs.existsSync(fallbackAbsolute)) {
        requestedPath = withoutRootName;
        absolute = fallbackAbsolute;
      }
    }
  }
  if (!pathInside(cwd, absolute)) throw new Error(`Refusing path outside workspace: ${filePath}`);
  const relative = normalizeRelativePath(path.relative(cwd, absolute));
  if (isBlockedPath(relative)) throw new Error(`Refusing blocked path: ${relative}`);
  return { absolute, relative };
}

export function ensureReadableText(filePath: string): string {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error("Path is not a file");
  if (stat.size > 512 * 1024) throw new Error("File is too large to read through this tool");
  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) throw new Error("Refusing to read binary file");
  return buffer.toString("utf8");
}

export function shouldSkipEntry(relative: string): boolean {
  return !relative || isGeneratedRuntimePath(relative) || isBlockedPath(relative);
}
