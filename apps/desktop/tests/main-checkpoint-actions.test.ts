import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-checkpoint-actions-"));
  const task = { id: "source", chatId: "source-chat", worktreePath: root, originalRepoPath: root,
    workspaceKind: "git", workspaceMode: "local", agentBranch: "", state: "completed", changedFiles: [] };
  const tasks = [task];
  const calls = [];
  const actions = loadTypeScriptModule(new URL("../src/main/checkpointActions.ts", import.meta.url), { mocks: {
    "./mainRuntime": { getTask: () => task, publicTask: (value) => value, saveTask: (value) => calls.push(value), recordProductTelemetry: () => {} },
    "./chatStore": { taskId: () => "fork", createChat: () => ({ id: "fork-chat" }) },
    "./worktreeOps": {
      worktreeRootForRepo: () => path.join(root, "managed"),
      taskUsesIsolatedWorktree: (value) => value.workspaceMode === "worktree" && !!value.agentBranch,
    },
    "./storage": { readTasks: () => tasks, readTaskCheckpoints: () => [] },
    "./checkpoints/service": {
      createTaskCheckpoint: async () => { calls.push("created"); },
      forkTaskFromCheckpoint: async ({ targetTask }) => {
        assert.equal(targetTask.chatId, undefined);
        return targetTask;
      },
    },
  } });
  return { root, task, tasks, calls, actions };
}

test("checkpoint IPC refuses a competing writer in a shared folder before any mutation", async () => {
  const state = fixture();
  try {
    state.tasks.push({ ...state.task, id: "other-chat", state: "running" });
    assert.equal(state.actions.listTaskCheckpoints({ taskId: "source" }).supported, false);
    await assert.rejects(state.actions.createCheckpoint({ taskId: "source" }), /chat is using/);
    assert.deepEqual(state.calls, []);
  } finally { fs.rmSync(state.root, { recursive: true, force: true }); }
});

test("local Git and an initial read-only worktree chat use the same checkpoint eligibility", () => {
  const state = fixture();
  try {
    assert.equal(state.actions.checkpointEligibility(state.task).supported, true);
    state.task.workspaceMode = "worktree";
    assert.equal(state.actions.checkpointEligibility(state.task).supported, true);
    state.task.workspaceKind = "folder";
    assert.equal(state.actions.checkpointEligibility(state.task).supported, false);
  } finally { fs.rmSync(state.root, { recursive: true, force: true }); }
});

test("fork creates a separate chat without rebinding its source conversation", async () => {
  const state = fixture();
  try {
    const fork = await state.actions.forkCheckpoint({ taskId: "source", checkpointId: "saved" });
    assert.equal(fork.chatId, "fork-chat");
    assert.equal(fork.workspaceMode, "worktree");
    assert.equal(fork.worktreeRootTaskId, "fork");
    assert.equal(state.task.chatId, "source-chat");
    assert.equal(state.calls[0].id, "fork");
  } finally { fs.rmSync(state.root, { recursive: true, force: true }); }
});
