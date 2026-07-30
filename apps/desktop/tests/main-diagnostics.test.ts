import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const appended = [];
const diagnostics = loadTypeScriptModule(new URL("../src/main/diagnostics.ts", import.meta.url), {
  cache: new Map(),
  mocks: {
    "./policy": {
      redactText: (value) => value,
      shortHashValue: () => "path-hash",
    },
    "./storage": {
      appendLocalDiagnostic: (input) => appended.push(input),
    },
  },
});

const plain = (value) => JSON.parse(JSON.stringify(value));

test("backend diagnostics ignore informational activity but retain warnings and errors", () => {
  assert.equal(diagnostics.localDiagnosticForBackendEvent({
    type: "permission.requested",
    taskId: "task-1",
    request: { id: "permission-1", kind: "bash", summary: "Run tests", command: "npm test", cwd: "/repo" },
  }), null);
  assert.equal(diagnostics.localDiagnosticForBackendEvent({
    type: "command.finished",
    taskId: "task-1",
    id: "command-1",
    exitCode: 0,
    status: "success",
  }), null);

  const warning = diagnostics.localDiagnosticForBackendEvent({
    type: "permission.resolved",
    taskId: "task-1",
    id: "permission-1",
    decision: "deny",
  });
  assert.equal(warning.level, "warn");
  assert.equal(warning.event, "permission.resolved");

  const error = diagnostics.localDiagnosticForBackendEvent({
    type: "task.error",
    taskId: "task-1",
    message: "Runner failed.",
    category: "provider",
    code: "model_request_failed",
    detail: "Model service timed out.",
  });
  assert.deepEqual(plain(error), {
    level: "error",
    source: "desktop",
    event: "task.error",
    taskId: "task-1",
    message: "Runner failed.",
    data: {
      message: "Runner failed.",
      category: "provider",
      code: "model_request_failed",
      detail: "Model service timed out.",
    },
  });
});

test("recording backend diagnostics does not append permission requests", () => {
  appended.length = 0;
  diagnostics.recordBackendEventDiagnostic({
    type: "permission.requested",
    taskId: "task-1",
    request: { id: "permission-1", kind: "bash", summary: "Run tests", command: "npm test", cwd: "/repo" },
  });
  diagnostics.recordBackendEventDiagnostic({
    type: "task.error",
    taskId: "task-1",
    message: "Runner failed.",
  });

  assert.deepEqual(plain(appended).map((entry) => entry.level), ["error"]);
});

test("diagnostics preserve numeric token counts without exposing authentication tokens", () => {
  assert.deepEqual(plain(diagnostics.sanitizeDiagnosticValue({
    authToken: "secret-value",
    apiToken: "another-secret",
    enrollmentCode: "umbe-secret",
    privateKeyPkcs8: "private-key",
    session: "umbs-secret",
    contextTokens: 8659,
    maxOutputTokens: 1024,
    promptTokens: "untrusted-string",
  })), {
    authToken: "[redacted]",
    apiToken: "[redacted]",
    enrollmentCode: "[redacted]",
    privateKeyPkcs8: "[redacted]",
    session: "[redacted]",
    contextTokens: 8659,
    maxOutputTokens: 1024,
    promptTokens: "[redacted]",
  });
});
