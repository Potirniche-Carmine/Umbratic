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

test("undo fingerprinting rejects replacement after open and closes without reading the replacement", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-undo-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "result.txt");
  fs.writeFileSync(file, "turn result");
  let reads = 0;
  let closed = false;
  const undo = loadTypeScriptModule(new URL("../src/main/checkpoints/undo.ts", import.meta.url), { mocks: { "node:fs": {
    ...fs,
    openSync: (...args) => {
      const descriptor = fs.openSync(...args);
      fs.renameSync(file, path.join(root, "original.txt"));
      fs.writeFileSync(file, "later change");
      return descriptor;
    },
    readSync: (...args) => { reads += 1; return fs.readSync(...args); },
    closeSync: (descriptor) => { closed = true; fs.closeSync(descriptor); },
  } } });
  await assert.rejects(() => undo.captureUndoFiles({ worktreePath: root, changedFiles: ["result.txt"] }), /changed while opening/);
  assert.equal(reads, 0);
  assert.equal(closed, true);
  assert.equal(fs.readFileSync(file, "utf8"), "later change");
});

test("undo fingerprinting rejects a file that grows during hashing", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-undo-growth-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "result.txt");
  fs.writeFileSync(file, "turn result");
  let reads = 0;
  const undo = loadTypeScriptModule(new URL("../src/main/checkpoints/undo.ts", import.meta.url), { mocks: { "node:fs": {
    ...fs,
    readSync: (...args) => {
      const count = fs.readSync(...args);
      reads += 1;
      fs.appendFileSync(file, "later work");
      return count;
    },
  } } });
  await assert.rejects(() => undo.captureUndoFiles({ worktreePath: root, changedFiles: ["result.txt"] }), /changed while reading/);
  assert.equal(reads, 1);
});
