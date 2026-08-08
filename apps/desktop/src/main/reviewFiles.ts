import { taskUsesIsolatedWorktree } from "./worktreeOps";
import { emit, getTask, missingSnapshotValue, publicTask, saveTask } from "./mainRuntime";
import { buildBinaryDiff, buildSnapshotDiff } from "./taskPromptContext";
import { readTextFileIfSafe, snapshotFileValue, snapshotFolder } from "./workspaceSnapshot";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";


import {
  isGeneratedRuntimePath,
} from "./policy";
import { gitOutput, gitResult } from "./processCommands";
import type { ReviewFile, TaskInfo, TaskRecord } from "./types";
import { isRecord, normalizeRelativePath, requiredString } from "./utils";
import { normalizeReviewFile, parseGitPorcelainPaths, reviewContextLines, buildTextDiff } from "../shared/reviewDiff";

export async function getChangedFiles(worktreePath: string, baseCommit: string): Promise<string[]> {
  if (baseCommit === "HEAD") {
    const status = await gitResult(worktreePath, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]);
    if (!status.success) {
      throw new Error((status.stderr || "Failed to read repository status.").trim());
    }
    return parseGitPorcelainPaths(status.stdout)
      .map((file) => normalizeRelativePath(file))
      .filter(Boolean);
  }
  const tracked = await gitOutput(worktreePath, ["diff", "--name-only", "--diff-filter=ACMRTD", baseCommit]);
  const untracked = await gitOutput(worktreePath, ["ls-files", "--others", "--exclude-standard"]);
  return Array.from(
    new Set(
      [...tracked.split(/\r?\n/), ...untracked.split(/\r?\n/)]
        .map((row) => normalizeRelativePath(row.trim()))
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b));
}

export function folderReviewFiles(task: TaskRecord): ReviewFile[] {
  const before = task.baselineFiles ?? {};
  const after = snapshotFolder(task.worktreePath);
  const paths = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
    .filter((file) => !isGeneratedRuntimePath(file))
    .sort((a, b) => a.localeCompare(b));
  return paths
    .map((file) => buildSnapshotDiff(file, before[file] ?? null, after[file] ?? null))
    .filter((file): file is ReviewFile => !!file);
}

/// Each changed file costs one or two git subprocesses. Reviews of large
/// changesets spawn them with bounded parallelism instead of one at a time;
/// results keep the input order so the file list stays sorted.
const gitReviewConcurrency = 6;

async function mapWithConcurrency<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await run(items[index]);
      }
    }),
  );
  return results;
}

export async function gitWorkspaceReviewFiles(repositoryPath: string, baseline: string): Promise<ReviewFile[]> {
  const changed = (await getChangedFiles(repositoryPath, baseline))
    .filter((file) => !isGeneratedRuntimePath(file))
    .sort((a, b) => a.localeCompare(b));
  const reviews = await mapWithConcurrency(changed, gitReviewConcurrency, (file) =>
    gitWorkspaceReviewFile(repositoryPath, baseline, file),
  );
  return reviews.filter((review): review is ReviewFile => !!review);
}

export async function gitWorkspaceReviewFile(repositoryPath: string, baseline: string, file: string): Promise<ReviewFile | null> {
  const absolute = path.join(repositoryPath, file);
  const status = await gitFileStatus(repositoryPath, baseline, file);
  const diff = await gitOutput(repositoryPath, ["diff", "--no-ext-diff", "--binary", "--find-renames", "--find-copies", `--unified=${reviewContextLines}`, baseline, "--", file]).catch(
    () => "",
  );
  if (diff.trim()) return normalizeReviewFile({ path: file, status, patch: diff });
  const text = readTextFileIfSafe(absolute);
  if (text !== null) return buildTextDiff(file, null, text);
  return buildBinaryDiff(
    file,
    status === "added" ? null : "before",
    status === "deleted" ? null : "after",
  );
}

export async function gitLocalReviewFiles(task: TaskRecord): Promise<ReviewFile[]> {
  const baselineFiles = task.baselineFiles ?? {};
  const baselinePaths = new Set(Object.keys(baselineFiles));
  const currentPaths = await getChangedFiles(task.worktreePath, task.baseCommit);
  const paths = Array.from(new Set([...baselinePaths, ...currentPaths]))
    .filter((file) => !isGeneratedRuntimePath(file))
    .sort((left, right) => left.localeCompare(right));
  const reviews = await mapWithConcurrency(paths, gitReviewConcurrency, async (file) => {
    if (baselinePaths.has(file)) {
      const beforeValue = baselineFiles[file];
      const afterValue = snapshotFileValue(path.join(task.worktreePath, file));
      return buildSnapshotDiff(
        file,
        beforeValue === missingSnapshotValue ? null : beforeValue,
        afterValue === missingSnapshotValue ? null : afterValue,
      );
    }
    return gitWorkspaceReviewFile(task.worktreePath, task.baseCommit, file);
  });
  return reviews.filter((review): review is ReviewFile => !!review);
}

export async function gitReviewFiles(task: TaskRecord, baseline = task.baseCommit, repositoryPath = task.worktreePath): Promise<ReviewFile[]> {
  if (task.baselineFiles && baseline !== "HEAD") {
    return task.workspaceKind === "git" ? gitLocalReviewFiles(task) : folderReviewFiles(task);
  }
  return gitWorkspaceReviewFiles(repositoryPath, baseline);
}

export async function gitFileStatus(repositoryPath: string, baseline: string, file: string): Promise<ReviewFile["status"]> {
  const absolute = path.join(repositoryPath, file);
  const afterExists = fs.existsSync(absolute);
  const before = await gitResult(repositoryPath, ["cat-file", "-e", `${baseline}:${file.replace(/\\/g, "/")}`]);
  if (!before.success && afterExists) {
    return "added";
  }
  if (before.success && !afterExists) {
    return "deleted";
  }
  return "modified";
}

export async function refreshReview(
  task: TaskRecord,
  scope: "task" | "worktree" = "task",
  wholeDiffWorkspacePath?: string,
): Promise<ReviewFile[]> {
  const workspacePath = scope === "worktree" && wholeDiffWorkspacePath
    ? wholeDiffWorkspacePath
    : fs.existsSync(task.worktreePath)
      ? task.worktreePath
      : task.originalRepoPath;
  const worktreeIsGit = scope === "worktree"
    && (await gitResult(workspacePath, ["rev-parse", "--is-inside-work-tree"])).success;
  const discoveredReviewFiles = task.workspaceKind === "folder" && !worktreeIsGit
    ? folderReviewFiles(task)
    : scope === "worktree"
      ? await gitReviewFiles(task, "HEAD", workspacePath)
      : await gitReviewFiles(task);
  const reviewFiles = discoveredReviewFiles;
  task.reviewFiles = reviewFiles;
  task.changedFiles = reviewFiles.map((file) => file.path);
  task.reviewScope = scope;
  task.reviewBaselineLabel = scope === "worktree" ? "Whole diff" : "Turn changes";
  task.reviewBaselineOid = scope === "worktree"
    ? await gitOutput(workspacePath, ["rev-parse", "--short", "HEAD"]).catch(() => "HEAD")
    : (task.workspaceKind === "folder" && !worktreeIsGit) || !taskUsesIsolatedWorktree(task)
      ? "task start"
      : task.baseCommit.slice(0, 10) || "task start";
  return reviewFiles;
}

export function reviewPatchHash(reviewFiles: ReviewFile[]): string {
  const normalized = reviewFiles
    .map((file) => `${file.path}\0${file.status}\0${file.patch}`)
    .sort()
    .join("\0");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

export function emitReviewChangedSinceReady(task: TaskRecord, reviewFiles: ReviewFile[]) {
  const currentPatchHash = reviewPatchHash(reviewFiles);
  if (!task.reviewPatchHash || task.reviewPatchHash === currentPatchHash) {
    return currentPatchHash;
  }
  emit({
    type: "review.changed_since_ready",
    taskId: task.id,
    previousPatchHash: task.reviewPatchHash,
    currentPatchHash,
    changedFileCount: reviewFiles.length,
  });
  return currentPatchHash;
}

export async function refreshTaskReview(input: unknown): Promise<TaskInfo | null> {
  if (!isRecord(input)) {
    throw new Error("Invalid review refresh input.");
  }
  const task = getTask(requiredString(input.taskId, "taskId"));
  const scope = input.scope === "worktree"
    ? "worktree"
    : input.scope === "task"
      ? "task"
      : task.reviewScope === "worktree"
        ? "worktree"
        : "task";
  let requestedWholeDiffPath: string | undefined;
  if (scope === "worktree" && typeof input.repositoryPath === "string" && input.repositoryPath.trim()) {
    const selectedPath = path.resolve(input.repositoryPath.trim());
    if (!fs.existsSync(selectedPath) || !fs.statSync(selectedPath).isDirectory()) {
      throw new Error("The selected project folder is no longer available.");
    }
    requestedWholeDiffPath = path.resolve(
      await gitOutput(selectedPath, ["rev-parse", "--show-toplevel"]).catch(() => selectedPath),
    );
  }
  const wholeWorkspaceStillAvailable = scope === "worktree" && fs.existsSync(task.originalRepoPath);
  if (!fs.existsSync(task.worktreePath) && !wholeWorkspaceStillAvailable && !requestedWholeDiffPath) {
    return publicTask(task);
  }
  await refreshReview(task, scope, requestedWholeDiffPath);
  saveTask(task);
  return publicTask(task);
}

export async function refreshWorkspaceReview(input: unknown): Promise<{ reviewFiles: ReviewFile[]; baselineOid: string }> {
  if (!isRecord(input)) {
    throw new Error("Invalid workspace review input.");
  }
  const selectedPath = path.resolve(requiredString(input.repositoryPath, "repository path"));
  if (!fs.existsSync(selectedPath) || !fs.statSync(selectedPath).isDirectory()) {
    throw new Error("The selected project folder is no longer available.");
  }
  const repositoryPath = path.resolve(await gitOutput(selectedPath, ["rev-parse", "--show-toplevel"]));
  const reviewFiles = await gitWorkspaceReviewFiles(repositoryPath, "HEAD");
  const baselineOid = await gitOutput(repositoryPath, ["rev-parse", "--short", "HEAD"]).catch(() => "HEAD");
  return { reviewFiles, baselineOid };
}
