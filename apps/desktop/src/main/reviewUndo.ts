import * as fs from "node:fs";
import * as path from "node:path";
import { assertUndoFileUnchanged } from "./checkpoints/undo";
import { assertFolderUndoBaseline, restoreTurnCheckpointFiles, UNDO_UNSAFE_NO_CHECKPOINT } from "./checkpoints/service";
import { getTask, missingSnapshotValue, publicTask, recordProductTelemetry, saveTask } from "./mainRuntime";
import { isBlockedPath, isGeneratedRuntimePath } from "./policy";
import { folderReviewFiles, gitReviewFiles, refreshReview } from "./reviewFiles";
import type { TaskInfo, TaskRecord } from "./types";
import { hasSymlinkComponent, isRecord, pathInside, requiredString } from "./utils";
import { isBinarySnapshotValue } from "./workspaceSnapshot";
import { withIdleTaskWorkspace } from "./workspaceActivity";

function folderRestore(task: TaskRecord, filePath: string): () => void {
  const baseline = task.baselineFiles!;
  if (isBinarySnapshotValue(baseline[filePath])) {
    throw new Error(`Undo cannot safely restore the earlier binary content of ${filePath}.`);
  }
  const absolute = path.resolve(task.worktreePath, filePath);
  if (!pathInside(task.worktreePath, absolute) || hasSymlinkComponent(task.worktreePath, absolute)) {
    throw new Error(`Refusing to restore a path outside the task folder: ${filePath}`);
  }
  return () => {
    if (!Object.hasOwn(baseline, filePath) || baseline[filePath] === missingSnapshotValue) {
      fs.rmSync(absolute, { force: true });
    } else {
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, baseline[filePath]);
    }
  };
}

/** Undo one file or the latest prompt's changes, always against its automatic snapshot. */
export async function undoTaskChanges(input: unknown): Promise<TaskInfo> {
  if (!isRecord(input)) throw new Error("Invalid undo input.");
  const task = getTask(requiredString(input.taskId, "taskId"));
  const selectedPath = input.path === undefined ? undefined : requiredString(input.path, "path").replace(/\\/g, "/");
  if (task.remote || ["approved", "merged", "rejected"].includes(task.state)) {
    throw new Error("This task is not available for undo.");
  }
  return withIdleTaskWorkspace(task, async () => {
    if (task.workspaceKind === "git") {
      if (!task.turnCheckpointId || !fs.existsSync(task.worktreePath)) throw new Error(UNDO_UNSAFE_NO_CHECKPOINT);
    } else {
      assertFolderUndoBaseline(task);
    }
    if (!task.undoFileHashes) throw new Error("The saved result of this prompt is unavailable for undo.");
    const reviews = task.workspaceKind === "git" ? await gitReviewFiles(task) : folderReviewFiles(task);
    const changed = new Set(reviews.map((file) => file.path));
    const files = selectedPath === undefined
      ? Object.keys(task.undoFileHashes).filter((file) => changed.has(file))
      : [selectedPath];
    // Validate every file before writing any of them. A later edit by another
    // chat must not turn Undo all into a partial undo or overwrite newer work.
    for (const file of files) {
      if (isGeneratedRuntimePath(file) || isBlockedPath(file) || !changed.has(file)) {
        throw new Error(`${file} is not available for undo.`);
      }
      await assertUndoFileUnchanged(task, file);
    }
    if (task.workspaceKind === "git") {
      await restoreTurnCheckpointFiles(task, files);
    } else {
      const restores = files.map((file) => folderRestore(task, file));
      for (const restore of restores) restore();
    }
    for (const file of files) delete task.undoFileHashes?.[file];
    recordProductTelemetry("task.undone", { taskId: task.id, chatId: task.chatId, repositoryId: task.repositoryId });
    await refreshReview(task, "task");
    saveTask(task);
    return publicTask(task);
  });
}
