import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const bufferPath = new URL("../src/main/backendEventBuffer.ts", import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));

test("backend stream buffering coalesces compatible deltas and preserves boundaries", () => {
  const { appendBufferedBackendEvent, shouldBufferBackendEvent } = loadTypeScriptModule(bufferPath);
  const events = [];
  appendBufferedBackendEvent(events, {
    type: "assistant.delta",
    taskId: "task-1",
    text: "hello ",
    at: "2026-01-01T00:00:00.000Z",
  });
  appendBufferedBackendEvent(events, {
    type: "assistant.delta",
    taskId: "task-1",
    text: "world",
    at: "2026-01-01T00:00:00.020Z",
  });
  appendBufferedBackendEvent(events, {
    type: "assistant.progress.delta",
    taskId: "task-1",
    text: "checking",
  });

  assert.deepEqual(plain(events), [
    {
      type: "assistant.delta",
      taskId: "task-1",
      text: "hello world",
      at: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:00.020Z",
    },
    { type: "assistant.progress.delta", taskId: "task-1", text: "checking" },
  ]);
  assert.equal(shouldBufferBackendEvent(events[0]), true);
  assert.equal(shouldBufferBackendEvent({ type: "assistant.done", taskId: "task-1" }), false);
});

test("command output only coalesces within the same command and stream", () => {
  const { appendBufferedBackendEvent } = loadTypeScriptModule(bufferPath);
  const events = [];
  appendBufferedBackendEvent(events, { type: "command.output", taskId: "task-1", id: "one", stream: "stdout", text: "a" });
  appendBufferedBackendEvent(events, { type: "command.output", taskId: "task-1", id: "one", stream: "stderr", text: "b" });
  appendBufferedBackendEvent(events, { type: "command.output", taskId: "task-1", id: "one", stream: "stderr", text: "c" });
  appendBufferedBackendEvent(events, { type: "command.output", taskId: "task-1", id: "two", stream: "stderr", text: "d" });

  assert.deepEqual(plain(events.map((event) => [event.id, event.stream, event.text])), [
    ["one", "stdout", "a"],
    ["one", "stderr", "bc"],
    ["two", "stderr", "d"],
  ]);
});

test("stream buffers retain only the visible tail of large internal output", () => {
  const { appendBufferedBackendEvent } = loadTypeScriptModule(bufferPath);
  const events = [];
  appendBufferedBackendEvent(events, { type: "command.output", taskId: "task-1", id: "one", stream: "stdout", text: `start-${"x".repeat(20_000)}` });
  appendBufferedBackendEvent(events, { type: "command.output", taskId: "task-1", id: "one", stream: "stdout", text: "-end" });
  appendBufferedBackendEvent(events, { type: "assistant.progress.delta", taskId: "task-1", text: "y".repeat(30_000) });

  assert.equal(events[0].text.length, 16_384);
  assert.equal(events[0].text.endsWith("-end"), true);
  assert.equal(events[1].text.length, 24_000);
});
