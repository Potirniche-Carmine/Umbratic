import * as fs from "node:fs";
import * as path from "node:path";
import { ensureReadableText, resolveWorkspacePath, toolError, type ToolContext, type ToolResult } from "./common.js";

type PatchLine = { kind: "context" | "remove" | "add"; text: string };
type PatchChange = { lines: PatchLine[] };
type PatchOperation =
  | { kind: "add"; filePath: string; lines: string[] }
  | { kind: "delete"; filePath: string }
  | { kind: "update"; filePath: string; moveTo?: string; changes: PatchChange[] };

type PatchSummary = { status: "added" | "deleted" | "modified" | "renamed"; path: string; to?: string };

function isPatchHeader(line: string): boolean {
  return (
    line.startsWith("*** Add File: ") ||
    line.startsWith("*** Delete File: ") ||
    line.startsWith("*** Update File: ") ||
    line === "*** End Patch"
  );
}

function requirePatchPath(rawPath: string, header: string): string {
  const filePath = rawPath.trim();
  if (!filePath) {
    throw toolError("validation_error", "invalid_arguments", `${header} requires a file path`);
  }
  return filePath;
}

function normalizePatchLines(patch: string): string[] {
  const lines = patch.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function flushPatchChange(changes: PatchChange[], current: PatchLine[]) {
  if (current.length === 0) return;
  changes.push({ lines: current.splice(0) });
}

function parsePatch(patch: string): PatchOperation[] {
  const lines = normalizePatchLines(patch);
  if (lines[0] !== "*** Begin Patch") {
    throw toolError("validation_error", "invalid_arguments", "Patch must start with *** Begin Patch");
  }
  const operations: PatchOperation[] = [];
  let index = 1;
  while (index < lines.length) {
    const line = lines[index];
    if (line === "*** End Patch") {
      if (index !== lines.length - 1) {
        throw toolError("validation_error", "invalid_arguments", "Patch has content after *** End Patch");
      }
      if (operations.length === 0) {
        throw toolError("validation_error", "invalid_arguments", "Patch must contain at least one file operation");
      }
      return operations;
    }

    if (line.startsWith("*** Add File: ")) {
      const filePath = requirePatchPath(line.slice("*** Add File: ".length), "*** Add File");
      index += 1;
      const addLines: string[] = [];
      while (index < lines.length && !isPatchHeader(lines[index])) {
        const addLine = lines[index];
        if (!addLine.startsWith("+")) {
          throw toolError("validation_error", "invalid_arguments", `Add File lines must start with + in ${filePath}`);
        }
        addLines.push(addLine.slice(1));
        index += 1;
      }
      if (addLines.length === 0) {
        throw toolError("validation_error", "invalid_arguments", `Add File requires at least one + line: ${filePath}`);
      }
      operations.push({ kind: "add", filePath, lines: addLines });
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      const filePath = requirePatchPath(line.slice("*** Delete File: ".length), "*** Delete File");
      operations.push({ kind: "delete", filePath });
      index += 1;
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      const filePath = requirePatchPath(line.slice("*** Update File: ".length), "*** Update File");
      index += 1;
      let moveTo: string | undefined;
      if (lines[index]?.startsWith("*** Move to: ")) {
        moveTo = requirePatchPath(lines[index].slice("*** Move to: ".length), "*** Move to");
        index += 1;
      }
      const changes: PatchChange[] = [];
      const current: PatchLine[] = [];
      while (index < lines.length && !isPatchHeader(lines[index])) {
        const changeLine = lines[index];
        if (changeLine === "*** End of File") {
          flushPatchChange(changes, current);
          index += 1;
          continue;
        }
        if (changeLine === "@@" || changeLine.startsWith("@@ ")) {
          flushPatchChange(changes, current);
          index += 1;
          continue;
        }
        const marker = changeLine[0];
        if (marker !== " " && marker !== "-" && marker !== "+") {
          throw toolError("validation_error", "invalid_arguments", `Invalid patch line in ${filePath}: ${changeLine}`);
        }
        current.push({
          kind: marker === " " ? "context" : marker === "-" ? "remove" : "add",
          text: changeLine.slice(1),
        });
        index += 1;
      }
      flushPatchChange(changes, current);
      if (!moveTo && !changes.some((change) => change.lines.some((patchLine) => patchLine.kind !== "context"))) {
        throw toolError("validation_error", "invalid_arguments", `Update File requires at least one changed line: ${filePath}`);
      }
      operations.push({ kind: "update", filePath, moveTo, changes });
      continue;
    }

    throw toolError("validation_error", "invalid_arguments", `Unexpected patch line: ${line}`);
  }

  throw toolError("validation_error", "invalid_arguments", "Patch must end with *** End Patch");
}

function textFromPatchLines(lines: PatchLine[], includeKinds: ReadonlySet<PatchLine["kind"]>): string {
  return lines
    .filter((line) => includeKinds.has(line.kind))
    .map((line) => line.text)
    .join("\n");
}

function applyPatchChanges(filePath: string, current: string, changes: PatchChange[]): string {
  let next = current;
  for (const change of changes) {
    if (!change.lines.some((line) => line.kind !== "context")) continue;
    const oldText = textFromPatchLines(change.lines, new Set(["context", "remove"]));
    const newText = textFromPatchLines(change.lines, new Set(["context", "add"]));
    if (oldText === newText) continue;
    if (!oldText) {
      throw toolError("validation_error", "invalid_arguments", `Patch hunk in ${filePath} must include context or removed text`);
    }
    if (!next.includes(oldText)) {
      throw toolError("validation_error", "invalid_arguments", `Patch hunk was not found in ${filePath}`);
    }
    next = next.replace(oldText, newText);
  }
  return next;
}

function readVirtualFile(absolute: string, virtualFiles: Map<string, string | null>): string | null {
  if (virtualFiles.has(absolute)) {
    return virtualFiles.get(absolute) ?? null;
  }
  if (!fs.existsSync(absolute)) return null;
  return ensureReadableText(absolute);
}

function assertPatchTargetDoesNotExist(absolute: string, relative: string, virtualFiles: Map<string, string | null>) {
  const current = readVirtualFile(absolute, virtualFiles);
  if (current !== null) {
    throw toolError("validation_error", "invalid_arguments", `Patch target already exists: ${relative}`);
  }
}

function patchOutput(summaries: PatchSummary[]): string {
  const lines = summaries.map((summary) => {
    if (summary.status === "renamed") return `- renamed ${summary.path} -> ${summary.to}`;
    return `- ${summary.status} ${summary.path}`;
  });
  return [`Patched ${summaries.length} file${summaries.length === 1 ? "" : "s"} successfully.`, ...lines].join("\n");
}

function patchPermissionSummary(summaries: PatchSummary[]): string {
  const files = summaries
    .map((summary) => (summary.status === "renamed" ? `${summary.path} -> ${summary.to}` : summary.path))
    .slice(0, 4)
    .join(", ");
  const suffix = summaries.length > 4 ? `, +${summaries.length - 4} more` : "";
  return `patch ${summaries.length} file${summaries.length === 1 ? "" : "s"}: ${files}${suffix}`;
}

function preparePatch(ctx: ToolContext, patch: string): { files: Map<string, string | null>; summaries: PatchSummary[] } {
  const operations = parsePatch(patch);
  const virtualFiles = new Map<string, string | null>();
  const summaries: PatchSummary[] = [];

  for (const operation of operations) {
    if (operation.kind === "add") {
      const { absolute, relative } = resolveWorkspacePath(ctx.cwd, operation.filePath);
      assertPatchTargetDoesNotExist(absolute, relative, virtualFiles);
      virtualFiles.set(absolute, operation.lines.join("\n"));
      summaries.push({ status: "added", path: relative });
      continue;
    }

    if (operation.kind === "delete") {
      const { absolute, relative } = resolveWorkspacePath(ctx.cwd, operation.filePath);
      const current = readVirtualFile(absolute, virtualFiles);
      if (current === null) {
        throw toolError("validation_error", "invalid_arguments", `Patch delete target was not found: ${relative}`);
      }
      virtualFiles.set(absolute, null);
      summaries.push({ status: "deleted", path: relative });
      continue;
    }

    const { absolute, relative } = resolveWorkspacePath(ctx.cwd, operation.filePath);
    const current = readVirtualFile(absolute, virtualFiles);
    if (current === null) {
      throw toolError("validation_error", "invalid_arguments", `Patch update target was not found: ${relative}`);
    }
    const next = applyPatchChanges(relative, current, operation.changes);
    if (operation.moveTo) {
      const moved = resolveWorkspacePath(ctx.cwd, operation.moveTo);
      if (moved.absolute !== absolute) {
        assertPatchTargetDoesNotExist(moved.absolute, moved.relative, virtualFiles);
        virtualFiles.set(absolute, null);
      }
      virtualFiles.set(moved.absolute, next);
      summaries.push({ status: "renamed", path: relative, to: moved.relative });
      continue;
    }
    if (next === current) {
      throw toolError("validation_error", "invalid_arguments", `Patch did not change ${relative}`);
    }
    virtualFiles.set(absolute, next);
    summaries.push({ status: "modified", path: relative });
  }

  return { files: virtualFiles, summaries };
}

async function editPatchTool(ctx: ToolContext, patch: string): Promise<ToolResult> {
  if (!patch.trim()) throw toolError("validation_error", "invalid_arguments", "edit patch mode requires patch content");
  const prepared = preparePatch(ctx, patch);
  const decision = await ctx.askPermission({
    permissionKind: "edit",
    summary: patchPermissionSummary(prepared.summaries),
    autoAllow: ctx.permissionMode === "bypass",
  });
  if (decision !== "allow") throw toolError("permission_denied", "permission_denied", "Patch edit denied");

  for (const [absolute, content] of prepared.files) {
    if (content === null) {
      fs.rmSync(absolute, { force: true });
    } else {
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content, "utf8");
    }
  }

  return { title: "patch", output: patchOutput(prepared.summaries), status: "success" };
}

async function editReplaceTool(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const filePath = typeof input.filePath === "string" ? input.filePath : typeof input.path === "string" ? input.path : "";
  const oldText =
    typeof input.oldText === "string" ? input.oldText :
    typeof input.old_string === "string" ? input.old_string :
    "";
  const newText =
    typeof input.newText === "string" ? input.newText :
    typeof input.new_string === "string" ? input.new_string :
    "";
  if (!oldText) throw toolError("validation_error", "invalid_arguments", "edit replace mode requires oldText");
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

export async function editTool(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const explicitMode = typeof input.mode === "string" ? input.mode : "";
  const inferredMode = explicitMode || (typeof input.patch === "string" && !input.filePath && !input.path ? "patch" : "replace");
  if (inferredMode === "patch") {
    return editPatchTool(ctx, typeof input.patch === "string" ? input.patch : "");
  }
  if (inferredMode === "replace") {
    return editReplaceTool(ctx, input);
  }
  throw toolError("validation_error", "invalid_arguments", "edit mode must be replace or patch");
}
