import assert from "node:assert/strict";
import test from "node:test";

import type { BackendUiEvent } from "../src/main/types.ts";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const { RunnerEventAdapter } = loadTypeScriptModule(
  new URL("../src/main/runnerEventAdapter.ts", import.meta.url),
);
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

function adapterHarness() {
  const emitted: BackendUiEvent[] = [];
  const invalid: Array<{ message: string; code: string; type?: string }> = [];
  const failures: string[] = [];
  let finished = 0;
  const adapter = new RunnerEventAdapter({
    task: {
      id: "task-1",
      worktreePath: "C:/workspace",
      reasoningMode: "reasoning",
    },
    emit: (event) => emitted.push(event),
    onPermission: async () => "resolved",
    onDelegated: () => undefined,
    onFinish: () => {
      finished += 1;
    },
    onFailure: (message) => failures.push(message),
    onInvalid: (input) => invalid.push(input),
  });
  return { adapter, emitted, invalid, failures, finished: () => finished };
}

test("runner event adapter translates one typed tool lifecycle", () => {
  const harness = adapterHarness();
  harness.adapter.handle({
    type: "assistant.delta",
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
    arguments: { filePath: "src/app.ts" },
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
    type: "session.idle",
    taskId: "task-1",
    at: "2026-01-01T00:00:04.000Z",
  });

  assert.deepEqual(
    plain(harness.emitted.map((event) => event.type)),
    [
      "assistant.reasoning.delta",
      "command.started",
      "command.output",
      "command.finished",
    ],
  );
  assert.equal(harness.finished(), 1);
  assert.deepEqual(plain(harness.failures), []);
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
  assert.deepEqual(plain(harness.failures), ["Veil request failed."]);
});
