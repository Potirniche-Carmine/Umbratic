import * as fs from "node:fs";
import * as path from "node:path";

import { readTaskCheckpoints, readTasks, readTaskWorkspaces, writeTaskCheckpoint, writeTaskWorkspace } from "../storage";
import type { TaskRecord } from "../types";
import { deleteGitCheckpointRef, removeManagedWorktree } from "./gitAdapter";

function inside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export type CheckpointReconcileReport = {
  inspectedTasks: number;
  failedCheckpoints: number;
  failedWorkspaces: number;
  missingActiveWorkspaces: number;
};

export async function reconcileCheckpointLifecycle(
  managedRootForTask: (task: TaskRecord) => string,
): Promise<CheckpointReconcileReport> {
  const report: CheckpointReconcileReport = {
    inspectedTasks: 0,
    failedCheckpoints: 0,
    failedWorkspaces: 0,
    missingActiveWorkspaces: 0,
  };
  for (const task of readTasks()) {
    const checkpoints = readTaskCheckpoints(task.id);
    const workspaces = readTaskWorkspaces(task.id);
    if (!checkpoints.some((checkpoint) => checkpoint.state === "preparing")
      && !workspaces.some((workspace) => workspace.state === "preparing")
      && (!task.activeWorkspaceId || workspaces.some((workspace) => workspace.id === task.activeWorkspaceId && fs.existsSync(workspace.path)))) {
      continue;
    }
    report.inspectedTasks += 1;
    for (const checkpoint of checkpoints.filter((candidate) => candidate.state === "preparing")) {
      const ref = `refs/umbratic/checkpoints/${task.id}/${checkpoint.id}`;
      await deleteGitCheckpointRef(task.originalRepoPath, ref).catch(() => undefined);
      writeTaskCheckpoint({ ...checkpoint, state: "failed" });
      report.failedCheckpoints += 1;
    }
    const managedRoot = path.resolve(managedRootForTask(task));
    for (const workspace of workspaces.filter((candidate) => candidate.state === "preparing")) {
      const target = path.resolve(workspace.path);
      if (target !== managedRoot && inside(managedRoot, target) && fs.existsSync(target)) {
        await removeManagedWorktree(task.originalRepoPath, target, managedRoot).catch(() => undefined);
      }
      writeTaskWorkspace({ ...workspace, state: "failed" });
      report.failedWorkspaces += 1;
    }
    if (task.activeWorkspaceId) {
      const active = workspaces.find((workspace) => workspace.id === task.activeWorkspaceId);
      if (!active || !fs.existsSync(active.path)) report.missingActiveWorkspaces += 1;
    }
  }
  return report;
}
