import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TaskRecord } from "../types";
import { hasSymlinkComponent, pathInside } from "../utils";
const execFileAsync = promisify(execFile);

async function indexEntries(task: TaskRecord, relative?: string): Promise<Map<string, string>> {
  if (task.workspaceKind !== "git") return new Map();
  const { stdout } = await execFileAsync("git", ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", ...(relative ? [relative] : [])],
    { cwd: task.worktreePath, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return new Map(stdout.split("\0").filter(Boolean).map((entry) => {
    const tab = entry.indexOf("\t");
    return [entry.slice(tab + 1), entry.slice(0, tab)];
  }));
}

function fileFingerprint(root: string, relative: string): string {
  const target = path.resolve(root, relative);
  if (!pathInside(root, target) || hasSymlinkComponent(root, target)) throw new Error("Unsafe undo path.");
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile()) throw new Error("Undo requires a regular file.");
    return `${stat.mode & 0o111}:${crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex")}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

// Capture once when the writer has stopped, not when a stale review is
// refreshed. Refreshing must not authorize overwriting another chat's work.
export async function captureUndoFiles(task: TaskRecord): Promise<void> {
  const index = await indexEntries(task);
  task.undoFileHashes = Object.fromEntries(task.changedFiles.map((file) => [file, `${fileFingerprint(task.worktreePath, file)}:${index.get(file) ?? ""}`]));
}

export async function assertUndoFileUnchanged(task: TaskRecord, relative: string): Promise<void> {
  const expected = task.undoFileHashes?.[relative];
  const index = await indexEntries(task, relative);
  if (!expected || `${fileFingerprint(task.worktreePath, relative)}:${index.get(relative) ?? ""}` !== expected) {
    throw new Error("This file changed after this turn, or its saved result is unavailable. Undo would overwrite later work.");
  }
}
