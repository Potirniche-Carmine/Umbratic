import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const storagePath = new URL("../src/main/storage.ts", import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));

function electronMock(userData) {
  return {
    app: {
      getPath(name) {
        if (name === "userData" || name === "documents" || name === "appData") return userData;
        return userData;
      },
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString(value) {
        return Buffer.from(Buffer.from(value, "utf8").toString("base64"), "utf8");
      },
      decryptString(buffer) {
        return Buffer.from(buffer.toString("utf8"), "base64").toString("utf8");
      },
    },
  };
}

function loadStorage(userData) {
  return loadTypeScriptModule(storagePath, { cache: new Map(), mocks: { electron: electronMock(userData) } });
}

function runnerToolExchangeState() {
  return {
    sourceTaskId: "task-news",
    updatedAt: "2026-08-16T21:00:00.000Z",
    summary: null,
    tail: [
      { role: "user", content: "tell me some things about the news today in Reno Nevada" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "search-1", type: "function", function: { name: "web_search", arguments: "{}" } }],
      },
      { role: "tool", toolCallId: "search-1", content: "Bug Fire near Reno" },
      { role: "assistant", content: "Shari Floyd dies of Bug Fire injuries." },
    ],
    sourceDigest: "a".repeat(64),
    usage: {
      estimatedPromptTokens: 1200,
      observedPromptTokens: null,
      compactionCount: 0,
    },
  };
}

test("normalizeConversationState keeps runner camelCase tool fields", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-conversation-state-"));
  const storage = loadStorage(userData);
  const state = runnerToolExchangeState();
  const normalized = plain(storage.normalizeConversationState(state));
  assert.equal(normalized.tail[1].toolCalls[0].id, "search-1");
  assert.equal(normalized.tail[2].toolCallId, "search-1");
  assert.equal("tool_calls" in normalized.tail[1], false);
  assert.equal("tool_call_id" in normalized.tail[2], false);
  storage.closeStorageDatabases();
});

test("normalizeConversationState rejects a tool exchange that only has snake_case ids", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-conversation-snake-"));
  const storage = loadStorage(userData);
  const state = runnerToolExchangeState();
  state.tail[1] = { role: "assistant", content: null, tool_calls: state.tail[1].toolCalls };
  state.tail[2] = { role: "tool", tool_call_id: "search-1", content: "Bug Fire near Reno" };
  assert.equal(storage.normalizeConversationState(state), undefined);
  storage.closeStorageDatabases();
});

test("writeChat round-trips a tool-using conversation snapshot", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-conversation-chat-"));
  const storage = loadStorage(userData);
  const conversationState = runnerToolExchangeState();
  storage.writeChat({
    id: "chat-news",
    title: "Reno news",
    createdAt: "2026-08-16T20:00:00.000Z",
    updatedAt: "2026-08-16T21:00:00.000Z",
    attachedFiles: [],
    conversationState,
  });
  const chat = storage.readChat("chat-news");
  assert.equal(chat.conversationState.tail[2].toolCallId, "search-1");
  assert.equal(chat.conversationState.tail[3].content, "Shari Floyd dies of Bug Fire injuries.");
  storage.closeStorageDatabases();
});
