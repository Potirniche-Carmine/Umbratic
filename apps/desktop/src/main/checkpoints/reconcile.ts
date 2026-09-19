import * as fs from "node:fs";
import { readTaskCheckpoints, readTasks, readTaskWorkspaces, writeTaskCheckpoint, writeTaskWorkspace } from "../storage";
import { deleteGitCheckpointRef } from "./gitAdapter";

export type CheckpointReconcileReport = {
  inspectedTasks: number;
  failedCheckpoints: number;
  failedWorkspaces: number;
  missingActiveWorkspaces: number;
};

export async function reconcileCheckpointLifecycle(): Promise<CheckpointReconcileReport> {
  const report: CheckpointReconcileReport = {
    inspectedTasks: 0,
    failedCheckpoints: 0,
    failedWorkspaces: 0,
    missingActiveWorkspaces: 0,
  };
  // Capture the interrupted rows before yielding. A new operation in another
  // chat must not become part of this startup repair while Git is awaited.
  const interrupted = readTasks().map((task) => ({ task,
    checkpoints: readTaskCheckpoints(task.id), workspaces: readTaskWorkspaces(task.id) }));
  const refsToDelete: Array<{ repository: string; ref: string }> = [];
  for (const { task, checkpoints, workspaces } of interrupted) {
    if (!checkpoints.some((checkpoint) => checkpoint.state === "preparing")
      && !workspaces.some((workspace) => workspace.state === "preparing")
      && (!task.activeWorkspaceId || workspaces.some((workspace) => workspace.id === task.activeWorkspaceId && fs.existsSync(workspace.path)))) {
      continue;
    }
    report.inspectedTasks += 1;
    for (const checkpoint of checkpoints.filter((candidate) => candidate.state === "preparing")) {
      const ref = `refs/umbratic/checkpoints/${task.id}/${checkpoint.id}`;
      refsToDelete.push({ repository: task.originalRepoPath, ref });
      writeTaskCheckpoint({ ...checkpoint, state: "failed" });
      report.failedCheckpoints += 1;
    }
    for (const workspace of workspaces.filter((candidate) => candidate.state === "preparing")) {
      // A recorded path alone proves neither ownership nor that its ignored
      // files are disposable. Keep it available for explicit recovery.
      writeTaskWorkspace({ ...workspace, state: "failed" });
      report.failedWorkspaces += 1;
    }
    if (task.activeWorkspaceId) {
      const active = workspaces.find((workspace) => workspace.id === task.activeWorkspaceId);
      if (!active || !fs.existsSync(active.path)) report.missingActiveWorkspaces += 1;
    }
  }
  for (const { repository, ref } of refsToDelete) {
    await deleteGitCheckpointRef(repository, ref).catch(() => undefined);
  }
  return report;
}
