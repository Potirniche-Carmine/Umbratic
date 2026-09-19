import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createGitCheckpoint } from "../src/main/checkpoints/gitAdapter.ts";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-review-undo-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (file, content) => fs.writeFileSync(path.join(root, file), content);
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  git("init");
  git("config", "user.name", "Undo Test");
  git("config", "user.email", "undo@example.test");
  git("config", "core.autocrlf", "false");
  write("a.txt", "baseline a\n");
  write("b.txt", "baseline b\n");
  git("add", ".");
  git("commit", "-m", "baseline");
  const task = { id: "task-undo", chatId: "chat", repositoryId: "repo", originalRepoPath: root,
    worktreePath: root, workspaceKind: "git", workspaceMode: "local", state: "completed",
    baseCommit: git("rev-parse", "HEAD"), activeWorkspaceId: "workspace", reviewFiles: [], changedFiles: [],
    reviewScope: "task", undoFileHashes: {}, turnCheckpointId: "", baselineFiles: {} };
  const tasks = [task];
  const checkpoints = [];
  let before = new Map();
  const snapshot = () => new Map(fs.readdirSync(root).filter((file) => file !== ".git")
    .map((file) => [file, fs.readFileSync(path.join(root, file))]));
  const reviews = () => {
    const after = snapshot();
    return [...new Set([...before.keys(), ...after.keys()])].sort().filter((file) =>
      !before.get(file)?.equals(after.get(file) ?? Buffer.alloc(0)) || !after.has(file))
      .map((file) => ({ path: file }));
  };
  const storage = { readTasks: () => tasks, readTaskCheckpoints: () => checkpoints };
  const service = loadTypeScriptModule(new URL("../src/main/checkpoints/service.ts", import.meta.url), {
    mocks: { "../storage": storage },
  });
  const fingerprints = loadTypeScriptModule(new URL("../src/main/checkpoints/undo.ts", import.meta.url));
  const refreshReview = async (value, scope) => {
    value.reviewFiles = reviews();
    value.changedFiles = value.reviewFiles.map((file) => file.path);
    value.reviewScope = scope;
    return value.reviewFiles;
  };
  const { undoTaskChanges } = loadTypeScriptModule(new URL("../src/main/reviewUndo.ts", import.meta.url), { mocks: {
    "./mainRuntime": { getTask: () => task, publicTask: (value) => value, saveTask: () => {}, recordProductTelemetry: () => {} },
    "./storage": storage,
    "./checkpoints/service": service,
    "./reviewFiles": { gitReviewFiles: async () => reviews(), folderReviewFiles: reviews, refreshReview },
  } });
  const checkpoint = async () => {
    before = snapshot();
    const id = `checkpoint-${checkpoints.length}`;
    const result = await createGitCheckpoint({ workspacePath: root, taskId: task.id, checkpointId: id, seedCommit: task.baseCommit });
    checkpoints.push({ ...result, id, taskId: task.id, workspaceId: task.activeWorkspaceId, source: "pre_turn", state: "ready" });
    task.turnCheckpointId = id;
    task.baselineFiles = Object.fromEntries([...before].map(([file, content]) => [file, content.toString()]));
  };
  const settle = async () => { await refreshReview(task, "task"); await fingerprints.captureUndoFiles(task); };
  return { root, task, tasks, checkpoints, git, write, read, checkpoint, settle, undo: (input = {}) => undoTaskChanges({ taskId: task.id, ...input }) };
}

test("per-file undo followed by Undo all restores the previous prompt, including staging, in the same workspace", async (t) => {
  const f = fixture(t);
  await f.checkpoint();
  f.write("a.txt", "prompt one a\n");
  f.write("b.txt", "prompt one b\n");
  f.git("add", "a.txt");
  await f.settle();
  await f.checkpoint();
  f.write("a.txt", "prompt two a\n");
  f.write("b.txt", "prompt two b\n");
  f.write("new.bin", Buffer.from([0, 1, 255]));
  f.git("add", ".");
  await f.settle();
  await f.undo({ path: "a.txt" });
  assert.equal(f.read("a.txt"), "prompt one a\n");
  assert.equal(f.read("b.txt"), "prompt two b\n");
  assert.equal(fs.existsSync(path.join(f.root, "new.bin")), true);
  await f.undo();
  assert.equal(f.read("b.txt"), "prompt one b\n");
  assert.equal(fs.existsSync(path.join(f.root, "new.bin")), false);
  assert.equal(f.git("show", ":a.txt"), "prompt one a");
  assert.equal(f.git("show", ":b.txt"), "baseline b");
  assert.equal(f.task.worktreePath, f.root);
  assert.deepEqual(f.task.changedFiles, []);
});

test("Undo all restores deleted and binary files from the automatic snapshot", async (t) => {
  const f = fixture(t);
  const binary = Buffer.from([0, 2, 255]);
  f.write("existing.bin", binary);
  await f.checkpoint();
  fs.unlinkSync(path.join(f.root, "a.txt"));
  f.write("existing.bin", Buffer.from([0, 3, 255]));
  await f.settle();
  await f.undo();
  assert.equal(f.read("a.txt"), "baseline a\n");
  assert.deepEqual(fs.readFileSync(path.join(f.root, "existing.bin")), binary);
});

test("a later edit blocks the entire undo before any files are restored", async (t) => {
  const f = fixture(t);
  await f.checkpoint();
  f.write("a.txt", "agent a\n");
  f.write("b.txt", "agent b\n");
  await f.settle();
  f.write("b.txt", "another chat\n");
  await assert.rejects(f.undo(), /changed after this turn/);
  assert.equal(f.read("a.txt"), "agent a\n");
  assert.equal(f.read("b.txt"), "another chat\n");
});

test("Undo all leaves unrelated later files alone, regardless of review scope", async (t) => {
  const f = fixture(t);
  await f.checkpoint();
  f.write("a.txt", "agent\n");
  await f.settle();
  f.write("later.txt", "another chat\n");
  f.task.reviewScope = "worktree";
  await f.undo();
  assert.equal(f.read("a.txt"), "baseline a\n");
  assert.equal(f.read("later.txt"), "another chat\n");
  assert.equal(f.task.reviewScope, "task");
});

test("an active chat in the same folder blocks Undo all", async (t) => {
  const f = fixture(t);
  await f.checkpoint();
  f.write("a.txt", "agent\n");
  await f.settle();
  f.tasks.push({ ...f.task, id: "other-task", state: "running" });
  await assert.rejects(f.undo(), /chat is using this folder/);
  assert.equal(f.read("a.txt"), "agent\n");
});

test("undo rejects missing or foreign automatic snapshots and invalid path input", async (t) => {
  const f = fixture(t);
  await f.checkpoint();
  f.write("a.txt", "agent\n");
  await f.settle();
  await assert.rejects(f.undo({ path: "../outside.txt" }), /not available for undo/);
  await assert.rejects(f.undo({ path: null }), /path/);
  f.checkpoints[0].workspaceId = "other-workspace";
  await assert.rejects(f.undo(), /does not belong/);
  f.task.turnCheckpointId = undefined;
  await assert.rejects(f.undo(), /no verified pre-turn checkpoint/);
  assert.equal(f.read("a.txt"), "agent\n");
});
