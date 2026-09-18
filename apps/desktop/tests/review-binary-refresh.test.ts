import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

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
