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
    baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    agentBranch: `umbratic/${taskId}`,
    permissionMode: "normal",
    reasoningMode: "reasoning",
    createdAt: "2026-01-01T00:00:00.000Z",
    changedFiles: ["tracked.txt"],
    reviewFiles: [],
    events: [],
    activeWorkspaceId: "workspace-1",
    turnCheckpointId: "checkpoint-pre-turn",
    baselineFiles: { "tracked.txt": "before\n" },
  };
  const checkpoints = [{
    id: "checkpoint-pre-turn",
    taskId,
    workspaceId: "workspace-1",
    source: "pre_turn",
    commitOid: "pre-turn-commit",
    treeOid: "pre-turn-tree",
    indexTreeOid: "pre-turn-index",
    createdAt: "2026-01-01T00:01:00.000Z",
    state: "ready",
    pinned: false,
  }];
  const workspaces = [{
    id: "workspace-1",
    taskId,
    number: 1,
    branch: task.agentBranch,
    path: task.worktreePath,
    createdAt: task.createdAt,
    state: "active",
  }];
  let restoreCalls = 0;
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
      storage.writeTaskWorkspace(active);
      if (previous) storage.writeTaskWorkspace(previous);
      Object.assign(task, value);
    },
  };
  const git = {
    createGitCheckpoint: async ({ checkpointId }) => ({
      commitOid: `recovery-${checkpointId}`,
      treeOid: `tree-${checkpointId}`,
      indexTreeOid: `index-${checkpointId}`,
      logicalBytes: 64,
      ref: `refs/umbratic/checkpoints/${taskId}/${checkpointId}`,
    }),
    restoreGitCheckpoint: async () => {
      restoreCalls += 1;
    },
    deleteGitCheckpointRef: async () => undefined,
    materializeCheckpointWorktree: async () => undefined,
    removeManagedWorktree: async () => undefined,
  };
  const service = loadTypeScriptModule(servicePath, {
    cache: new Map(),
    mocks: { "../storage": storage, "./gitAdapter": git },
  });
  return {
    task,
    service,
    restoreCalls: () => restoreCalls,
  };
}

test("reject restore requires a verified pre-turn checkpoint", async () => {
  const state = fixture("task-reject-ok");
  await state.service.restoreIsolatedWorktreeForReject(state.task, true);
  assert.equal(state.restoreCalls(), 1);
  assert.equal(state.task.turnCheckpointId, undefined);
});

test("reject without turnCheckpointId fails closed and never restores", async () => {
  const state = fixture("task-reject-missing");
  state.task.turnCheckpointId = undefined;
  await assert.rejects(
    () => state.service.restoreIsolatedWorktreeForReject(state.task, true),
    /Automatic reject is unsafe: no verified pre-turn checkpoint/,
  );
  assert.equal(state.restoreCalls(), 0);
});

test("reject with missing worktree fails closed", async () => {
  const state = fixture("task-reject-missing-worktree");
  await assert.rejects(
    () => state.service.restoreIsolatedWorktreeForReject(state.task, false),
    /Automatic reject is unsafe: no verified pre-turn checkpoint/,
  );
  assert.equal(state.restoreCalls(), 0);
});

test("folder reject without baseline fails closed", () => {
  const state = fixture("task-reject-folder");
  state.task.baselineFiles = undefined;
  assert.throws(
    () => state.service.assertFolderRejectBaseline(state.task),
    /Automatic reject is unsafe: no verified undo baseline/,
  );
});
