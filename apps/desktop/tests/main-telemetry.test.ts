import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const cache = new Map();
const {
  buildRedactedTelemetryBundle,
  listTelemetrySpoolFiles,
  writeTelemetrySpoolFile,
} = loadTypeScriptModule(new URL("../src/main/telemetry.ts", import.meta.url), { cache });
const {
  syncTelemetryBundle,
  telemetrySpoolDirectory,
  uploadTelemetrySpool,
} = loadTypeScriptModule(new URL("../src/main/telemetrySync.ts", import.meta.url), { cache });
const plain = (value) => JSON.parse(JSON.stringify(value));

function sampleTelemetryBundle() {
  return buildRedactedTelemetryBundle(
    [
      {
        id: "task-sync",
        chatId: "chat-sync",
        repositoryId: "repo-sync",
        originalRepoPath: "/secret/repo",
        workspaceKind: "git",
        workspaceMode: "local",
        originalBranch: "main",
        baseCommit: "abcdef1234567890abcdef",
        worktreePath: "/secret/repo",
        permissionMode: "normal",
        reasoningMode: "reasoning",
        state: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        changedFiles: ["src/report.ts"],
        reviewFiles: [],
        prompt: "token=abcdefghijklmnopqrstuvwxyz",
        events: [
          { type: "user.message", taskId: "task-sync", text: "password=abcdefghijklmnopqrstuvwxyz", at: "2026-01-01T00:00:00.000Z" },
          { type: "assistant.done", taskId: "task-sync", at: "2026-01-01T00:00:01.000Z" },
        ],
      },
    ],
    [{ id: "repo-sync", name: "Repo", rootPath: "/secret/repo", kind: "git", originalBranch: "main", baseCommit: "abcdef", dirty: false, statusSummary: "clean" }],
  );
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
  });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

// The golden fixture is shared with the Veil consumer test, which reads it by
// relative path. Both sides must accept the same bytes or the bundle silently
// stops round-tripping in production.
test("telemetry bundle matches the shared golden contract fixture", () => {
  const fixtures = new URL("fixtures/", import.meta.url);
  const input = JSON.parse(fs.readFileSync(new URL("telemetry-bundle.input.json", fixtures), "utf8"));
  const golden = JSON.parse(fs.readFileSync(new URL("telemetry-bundle.golden.json", fixtures), "utf8"));

  const bundle = plain(
    buildRedactedTelemetryBundle(input.tasks, input.projects, input.productEvents, input.localDiagnostics),
  );
  assert.match(bundle.exportedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  bundle.exportedAt = golden.exportedAt;
  assert.deepEqual(bundle, golden);
});

test("telemetry bundle keeps workflow facts while redacting prompts, paths, command output, and secrets", () => {
  const diagnosticDir = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-diagnostics-"));
  const diagnosticLogPath = path.join(diagnosticDir, "task-1.jsonl");
  fs.writeFileSync(
    diagnosticLogPath,
    `${JSON.stringify({
      source: "umbratic-runner",
      level: "error",
      eventType: "runner.error",
      taskId: "task-1",
      at: "2026-01-01T00:00:07.000Z",
      data: {
        message: "model request failed token=abcdefghijklmnopqrstuvwxyz",
        detail: "provider path C:/secret/model-cache",
      },
    })}\n`,
    "utf8",
  );

  const bundle = buildRedactedTelemetryBundle(
    [
      {
        id: "task-1",
        chatId: "chat-1",
        repositoryId: "repo-1",
        originalRepoPath: "C:/secret/repo",
        workspaceKind: "git",
        workspaceMode: "worktree",
        originalBranch: "main",
        baseCommit: "abcdef1234567890abcdef",
        agentBranch: "umbratic/test",
        worktreePath: "C:/secret/worktree",
        permissionMode: "normal",
        reasoningMode: "reasoning",
        state: "review_ready",
        createdAt: "2026-01-01T00:00:00.000Z",
        changedFiles: ["src/app.ts"],
        reviewFiles: [
          {
            path: "src/app.ts",
            status: "modified",
            patch: ["@@ -1,1 +1,2 @@", "-old", "+new", "+token=abcdefghijklmnopqrstuvwxyz"].join("\n"),
          },
        ],
        latestTest: {
          command: "npm run test -- --token=abcdefghijklmnopqrstuvwxyz",
          output: "passed",
          passed: true,
          exitCode: 0,
          completedAt: "2026-01-01T00:01:00.000Z",
        },
        model: {
          providerId: "company-endpoint",
          providerName: "Umbratic Veil",
          modelId: "veil-managed",
          displayName: "Veil",
          baseUrl: "https://veil.example.internal",
        },
        diagnosticLogPath,
        capabilityProbes: [
          {
            id: "pdftoppm",
            status: "missing",
            category: "optional-artifacts",
            importance: "optional",
            workflows: ["PDF artifact", "visual QA"],
            versionFamily: "24.02",
            affectedCurrentRun: true,
          },
        ],
        prompt: "Please fix the secret bug",
        events: [
          { type: "user.message", taskId: "task-1", text: "password=abcdefghijklmnopqrstuvwxyz", at: "2026-01-01T00:00:00.000Z" },
          { type: "assistant.delta", taskId: "task-1", text: "Here is the full answer", at: "2026-01-01T00:00:01.000Z" },
          {
            type: "command.started",
            taskId: "task-1",
            id: "cmd-1",
            command: "echo token=abcdefghijklmnopqrstuvwxyz",
            cwd: "C:/secret/worktree",
            at: "2026-01-01T00:00:02.000Z",
          },
          {
            type: "command.output",
            taskId: "task-1",
            id: "cmd-1",
            stream: "stdout",
            text: "api_key=abcdefghijklmnopqrstuvwxyz",
            at: "2026-01-01T00:00:03.000Z",
          },
          {
            type: "command.finished",
            taskId: "task-1",
            id: "cmd-1",
            exitCode: 1,
            status: "runtime_error",
            errorCode: "command_exit_nonzero",
            errorMessage: "token=abcdefghijklmnopqrstuvwxyz",
            durationMs: 42,
            at: "2026-01-01T00:00:04.000Z",
          },
          {
            type: "permission.requested",
            taskId: "task-1",
            request: {
              id: "permission-1",
              kind: "bash",
              summary: "Run tests",
              command: "npm test",
              cwd: "C:/secret/worktree",
            },
            at: "2026-01-01T00:00:04.010Z",
          },
          {
            type: "permission.resolved",
            taskId: "task-1",
            id: "permission-1",
            decision: "allow",
            at: "2026-01-01T00:00:04.020Z",
          },
          {
            type: "context.compressed",
            taskId: "task-1",
            toolCallId: "cmd-1",
            toolKind: "command",
            kind: "log",
            strategy: "log_errors_tail",
            hash: "abcdef1234567890",
            originalBytes: 48000,
            outputBytes: 9000,
            at: "2026-01-01T00:00:04.100Z",
          },
          {
            type: "context.retrieved",
            taskId: "task-1",
            toolCallId: "cmd-2",
            hash: "abcdef1234567890",
            offset: 0,
            bytesShown: 12000,
            totalBytes: 48000,
            at: "2026-01-01T00:00:04.200Z",
          },
          {
            type: "required_tool.failed",
            taskId: "task-1",
            requirement: "file_change",
            reason: "attempted_tool_failed",
            requiredTools: ["write", "edit", "command"],
            attemptedTools: ["edit"],
            attempt: 1,
            detail: "tool failed with token=abcdefghijklmnopqrstuvwxyz",
            at: "2026-01-01T00:00:05.000Z",
          },
          {
            type: "skill.loaded",
            taskId: "task-1",
            sessionId: "session-1",
            runId: "run-1",
            requestId: "skill-req-1",
            skillId: "deal-review",
            source: "local",
            origin: "harness",
            contentHash: "abc123",
            bytes: 42,
            at: "2026-01-01T00:00:06.000Z",
          },
          {
            type: "review.ready",
            taskId: "task-1",
            changedFiles: ["src/app.ts"],
            reviewFiles: [
              {
                path: "src/app.ts",
                status: "modified",
                patch: ["@@ -1,1 +1,2 @@", "-old", "+new"].join("\n"),
              },
            ],
            latestTest: {
              command: "npm run test -- --token=abcdefghijklmnopqrstuvwxyz",
              output: "passed",
              passed: true,
              exitCode: 0,
              completedAt: "2026-01-01T00:01:00.000Z",
            },
          },
        ],
      },
    ],
    [{ id: "repo-1", name: "Repo", rootPath: "C:/secret/repo", kind: "git", originalBranch: "main", baseCommit: "abcdef", dirty: false, statusSummary: "clean" }],
  );

  const serialized = JSON.stringify(bundle);
  assert.doesNotMatch(serialized, /password=abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(serialized, /api_key=abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(serialized, /abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(serialized, /model request failed token=abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(serialized, /model-cache/);
  assert.doesNotMatch(serialized, /umbratic-runner-diagnostics/);
  assert.doesNotMatch(serialized, /npm run test/);
  assert.doesNotMatch(serialized, /echo token/);
  assert.doesNotMatch(serialized, /C:\/secret/);
  assert.doesNotMatch(serialized, /executablePath/);
  assert.equal("schemaVersion" in bundle, false);
  assert.equal("policy" in bundle, false);
  assert.deepEqual(plain(bundle.productEvents), []);

  const task = bundle.tasks[0];
  assert.equal(task.outcome, "success");
  assert.deepEqual(plain(task.workspace), { kind: "git", mode: "worktree" });
  assert.deepEqual(plain(task.model), { providerId: "company-endpoint", modelId: "veil-managed" });
  assert.deepEqual(plain(task.mode), { permission: "normal", reasoning: "reasoning" });
  assert.equal(task.changes.fileCount, 1);
  assert.deepEqual(plain(task.changes.review), { fileCount: 1, additions: 2, deletions: 1 });
  assert.deepEqual(plain(task.changes.latestTest), { passed: true, exitCode: 0 });
  assert.equal("runnerDiagnostics" in task, false);
  assert.equal("capabilityProbes" in task, false);
  assert.equal("events" in task, false);
  assert.equal("changedFiles" in task, false);
  assert.equal("patchHash" in task, false);
  assert.deepEqual(plain(task.runtimeHealth), {
    total: 1,
    affectedCurrentRun: 1,
    byStatus: { missing: 1 },
    byImportance: { optional: 1 },
  });
  assert.equal(task.activity.eventCount, 12);
  assert.equal(task.activity.messages.user, 1);
  assert.equal(task.activity.messages.promptChars, "password=abcdefghijklmnopqrstuvwxyz".length);
  assert.equal(task.activity.messages.assistantChars, "Here is the full answer".length);
  assert.equal(task.activity.commands.started, 1);
  assert.equal(task.activity.commands.finished, 1);
  assert.equal(task.activity.commands.failed, 1);
  assert.equal(task.activity.commands.outputEvents, 1);
  assert.equal(task.activity.commands.outputChars, "api_key=abcdefghijklmnopqrstuvwxyz".length);
  assert.equal(task.activity.commands.durationMs, 42);
  assert.equal(task.activity.commands.byClass.shell, 1);
  assert.equal(task.activity.commands.errors.command_exit_nonzero, 1);
  assert.deepEqual(plain(task.activity.permissions), { requested: 1, allowed: 1, denied: 0 });
  assert.equal(task.activity.context.compressed, 1);
  assert.equal(task.activity.context.retrieved, 1);
  assert.equal(task.activity.context.originalBytes, 48000);
  assert.equal(task.activity.context.outputBytes, 9000);
  assert.equal(task.activity.context.bytesSaved, 39000);
  assert.equal(task.activity.context.retrievedBytes, 12000);
  assert.equal(task.activity.context.byKind.log, 1);
  assert.equal(task.activity.context.byStrategy.log_errors_tail, 1);
  assert.equal(task.activity.requiredToolFailures.attempted_tool_failed, 1);
});

test("telemetry summarizes local diagnostic severity without exporting diagnostic messages", () => {
  const bundle = buildRedactedTelemetryBundle([], [], [], [
    { id: 1, at: "2026-01-01T00:00:00.000Z", level: "warn", source: "runner", event: "runner.warning", message: "non-sensitive warning", data: {} },
    { id: 2, at: "2026-01-01T00:00:01.000Z", level: "error", source: "task", event: "task.error", message: "secret path /private/repo", data: {} },
  ]);

  assert.deepEqual(plain(bundle.localDiagnostics), {
    total: 2,
    warnings: 1,
    errors: 1,
    bySource: { runner: 1, task: 1 },
    byEvent: { "runner.warning": 1, "task.error": 1 },
  });
  assert.doesNotMatch(JSON.stringify(bundle), /secret path/);
});

test("telemetry includes full rated conversations, typed failed tool metadata, context crossings, and product events", () => {
  const task = (id, createdAt, events) => ({
    id,
    chatId: "chat-shared",
    repositoryId: "repo-1",
    originalRepoPath: "/private/repo",
    workspaceKind: "git",
    workspaceMode: "local",
    originalBranch: "main",
    baseCommit: "abcdef1234567890",
    worktreePath: "/private/repo",
    permissionMode: "normal",
    reasoningMode: "reasoning",
    state: "completed",
    createdAt,
    changedFiles: [],
    reviewFiles: [],
    prompt: "stored prompt",
    events,
  });
  const bundle = buildRedactedTelemetryBundle(
    [
      task("task-1", "2026-01-01T00:00:00.000Z", [
        { type: "user.message", taskId: "task-1", text: "First user message", at: "2026-01-01T00:00:00.000Z" },
        { type: "assistant.delta", taskId: "task-1", text: "First response", at: "2026-01-01T00:00:01.000Z" },
        { type: "assistant.done", taskId: "task-1", at: "2026-01-01T00:00:02.000Z" },
        { type: "response.feedback", taskId: "task-1", messageId: "assistant-1", rating: "bad", reason: "Missing details", comment: "Missed the edge case.", at: "2026-01-01T00:00:03.000Z" },
        { type: "context.usage", taskId: "task-1", contextLength: 1000, contentTokens: 700, reserveTokens: 100, estimatedTokens: 800, at: "2026-01-01T00:00:04.000Z" },
        { type: "context.usage", taskId: "task-1", contextLength: 1000, contentTokens: 850, reserveTokens: 100, estimatedTokens: 950, phase: "preflight", source: "heuristic", confidence: "low", at: "2026-01-01T00:00:05.000Z" },
        { type: "context.usage", taskId: "task-1", contextLength: 1000, contentTokens: 400, reserveTokens: 100, estimatedTokens: 500, at: "2026-01-01T00:00:06.000Z" },
        { type: "context.usage", taskId: "task-1", contextLength: 1000, contentTokens: 660, reserveTokens: 100, estimatedTokens: 760, at: "2026-01-01T00:00:07.000Z" },
        {
          type: "tool.failed",
          taskId: "task-1",
          id: "ar-call-1",
          toolKind: "edit",
          input: { path: "src/app.ts", edits: [{ oldText: "before", newText: "after" }] },
          response: { stdout: "", stderr: "", toolResponse: "oldText was not found", exitCode: 1, status: "validation_error", errorCode: "invalid_arguments" },
          at: "2026-01-01T00:00:08.000Z",
        },
      ]),
      task("task-2", "2026-01-01T00:10:00.000Z", [
        { type: "user.message", taskId: "task-2", text: "Second user message", at: "2026-01-01T00:10:00.000Z" },
        { type: "assistant.delta", taskId: "task-2", text: "Second response", at: "2026-01-01T00:10:01.000Z" },
        { type: "assistant.done", taskId: "task-2", at: "2026-01-01T00:10:02.000Z" },
      ]),
    ],
    [],
    [{ id: "event-1", type: "review.opened", at: "2026-01-01T00:00:00.000Z", taskId: "task-1", repositoryId: "repo-1", data: { scope: "task" } }],
  );

  assert.equal("schemaVersion" in bundle, false);
  assert.deepEqual(plain(bundle.productEvents).map((event) => event.type), ["review.opened"]);
  assert.deepEqual(plain(bundle.tasks[0].feedback[0]), {
    messageId: "assistant-1",
    rating: "bad",
    reason: "Missing details",
    comment: "Missed the edge case.",
    at: "2026-01-01T00:00:03.000Z",
    conversation: [
      { role: "user", content: "First user message", taskId: "task-1", at: "2026-01-01T00:00:00.000Z" },
      { role: "assistant", content: "First response", taskId: "task-1", at: "2026-01-01T00:00:01.000Z", messageId: "assistant-1" },
      { role: "user", content: "Second user message", taskId: "task-2", at: "2026-01-01T00:10:00.000Z" },
      { role: "assistant", content: "Second response", taskId: "task-2", at: "2026-01-01T00:10:01.000Z", messageId: "assistant-1" },
    ],
  });
  const failed = plain(bundle.tasks[0].failedTools[0]);
  assert.equal(failed.toolKind, "edit");
  assert.equal(failed.status, "validation_error");
  assert.equal(failed.errorCode, "invalid_arguments");
  assert.deepEqual(failed.inputMeta.argKeys, ["path", "edits"]);
  assert.equal(typeof failed.inputMeta.pathHash, "string");
  assert.equal(failed.responseMeta.toolResponseChars, "oldText was not found".length);
  assert.doesNotMatch(JSON.stringify(bundle.tasks[0].failedTools), /"before"|"after"|oldText was not found/);
  assert.equal("input" in failed, false);
  assert.equal("response" in failed, false);
  assert.deepEqual(plain(bundle.tasks[0].contextTriggers).map((trigger) => trigger.threshold), [75, 75]);
});

test("telemetry spool files are unique and sorted for retry", async () => {
  const spool = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-telemetry-spool-"));
  const bundle = sampleTelemetryBundle();
  const date = new Date("2026-01-01T00:00:00.000Z");

  const first = await writeTelemetrySpoolFile(spool, bundle, date);
  const second = await writeTelemetrySpoolFile(spool, bundle, date);
  const files = await listTelemetrySpoolFiles(spool);

  assert.notEqual(first, second);
  assert.deepEqual(plain(files), [first, second].sort());
  const contents = fs.readFileSync(first, "utf8");
  assert.equal(contents.trim(), JSON.stringify(bundle));
  assert.doesNotMatch(contents, /\n\s+"/);
});

test("telemetry sync uploads redacted spool files with endpoint auth and keeps failed files for retry", async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-telemetry-sync-"));
  const spool = telemetrySpoolDirectory(userData);
  const received = [];
  let shouldFail = true;
  const server = http.createServer(async (request, response) => {
    const body = await readRequestBody(request);
    received.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      team: request.headers["x-team"],
      body,
    });
    response.setHeader("Content-Type", "application/json");
    if (shouldFail) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: "retry later" }));
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  t.after(() => server.close());
  const address = await listen(server);
  const endpoint = {
    url: `http://${address.address}:${address.port}/api/telemetry`,
    headers: { Authorization: "Bearer telemetry-token", "X-Team": "engineering" },
  };
  const bundle = sampleTelemetryBundle();

  const failed = await syncTelemetryBundle({
    directory: spool,
    bundle,
    endpoint,
    date: new Date("2026-01-01T00:00:00.000Z"),
  });

  assert.equal(failed.ok, false);
  assert.equal(failed.uploaded, 0);
  assert.equal(failed.pending, 1);
  assert.equal((await listTelemetrySpoolFiles(spool)).length, 1);
  assert.equal(received[0].method, "POST");
  assert.equal(received[0].url, "/api/telemetry");
  assert.equal(received[0].authorization, "Bearer telemetry-token");
  assert.equal(received[0].team, "engineering");
  assert.doesNotMatch(received[0].body, /password=abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(received[0].body, /\/secret\/repo/);
  assert.doesNotMatch(received[0].body, /promptRedacted/);
  const uploadedBundle = JSON.parse(received[0].body);
  assert.equal("schemaVersion" in uploadedBundle, false);
  assert.equal(uploadedBundle.tasks[0].outcome, "success");
  assert.equal(uploadedBundle.tasks[0].activity.messages.promptChars, "password=abcdefghijklmnopqrstuvwxyz".length);
  assert.equal("events" in uploadedBundle.tasks[0], false);
  assert.equal("policy" in uploadedBundle, false);

  shouldFail = false;
  const retry = await uploadTelemetrySpool({ directory: spool, endpoint });
  assert.equal(retry.uploaded, 1);
  assert.equal(retry.pending, 0);
  assert.equal((await listTelemetrySpoolFiles(spool)).length, 0);
  assert.equal(received.length, 2);

  assert.equal((await listTelemetrySpoolFiles(spool)).length, 0);
});
