import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// The main process is split across modules; these ordering invariants are
// about the code, not about which file it happens to live in.
const source = ["main", "mainRuntime", "taskRunner", "taskActions"]
  .map((name) => fs.readFileSync(new URL(`../src/main/${name}.ts`, import.meta.url), "utf8"))
  .join("\n");

function functionSource(name: string, nextName: string): string {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`async function ${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `Could not find ${name}.`);
  return source.slice(start, end);
}

test("steering hands the runner a complete prompt and never aborts the run", () => {
  const steer = functionSource("steerTask", "queueFollowUpTask");

  // The running turn applies the steer itself, so the parts have to be built
  // before the queue call rather than after a dequeue round trip.
  const prepared = steer.indexOf("runnerPromptForTask");
  const pending = steer.indexOf("pendingTaskSteers.set");
  const queue = steer.indexOf("/queue");
  assert.ok(prepared >= 0, "a steer must carry prompt parts");
  assert.ok(pending > prepared && queue > pending);
  assert.match(steer, /action:\s*"steer"/);
  assert.match(steer, /parts/);

  // Aborting is what used to discard the in-flight step and force a resubmit.
  assert.doesNotMatch(steer, /\/abort/);
  assert.doesNotMatch(steer, /submitSteeredRunnerTurn/);
});

test("a queued message registers with the runner and never self-schedules", () => {
  const queued = functionSource("queueFollowUpTask", "dropQueuedTaskPrompt");
  assert.match(queued, /action:\s*"follow_up"/);
  // The runner decides when a queued message runs. Nothing here may start a
  // turn, because the release only happens after a final answer.
  assert.doesNotMatch(queued, /submitSteeredRunnerTurn|startTask/);
  assert.match(queued, /follow_up_capacity_exceeded/);
});

test("cancel posts the runner queue and waits before hard-kill", () => {
  const cancel = functionSource("cancelTask", "steerTask");
  assert.match(cancel, /\/queue/);
  assert.match(cancel, /action:\s*"cancel"/);
  assert.match(cancel, /runnerGracefulCancelDeadlineMs|pendingTaskCancelWaits/);
  assert.match(cancel, /stopRunnerProcess/);
});

test("a released queued message builds its prompt context at launch", () => {
  const start = source.indexOf("const launchQueuedPrompt");
  const end = source.indexOf("const runnerEvents", start);
  assert.ok(start >= 0 && end > start);
  const launch = source.slice(start, end);

  // Workspace preview, capability probe, and attachment staging describe the
  // moment the turn starts, so they cannot be captured when it was queued.
  assert.match(launch, /runnerPromptForTask/);
  assert.ok(launch.indexOf("appendUserMessage") < launch.indexOf("runnerPromptForTask"));
  assert.ok(launch.indexOf("intent = pending.prompt") < launch.indexOf("submitSteeredRunnerTurn"));
});

test("an applied steer is absorbed by the running turn, not relaunched", () => {
  const start = source.indexOf("onQueueUpdated:");
  const end = source.indexOf("});", start);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end);

  const applied = handler.indexOf('"applied"');
  const launch = handler.indexOf("launchQueuedPrompt");
  assert.ok(applied >= 0, "the handler must distinguish an applied steer");
  assert.ok(launch > applied, "an applied steer must return before any launch");
  assert.match(handler, /disposition !== "dequeued"/);
});

test("run.settled always reaches the adapter before queue-driven launch", () => {
  const handleStart = source.indexOf("const handleRunnerEvent");
  const handleEnd = source.indexOf("const stream = beginRunnerEventStream", handleStart);
  assert.ok(handleStart >= 0 && handleEnd > handleStart);
  const handle = source.slice(handleStart, handleEnd);
  assert.match(handle, /runnerEvents\.handle\(event\)/);
  assert.match(source, /onQueueUpdated:/);
});
