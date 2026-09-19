import * as fs from "node:fs";
import * as path from "node:path";
import { readTasks } from "./storage";
import type { TaskRecord } from "./types";

// A chat id is not a filesystem boundary: several chats can use one folder.
// Keep the lease until asynchronous startup and runner shutdown have settled.
const leases = new Set<{ taskId: string; root: string; host: string }>();

export function canonicalWorkspacePath(value: string): string {
  let root = path.resolve(value);
  const suffix: string[] = [];
  while (!fs.existsSync(root) && path.dirname(root) !== root) {
    suffix.unshift(path.basename(root));
    root = path.dirname(root);
  }
  const resolved = path.join(fs.realpathSync(root), ...suffix);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function identity(task: TaskRecord) {
  return {
    taskId: task.id,
    root: task.remote ? path.posix.normalize(task.remote.directory) : canonicalWorkspacePath(task.worktreePath),
    host: task.remote?.connectionId ?? "local",
  };
}

function overlaps(left: ReturnType<typeof identity>, right: ReturnType<typeof identity>): boolean {
  if (left.taskId === right.taskId) return true;
  if (left.host !== right.host) return false;
  const within = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  return within(left.root, right.root) || within(right.root, left.root);
}

export function workspaceBusyReason(task: TaskRecord, startingRun = false): string | undefined {
  const target = identity(task);
  if ([...leases].some((lease) => overlaps(target, lease))) {
    return "This folder has an operation in progress. Wait for it to finish, or use a separate worktree.";
  }
  if (readTasks().some((other) => {
    if (startingRun && other.id === task.id) return false;
    return ["running", "approving", "awaiting_worktree_approval"].includes(other.state)
      && overlaps(target, identity(other));
  })) return "A chat is using this folder. Stop it or wait for it to finish before restoring files.";
  return undefined;
}

export function assertTaskWorkspaceIdle(task: TaskRecord, startingRun = false): void {
  const reason = workspaceBusyReason(task, startingRun);
  if (reason) throw new Error(reason);
}

export function reserveTaskWorkspace(task: TaskRecord, startingRun = false): () => void {
  const reason = workspaceBusyReason(task, startingRun);
  if (reason) throw new Error(reason);
  const lease = identity(task);
  leases.add(lease);
  return () => { leases.delete(lease); };
}

export async function withIdleTaskWorkspace<T>(task: TaskRecord, action: () => Promise<T>): Promise<T> {
  const release = reserveTaskWorkspace(task);
  try { return await action(); } finally { release(); }
}
