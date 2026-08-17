import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const promptPath = new URL("../src/main/taskPromptContext.ts", import.meta.url);

function electronMock(userData) {
  return {
    app: {
      getPath: () => userData,
      on: () => {},
      whenReady: async () => {},
    },
    BrowserWindow: class {},
    safeStorage: {
      isEncryptionAvailable: () => false,
    },
  };
}

function loadPrompt(userData) {
  return loadTypeScriptModule(promptPath, {
    cache: new Map(),
    mocks: { electron: electronMock(userData) },
  });
}

function hiddenTask(userData, prompt) {
  const chatId = "chat-news";
  const scratch = path.join(userData, "workspaces", "scratch", chatId);
  fs.mkdirSync(scratch, { recursive: true });
  return {
    id: "task-news",
    chatId,
    repositoryId: `hidden-${chatId}`,
    prompt,
    originalRepoPath: scratch,
    worktreePath: scratch,
    workspaceKind: "folder",
    workspaceMode: "local",
    state: "completed",
    originalBranch: "folder",
    baseCommit: "abc",
    agentBranch: "",
    permissionMode: "normal",
    createdAt: "2026-08-16T20:00:00.000Z",
    changedFiles: [],
    reviewFiles: [],
    originalWasDirty: false,
    events: [
      {
        type: "user.message",
        taskId: "task-news",
        text: "tell me some things about the news today like the 1 or 2 bullet points most important in Reno Nevada",
      },
      {
        type: "assistant.delta",
        taskId: "task-news",
        text: "Shari Floyd dies of Bug Fire injuries.",
      },
      { type: "user.message", taskId: "task-news", text: prompt },
    ],
  };
}

test("priorChatContext keeps the previous user and assistant turns", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-prompt-history-"));
  const prompt = loadPrompt(userData);
  const history = prompt.priorChatContext(hiddenTask(userData, "anything about any car crashed").events, "anything about any car crashed");
  assert.match(history, /User: tell me some things about the news today/);
  assert.match(history, /Assistant: Shari Floyd dies of Bug Fire injuries/);
  assert.doesNotMatch(history, /car crashed/);
});

test("a folderless follow-up still includes conversation history when durable state is missing", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-prompt-folderless-"));
  const prompt = loadPrompt(userData);
  const followUp = "anything about any car crashed";
  const parts = await prompt.runnerPromptForTask(
    hiddenTask(userData, followUp),
    followUp,
    [],
    32_000,
    { useDurableContext: false },
  );
  const text = parts.map((part) => part.text ?? "").join("\n");
  assert.match(text, /Conversation so far:/);
  assert.match(text, /Reno Nevada/);
  assert.match(text, /Bug Fire/);
  assert.equal(parts.at(-1).text, followUp);
});

test("durable conversation state suppresses the event-history dump", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-prompt-durable-"));
  const prompt = loadPrompt(userData);
  const followUp = "anything about any car crashed";
  const parts = await prompt.runnerPromptForTask(
    hiddenTask(userData, followUp),
    followUp,
    [],
    32_000,
    { useDurableContext: true },
  );
  const text = parts.map((part) => part.text ?? "").join("\n");
  assert.doesNotMatch(text, /Conversation so far:/);
  assert.doesNotMatch(text, /Bug Fire/);
  assert.equal(parts.at(-1).text, followUp);
});
