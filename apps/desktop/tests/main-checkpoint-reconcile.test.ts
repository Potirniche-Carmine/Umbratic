import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const reconcilePath = new URL("../src/main/checkpoints/reconcile.ts", import.meta.url);

test("startup reconciliation fails interrupted rows and cleans only recorded contained worktrees", async () => {
  const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-reconcile-root-"));
  const contained = path.join(managedRoot, "task-1-preparing");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-reconcile-outside-"));
  fs.mkdirSync(contained);
  const checkpoints = [{
    id: "checkpoint-1", taskId: "task-1", workspaceId: "workspace-1", source: "manual",
    commitOid: "", treeOid: "", createdAt: "2026-01-01T00:00:00.000Z", state: "preparing", pinned: false,
  }];
  const workspaces = [
    { id: "workspace-1", taskId: "task-1", number: 1, branch: "umbratic/task-1", path: outside, createdAt: "2026-01-01T00:00:00.000Z", state: "active" },
    { id: "workspace-2", taskId: "task-1", number: 2, branch: "umbratic/task-1-restore", path: contained, createdAt: "2026-01-01T00:01:00.000Z", state: "preparing" },
  ];
  const removed: string[] = [];
  const deletedRefs: string[] = [];
  const storage = {
    readTasks: () => [{ id: "task-1", originalRepoPath: managedRoot, activeWorkspaceId: "missing-active" }],
    readTaskCheckpoints: () => checkpoints,
    readTaskWorkspaces: () => workspaces,
    writeTaskCheckpoint: (value) => Object.assign(checkpoints[0], value),
    writeTaskWorkspace: (value) => Object.assign(workspaces.find((row) => row.id === value.id), value),
  };
  const reconcile = loadTypeScriptModule(reconcilePath, {
    cache: new Map(),
    mocks: {
      "../storage": storage,
      "./gitAdapter": {
        deleteGitCheckpointRef: async (_repository, ref) => { deletedRefs.push(ref); },
        removeManagedWorktree: async (_repository, target) => { removed.push(target); },
      },
    },
  });

  const report = await reconcile.reconcileCheckpointLifecycle(() => managedRoot);
  assert.deepEqual(JSON.parse(JSON.stringify(report)), {
    inspectedTasks: 1,
    failedCheckpoints: 1,
    failedWorkspaces: 1,
    missingActiveWorkspaces: 1,
  });
  assert.equal(checkpoints[0].state, "failed");
  assert.equal(workspaces[1].state, "failed");
  assert.deepEqual(removed, [contained]);
  assert.deepEqual(deletedRefs, ["refs/umbratic/checkpoints/task-1/checkpoint-1"]);
  assert.equal(fs.existsSync(outside), true);

  fs.rmSync(managedRoot, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});
