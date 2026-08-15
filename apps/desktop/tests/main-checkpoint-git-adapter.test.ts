import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { createGitCheckpoint, materializeCheckpointWorktree, restoreGitCheckpointPath } from "../src/main/checkpoints/gitAdapter.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixtureRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-checkpoint-test-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "Checkpoint Test"]);
  git(root, ["config", "user.email", "checkpoint@example.test"]);
  git(root, ["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
  fs.writeFileSync(path.join(root, "deleted.txt"), "remove me\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "base"]);
  return root;
}

test("checkpoint captures tracked, deleted, and untracked state without changing visible Git state", async () => {
  const root = fixtureRepository();
  try {
    fs.writeFileSync(path.join(root, "tracked.txt"), "changed\n");
    fs.rmSync(path.join(root, "deleted.txt"));
    fs.writeFileSync(path.join(root, "new.txt"), "untracked\n");
    const headBefore = git(root, ["rev-parse", "HEAD"]);
    const branchBefore = git(root, ["symbolic-ref", "HEAD"]);
    const statusBefore = git(root, ["status", "--porcelain=v1"]);
    const indexPath = git(root, ["rev-parse", "--git-path", "index"]);
    const indexBefore = fs.readFileSync(path.resolve(root, indexPath));

    const checkpoint = await createGitCheckpoint({
      workspacePath: root,
      taskId: "task-1",
      checkpointId: "checkpoint-1",
      seedCommit: headBefore,
    });

    assert.equal(git(root, ["rev-parse", "HEAD"]), headBefore);
    assert.equal(git(root, ["symbolic-ref", "HEAD"]), branchBefore);
    assert.equal(git(root, ["status", "--porcelain=v1"]), statusBefore);
    assert.deepEqual(fs.readFileSync(path.resolve(root, indexPath)), indexBefore);
    assert.equal(git(root, ["show", `${checkpoint.commitOid}:tracked.txt`]), "changed");
    assert.equal(git(root, ["show", `${checkpoint.commitOid}:new.txt`]), "untracked");
    assert.throws(() => git(root, ["show", `${checkpoint.commitOid}:deleted.txt`]));
    assert.equal(git(root, ["rev-parse", checkpoint.ref]), checkpoint.commitOid);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint rejects blocked secrets and materializes a contained fork", async () => {
  const root = fixtureRepository();
  const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-worktrees-test-"));
  try {
    fs.writeFileSync(path.join(root, ".env"), "TOKEN=secret\n");
    await assert.rejects(
      createGitCheckpoint({ workspacePath: root, taskId: "task-2", checkpointId: "blocked", seedCommit: "HEAD" }),
      /blocked credential/,
    );
    fs.rmSync(path.join(root, ".env"));
    fs.writeFileSync(path.join(root, "new.txt"), "fork content\n");
    const checkpoint = await createGitCheckpoint({ workspacePath: root, taskId: "task-2", checkpointId: "ready", seedCommit: "HEAD" });
    const target = path.join(managedRoot, "fork-1");
    await materializeCheckpointWorktree({
      repositoryPath: root,
      checkpointCommit: checkpoint.commitOid,
      branch: "umbratic/fork-1",
      targetPath: target,
      managedRoot,
    });
    assert.equal(fs.readFileSync(path.join(target, "new.txt"), "utf8"), "fork content\n");
    assert.equal(git(target, ["rev-parse", "HEAD"]), checkpoint.commitOid);
    await assert.rejects(materializeCheckpointWorktree({
      repositoryPath: root,
      checkpointCommit: checkpoint.commitOid,
      branch: "umbratic/escape",
      targetPath: path.join(managedRoot, "..", "escape"),
      managedRoot,
    }), /outside the managed root/);
  } finally {
    try { git(root, ["worktree", "remove", "--force", path.join(managedRoot, "fork-1")]); } catch { /* absent */ }
    fs.rmSync(managedRoot, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint uses its seed tree when a file is reverted to the visible base state", async () => {
  const root = fixtureRepository();
  try {
    fs.writeFileSync(path.join(root, "tracked.txt"), "first checkpoint\n");
    const first = await createGitCheckpoint({
      workspacePath: root, taskId: "task-revert", checkpointId: "first", seedCommit: "HEAD",
    });
    fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
    const second = await createGitCheckpoint({
      workspacePath: root, taskId: "task-revert", checkpointId: "second", seedCommit: first.commitOid,
    });
    assert.equal(git(root, ["show", `${second.commitOid}:tracked.txt`]), "base");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint refuses symbolic links and junctions instead of following them", async () => {
  const root = fixtureRepository();
  const linkTarget = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-checkpoint-link-target-"));
  try {
    fs.writeFileSync(path.join(linkTarget, "notes.txt"), "linked fixture\n");
    fs.symlinkSync(linkTarget, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      createGitCheckpoint({
        workspacePath: root,
        taskId: "task-symlink",
        checkpointId: "blocked-link",
        seedCommit: "HEAD",
      }),
      /symbolic links or junctions/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(linkTarget, { recursive: true, force: true });
  }
});

test("per-file restore returns one file and leaves the rest of the turn alone", async () => {
  const root = fixtureRepository();
  try {
    fs.writeFileSync(path.join(root, "tracked.txt"), "turn start\n");
    fs.writeFileSync(path.join(root, "turn-start.txt"), "present before turn\n");
    const checkpoint = await createGitCheckpoint({
      workspacePath: root,
      taskId: "task-undo",
      checkpointId: "before-turn",
      seedCommit: "HEAD",
    });

    fs.writeFileSync(path.join(root, "tracked.txt"), "changed by turn\n");
    fs.writeFileSync(path.join(root, "turn-start.txt"), "also changed by turn\n");
    fs.writeFileSync(path.join(root, "turn-only.txt"), "created by turn\n");

    await restoreGitCheckpointPath({
      workspacePath: root,
      checkpointCommit: checkpoint.commitOid,
      relativePath: "tracked.txt",
    });

    assert.equal(fs.readFileSync(path.join(root, "tracked.txt"), "utf8"), "turn start\n");
    // Everything the undo did not name is still exactly as the turn left it.
    assert.equal(fs.readFileSync(path.join(root, "turn-start.txt"), "utf8"), "also changed by turn\n");
    assert.equal(fs.readFileSync(path.join(root, "turn-only.txt"), "utf8"), "created by turn\n");

    // A file the checkpoint never had is undone by going away again.
    await restoreGitCheckpointPath({
      workspacePath: root,
      checkpointCommit: checkpoint.commitOid,
      relativePath: "turn-only.txt",
    });
    assert.equal(fs.existsSync(path.join(root, "turn-only.txt")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("per-file restore refuses paths outside the worktree and blocked paths", async () => {
  const root = fixtureRepository();
  try {
    const checkpoint = await createGitCheckpoint({
      workspacePath: root,
      taskId: "task-undo-guard",
      checkpointId: "guard",
      seedCommit: "HEAD",
    });
    for (const relativePath of ["../escape.txt", ".git/config", ".env"]) {
      await assert.rejects(
        () => restoreGitCheckpointPath({
          workspacePath: root,
          checkpointCommit: checkpoint.commitOid,
          relativePath,
        }),
        /Invalid path to restore|Refusing to restore/,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("restore materialization reproduces the checkpoint exactly and leaves the prior workspace recoverable", async () => {
  const root = fixtureRepository();
  const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-restore-test-"));
  const restoredPath = path.join(managedRoot, "restored");
  try {
    fs.writeFileSync(path.join(root, "tracked.txt"), "checkpoint state\n");
    fs.rmSync(path.join(root, "deleted.txt"));
    fs.writeFileSync(path.join(root, "checkpoint-only.txt"), "preserved\n");
    const requested = await createGitCheckpoint({
      workspacePath: root,
      taskId: "task-restore",
      checkpointId: "requested",
      seedCommit: "HEAD",
    });

    fs.writeFileSync(path.join(root, "tracked.txt"), "pre-restore recovery state\n");
    fs.rmSync(path.join(root, "checkpoint-only.txt"));
    fs.writeFileSync(path.join(root, "recovery-only.txt"), "recoverable\n");
    const recovery = await createGitCheckpoint({
      workspacePath: root,
      taskId: "task-restore",
      checkpointId: "recovery",
      seedCommit: requested.commitOid,
    });

    await materializeCheckpointWorktree({
      repositoryPath: root,
      checkpointCommit: requested.commitOid,
      branch: "umbratic/task-restore-restored",
      targetPath: restoredPath,
      managedRoot,
    });

    assert.equal(fs.readFileSync(path.join(restoredPath, "tracked.txt"), "utf8"), "checkpoint state\n");
    assert.equal(fs.readFileSync(path.join(restoredPath, "checkpoint-only.txt"), "utf8"), "preserved\n");
    assert.equal(fs.existsSync(path.join(restoredPath, "deleted.txt")), false);
    assert.equal(git(restoredPath, ["rev-parse", "HEAD"]), requested.commitOid);
    assert.equal(git(root, ["show", `${recovery.commitOid}:tracked.txt`]), "pre-restore recovery state");
    assert.equal(git(root, ["show", `${recovery.commitOid}:recovery-only.txt`]), "recoverable");
    assert.equal(fs.readFileSync(path.join(root, "tracked.txt"), "utf8"), "pre-restore recovery state\n");
  } finally {
    try { git(root, ["worktree", "remove", "--force", restoredPath]); } catch { /* absent */ }
    fs.rmSync(managedRoot, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
