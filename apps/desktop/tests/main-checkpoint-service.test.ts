import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const servicePath = new URL("../src/main/checkpoints/service.ts", import.meta.url);

function fixture(taskId: string) {
  const managedRoot = path.join("/managed", taskId);
  const task = {
    id: taskId,
    repositoryId: "repo",
    prompt: "checkpoint task",
    originalRepoPath: "/repository",
    worktreePath: path.join(managedRoot, "active"),
    workspaceKind: "git",
    workspaceMode: "worktree",
    state: "completed",
    originalBranch: "main",
    baseCommit: "base",
    agentBranch: `umbratic/${taskId}`,
    permissionMode: "normal",
    createdAt: "2026-01-01T00:00:00.000Z",
    changedFiles: ["tracked.txt"],
    reviewFiles: [],
    events: [],
    activeWorkspaceId: "workspace-1",
  };
  const checkpoints = [{
    id: "checkpoint-target", taskId, workspaceId: "workspace-1", source: "manual",
    commitOid: "target-commit", treeOid: "target-tree", createdAt: "2026-01-01T00:01:00.000Z",
    state: "ready", pinned: true,
  }];
  const workspaces = [{
    id: "workspace-1", taskId, number: 1, branch: task.agentBranch, path: task.worktreePath,
    createdAt: task.createdAt, state: "active",
  }];
  let activated;
  let checkpointCreations = 0;
  const storage = {
    readTasks: () => [task],
    readTaskCheckpoints: () => checkpoints,
    readTaskWorkspaces: () => workspaces,
    writeTask: (value) => Object.assign(task, value),
    writeTaskCheckpoint: (value) => {
      const index = checkpoints.findIndex((candidate) => candidate.id === value.id);
      if (index >= 0) checkpoints[index] = value;
      else checkpoints.unshift(value);
    },
    completeTaskCheckpoint: (value, checkpoint) => {
      storage.writeTaskCheckpoint(checkpoint);
      Object.assign(task, value);
    },
    deleteTaskCheckpoint: (id) => {
      const index = checkpoints.findIndex((candidate) => candidate.id === id);
      if (index >= 0) checkpoints.splice(index, 1);
    },
    writeTaskWorkspace: (value) => {
      const index = workspaces.findIndex((candidate) => candidate.id === value.id);
      if (index >= 0) workspaces[index] = value;
      else workspaces.unshift(value);
    },
    activateTaskWorkspace: (value, active, previous) => {
      activated = { task: value, active, previous };
      storage.writeTaskWorkspace(active);
      if (previous) storage.writeTaskWorkspace(previous);
      Object.assign(task, value);
    },
  };
  const git = {
    createGitCheckpoint: async ({ checkpointId }) => {
      checkpointCreations += 1;
      return {
        commitOid: `recovery-${checkpointId}`, treeOid: `tree-${checkpointId}`,
        logicalBytes: 64, ref: `refs/umbratic/checkpoints/${taskId}/${checkpointId}`,
      };
    },
    deleteGitCheckpointRef: async () => undefined,
    materializeCheckpointWorktree: async () => undefined,
    removeManagedWorktree: async () => undefined,
  };
  const service = loadTypeScriptModule(servicePath, {
    cache: new Map(), mocks: { "../storage": storage, "./gitAdapter": git },
  });
  return {
    task, checkpoints, service, managedRoot,
    activated: () => activated,
    checkpointCreations: () => checkpointCreations,
  };
}

test("restore links the displaced workspace to its pre-restore recovery checkpoint", async () => {
  const state = fixture("task-normal-restore");
  const restored = await state.service.restoreTaskCheckpoint({
    task: state.task,
    checkpointId: "checkpoint-target",
    managedRoot: state.managedRoot,
  });
  const recovery = state.checkpoints.find((checkpoint) => checkpoint.source === "pre_restore");
  assert.ok(recovery);
  assert.equal(recovery.state, "ready");
  assert.equal(recovery.pinned, true);
  assert.equal(state.activated().previous.sourceCheckpointId, recovery.id);
  assert.equal(state.activated().previous.state, "recovery");
  assert.equal(state.activated().active.state, "active");
  assert.equal(restored.sourceCheckpointId, "checkpoint-target");
  assert.equal(state.checkpointCreations(), 1);
});

test("a missing active worktree restores from durable checkpoint without taking an impossible snapshot", async () => {
  const state = fixture("task-missing-restore");
  const restored = await state.service.restoreTaskCheckpoint({
    task: state.task,
    checkpointId: "checkpoint-target",
    managedRoot: state.managedRoot,
    skipRecoveryCheckpoint: true,
  });
  assert.equal(state.checkpointCreations(), 0);
  assert.equal(state.activated().previous.state, "failed");
  assert.equal(state.activated().active.state, "active");
  assert.equal(restored.sourceCheckpointId, "checkpoint-target");
});
