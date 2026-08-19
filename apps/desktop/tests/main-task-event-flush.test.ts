import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const sharedTaskEventsPath = new URL("../src/shared/taskEvents.ts", import.meta.url);

test("appendTaskEvent coalesces adjacent streaming deltas in memory", async () => {
  const shared = await loadTypeScriptModule(sharedTaskEventsPath, { cache: new Map() });
  const first = shared.appendTaskEvent([], {
    type: "assistant.delta",
    taskId: "task-1",
    text: "Hello ",
    at: "2026-01-01T00:00:00.000Z",
  }, 500);
  const second = shared.appendTaskEvent(first, {
    type: "assistant.delta",
    taskId: "task-1",
    text: "world",
    at: "2026-01-01T00:00:01.000Z",
  }, 500);
  assert.equal(second.length, 1);
  assert.equal(second[0].text, "Hello world");
});

test("appendTaskEvent does not coalesce thinking into orientation", async () => {
  const shared = await loadTypeScriptModule(sharedTaskEventsPath, { cache: new Map() });
  const progress = shared.appendTaskEvent([], {
    type: "assistant.progress.delta",
    taskId: "task-1",
    text: "checking",
  }, 500);
  const next = shared.appendTaskEvent(progress, {
    type: "assistant.progress.delta",
    kind: "thinking",
    taskId: "task-1",
    text: "private thought",
  }, 500);
  assert.equal(next.length, 2);
  assert.equal(next[0].kind, undefined);
  assert.equal(next[0].text, "checking");
  assert.equal(next[1].kind, "thinking");
  assert.equal(next[1].text, "private thought");
});

test("response feedback can be toggled off without removing other ratings", async () => {
  const shared = await loadTypeScriptModule(sharedTaskEventsPath, { cache: new Map() });
  const events = [
    { type: "response.feedback", taskId: "task-1", messageId: "assistant-1", rating: "good" },
    { type: "response.feedback", taskId: "task-1", messageId: "assistant-2", rating: "bad" },
  ];

  assert.equal(shared.toggleResponseRating("good", "good"), null);
  assert.equal(shared.toggleResponseRating("good", "bad"), "bad");
  assert.equal(shared.toggleResponseRating(undefined, "good"), "good");
  assert.deepEqual(
    shared.removeResponseFeedback(events, "task-1", "assistant-1"),
    [events[1]],
  );
});

test("a batch folds in one pass and matches folding the events one at a time", async () => {
  const shared = await loadTypeScriptModule(sharedTaskEventsPath, { cache: new Map() });
  const at = (index) => new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  const batch = [];
  for (let index = 0; index < 400; index += 1) {
    batch.push({ type: "assistant.delta", taskId: "task-1", text: `t${index} `, at: at(index) });
    if (index % 40 === 0) {
      batch.push({ type: "command.started", taskId: "task-1", id: `c${index}`, command: "ls", cwd: ".", at: at(index) });
      batch.push({ type: "command.output", taskId: "task-1", id: `c${index}`, stream: "stdout", text: "out", at: at(index) });
      batch.push({ type: "command.finished", taskId: "task-1", id: `c${index}`, exitCode: 0, at: at(index) });
    }
  }
  const oneAtATime = batch.reduce((events, event) => shared.appendTaskEvent(events, event, 500), []);
  const inOnePass = shared.appendTaskEvents([], batch, 500);
  assert.deepEqual(inOnePass, oneAtATime);

  // A batch that changes nothing hands back the caller's own array, so React
  // can skip the render rather than diffing an identical transcript.
  const userMessage = { type: "user.message", taskId: "task-1", text: "hi", at: at(0) };
  const withMessage = shared.appendTaskEvents([], [userMessage], 500);
  assert.equal(shared.appendTaskEvents(withMessage, [userMessage], 500), withMessage);
  assert.equal(shared.appendTaskEvents(withMessage, [], 500), withMessage);
});
