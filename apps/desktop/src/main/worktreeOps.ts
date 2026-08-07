import { pathKey } from "./chatStore";
import { activeRunnerProcesses } from "./mainRuntime";
import {
  app,
} from "electron";
import * as fs from "node:fs";
import * as path from "node:path";


import {
  readTasks,
} from "./storage";
import { gitResult } from "./processCommands";
import type { ChatRecord, RepositoryInfo, TaskRecord } from "./types";
import { pathInside, shortHash, slugify } from "./utils";
import * as appPaths from "./appPaths";

export function worktreeRootForRepo(repoRoot: string): string {
  const resolved = path.resolve(repoRoot);
  return path.join(appPaths.worktreesDirectory(app.getPath("userData")), `${slugify(path.basename(resolved))}-${shortHash(resolved.toLowerCase())}`);
}

export function umbraticWorktreesRoot(): string {
  return appPaths.worktreesDirectory(app.getPath("userData"));
}

export function directoryIsEmpty(directory: string): boolean {
  try {
    return fs.readdirSync(directory).length === 0;
  } catch {
    return false;
  }
}

export function removeEmptyDirectory(directory: string): boolean {
  try {
    fs.rmdirSync(directory);
    return !fs.existsSync(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return false;
    return false;
  }
}

export function cleanupEmptyUmbraticWorktreeDirectories(task: TaskRecord) {
  const worktreesRoot = umbraticWorktreesRoot();
  const repoWorktreeRoot = worktreeRootForRepo(task.originalRepoPath);
  if (!pathInside(worktreesRoot, repoWorktreeRoot) || !pathInside(repoWorktreeRoot, task.worktreePath)) return;
  if (fs.existsSync(task.worktreePath) && directoryIsEmpty(task.worktreePath)) {
    removeEmptyDirectory(task.worktreePath);
  }
  removeEmptyDirectory(repoWorktreeRoot);
}

export async function removeGitWorktree(task: TaskRecord) {
  if (!taskUsesIsolatedWorktree(task)) {
    return;
  }
  const repoWorktreeRoot = worktreeRootForRepo(task.originalRepoPath);
  if (!pathInside(repoWorktreeRoot, task.worktreePath)) {
    throw new Error("Worktree path is outside Umbratic control.");
  }
  if (fs.existsSync(task.worktreePath)) {
    const result = await gitResult(task.originalRepoPath, ["worktree", "remove", "--force", task.worktreePath]);
    if (!result.success) {
      if (!directoryIsEmpty(task.worktreePath)) {
        const message = (result.stderr || result.stdout || "Failed to remove worktree.").trim();
        throw new Error(message);
      }
      removeEmptyDirectory(task.worktreePath);
    }
  }
  cleanupEmptyUmbraticWorktreeDirectories(task);
}

export function taskMetadataPath(task: TaskRecord): string {
  return path.join(appPaths.taskMetadataDirectory(app.getPath("userData")), `${task.id}.json`);
}

export function taskUsesIsolatedWorktree(task: TaskRecord): boolean {
  return task.workspaceKind === "git" && task.workspaceMode === "worktree" && !!task.agentBranch;
}

export function taskCanHostWorktreeChats(task: TaskRecord): boolean {
  return (
    taskUsesIsolatedWorktree(task) &&
    task.state !== "merged" &&
    task.state !== "rejected" &&
    !!task.worktreePath &&
    fs.existsSync(task.worktreePath) &&
    pathInside(worktreeRootForRepo(task.originalRepoPath), task.worktreePath)
  );
}

export function worktreeRootTaskId(task: TaskRecord): string {
  return task.worktreeRootTaskId ?? task.id;
}

export function findReusableWorktreeTask(taskIdValue?: string): TaskRecord | undefined {
  if (!taskIdValue || !/^task-[A-Za-z0-9_-]+$/.test(taskIdValue)) return undefined;
  return readTasks().find((row) => (row.id === taskIdValue || row.worktreeRootTaskId === taskIdValue) && taskCanHostWorktreeChats(row));
}

export function worktreeHasActiveRun(worktreePath: string): boolean {
  const target = pathKey(worktreePath);
  for (const task of readTasks()) {
    if (!task.worktreePath || pathKey(task.worktreePath) !== target) continue;
    if (activeRunnerProcesses.has(task.id) || task.state === "running" || task.state === "awaiting_worktree_approval" || task.state === "approving") {
      return true;
    }
  }
  return false;
}

export function assertReusableWorktreeForRepository(task: TaskRecord, repository: RepositoryInfo) {
  if (!taskCanHostWorktreeChats(task)) {
    throw new Error("This worktree is no longer open. Start a new worktree chat from the project.");
  }
  if (pathKey(task.originalRepoPath) !== pathKey(repository.rootPath)) {
    throw new Error("This worktree belongs to a different project.");
  }
  if (worktreeHasActiveRun(task.worktreePath)) {
    throw new Error("This worktree already has a chat in progress.");
  }
}

export function chatWorktreeTaskId(chat?: ChatRecord): string | undefined {
  if (chat?.worktreeRootTaskId && /^task-[A-Za-z0-9_-]+$/.test(chat.worktreeRootTaskId)) {
    return chat.worktreeRootTaskId;
  }
  if (chat?.taskId && /^task-[A-Za-z0-9_-]+$/.test(chat.taskId)) {
    return chat.taskId;
  }
  return undefined;
}
