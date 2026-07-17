import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const contract = loadTypeScriptModule(new URL("../src/shared/backendEvents.ts", import.meta.url));

const fixtures = [
  ["user.message", { text: "hello" }], ["assistant.delta", { text: "hi" }],
  ["assistant.reasoning.delta", { text: "thinking" }], ["assistant.done", {}],
  ["worktree.requested", { branch: "b", path: "p", baseCommit: "c" }], ["worktree.created", { branch: "b", path: "p" }],
  ["command.started", { id: "1", command: "npm test", cwd: "." }], ["command.output", { id: "1", stream: "stdout", text: "ok" }],
  ["command.finished", { id: "1", exitCode: 0 }],
  ["context.usage", { contextLength: 64000, contentTokens: 12000, reserveTokens: 8192, estimatedTokens: 20192 }],
  ["context.compressed", { toolCallId: "1", toolKind: "read", kind: "file", strategy: "text_head_tail", originalBytes: 2, outputBytes: 1 }],
  ["context.retrieved", { toolCallId: "1", hash: "abc", offset: 0, bytesShown: 1, totalBytes: 1 }],
  ["permission.requested", { request: { id: "p", kind: "edit", summary: "write", command: "write", cwd: "." } }],
  ["permission.resolved", { id: "p", decision: "allow" }], ["review.ready", { changedFiles: [], reviewFiles: [] }],
  ["review.changed_since_ready", { previousPatchHash: "a", currentPatchHash: "b", changedFileCount: 1 }],
  ["approval.check", { name: "tests", status: "passed" }], ["merge.approval", { decision: "approved" }],
  ["approval.completed", { target: "main", patchHash: "a" }], ["merge.completed", { targetBranch: "main", commit: "c", patchHash: "a" }],
  ["ide.opened", { ideId: "code", target: "workspace", result: "success" }], ["response.feedback", { messageId: "m", rating: "good" }],
  ["skill.selected", { skillId: "s", source: "system", reason: "metadata", fullContent: false }],
  ["required_tool.failed", { requirement: "file_change", reason: "missing_tool_call", requiredTools: ["edit"] }],
  ["task.error", { message: "failed" }],
];

test("every backend event variant normalizes to contract version 1", () => {
  for (const [type, payload] of fixtures) {
    const result = contract.parseBackendUiEvent({ type, taskId: "task-1", ...payload });
    assert.equal(result.ok, true, `${type}: ${result.message ?? "invalid"}`);
    assert.equal(result.event.version, 1);
  }
});

test("malformed, unknown, and future backend events are quarantined", () => {
  assert.equal(contract.parseBackendUiEvent(null).code, "not_an_object");
  assert.equal(contract.parseBackendUiEvent({ version: 2, type: "assistant.done", taskId: "t" }).code, "unsupported_version");
  assert.equal(contract.parseBackendUiEvent({ type: "future.event", taskId: "t" }).code, "unknown_type");
  const invalid = contract.parseBackendUiEvent({ type: "assistant.delta", taskId: "t", text: 42 });
  assert.equal(invalid.code, "invalid_field");
  assert.match(contract.backendEventDiagnostic(invalid), /^\[invalid-event:invalid_field\]/);
});


