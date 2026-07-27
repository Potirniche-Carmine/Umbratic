import assert from "node:assert/strict";
import test from "node:test";

import type { BackendUiEvent, TaskInfo } from "../src/shared/desktopApi.ts";
import {
  reduceApprovalChecks,
  reducePendingPermission,
  reduceVisibleTask,
  taskEventEffects,
} from "../src/renderer/taskEventReducer.ts";

function task(): TaskInfo {
  return {
    id: "task-1",
    repositoryId: "repository-1",
    prompt: "Change the app",
    workspaceKind: "git",
    workspaceMode: "local",
    state: "running",
    originalBranch: "main",
    baseCommit: "base",
    agentBranch: "",
    worktreePath: "",
    permissionMode: "normal",
    createdAt: "2026-01-01T00:00:00.000Z",
    changedFiles: [],
    reviewFiles: [],
    events: [],
  };
}

test("task-event reducer applies task lifecycle transitions", () => {
  const events: BackendUiEvent[] = [
    {
      type: "worktree.requested",
      taskId: "task-1",
      path: "C:/worktree",
      branch: "codex/change",
      at: "2026-01-01T00:00:01.000Z",
    },
    {
      type: "worktree.created",
      taskId: "task-1",
      path: "C:/worktree",
      branch: "codex/change",
      at: "2026-01-01T00:00:02.000Z",
    },
    {
      type: "review.ready",
      taskId: "task-1",
      changedFiles: ["src/app.ts"],
      reviewFiles: [],
      at: "2026-01-01T00:00:03.000Z",
    },
    {
      type: "approval.completed",
      taskId: "task-1",
      patchHash: "patch-1",
      at: "2026-01-01T00:00:04.000Z",
    },
    {
      type: "merge.completed",
      taskId: "task-1",
      patchHash: "patch-2",
      at: "2026-01-01T00:00:05.000Z",
    },
  ];
  const states = events.reduce<TaskInfo | null>(reduceVisibleTask, task());
  assert.equal(states?.state, "merged");
  assert.equal(states?.patchHash, "patch-2");
  assert.equal(states?.worktreePath, "C:/worktree");
  assert.deepEqual(states?.changedFiles, ["src/app.ts"]);
});

test("task-event reducer keeps permission and approval state deterministic", () => {
  const requested: BackendUiEvent = {
    type: "permission.requested",
    taskId: "task-1",
    request: {
      id: "permission-1",
      kind: "edit",
      summary: "Edit src/app.ts",
      command: "",
      cwd: "C:/workspace",
    },
    at: "2026-01-01T00:00:01.000Z",
  };
  const resolved: BackendUiEvent = {
    type: "permission.resolved",
    taskId: "task-1",
    id: "permission-1",
    decision: "allow",
    at: "2026-01-01T00:00:02.000Z",
  };
  const pending = reducePendingPermission(null, requested);
  assert.equal(pending?.id, "permission-1");
  assert.equal(reducePendingPermission(pending, resolved), null);

  const checks = reduceApprovalChecks([], {
    type: "approval.check",
    taskId: "task-1",
    name: "tests",
    status: "passed",
    detail: "All tests passed",
    at: "2026-01-01T00:00:03.000Z",
  });
  assert.deepEqual(checks, [
    { name: "tests", status: "passed", detail: "All tests passed" },
  ]);
});

test("task-event reducer exposes effects without running I/O", () => {
  const event: BackendUiEvent = {
    type: "task.error",
    taskId: "task-1",
    message: "Runner stopped",
    at: "2026-01-01T00:00:01.000Z",
  };
  assert.deepEqual(taskEventEffects(event), {
    reloadChats: true,
    refreshReview: false,
    resetExpandedReview: false,
    errorMessage: "Runner stopped",
  });
  assert.equal(reduceVisibleTask(task(), { ...event, taskId: "other" })?.state, "running");
});
