import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const contract = loadTypeScriptModule(new URL("../src/shared/backendEvents.ts", import.meta.url));

const fixtures = [
  ["user.message", { text: "hello" }], ["assistant.delta", { text: "hi" }],
  ["assistant.progress.delta", { text: "planning" }], ["assistant.done", {}],
  ["worktree.requested", { branch: "b", path: "p", baseCommit: "c" }], ["worktree.created", { branch: "b", path: "p" }],
  ["command.started", { id: "1", command: "npm test", cwd: "." }], ["command.output", { id: "1", stream: "stdout", text: "ok" }],
  ["command.finished", { id: "1", exitCode: 0 }],
  ["context.usage", { contextLength: 64000, contentTokens: 12000, promptTokens: 12000, completionTokens: 256, reserveTokens: 4096, protectedTokens: 3187, estimatedTokens: 16096, phase: "observed", source: "provider", confidence: "high", anchored: true, compactionBlocked: false, breakdown: { systemPromptTokens: 3187, systemPromptExact: true, toolDefinitionTokens: 2100, skillTokens: 320, conversationTokens: 4200, toolResultTokens: 1900, imageTokens: 0 } }],
  ["context.threshold", { threshold: 75, contextLength: 64000, estimatedTokens: 48000 }],
  ["context.compressed", { toolCallId: "1", toolKind: "read", kind: "file", strategy: "text_head_tail", originalBytes: 2, outputBytes: 1 }],
  ["context.retrieved", { toolCallId: "1", hash: "abc", offset: 0, bytesShown: 1, totalBytes: 1 }],
  ["permission.requested", { request: { id: "p", kind: "edit", summary: "write", command: "write", cwd: "." } }],
  ["permission.resolved", { id: "p", decision: "allow" }], ["review.ready", { changedFiles: [], reviewFiles: [] }],
  ["review.changed_since_ready", { previousPatchHash: "a", currentPatchHash: "b", changedFileCount: 1 }],
  ["approval.check", { name: "tests", status: "passed" }], ["merge.approval", { decision: "approved" }],
  ["approval.completed", { target: "main", patchHash: "a" }], ["merge.completed", { targetBranch: "main", commit: "c", patchHash: "a" }],
  ["ide.opened", { ideId: "code", target: "workspace", result: "success" }], ["response.feedback", { messageId: "m", rating: "good", reason: "Solved my issue", comment: "Useful." }],
  ["tool.failed", { id: "tool-1", toolKind: "edit", input: { path: "a.ts" }, response: { stdout: "", stderr: "not found", exitCode: 1 } }],
  ["skill.requested", { sessionId: "s", runId: "r", requestId: "req", skillId: "s", source: "system", origin: "harness" }],
  ["skill.loaded", { sessionId: "s", runId: "r", requestId: "req", skillId: "s", source: "system", origin: "harness", contentHash: "abc", bytes: 12 }],
  ["skill.failed", { sessionId: "s", runId: "r", requestId: "req", skillId: "s", source: "system", origin: "harness", code: "skill_not_enabled", message: "missing" }],
  ["required_tool.failed", { requirement: "file_change", reason: "missing_tool_call", requiredTools: ["edit"] }],
  ["task.error", { message: "failed", category: "provider", code: "model_request_failed", detail: "safe detail" }],
];

test("every backend event variant parses to its exact unversioned shape", () => {
  for (const [type, payload] of fixtures) {
    const input = { type, taskId: "task-1", ...payload };
    const result = contract.parseBackendUiEvent(input);
    assert.equal(result.ok, true, `${type}: ${result.message ?? "invalid"}`);
    assert.deepEqual(result.event, input);
  }
});

test("malformed, unknown, and future backend events are quarantined", () => {
  assert.equal(contract.parseBackendUiEvent(null).code, "not_an_object");
  assert.equal(contract.parseBackendUiEvent({ ["ver" + "sion"]: 1, type: "assistant.done", taskId: "t" }).code, "invalid_field");
  assert.equal(contract.parseBackendUiEvent({ type: "future.event", taskId: "t" }).code, "unknown_type");
  const invalid = contract.parseBackendUiEvent({ type: "assistant.delta", taskId: "t", text: 42 });
  assert.equal(invalid.code, "invalid_field");
  assert.match(contract.backendEventDiagnostic(invalid), /^\[invalid-event:invalid_field\]/);
  assert.equal(
    contract.parseBackendUiEvent({
      type: "response.feedback",
      taskId: "t",
      messageId: "assistant-1",
      rating: "bad",
      reason: "Solved my issue",
    }).code,
    "invalid_field",
  );

  for (const payload of [
    { contextLength: 64000, contentTokens: -1, reserveTokens: 4096, estimatedTokens: 4095 },
    { contextLength: 64000, contentTokens: 12000, reserveTokens: 4096, estimatedTokens: 99999 },
    { contextLength: 0, contentTokens: 0, reserveTokens: 0, estimatedTokens: 0 },
    { contextLength: 64000, contentTokens: 12000, reserveTokens: 4096, estimatedTokens: 16096, phase: "guess" },
    { contextLength: 64000, contentTokens: 12000, reserveTokens: 4096, estimatedTokens: 16096, anchored: "yes" },
    {
      contextLength: 64000, contentTokens: 12000, reserveTokens: 4096, estimatedTokens: 16096,
      breakdown: { systemPromptTokens: -1, systemPromptExact: true, toolDefinitionTokens: 0, skillTokens: 0, conversationTokens: 0, toolResultTokens: 0, imageTokens: 0 },
    },
    {
      contextLength: 64000, contentTokens: 12000, reserveTokens: 4096, estimatedTokens: 16096,
      breakdown: { systemPromptTokens: 10, toolDefinitionTokens: 0, skillTokens: 0, conversationTokens: 0, toolResultTokens: 0, imageTokens: 0 },
    },
  ]) {
    assert.equal(contract.parseBackendUiEvent({ type: "context.usage", taskId: "t", ...payload }).code, "invalid_field");
  }
});

test("category rows are accepted without being reconciled to the measured headline", () => {
  // Only the headline is measured. Requiring the rows to add up to it would
  // spread the estimator's error across every category, so the contract
  // deliberately does not.
  const event = {
    type: "context.usage",
    taskId: "t",
    contextLength: 64000,
    contentTokens: 12000,
    reserveTokens: 4096,
    estimatedTokens: 16096,
    anchored: true,
    breakdown: {
      systemPromptTokens: 1, systemPromptExact: false, toolDefinitionTokens: 1, skillTokens: 1,
      conversationTokens: 1, toolResultTokens: 1, imageTokens: 1,
    },
  };
  assert.equal(contract.parseBackendUiEvent(event).ok, true);

  // A runner that has not been told the prefix size, or a stored event from
  // before the meter reported one, is still a valid event.
  const bare = { type: "context.usage", taskId: "t", contextLength: 64000, contentTokens: 12000, reserveTokens: 4096, estimatedTokens: 16096 };
  assert.equal(contract.parseBackendUiEvent(bare).ok, true);
});
