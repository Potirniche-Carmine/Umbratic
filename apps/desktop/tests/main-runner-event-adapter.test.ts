import assert from "node:assert/strict";
import test from "node:test";

import type { BackendUiEvent } from "../src/main/types.ts";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const { RunnerEventAdapter } = loadTypeScriptModule(
  new URL("../src/main/runnerEventAdapter.ts", import.meta.url),
);
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

function adapterHarness(reasoningMode: "fast" | "reasoning" = "reasoning") {
  const emitted: BackendUiEvent[] = [];
  const invalid: Array<{ message: string; code: string; type?: string }> = [];
  const failures: string[] = [];
  const settledSteps: unknown[] = [];
  let finished = 0;
  let aborted = 0;
  const adapter = new RunnerEventAdapter({
    task: {
      id: "task-1",
      worktreePath: "C:/workspace",
      reasoningMode,
    },
    emit: (event) => emitted.push(event),
    onPermission: async () => "resolved",
    onDelegated: () => undefined,
    onStepSettled: (conversationState) => {
      settledSteps.push(conversationState);
    },
    onFinish: () => {
      finished += 1;
    },
    onAborted: () => {
      aborted += 1;
    },
    onFailure: (message) => failures.push(message),
    onInvalid: (input) => invalid.push(input),
  });
  return { adapter, emitted, invalid, failures, settledSteps, finished: () => finished, aborted: () => aborted };
}

test("runner event adapter translates one typed tool lifecycle", () => {
  const harness = adapterHarness();
  harness.adapter.handle({
    type: "assistant.progress.delta",
    taskId: "task-1",
    text: "I will inspect the file.",
    at: "2026-01-01T00:00:00.000Z",
  });
  harness.adapter.handle({
    type: "tool.requested",
    taskId: "task-1",
    toolCallId: "tool-1",
    toolKind: "read",
    summary: "read src/app.ts",
    commandClass: "read",
    arguments: { path: "src/app.ts" },
    at: "2026-01-01T00:00:01.000Z",
  });
  harness.adapter.handle({
    type: "tool.output",
    taskId: "task-1",
    toolCallId: "tool-1",
    stream: "stdout",
    text: "1: export const app = true;",
    at: "2026-01-01T00:00:02.000Z",
  });
  harness.adapter.handle({
    type: "tool.finished",
    taskId: "task-1",
    toolCallId: "tool-1",
    exitCode: 0,
    status: "success",
    at: "2026-01-01T00:00:03.000Z",
  });
  harness.adapter.handle({
    type: "run.settled",
    taskId: "task-1",
    sessionId: "session-1",
    runId: "run-1",
    outcome: "completed",
    summary: { outcome: "completed", turns: 1 },
    errorCode: null,
    at: "2026-01-01T00:00:04.000Z",
  });

  assert.deepEqual(
    plain(harness.emitted.map((event) => event.type)),
    [
      "assistant.progress.delta",
      "command.started",
      "command.output",
      "command.finished",
      "turn.outcome",
    ],
  );
  assert.equal(harness.finished(), 1);
  assert.deepEqual(plain(harness.failures), []);
});

test("runner event adapter rejects the removed raw reasoning event", () => {
  const harness = adapterHarness();
  harness.adapter.handle({
    type: "assistant.reasoning.delta",
    taskId: "task-1",
    text: "private chain of thought",
  });
  assert.equal(harness.invalid.length, 1);
  assert.equal(harness.invalid[0].code, "unknown_type");
  assert.deepEqual(plain(harness.emitted), []);
});

test("runner event adapter shows safe public progress in fast mode", () => {
  const harness = adapterHarness("fast");
  harness.adapter.handle({
    type: "assistant.progress.delta",
    taskId: "task-1",
    text: "I am checking the request path.",
  });

  assert.deepEqual(plain(harness.emitted), [{
    type: "assistant.progress.delta",
    taskId: "task-1",
    text: "I am checking the request path.",
  }]);
});

test("runner event adapter keeps run_program distinct and treats it as an executable action", () => {
  const harness = adapterHarness();
  harness.adapter.handle({
    type: "tool.requested",
    taskId: "task-1",
    toolCallId: "program-1",
    toolKind: "run_program",
    summary: "uv run python bubble_sort.py",
    commandClass: "python-runtime",
    arguments: { programId: "uv", args: ["run", "python", "bubble_sort.py"] },
  });
  const started = harness.emitted.find((event) => event.type === "command.started");
  assert.ok(started && started.type === "command.started");
  assert.equal(started.kind, "bash");
  assert.equal(started.toolKind, "run_program");
  assert.equal(started.command, "uv run python bubble_sort.py");
});

test("assistant text reaches the renderer as it streams instead of at the turn boundary", () => {
  const harness = adapterHarness();
  harness.adapter.handle({
    type: "assistant.delta",
    taskId: "task-1",
    text: "Umbratic is ",
    at: "2026-01-01T00:00:00.000Z",
  });

  assert.deepEqual(plain(harness.emitted), [{
    type: "assistant.delta",
    taskId: "task-1",
    text: "Umbratic is ",
    at: "2026-01-01T00:00:00.000Z",
  }]);

  harness.adapter.handle({
    type: "assistant.delta",
    taskId: "task-1",
    text: "a layered product.",
    at: "2026-01-01T00:00:01.000Z",
  });
  harness.adapter.handle({
    type: "run.settled",
    taskId: "task-1",
    sessionId: "session-1",
    runId: "run-1",
    outcome: "completed",
    summary: { outcome: "completed" },
    errorCode: null,
    at: "2026-01-01T00:00:02.000Z",
  });

  assert.deepEqual(
    plain(harness.emitted.map((event) => event.type)),
    ["assistant.delta", "assistant.delta", "turn.outcome"],
  );
  assert.equal(harness.finished(), 1);
});

test("streamed text before a tool call is forwarded once and is not replayed as progress", () => {
  const harness = adapterHarness();
  harness.adapter.handle({
    type: "assistant.delta",
    taskId: "task-1",
    text: "I'll read the runner first.",
    at: "2026-01-01T00:00:00.000Z",
  });
  harness.adapter.handle({
    type: "tool.requested",
    taskId: "task-1",
    toolCallId: "tool-1",
    toolKind: "read",
    summary: "read src/app.ts",
    commandClass: "read",
    at: "2026-01-01T00:00:01.000Z",
  });

  assert.deepEqual(
    plain(harness.emitted.map((event) => event.type)),
    ["assistant.delta", "command.started"],
  );
  const deltas = harness.emitted.filter((event) => event.type === "assistant.delta");
  assert.equal(deltas.length, 1);
});

test("recovering compacted context never becomes a visible workspace action", () => {
  const harness = adapterHarness();
  harness.adapter.handle({
    type: "tool.requested",
    taskId: "task-1",
    toolCallId: "internal-1",
    toolKind: "retrieve_context",
    summary: "retrieve_context 90dd8e8bc426f10604232f55",
    commandClass: "read",
    arguments: { hash: "90dd8e8bc426f10604232f55" },
    at: "2026-01-01T00:00:00.000Z",
  });
  harness.adapter.handle({
    type: "tool.output",
    taskId: "task-1",
    toolCallId: "internal-1",
    stream: "stdout",
    text: "258: **Stated risk.** ...",
    at: "2026-01-01T00:00:01.000Z",
  });
  harness.adapter.handle({
    type: "context.retrieved",
    taskId: "task-1",
    toolCallId: "internal-1",
    hash: "90dd8e8bc426f10604232f55",
    offset: 0,
    bytesShown: 24,
    totalBytes: 4096,
    at: "2026-01-01T00:00:01.000Z",
  });
  harness.adapter.handle({
    type: "tool.finished",
    taskId: "task-1",
    toolCallId: "internal-1",
    exitCode: 0,
    status: "success",
    at: "2026-01-01T00:00:02.000Z",
  });
  harness.adapter.handle({
    type: "run.settled",
    taskId: "task-1",
    sessionId: "session-1",
    runId: "run-1",
    outcome: "completed",
    summary: { outcome: "completed" },
    errorCode: null,
    at: "2026-01-01T00:00:03.000Z",
  });

  // The retrieval stays observable for telemetry, but the user sees no command
  // row, no hash, and none of the recovered bytes.
  assert.deepEqual(plain(harness.emitted.map((event) => event.type)), ["context.retrieved", "turn.outcome"]);
  assert.deepEqual(plain(harness.failures), []);
  assert.equal(harness.invalid.length, 0);
});

test("a failing internal tool still produces no timeline row", () => {
  const harness = adapterHarness();
  harness.adapter.handle({
    type: "tool.requested",
    taskId: "task-1",
    toolCallId: "internal-2",
    toolKind: "retrieve_context",
    summary: "retrieve_context deadbeef",
    commandClass: "read",
  });
  harness.adapter.handle({
    type: "tool.finished",
    taskId: "task-1",
    toolCallId: "internal-2",
    exitCode: 1,
    status: "invalid_request",
    errorCode: "validation_failed",
    errorMessage: "No stored context found for hash deadbeef.",
  });

  assert.deepEqual(plain(harness.emitted), []);
});

test("runner event adapter quarantines malformed and foreign events", () => {
  const harness = adapterHarness();
  harness.adapter.handle({
    type: "tool.output",
    taskId: "task-1",
    toolCallId: "tool-1",
    stream: "other",
    text: "bad",
  });
  harness.adapter.handle({
    type: "assistant.delta",
    taskId: "other-task",
    text: "foreign",
  });
  assert.equal(harness.invalid.length, 1);
  assert.equal(harness.invalid[0].code, "invalid_payload");
  assert.deepEqual(plain(harness.emitted), []);
});

test("runner event adapter keeps runner failures typed and bounded", () => {
  const harness = adapterHarness();
  harness.adapter.handle({
    type: "runner.error",
    taskId: "task-1",
    category: "provider",
    code: "veil_failed",
    message: "Veil request failed.",
    detail: "private detail",
    at: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(plain(harness.failures), []);
  harness.adapter.handle({
    type: "run.settled",
    taskId: "task-1",
    sessionId: "session-1",
    runId: "run-1",
    outcome: "failed",
    summary: null,
    errorCode: "veil_failed",
    at: "2026-01-01T00:00:01.000Z",
  });
  assert.deepEqual(plain(harness.failures), ["Veil request failed."]);
  assert.equal(harness.finished(), 0);
});

test("a run the user stopped settles quietly through onAborted, never as a failure", () => {
  const harness = adapterHarness();
  harness.adapter.handle({
    type: "runner.error",
    taskId: "task-1",
    message: "Run aborted.",
    category: "abort",
    code: "run_aborted",
    at: "2026-01-01T00:00:00.000Z",
  });
  harness.adapter.handle({
    type: "run.settled",
    taskId: "task-1",
    sessionId: "session-1",
    runId: "run-1",
    outcome: "aborted",
    summary: { outcome: "aborted", turns: 1 },
    errorCode: null,
    at: "2026-01-01T00:00:01.000Z",
  });
  assert.equal(harness.aborted(), 1);
  assert.deepEqual(plain(harness.failures), []);
  assert.equal(harness.finished(), 0);
  assert.ok(!harness.emitted.some((event) => event.type === "task.error" || event.type === "turn.outcome"));
});

test("runner event adapter forwards run.queue.updated to the queue callback", () => {
  const queueEvents: Array<Record<string, unknown>> = [];
  const adapter = new RunnerEventAdapter({
    task: {
      id: "task-1",
      worktreePath: "C:/workspace",
      reasoningMode: "reasoning",
    },
    emit: () => undefined,
    onPermission: async () => "resolved",
    onDelegated: () => undefined,
    onStepSettled: () => undefined,
    onFinish: () => undefined,
    onAborted: () => undefined,
    onFailure: () => undefined,
    onInvalid: () => undefined,
    onQueueUpdated: (event) => {
      queueEvents.push(event as unknown as Record<string, unknown>);
    },
  });
  adapter.handle({
    type: "run.queue.updated",
    taskId: "task-1",
    sessionId: "session-1",
    runId: "run-1",
    actionId: "steer-1",
    action: "steer",
    disposition: "dequeued",
    pendingSteer: false,
    followUpCount: 0,
    followUpCapacity: 8,
    reasonCode: null,
    at: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(queueEvents.length, 1);
  assert.equal(queueEvents[0]?.disposition, "dequeued");
  assert.equal(queueEvents[0]?.actionId, "steer-1");
});
