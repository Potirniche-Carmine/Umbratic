import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const { PermissionBroker } = loadTypeScriptModule(new URL("../src/permission.ts", import.meta.url).pathname);

test("PermissionBroker auto-allows bypassed requests and emits both lifecycle events", async () => {
  const events = [];
  const broker = new PermissionBroker((event) => events.push(event));

  const decision = await broker.request({
    taskId: "task-1",
    permissionKind: "bash",
    summary: "npm run test",
    autoAllow: true,
  });

  assert.equal(decision, "allow");
  assert.deepEqual(events.map((event) => event.type), ["permission.requested", "permission.resolved"]);
  assert.equal(events[0].summary, "npm run test");
  assert.equal(events[1].decision, "allow");
});

test("PermissionBroker resolves manual replies and ignores unknown permission ids", async () => {
  const events = [];
  const broker = new PermissionBroker((event) => events.push(event));
  const pending = broker.request({
    taskId: "task-2",
    permissionKind: "edit",
    summary: "edit src/index.ts",
    autoAllow: false,
  });
  const permissionId = events[0].permissionId;

  assert.equal(broker.reply("missing", "allow"), false);
  assert.equal(broker.reply(permissionId, "deny"), true);
  assert.equal(await pending, "deny");
  assert.equal(events.at(-1).decision, "deny");
});

test("PermissionBroker denyAll only resolves requests for the selected task", async () => {
  const events = [];
  const broker = new PermissionBroker((event) => events.push(event));
  const taskA = broker.request({ taskId: "task-a", permissionKind: "edit", summary: "a", autoAllow: false });
  const taskB = broker.request({ taskId: "task-b", permissionKind: "edit", summary: "b", autoAllow: false });

  broker.denyAll("task-a");

  assert.equal(await taskA, "deny");
  const taskBPermission = events.find((event) => event.type === "permission.requested" && event.taskId === "task-b").permissionId;
  broker.reply(taskBPermission, "allow");
  assert.equal(await taskB, "allow");
});

