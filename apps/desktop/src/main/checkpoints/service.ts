import * as crypto from "node:crypto";

import {
  deleteTaskCheckpoint,
  activateTaskWorkspace,
  completeTaskCheckpoint,
  readTasks,
  readTaskCheckpoints,
  readTaskWorkspaces,
  writeTask,
  writeTaskCheckpoint,
  writeTaskWorkspace,
} from "../storage";
import type { TaskCheckpoint, TaskRecord, TaskWorkspace } from "../types";
import { createGitCheckpoint, deleteGitCheckpointRef, materializeCheckpointWorktree, removeManagedWorktree, restoreGitCheckpoint } from "./gitAdapter";
import * as path from "node:path";

const taskLocks = new Map<string, Promise<void>>();

async function serialized<T>(taskId: string, action: () => Promise<T>): Promise<T> {
  const prior = taskLocks.get(taskId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const chain = prior.then(() => current);
  taskLocks.set(taskId, chain);
  await prior;
  try { return await action(); } finally {
    release();
    if (taskLocks.get(taskId) === chain) taskLocks.delete(taskId);
  }
}

function checkpointRef(checkpoint: TaskCheckpoint): string {
  return `refs/umbratic/checkpoints/${checkpoint.taskId}/${checkpoint.id}`;
}

export async function createTaskCheckpoint(
  task: TaskRecord,
  source: TaskCheckpoint["source"] = "manual",
  label?: string,
): Promise<TaskCheckpoint> {
  return serialized(task.id, async () => {
    if (task.workspaceMode !== "worktree" || !task.agentBranch) {
      throw new Error("Checkpoints require an Umbratic-owned Git task worktree.");
    }
    const workspaces = readTaskWorkspaces(task.id);
    if (!workspaces.some((workspace) => workspace.id === task.activeWorkspaceId)) {
      const activeWorkspace: TaskWorkspace = {
        id: task.activeWorkspaceId ?? `workspace-${task.id}-1`,
        taskId: task.id,
        number: 1,
        branch: task.agentBranch,
        path: task.worktreePath,
        createdAt: task.createdAt,
        state: "active",
      };
      task.activeWorkspaceId = activeWorkspace.id;
      writeTaskWorkspace(activeWorkspace);
      writeTask(task, false);
    }
    const id = `checkpoint-${crypto.randomBytes(10).toString("hex")}`;
    const prior = readTaskCheckpoints(task.id).find((checkpoint) => checkpoint.state === "ready");
    const checkpoint: TaskCheckpoint = {
      id,
      taskId: task.id,
      workspaceId: task.activeWorkspaceId ?? `workspace-${task.id}-1`,
      ...(prior ? { parentCheckpointId: prior.id } : {}),
      source,
      ...(label?.trim() ? { label: label.trim().slice(0, 160) } : {}),
      commitOid: "",
      treeOid: "",
      createdAt: new Date().toISOString(),
      state: "preparing",
      pinned: source === "pre_restore" || source === "pre_cleanup",
    };
    writeTaskCheckpoint(checkpoint);
    try {
      const result = await createGitCheckpoint({
        workspacePath: task.worktreePath,
        taskId: task.id,
        checkpointId: id,
        seedCommit: prior?.commitOid || task.baseCommit,
      });
      if (source !== "pre_turn" && prior?.treeOid === result.treeOid) {
        await deleteGitCheckpointRef(task.originalRepoPath, result.ref);
        deleteTaskCheckpoint(id);
        return prior;
      }
      const ready: TaskCheckpoint = {
        ...checkpoint,
        commitOid: result.commitOid,
        treeOid: result.treeOid,
        indexTreeOid: result.indexTreeOid,
        logicalBytes: result.logicalBytes,
        state: "ready",
      };
      task.latestCheckpointId = ready.id;
      completeTaskCheckpoint(task, ready);

      const removable = readTaskCheckpoints(task.id)
        .filter((candidate) => candidate.state === "ready" && !candidate.pinned && candidate.id !== ready.id)
        .slice(9);
      for (const candidate of removable) {
        await deleteGitCheckpointRef(task.originalRepoPath, checkpointRef(candidate));
        deleteTaskCheckpoint(candidate.id);
      }
      return ready;
    } catch (error) {
      writeTaskCheckpoint({ ...checkpoint, state: "failed" });
      throw error;
    }
  });
}

export async function createTurnCheckpoint(task: TaskRecord): Promise<TaskCheckpoint> {
  const checkpoint = await createTaskCheckpoint(task, "pre_turn", "Before turn");
  task.turnCheckpointId = checkpoint.id;
  writeTask(task, false);
  return checkpoint;
}

export async function restoreTurnCheckpoint(task: TaskRecord): Promise<boolean> {
  if (!task.turnCheckpointId) return false;
  const checkpoint = readyCheckpoint(task.id, task.turnCheckpointId);
  const indexTreeOid = checkpoint.indexTreeOid;
  if (checkpoint.source !== "pre_turn" || !indexTreeOid) {
    throw new Error("The automatic turn checkpoint is not restorable.");
  }
  await createTaskCheckpoint(task, "pre_restore", "Recovery before undo");
  await serialized(task.id, async () => {
    await restoreGitCheckpoint({
      workspacePath: task.worktreePath,
      checkpointCommit: checkpoint.commitOid,
      treeOid: checkpoint.treeOid,
      indexTreeOid,
    });
    task.latestCheckpointId = checkpoint.id;
    task.turnCheckpointId = undefined;
    task.baselineFiles = undefined;
    writeTask(task, false);
  });
  return true;
}

export const REJECT_UNSAFE_NO_CHECKPOINT =
  "Automatic reject is unsafe: no verified pre-turn checkpoint.";
export const REJECT_UNSAFE_NO_BASELINE =
  "Automatic reject is unsafe: no verified undo baseline.";

/** Fail-closed reject restore for isolated git worktrees. Never resets to task.baseCommit. */
export async function restoreIsolatedWorktreeForReject(
  task: TaskRecord,
  worktreeExists: boolean = true,
): Promise<void> {
  if (!worktreeExists || !task.turnCheckpointId) {
    throw new Error(REJECT_UNSAFE_NO_CHECKPOINT);
  }
  const restored = await restoreTurnCheckpoint(task);
  if (!restored) {
    throw new Error(REJECT_UNSAFE_NO_CHECKPOINT);
  }
}

/** Fail-closed gate for folder / non-worktree text undo. */
export function assertFolderRejectBaseline(task: TaskRecord): void {
  if (!task.baselineFiles) {
    throw new Error(REJECT_UNSAFE_NO_BASELINE);
  }
}

export function setTaskCheckpointPinned(taskId: string, checkpointId: string, pinned: boolean): TaskCheckpoint {
  const checkpoint = readyCheckpoint(taskId, checkpointId);
  if (checkpoint.source !== "manual" && !pinned) {
    throw new Error("Recovery checkpoints stay pinned until their owning recovery state is retired.");
  }
  const updated = { ...checkpoint, pinned };
  writeTaskCheckpoint(updated);
  return updated;
}

export async function removeTaskCheckpoint(task: TaskRecord, checkpointId: string): Promise<void> {
  await serialized(task.id, async () => {
    const checkpoint = readyCheckpoint(task.id, checkpointId);
    if (checkpoint.pinned || checkpoint.source !== "manual") {
      throw new Error("Unpin this manual checkpoint before deleting it.");
    }
    const referencedByTask = readTasks().some((candidate) =>
      candidate.id !== task.id && candidate.sourceCheckpointId === checkpoint.id,
    );
    const referencedByWorkspace = readTasks().some((candidate) =>
      readTaskWorkspaces(candidate.id).some((workspace) => workspace.sourceCheckpointId === checkpoint.id),
    );
    if (referencedByTask || referencedByWorkspace) {
      throw new Error("This checkpoint is still referenced by a fork or recovery workspace.");
    }
    await deleteGitCheckpointRef(task.originalRepoPath, checkpointRef(checkpoint));
    deleteTaskCheckpoint(checkpoint.id);
    if (task.latestCheckpointId === checkpoint.id) {
      task.latestCheckpointId = readTaskCheckpoints(task.id).find((candidate) => candidate.state === "ready")?.id;
      writeTask(task, false);
    }
  });
}

export async function ensurePreCleanupCheckpoint(task: TaskRecord): Promise<TaskCheckpoint> {
  return createTaskCheckpoint(task, "pre_cleanup", "Recovery before cleanup");
}

function readyCheckpoint(taskId: string, checkpointId: string): TaskCheckpoint {
  const checkpoint = readTaskCheckpoints(taskId).find((candidate) => candidate.id === checkpointId && candidate.state === "ready");
  if (!checkpoint) throw new Error("Checkpoint is missing or not ready.");
  return checkpoint;
}

export async function forkTaskFromCheckpoint(input: {
  sourceTask: TaskRecord;
  targetTask: TaskRecord;
  checkpointId: string;
  managedRoot: string;
}): Promise<TaskRecord> {
  const checkpoint = readyCheckpoint(input.sourceTask.id, input.checkpointId);
  return serialized(input.sourceTask.id, async () => {
    const workspace: TaskWorkspace = {
      id: `workspace-${input.targetTask.id}-1`, taskId: input.targetTask.id, number: 1,
      branch: input.targetTask.agentBranch, path: input.targetTask.worktreePath,
      sourceCheckpointId: checkpoint.id, createdAt: new Date().toISOString(), state: "preparing",
    };
    writeTask(input.targetTask, false);
    writeTaskWorkspace(workspace);
    try {
      await materializeCheckpointWorktree({
        repositoryPath: input.sourceTask.originalRepoPath,
        checkpointCommit: checkpoint.commitOid,
        branch: workspace.branch,
        targetPath: workspace.path,
        managedRoot: input.managedRoot,
      });
      const active = { ...workspace, state: "active" as const };
      const target = {
        ...input.targetTask,
        parentTaskId: input.sourceTask.id,
        sourceCheckpointId: checkpoint.id,
        activeWorkspaceId: active.id,
        baseCommit: checkpoint.commitOid,
      };
      activateTaskWorkspace(target, active);
      return target;
    } catch (error) {
      writeTaskWorkspace({ ...workspace, state: "failed" });
      throw error;
    }
  });
}

export async function restoreTaskCheckpoint(input: {
  task: TaskRecord;
  checkpointId: string;
  managedRoot: string;
  skipRecoveryCheckpoint?: boolean;
}): Promise<TaskRecord> {
  const checkpoint = readyCheckpoint(input.task.id, input.checkpointId);
  const recoveryCheckpoint = input.skipRecoveryCheckpoint
    ? undefined
    : await createTaskCheckpoint(input.task, "pre_restore", "Recovery before restore");
  return serialized(input.task.id, async () => {
    const existing = readTaskWorkspaces(input.task.id);
    const number = Math.max(0, ...existing.map((workspace) => workspace.number)) + 1;
    const targetPath = path.join(path.resolve(input.managedRoot), `${input.task.id}-restore-${number}`);
    const branch = `${input.task.agentBranch || `umbratic/${input.task.id}`}-restore-${number}`.slice(0, 220);
    const preparing: TaskWorkspace = {
      id: `workspace-${input.task.id}-${number}`, taskId: input.task.id, number, branch,
      path: targetPath, sourceCheckpointId: checkpoint.id, createdAt: new Date().toISOString(), state: "preparing",
    };
    writeTaskWorkspace(preparing);
    try {
      await materializeCheckpointWorktree({
        repositoryPath: input.task.originalRepoPath,
        checkpointCommit: checkpoint.commitOid,
        branch,
        targetPath,
        managedRoot: input.managedRoot,
      });
      const old = existing.find((workspace) => workspace.id === input.task.activeWorkspaceId) ?? {
        id: input.task.activeWorkspaceId ?? `workspace-${input.task.id}-1`, taskId: input.task.id,
        number: 1, branch: input.task.agentBranch, path: input.task.worktreePath,
        createdAt: input.task.createdAt, state: "recovery" as const,
      };
      const active = { ...preparing, state: "active" as const };
      const restored: TaskRecord = {
        ...input.task,
        worktreePath: targetPath,
        agentBranch: branch,
        baseCommit: checkpoint.commitOid,
        activeWorkspaceId: active.id,
        sourceCheckpointId: checkpoint.id,
        runnerSessionId: undefined,
        diagnosticLogPath: undefined,
        pendingPrompt: undefined,
        changedFiles: [],
        reviewFiles: [],
        reviewPatchHash: undefined,
        patchHash: undefined,
      };
      activateTaskWorkspace(restored, active, {
        ...old,
        ...(recoveryCheckpoint ? { sourceCheckpointId: recoveryCheckpoint.id } : {}),
        state: input.skipRecoveryCheckpoint ? "failed" : "recovery",
      });
      for (const recovery of existing.filter((workspace) => workspace.state === "recovery" && workspace.id !== old.id)) {
        try {
          await removeManagedWorktree(input.task.originalRepoPath, recovery.path, input.managedRoot);
          writeTaskWorkspace({ ...recovery, state: "retired" });
        } catch {
          // Keep an older recovery workspace recorded when ownership or Git validation prevents safe cleanup.
        }
      }
      const referencedRecoveryCheckpoints = new Set(
        readTasks().flatMap((candidate) => [
          candidate.sourceCheckpointId,
          ...readTaskWorkspaces(candidate.id)
            .filter((workspace) => workspace.state !== "retired" && workspace.state !== "failed")
            .map((workspace) => workspace.sourceCheckpointId),
        ]).filter((value): value is string => Boolean(value)),
      );
      for (const priorRecovery of readTaskCheckpoints(input.task.id).filter((candidate) =>
        candidate.source === "pre_restore"
        && candidate.id !== recoveryCheckpoint?.id
        && !referencedRecoveryCheckpoints.has(candidate.id)
      )) {
        try {
          await deleteGitCheckpointRef(input.task.originalRepoPath, checkpointRef(priorRecovery));
          deleteTaskCheckpoint(priorRecovery.id);
        } catch {
          // Retention cleanup is best-effort after the atomic workspace switch succeeds.
        }
      }
      return restored;
    } catch (error) {
      await removeManagedWorktree(input.task.originalRepoPath, targetPath, input.managedRoot).catch(() => undefined);
      writeTaskWorkspace({ ...preparing, state: "failed" });
      throw error;
    }
  });
}
