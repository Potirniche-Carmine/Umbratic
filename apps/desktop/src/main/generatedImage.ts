import * as fs from "node:fs";
import * as path from "node:path";
import type { TaskRecord } from "./types";
import { isBlockedPath } from "./policy";
import { hasSymlinkComponent, normalizeRelativePath, pathInside } from "./utils";

/** Only a successful image tool result grants access to its PNG. */
export function readGeneratedImage(task: TaskRecord, requested: unknown): { dataUrl: string | null } {
  const unavailable = { dataUrl: null };
  if (typeof requested !== "string" || requested.length > 240 || path.isAbsolute(requested)) return unavailable;
  const relative = normalizeRelativePath(requested);
  if (!relative || !relative.toLowerCase().endsWith(".png") || isBlockedPath(relative)) return unavailable;
  if (!task.events.some((event) => event.type === "command.finished" && event.exitCode === 0
    && event.details?.image === true && event.details.path === relative)) return unavailable;
  const root = task.worktreePath || task.originalRepoPath;
  if (!root) return unavailable;
  const absolute = path.resolve(root, relative);
  if (!pathInside(root, absolute) || hasSymlinkComponent(root, absolute)) return unavailable;
  let fd: number | undefined;
  try {
    fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 24 || stat.size > 16 * 1024 * 1024) return unavailable;
    const bytes = Buffer.alloc(stat.size);
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return unavailable;
    return { dataUrl: `data:image/png;base64,${bytes.toString("base64")}` };
  } catch { return unavailable; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
