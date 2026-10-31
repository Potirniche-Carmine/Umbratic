import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

test("workspace leases exclude overlapping chats, including startup, shutdown and symlink aliases", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-activity-"));
  const tasks = [];
  const activity = loadTypeScriptModule(new URL("../src/main/workspaceActivity.ts", import.meta.url), {
    mocks: { "./storage": { readTasks: () => tasks } },
  });
  try {
    fs.mkdirSync(path.join(root, "one"));
    fs.mkdirSync(path.join(root, "two"));
    fs.symlinkSync(path.join(root, "one"), path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    const task = { id: "a", worktreePath: path.join(root, "one"), state: "running" };
    tasks.push(task);
    const release = activity.reserveTaskWorkspace(task, true);
    // Cancel can set completed before the child has actually exited.
    task.state = "completed";
    for (const directory of ["one", "alias", "one/nested"]) {
      assert.throws(() => activity.reserveTaskWorkspace({ id: "b", worktreePath: path.join(root, directory) }), /operation in progress/);
    }
    const releaseOther = activity.reserveTaskWorkspace({ id: "c", worktreePath: path.join(root, "two") });
    releaseOther();
    release();
    await assert.rejects(activity.withIdleTaskWorkspace(task, async () => { throw new Error("failed mutation"); }), /failed mutation/);
    const releaseAgain = activity.reserveTaskWorkspace(task);
    releaseAgain();
    task.state = "running";
    assert.throws(() => activity.reserveTaskWorkspace({ id: "d", worktreePath: path.join(root, "one") }), /chat is using/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
