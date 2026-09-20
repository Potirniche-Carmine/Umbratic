import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

test("remote review never reads a coincident local path, including whole-workspace refresh", async () => {
  const forbidden = () => { throw new Error("remote paths must not reach local filesystem or Git"); };
  const task = {
    id: "remote", remote: { connectionId: "host", directory: "/same/path" },
    worktreePath: "/same/path", originalRepoPath: "/local/scratch", workspaceKind: "folder",
    reviewFiles: [{ path: "local-secret.txt" }], changedFiles: ["local-secret.txt"], reviewPatchHash: "stale",
  };
  let saved = 0;
  const review = loadTypeScriptModule(new URL("../src/main/reviewFiles.ts", import.meta.url), {
    mocks: {
      "node:fs": { existsSync: forbidden, statSync: forbidden },
      "./worktreeOps": { taskUsesIsolatedWorktree: forbidden },
      "./mainRuntime": { getTask: () => task, saveTask: () => saved++, publicTask: (value) => value },
      "./taskPromptContext": {},
      "./workspaceSnapshot": { snapshotFolder: forbidden, snapshotFileValue: forbidden, readTextFileIfSafe: forbidden },
      "./policy": {},
      "./processCommands": { gitResult: forbidden, gitOutput: forbidden },
    },
  });
  assert.equal((await review.refreshReview(task)).length, 0);
  assert.equal(task.reviewFiles.length, 0);
  assert.equal(task.changedFiles.length, 0);
  assert.equal(task.reviewPatchHash, undefined);
  const refreshed = await review.refreshTaskReview({ taskId: "remote", scope: "worktree", repositoryPath: "/same/path" });
  assert.equal(refreshed.id, "remote");
  assert.equal(saved, 1);
  assert.equal(refreshed.reviewFiles.length, 0);
});
