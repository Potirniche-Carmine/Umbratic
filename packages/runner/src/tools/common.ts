import * as fs from "node:fs";
import * as path from "node:path";
import { isBlockedPath, isGeneratedRuntimePath } from "../policy.js";
import type { RunnerToolName } from "../config.js";

export type ToolResultStatus =
  | "success"
  | "permission_denied"
  | "policy_blocked"
  | "validation_error"
  | "runtime_error"
  | "timeout";

export type ToolErrorCode =
  | "tool_disabled"
  | "unknown_tool"
  | "invalid_arguments"
  | "permission_denied"
  | "policy_blocked"
  | "workspace_boundary"
  | "blocked_path"
  | "command_exit_nonzero"
  | "process_timeout"
  | "process_error"
  | "missing_dependency"
  | "runtime_error";

export class ToolExecutionError extends Error {
  readonly status: ToolResultStatus;
  readonly errorCode: ToolErrorCode;

  constructor(status: ToolResultStatus, errorCode: ToolErrorCode, message: string) {
    super(message);
    this.name = "ToolExecutionError";
    this.status = status;
    this.errorCode = errorCode;
  }
}

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
  status: ToolResultStatus;
  errorCode?: ToolErrorCode;
  errorMessage?: string;
  exitCode?: number | null;
};

export function toolError(status: ToolResultStatus, errorCode: ToolErrorCode, message: string): ToolExecutionError {
  return new ToolExecutionError(status, errorCode, message);
}

export function toolFailureDetails(error: unknown): { status: ToolResultStatus; errorCode: ToolErrorCode; message: string } {
  if (error instanceof ToolExecutionError) {
    return { status: error.status, errorCode: error.errorCode, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/denied/i.test(message)) {
    return { status: "permission_denied", errorCode: "permission_denied", message };
  }
  if (/outside workspace/i.test(message)) {
    return { status: "policy_blocked", errorCode: "workspace_boundary", message };
  }
  if (/blocked path/i.test(message)) {
    return { status: "policy_blocked", errorCode: "blocked_path", message };
  }
  if (/blocked by policy|bare python/i.test(message)) {
    return { status: "policy_blocked", errorCode: "policy_blocked", message };
  }
  if (/requires|not found|not a file|too large|binary|text to replace/i.test(message)) {
    return { status: "validation_error", errorCode: "invalid_arguments", message };
  }
  return { status: "runtime_error", errorCode: "runtime_error", message };
}

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
  if (!pathInside(cwd, absolute)) {
    throw toolError("policy_blocked", "workspace_boundary", `Refusing path outside workspace: ${filePath}`);
  }
  const relative = normalizeRelativePath(path.relative(cwd, absolute));
  if (isBlockedPath(relative)) throw toolError("policy_blocked", "blocked_path", `Refusing blocked path: ${relative}`);
  return { absolute, relative };
}

export function ensureReadableText(filePath: string): string {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw toolError("validation_error", "invalid_arguments", "Path is not a file");
  if (stat.size > 512 * 1024) {
    throw toolError("validation_error", "invalid_arguments", "File is too large to read through this tool");
  }
  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) throw toolError("validation_error", "invalid_arguments", "Refusing to read binary file");
  return buffer.toString("utf8");
}

export function shouldSkipEntry(relative: string): boolean {
  return !relative || isGeneratedRuntimePath(relative) || isBlockedPath(relative);
}
