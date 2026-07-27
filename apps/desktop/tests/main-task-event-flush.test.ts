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
