import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

test("undo refuses later edits from another agent or user, including same-size binary changes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-undo-conflict-"));
  const undo = loadTypeScriptModule(new URL("../src/main/checkpoints/undo.ts", import.meta.url));
  const task = { worktreePath: root, changedFiles: ["text.txt", "binary.bin", "deleted.txt"] };
  try {
    fs.writeFileSync(path.join(root, "text.txt"), "turn result\n");
    fs.writeFileSync(path.join(root, "binary.bin"), Buffer.from([0, 1]));
    await undo.captureUndoFiles(task);
    await undo.assertUndoFileUnchanged(task, "text.txt");
    await undo.assertUndoFileUnchanged(task, "deleted.txt");
    fs.writeFileSync(path.join(root, "text.txt"), "another chat\n");
    fs.writeFileSync(path.join(root, "binary.bin"), Buffer.from([0, 2]));
    fs.writeFileSync(path.join(root, "deleted.txt"), "recreated by user\n");
    for (const file of task.changedFiles) await assert.rejects(() => undo.assertUndoFileUnchanged(task, file), /overwrite later work/);
    await assert.rejects(() => undo.assertUndoFileUnchanged(task, "not-reviewed.txt"), /overwrite later work/);
    assert.equal(fs.readFileSync(path.join(root, "text.txt"), "utf8"), "another chat\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("undo refuses staging changes even when the working file is unchanged", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-undo-index-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const undo = loadTypeScriptModule(new URL("../src/main/checkpoints/undo.ts", import.meta.url));
  const task = { workspaceKind: "git", worktreePath: root, changedFiles: ["file.txt"] };
  try {
    git("init", "-q");
    fs.writeFileSync(path.join(root, "file.txt"), "before\n");
    git("add", "file.txt");
    fs.writeFileSync(path.join(root, "file.txt"), "turn result\n");
    await undo.captureUndoFiles(task);
    await undo.assertUndoFileUnchanged(task, "file.txt");
    git("add", "file.txt");
    await assert.rejects(() => undo.assertUndoFileUnchanged(task, "file.txt"), /overwrite later work/);
    assert.equal(git("show", ":file.txt"), "turn result\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
