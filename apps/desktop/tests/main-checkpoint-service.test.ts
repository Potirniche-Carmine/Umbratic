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
    task, checkpoints, workspaces, storage, git, service, managedRoot,
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

test("unchanged recovery snapshots stay pinned and restore clears stale turn state", async () => {
  const state = fixture("task-unchanged");
  state.task.turnCheckpointId = "old-turn";
  state.task.baselineFiles = { "tracked.txt": "old" };
  state.task.undoFileHashes = { "tracked.txt": "old-hash" };
  state.task.mergedAt = "2026-01-01T00:01:00.000Z";
  state.task.latestCheckpointId = "checkpoint-target";
  state.git.createGitCheckpoint = async () => ({ commitOid: "same", treeOid: "target-tree", indexTreeOid: "staging", logicalBytes: 0 });
  const restored = await state.service.restoreTaskCheckpoint({ task: state.task, checkpointId: "checkpoint-target", managedRoot: state.managedRoot });
  const recovery = state.checkpoints.find((checkpoint) => checkpoint.source === "pre_restore");
  assert.equal(recovery?.pinned, true);
  assert.notEqual(recovery.id, "checkpoint-target");
  assert.equal(restored.turnCheckpointId, undefined);
  assert.equal(restored.baselineFiles, undefined);
  assert.equal(restored.undoFileHashes, undefined);
  assert.equal(restored.mergedAt, undefined);
  assert.equal(restored.latestCheckpointId, "checkpoint-target");
  assert.equal(restored.state, "completed");
});

test("retention keeps the current turn and checkpoints referenced by other chats", async () => {
  const state = fixture("task-retention");
  state.checkpoints[0].pinned = false;
  state.storage.readTasks = () => [state.task, { id: "fork", sourceCheckpointId: "checkpoint-target" }];
  const beforeTurn = await state.service.createTurnCheckpoint(state.task);
  for (let i = 0; i < 15; i++) await state.service.createTaskCheckpoint(state.task, "manual", `checkpoint ${i}`);
  assert.ok(state.checkpoints.some((checkpoint) => checkpoint.id === beforeTurn.id));
  assert.ok(state.checkpoints.some((checkpoint) => checkpoint.id === "checkpoint-target"));
  assert.ok(state.checkpoints.length <= 12);
});

test("retention failure cannot invalidate a published pre-turn checkpoint", async () => {
  const state = fixture("task-retention-failure");
  state.storage.readTasks = () => { throw new Error("retention unavailable"); };
  const checkpoint = await state.service.createTurnCheckpoint(state.task);
  assert.equal(checkpoint.state, "ready");
  assert.equal(state.task.turnCheckpointId, checkpoint.id);
  assert.equal(state.checkpoints.find((row) => row.id === checkpoint.id)?.state, "ready");
});

test("failed publication does not leave in-memory task pointers on an unusable checkpoint", async () => {
  const state = fixture("task-publication-failure");
  state.task.latestCheckpointId = "checkpoint-target";
  state.task.turnCheckpointId = "old-turn";
  state.storage.completeTaskCheckpoint = () => { throw new Error("transaction failed"); };
  await assert.rejects(state.service.createTurnCheckpoint(state.task), /transaction failed/);
  assert.equal(state.task.latestCheckpointId, "checkpoint-target");
  assert.equal(state.task.turnCheckpointId, "old-turn");
  assert.equal(state.checkpoints[0].state, "failed");
});

test("shared workspace snapshots serialize while independent workspaces can progress", async () => {
  const state = fixture("task-concurrent");
  const originalTaskId = state.task.id;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const entered = [];
  state.git.createGitCheckpoint = async ({ taskId, checkpointId }) => {
    entered.push(taskId);
    if (taskId === originalTaskId) await blocked;
    return { commitOid: checkpointId, treeOid: checkpointId, indexTreeOid: checkpointId };
  };
  const first = state.service.createTurnCheckpoint(state.task);
  const sibling = state.service.createTurnCheckpoint({ ...state.task, id: "same-workspace" });
  const separate = state.service.createTurnCheckpoint({ ...state.task, id: "separate-workspace", worktreePath: "/managed/other" });
  await separate;
  assert.deepEqual(entered, [originalTaskId, "separate-workspace"]);
  release();
  await Promise.all([first, sibling]);
  assert.deepEqual(entered, [originalTaskId, "separate-workspace", "same-workspace"]);
});

test("local Git chats get automatic checkpoints and restore into their own worktree", async () => {
  const state = fixture("task-local");
  state.task.workspaceMode = "local";
  state.task.agentBranch = "";
  const before = await state.service.createTurnCheckpoint(state.task);
  const restored = await state.service.restoreTaskCheckpoint({ task: state.task, checkpointId: before.id, managedRoot: state.managedRoot });
  assert.equal(restored.workspaceMode, "worktree");
  assert.equal(restored.worktreeRootTaskId, state.task.id);
  const relative = path.relative(path.resolve(state.managedRoot), path.resolve(restored.worktreePath));
  assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
});

test("a chat moving into an editing worktree gives its checkpoints a new workspace owner", async () => {
  const state = fixture("task-worktree-handoff");
  state.task.latestCheckpointId = "checkpoint-target";
  const previousPath = state.task.worktreePath;
  state.task.worktreePath = path.join(state.managedRoot, "editing");
  const checkpoint = await state.service.createTurnCheckpoint(state.task);
  assert.notEqual(checkpoint.workspaceId, "workspace-1");
  assert.equal(state.workspaces.find((row) => row.id === checkpoint.workspaceId)?.path, state.task.worktreePath);
  const previous = state.workspaces.find((row) => row.id === "workspace-1");
  assert.equal(previous.path, previousPath);
  assert.equal(previous.state, "recovery");
  assert.equal(previous.sourceCheckpointId, "checkpoint-target");
});

test("a failed materialization leaves the active workspace and other chats' files alone", async () => {
  const state = fixture("task-failed");
  const previousPath = state.task.worktreePath;
  let removed = false;
  state.git.materializeCheckpointWorktree = async () => { throw new Error("target exists"); };
  state.git.removeManagedWorktree = async () => { removed = true; };
  await assert.rejects(state.service.restoreTaskCheckpoint({ task: state.task, checkpointId: "checkpoint-target", managedRoot: state.managedRoot }), /target exists/);
  assert.equal(removed, false);
  assert.equal(state.task.worktreePath, previousPath);
  assert.equal(state.activated(), undefined);
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
