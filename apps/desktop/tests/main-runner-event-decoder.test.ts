import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const decoder = loadTypeScriptModule(
  new URL("../src/main/runnerEventDecoder.ts", import.meta.url),
);

test("runner event decoder accepts handled events and marks internal events as ignored", () => {
  const assistant = decoder.decodeRunnerEvent({
    type: "assistant.delta",
    taskId: "task-1",
    text: "hello",
  });
  assert.equal(assistant.ok, true);
  assert.equal(assistant.ignored, false);
  assert.equal(assistant.event.text, "hello");

  const legacyFinished = decoder.decodeRunnerEvent({
    type: "tool.finished",
    taskId: "task-1",
    toolCallId: "tool-1",
    exitCode: 0,
    status: "success",
    errorCode: null,
    errorMessage: null,
    response: null,
  });
  assert.equal(legacyFinished.ok, true);
  assert.equal(legacyFinished.ignored, false);

  assert.deepEqual(
    JSON.parse(JSON.stringify(decoder.decodeRunnerEvent({
      type: "tool.policy.stage",
      taskId: "task-1",
    }))),
    { ok: true, ignored: true },
  );
});

test("runner event decoder rejects malformed native events before translation", () => {
  for (const event of [
    null,
    { type: "assistant.delta", taskId: "task-1", text: 42 },
    { type: "tool.output", taskId: "task-1", toolCallId: "tool-1", stream: "other", text: "x" },
    { type: "context.usage", taskId: "task-1", contextLength: 0, contentTokens: 1, reserveTokens: 1 },
    { type: "permission.requested", taskId: "task-1", permissionId: 3, permissionKind: "edit", summary: "write" },
    { type: "session.idle" },
    { type: "future.event", taskId: "task-1" },
  ]) {
    assert.equal(decoder.decodeRunnerEvent(event).ok, false, JSON.stringify(event));
  }
});
