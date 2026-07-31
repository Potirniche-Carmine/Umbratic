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

test("steering aborts the active turn before replacement prompt preparation", () => {
  const steer = functionSource("steerTask", "setResponseFeedback");
  const pending = steer.indexOf("pendingTaskSteers.set");
  const abort = steer.indexOf("/abort");

  assert.ok(pending >= 0 && abort > pending);
  assert.doesNotMatch(steer, /runnerPromptForTask/);
});

test("the replacement prompt is prepared only after the old turn is terminal", () => {
  const start = source.indexOf("const launchPendingSteer");
  const end = source.indexOf("const handleRunnerEvent", start);
  assert.ok(start >= 0 && end > start);
  const launch = source.slice(start, end);

  assert.match(launch, /runnerPromptForTask/);
  assert.ok(launch.indexOf("appendUserMessage") < launch.indexOf("runnerPromptForTask"));
  assert.ok(launch.indexOf("intent = pending.prompt") < launch.indexOf("submitSteeredRunnerTurn"));
});
