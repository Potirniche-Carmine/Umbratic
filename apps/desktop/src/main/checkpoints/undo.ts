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
  let fd: number;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("Undo requires a regular file.");
    const entry = fs.lstatSync(target);
    if (entry.isSymbolicLink() || stat.dev !== entry.dev || stat.ino !== entry.ino || hasSymlinkComponent(root, target)) {
      throw new Error("The undo file changed while opening it.");
    }
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (offset < stat.size) {
      const length = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (!length) throw new Error("The undo file changed while reading it.");
      hash.update(buffer.subarray(0, length));
      offset += length;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw new Error("The undo file changed while reading it.");
    }
    return `${stat.mode & 0o111}:${hash.digest("hex")}`;
  } finally { fs.closeSync(fd); }
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
