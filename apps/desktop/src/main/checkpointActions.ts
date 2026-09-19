import { createChat, taskId } from "./chatStore";
import { withIdleTaskWorkspace, workspaceBusyReason } from "./workspaceActivity";
import { getTask, publicTask, recordProductTelemetry, saveTask } from "./mainRuntime";
import { taskUsesIsolatedWorktree, worktreeRootForRepo } from "./worktreeOps";
import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import {
  readTaskCheckpoints,
} from "./storage";
import type { TaskInfo, TaskCheckpoint, TaskRecord } from "./types";
import type { TaskCheckpointView } from "../shared/desktopApi";
import { isRecord, pathInside, requiredString } from "./utils";
import {
  createTaskCheckpoint,
  forkTaskFromCheckpoint,
  removeTaskCheckpoint,
  restoreTaskCheckpoint,
  setTaskCheckpointPinned,
} from "./checkpoints/service";

export type { TaskCheckpointView };

export function checkpointView(checkpoint: TaskCheckpoint): TaskCheckpointView {
  const { id, source, label, createdAt, state, pinned, logicalBytes } = checkpoint;
  return { id, source, ...(label ? { label } : {}), createdAt, state, pinned, ...(logicalBytes !== undefined ? { logicalBytes } : {}) };
}

export function checkpointEligibility(task: TaskRecord, requireIdle = true, requireActiveWorktree = true): { supported: boolean; reason?: string } {
  if (task.remote || task.workspaceKind !== "git") {
    return { supported: false, reason: "Checkpoints require a local Git folder. Folder chats support per-file text undo." };
  }
  const busyReason = requireIdle ? workspaceBusyReason(task) : undefined;
  if (busyReason) return { supported: false, reason: busyReason };
  const managedRoot = worktreeRootForRepo(task.originalRepoPath);
  if (!task.worktreePath || (taskUsesIsolatedWorktree(task) && !pathInside(managedRoot, task.worktreePath))) {
    return { supported: false, reason: "The active task worktree is missing or is outside Umbratic's managed worktree root." };
  }
  if (requireActiveWorktree && !fs.existsSync(task.worktreePath)) {
    return { supported: false, reason: "The active task worktree is missing. A ready checkpoint can still be restored." };
  }
  return { supported: true };
}

export function checkpointTask(input: unknown): TaskRecord {
  if (!isRecord(input)) throw new Error("Invalid checkpoint input.");
  const task = getTask(requiredString(input.taskId, "taskId"));
  const eligibility = checkpointEligibility(task);
  if (!eligibility.supported) throw new Error(eligibility.reason);
  return task;
}

export function lifecycleDurationBucket(startedAt: number): string {
  const duration = performance.now() - startedAt;
  if (duration < 100) return "lt_100ms";
  if (duration < 500) return "100_499ms";
  if (duration < 2000) return "500_1999ms";
  return "gte_2s";
}

export function checkpointByteBucket(bytes?: number): string {
  if (!bytes || bytes < 1024) return "lt_1kib";
  if (bytes < 1024 * 1024) return "1kib_1mib";
  if (bytes < 100 * 1024 * 1024) return "1mib_100mib";
  return "gte_100mib";
}

export function listTaskCheckpoints(input: unknown): {
  supported: boolean;
  reason?: string;
  changedFileCount: number;
  checkpoints: TaskCheckpointView[];
} {
  if (!isRecord(input)) throw new Error("Invalid checkpoint input.");
  const task = getTask(requiredString(input.taskId, "taskId"));
  return {
    ...checkpointEligibility(task, true, false),
    changedFileCount: task.changedFiles.length,
    checkpoints: readTaskCheckpoints(task.id).map(checkpointView),
  };
}

export async function createCheckpoint(input: unknown): Promise<TaskCheckpointView> {
  const task = checkpointTask(input);
  return withIdleTaskWorkspace(task, async () => {
    const startedAt = performance.now();
    recordProductTelemetry("checkpoint.started", { taskId: task.id, repositoryId: task.repositoryId });
    try {
      const label = isRecord(input) && typeof input.label === "string" ? input.label : undefined;
      const checkpoint = await createTaskCheckpoint(task, "manual", label);
      saveTask(task);
      recordProductTelemetry("checkpoint.completed", {
        taskId: task.id,
        repositoryId: task.repositoryId,
        data: {
          durationBucket: lifecycleDurationBucket(startedAt),
          changedFileCount: task.changedFiles.length,
          byteBucket: checkpointByteBucket(checkpoint.logicalBytes),
        },
      });
      return checkpointView(checkpoint);
    } catch (error) {
      recordProductTelemetry("checkpoint.failed", {
        taskId: task.id,
        repositoryId: task.repositoryId,
        data: { durationBucket: lifecycleDurationBucket(startedAt) },
      });
      throw error;
    }
  });
}

export async function setCheckpointPinned(input: unknown): Promise<TaskCheckpointView> {
  const task = checkpointTask(input);
  if (!isRecord(input) || typeof input.pinned !== "boolean") throw new Error("Invalid checkpoint pin input.");
  const { pinned } = input;
  return withIdleTaskWorkspace(task, async () => checkpointView(setTaskCheckpointPinned(task.id, requiredString(input.checkpointId, "checkpointId"), pinned)));
}

export async function deleteCheckpoint(input: unknown): Promise<void> {
  const task = checkpointTask(input);
  if (!isRecord(input)) throw new Error("Invalid checkpoint delete input.");
  await withIdleTaskWorkspace(task, async () => {
    await removeTaskCheckpoint(task, requiredString(input.checkpointId, "checkpointId"));
    saveTask(task);
  });
}

export async function forkCheckpoint(input: unknown): Promise<TaskInfo> {
  const sourceTask = checkpointTask(input);
  if (!isRecord(input)) throw new Error("Invalid checkpoint fork input.");
  const checkpointId = requiredString(input.checkpointId, "checkpointId");
  return withIdleTaskWorkspace(sourceTask, async () => {
    const startedAt = performance.now();
    const id = taskId();
    const targetTask: TaskRecord = {
      ...sourceTask,
      id,
      worktreeRootTaskId: id,
      chatId: undefined,
      workspaceMode: "worktree",
      turnCheckpointId: undefined,
      baselineFiles: undefined,
      undoFileHashes: undefined,
      latestTest: undefined,
      prompt: `Forked from checkpoint ${checkpointId}`,
      state: "completed",
      agentBranch: `umbratic/${id}-fork`,
      worktreePath: path.join(worktreeRootForRepo(sourceTask.originalRepoPath), id),
      createdAt: new Date().toISOString(),
      changedFiles: [],
      reviewFiles: [],
      events: [],
      runnerSessionId: undefined,
      diagnosticLogPath: undefined,
      pendingPrompt: undefined,
      metadataPath: undefined,
      approvedAt: undefined,
      mergedAt: undefined,
      rejectedAt: undefined,
      activeWorkspaceId: undefined,
      latestCheckpointId: undefined,
      parentTaskId: sourceTask.id,
      sourceCheckpointId: checkpointId,
      reviewPatchHash: undefined,
      reviewBaselineLabel: "Fork checkpoint",
      reviewBaselineOid: undefined,
      patchHash: undefined,
      error: undefined,
    };
    try {
      const forked = await forkTaskFromCheckpoint({
        sourceTask,
        targetTask,
        checkpointId,
        managedRoot: worktreeRootForRepo(sourceTask.originalRepoPath),
      });
      const chat = createChat({ title: "Checkpoint fork", repositoryPath: sourceTask.originalRepoPath });
      forked.chatId = chat.id;
      saveTask(forked);
      recordProductTelemetry("fork.completed", {
        taskId: forked.id,
        chatId: forked.chatId,
        repositoryId: forked.repositoryId,
        data: { durationBucket: lifecycleDurationBucket(startedAt) },
      });
      return publicTask(forked);
    } catch (error) {
      recordProductTelemetry("fork.failed", {
        taskId: sourceTask.id,
        repositoryId: sourceTask.repositoryId,
        data: { durationBucket: lifecycleDurationBucket(startedAt) },
      });
      throw error;
    }
  });
}

export async function restoreCheckpoint(input: unknown): Promise<TaskInfo> {
  if (!isRecord(input) || input.confirmed !== true) throw new Error("Restore confirmation is required.");
  const task = getTask(requiredString(input.taskId, "taskId"));
  const eligibility = checkpointEligibility(task, true, false);
  if (!eligibility.supported) throw new Error(eligibility.reason);
  const checkpointId = requiredString(input.checkpointId, "checkpointId");
  return withIdleTaskWorkspace(task, async () => {
    const startedAt = performance.now();
    recordProductTelemetry("restore.started", { taskId: task.id, repositoryId: task.repositoryId });
    try {
      const restored = await restoreTaskCheckpoint({
        task,
        checkpointId,
        managedRoot: worktreeRootForRepo(task.originalRepoPath),
        skipRecoveryCheckpoint: !fs.existsSync(task.worktreePath),
      });
      saveTask(restored);
      recordProductTelemetry("restore.completed", {
        taskId: restored.id,
        repositoryId: restored.repositoryId,
        data: { durationBucket: lifecycleDurationBucket(startedAt) },
      });
      return publicTask(restored);
    } catch (error) {
      recordProductTelemetry("restore.failed", {
        taskId: task.id,
        repositoryId: task.repositoryId,
        data: { durationBucket: lifecycleDurationBucket(startedAt) },
      });
      throw error;
    }
  });
}
