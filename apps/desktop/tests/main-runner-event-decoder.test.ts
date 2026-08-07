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

  // `kind` no longer routes a delta anywhere, so a leftover tag from an older
  // runner is accepted rather than rejected: failing the payload would drop the
  // run's opening sentence outright. The adapter is what stops forwarding it.
  for (const kind of ["status", "banner"]) {
    const tagged = decoder.decodeRunnerEvent({
      type: "assistant.delta",
      kind,
      taskId: "task-1",
      text: "I will map this folder.",
    });
    assert.equal(tagged.ok, true, kind);
    assert.equal(tagged.event.text, "I will map this folder.", kind);
  }

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

  const compressedWithoutHash = decoder.decodeRunnerEvent({
    type: "context.compressed",
    taskId: "task-1",
    toolCallId: "tool-1",
    toolKind: "read",
    kind: "file",
    strategy: "text_head_tail",
    hash: null,
    originalBytes: 2048,
    outputBytes: 1024,
  });
  assert.equal(compressedWithoutHash.ok, true);
  assert.equal(compressedWithoutHash.ignored, false);

  assert.deepEqual(
    JSON.parse(JSON.stringify(decoder.decodeRunnerEvent({
      type: "tool.policy.stage",
      taskId: "task-1",
      toolCallId: "tool-1",
      stage: "coerce_arguments",
      outcome: "changed",
      reason: "numeric string converted to integer",
    }))),
    {
      ok: true,
      ignored: false,
      event: {
        type: "tool.policy.stage",
        taskId: "task-1",
        toolCallId: "tool-1",
        stage: "coerce_arguments",
        outcome: "changed",
        reason: "numeric string converted to integer",
      },
    },
  );

  const queueUpdated = decoder.decodeRunnerEvent({
    type: "run.queue.updated",
    taskId: "task-1",
    sessionId: "session-1",
    runId: null,
    actionId: "steer-1",
    action: "steer",
    disposition: "accepted",
    pendingSteer: true,
    followUpCount: 0,
    followUpCapacity: 8,
    reasonCode: null,
    at: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(queueUpdated.ok, true);
  assert.equal(queueUpdated.ignored, false);
  assert.equal(queueUpdated.event.type, "run.queue.updated");
  assert.equal(queueUpdated.event.pendingSteer, true);
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

test("runner context usage decodes the anchor, the breakdown, and the protected prefix", () => {
  const decoded = decoder.decodeRunnerEvent({
    type: "context.usage",
    taskId: "task-1",
    contextLength: 64000,
    contentTokens: 12000,
    promptTokens: 12000,
    completionTokens: 256,
    reserveTokens: 4096,
    protectedTokens: 3187,
    estimatedTokens: 16096,
    anchored: true,
    compactionBlocked: false,
    breakdown: {
      systemPromptTokens: 3187, systemPromptExact: true, toolDefinitionTokens: 2100,
      skillTokens: 320, conversationTokens: 4200, toolResultTokens: 1900, imageTokens: 1600,
    },
  });
  assert.equal(decoded.ok, true);
  assert.equal(decoded.event.anchored, true);
  assert.equal(decoded.event.protectedTokens, 3187);
  assert.equal(decoded.event.breakdown.systemPromptExact, true);
  assert.equal(decoded.event.breakdown.imageTokens, 1600);

  // A usage event that carries none of it is still a usage event.
  assert.equal(
    decoder.decodeRunnerEvent({ type: "context.usage", taskId: "task-1", contextLength: 64000, contentTokens: 1, reserveTokens: 1 }).ok,
    true,
  );

  for (const invalid of [
    { anchored: "yes" },
    { breakdown: { systemPromptTokens: 1, systemPromptExact: true, toolDefinitionTokens: 1, skillTokens: 1, conversationTokens: 1, toolResultTokens: 1 } },
    { breakdown: { systemPromptTokens: 1, systemPromptExact: "true", toolDefinitionTokens: 1, skillTokens: 1, conversationTokens: 1, toolResultTokens: 1, imageTokens: 1 } },
    { protectedTokens: -4 },
  ]) {
    assert.equal(
      decoder.decodeRunnerEvent({ type: "context.usage", taskId: "task-1", contextLength: 64000, contentTokens: 1, reserveTokens: 1, ...invalid }).ok,
      false,
      JSON.stringify(invalid),
    );
  }
});
