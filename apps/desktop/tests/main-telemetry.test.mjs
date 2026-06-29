import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

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

test("telemetry bundle keeps workflow facts while redacting prompts, paths, command output, and secrets", () => {
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
            diff: ["@@ -1,1 +1,2 @@", "-old", "+new", "+token=abcdefghijklmnopqrstuvwxyz"].join("\n"),
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
            type: "skill.selected",
            taskId: "task-1",
            skillId: "deal-review",
            source: "local",
            reason: "explicit_request",
            fullContent: true,
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
                diff: ["@@ -1,1 +1,2 @@", "-old", "+new"].join("\n"),
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
  assert.doesNotMatch(serialized, /C:\/secret/);
  assert.doesNotMatch(serialized, /executablePath/);
  assert.match(serialized, /promptRedacted/);
  assert.match(serialized, /outputRedacted/);

  const task = bundle.tasks[0];
  assert.equal(task.review.additions, 2);
  assert.equal(task.review.deletions, 1);
  assert.deepEqual(plain(task.capabilityProbes), [
    {
      id: "pdftoppm",
      status: "missing",
      category: "optional-artifacts",
      importance: "optional",
      workflows: ["PDF artifact", "visual QA"],
      versionFamily: "24.02",
      affectedCurrentRun: true,
    },
  ]);
  assert.equal(task.events[0].data.length, "password=abcdefghijklmnopqrstuvwxyz".length);
  assert.equal(task.events[2].data.command, "echo token=[redacted]");
  assert.equal(task.events[4].data.status, "runtime_error");
  assert.equal(task.events[4].data.errorCode, "command_exit_nonzero");
  assert.equal(task.events[4].data.errorMessage, "token=[redacted]");
  assert.equal(task.events[4].data.durationMs, 42);
  const requiredToolFailure = task.events.find((event) => event.type === "required_tool.failed");
  assert.equal(requiredToolFailure.data.requirement, "file_change");
  assert.equal(requiredToolFailure.data.reason, "attempted_tool_failed");
  assert.deepEqual(requiredToolFailure.data.requiredTools, ["write", "edit", "command"]);
  assert.deepEqual(requiredToolFailure.data.attemptedTools, ["edit"]);
  assert.equal(requiredToolFailure.data.detail, "tool failed with token=[redacted]");
  const skillSelected = task.events.find((event) => event.type === "skill.selected");
  assert.equal(skillSelected.data.skillId, "deal-review");
  assert.equal(skillSelected.data.source, "local");
  assert.equal(skillSelected.data.reason, "explicit_request");
  assert.equal(skillSelected.data.fullContent, true);
  const reviewReady = task.events.find((event) => event.type === "review.ready");
  assert.equal(reviewReady.data.latestTest.command, "npm run test -- --token=[redacted]");
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
  assert.match(received[0].body, /promptRedacted/);

  shouldFail = false;
  const retry = await uploadTelemetrySpool({ directory: spool, endpoint });
  assert.equal(retry.uploaded, 1);
  assert.equal(retry.pending, 0);
  assert.equal((await listTelemetrySpoolFiles(spool)).length, 0);
  assert.equal(received.length, 2);

  assert.equal((await listTelemetrySpoolFiles(spool)).length, 0);
});
