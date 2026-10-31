import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

test("generated images stay out of task reviews while code and ordinary image changes remain", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-generated-review-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mocks = { electron: {
    app: { getPath: () => root, on: () => {}, whenReady: async () => {} },
    BrowserWindow: class {}, safeStorage: { isEncryptionAvailable: () => false },
  } };
  const review = loadTypeScriptModule(new URL("../src/main/reviewFiles.ts", import.meta.url), { mocks });
  const { withoutGeneratedImages } = loadTypeScriptModule(new URL("../src/shared/generatedImages.ts", import.meta.url));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, encoding: "utf8", stdio: "pipe" }).trim();
  git("init");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Baseline");
  for (const file of ["sphere.png", "asset.png"]) fs.writeFileSync(path.join(workspace, file), Buffer.from([137, 80, 78, 71, 0, 1]));
  fs.writeFileSync(path.join(workspace, "main.ts"), "export const value = 1;\n");
  const events = [
    { type: "command.finished", taskId: "image-task", id: "image-1", exitCode: 0, details: { image: true, path: "sphere.png" } },
    { type: "command.finished", taskId: "image-task", id: "image-2", exitCode: 1, details: { image: true, path: "asset.png" } },
  ];
  const task = { worktreePath: workspace, originalRepoPath: workspace, workspaceKind: "git", baseCommit: git("rev-parse", "HEAD"), baselineFiles: {}, events };
  for (const files of [review.folderReviewFiles(task), await review.gitReviewFiles(task), await review.gitReviewFiles(task, "HEAD")]) {
    assert.deepEqual(Array.from(files, (file) => file.path).sort(), ["asset.png", "main.ts"]);
  }
  await review.refreshReview(task);
  assert.deepEqual(Array.from(task.changedFiles).sort(), ["asset.png", "main.ts"]);
  const cached = [{ path: "sphere.png" }, { path: "asset.png" }, { path: "main.ts" }];
  assert.deepEqual(Array.from(withoutGeneratedImages(cached, events), (file) => file.path), ["asset.png", "main.ts"]);
  assert.equal(fs.existsSync(path.join(workspace, "sphere.png")), true, "review exclusion must preserve the generated file");
});

test("successive binary edits invalidate folder and untracked Git review previews", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-binary-review-"));
  try {
    const mocks = { electron: {
      app: { getPath: () => root, on: () => {}, whenReady: async () => {} },
      BrowserWindow: class {}, safeStorage: { isEncryptionAvailable: () => false },
    } };
    const cache = new Map();
    const review = loadTypeScriptModule(new URL("../src/main/reviewFiles.ts", import.meta.url), { mocks, cache });
    const snapshot = loadTypeScriptModule(new URL("../src/main/workspaceSnapshot.ts", import.meta.url), { mocks, cache });
    const diff = loadTypeScriptModule(new URL("../src/shared/reviewDiff.ts", import.meta.url), { mocks, cache });
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, stdio: "pipe" });
    git("init");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Baseline");
    const relative = "notes.docx";
    const file = path.join(workspace, relative);
    const write = (value: number) => {
      fs.writeFileSync(file, Buffer.from([80, 75, 0, value]));
      const time = new Date(1_800_000_000_000 + value * 1000);
      fs.utimesSync(file, time, time);
    };
    write(1);
    const task = { worktreePath: workspace, baselineFiles: snapshot.snapshotFolder(workspace) };
    write(2);
    const folderBefore = review.folderReviewFiles(task);
    const gitBefore = [await review.gitWorkspaceReviewFile(workspace, "HEAD", relative)];
    write(3);
    const folderAfter = review.folderReviewFiles(task);
    const gitAfter = [await review.gitWorkspaceReviewFile(workspace, "HEAD", relative)];
    for (const [before, after] of [[folderBefore, folderAfter], [gitBefore, gitAfter]]) {
      assert.equal(before.length, 1);
      assert.equal(after.length, 1);
      assert.equal(before[0].binary, true);
      assert.equal(before[0].patch, after[0].patch, "binary display text stays the same");
      assert.notEqual(before[0].contentHash, after[0].contentHash);
      assert.notEqual(review.reviewPatchHash(before), review.reviewPatchHash(after));
      assert.notEqual(diff.reviewContentHash(before), diff.reviewContentHash(after));
      assert.equal(diff.normalizeReviewFile(after[0]).contentHash, after[0].contentHash);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
