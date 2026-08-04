import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/main/main.ts", import.meta.url), "utf8");

function functionSource(name: string, nextName: string): string {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`async function ${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `Could not find ${name}.`);
  return source.slice(start, end);
}

test("steering posts the runner queue before replacement prompt preparation", () => {
  const steer = functionSource("steerTask", "setResponseFeedback");
  const pending = steer.indexOf("pendingTaskSteers.set");
  const queue = steer.indexOf("/queue");

  assert.ok(pending >= 0 && queue > pending);
  assert.match(steer, /action:\s*"steer"/);
  assert.doesNotMatch(steer, /\/abort/);
  assert.doesNotMatch(steer, /runnerPromptForTask/);
});

test("cancel posts the runner queue and waits before hard-kill", () => {
  const cancel = functionSource("cancelTask", "steerTask");
  assert.match(cancel, /\/queue/);
  assert.match(cancel, /action:\s*"cancel"/);
  assert.match(cancel, /runnerGracefulCancelDeadlineMs|pendingTaskCancelWaits/);
  assert.match(cancel, /stopRunnerProcess/);
});

test("the replacement prompt is prepared only after queue dequeue", () => {
  const start = source.indexOf("const launchPendingSteer");
  const end = source.indexOf("const runnerEvents", start);
  assert.ok(start >= 0 && end > start);
  const launch = source.slice(start, end);

  assert.match(launch, /runnerPromptForTask/);
  assert.ok(launch.indexOf("appendUserMessage") < launch.indexOf("runnerPromptForTask"));
  assert.ok(launch.indexOf("intent = pending.prompt") < launch.indexOf("submitSteeredRunnerTurn"));
});

test("run.settled always reaches the adapter before queue-driven steer launch", () => {
  const handleStart = source.indexOf("const handleRunnerEvent");
  const handleEnd = source.indexOf("const stream = beginRunnerEventStream", handleStart);
  assert.ok(handleStart >= 0 && handleEnd > handleStart);
  const handle = source.slice(handleStart, handleEnd);
  assert.match(handle, /runnerEvents\.handle\(event\)/);
  assert.doesNotMatch(handle, /launchPendingSteer\(pending\);\s*return;/);
  assert.match(source, /onQueueUpdated:/);
});
