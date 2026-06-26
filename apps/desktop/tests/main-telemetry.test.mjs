import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const { buildRedactedTelemetryBundle } = loadTypeScriptModule(new URL("../src/main/telemetry.ts", import.meta.url));

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
        agentBranch: "codex/test",
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
          { type: "command.finished", taskId: "task-1", id: "cmd-1", exitCode: 0, at: "2026-01-01T00:00:04.000Z" },
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
  assert.match(serialized, /promptRedacted/);
  assert.match(serialized, /outputRedacted/);

  const task = bundle.tasks[0];
  assert.equal(task.review.additions, 2);
  assert.equal(task.review.deletions, 1);
  assert.equal(task.events[0].data.length, "password=abcdefghijklmnopqrstuvwxyz".length);
  assert.equal(task.events[2].data.command, "echo token=[redacted]");
  const reviewReady = task.events.find((event) => event.type === "review.ready");
  assert.equal(reviewReady.data.latestTest.command, "npm run test -- --token=[redacted]");
});
