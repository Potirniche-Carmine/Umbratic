import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const storagePath = new URL("../src/main/storage.ts", import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));

function setEnv(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

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
  setEnv({
    OLLAMA_BASE_URL: "",
    OLLAMA_API_KEY: "",
    UMBRATIC_ALLOW_ENDPOINT_EDIT: "true",
    UMBRATIC_MANAGED_ENDPOINT_MODE: undefined,
    UMBRATIC_MANAGED_MODEL_API_KEY: undefined,
    UMBRATIC_MANAGED_MODEL_BASE_URL: undefined,
    UMBRATIC_MANAGED_MODEL_SOFTWARE: undefined,
    UMBRATIC_MODEL_API_KEY: "",
    UMBRATIC_MODEL_BASE_URL: "",
    UMBRATIC_MODEL_SOFTWARE: "",
    UMBRATIC_VEIL_BASE_URL: "",
    UMBRATIC_VEIL_TOKEN: "",
    UMBRATIC_VLLM_BASE_URL: "",
    VLLM_BASE_URL: "",
    VLLM_API_KEY: "",
  });
  return loadTypeScriptModule(storagePath, { cache: new Map(), mocks: { electron: electronMock(userData) } });
}

test("projects and chats are normalized from real JSON files", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-storage-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-repo-"));
  const storage = loadStorage(userData);

  storage.writeJsonFile(path.join(userData, "projects.json"), [
    { id: "repo", name: "Repo", rootPath: repo, originalBranch: "main", baseCommit: "abc", dirty: false, statusSummary: "clean" },
    { id: "missing", name: "Missing", rootPath: path.join(userData, "missing"), originalBranch: "main", baseCommit: "abc", dirty: false, statusSummary: "clean" },
  ]);
  assert.deepEqual(plain(storage.readProjects()).map((project) => project.id), ["repo"]);
  assert.equal(storage.readProjects()[0].kind, "git");

  storage.writeJsonFile(path.join(userData, "chats.json"), [
    { id: "chat-2", title: "Second", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z", attachedFiles: [{ path: "a.ts", name: "a.ts" }] },
    { id: "chat-1", title: "First", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", attachedFiles: [{ path: 1, name: "bad" }] },
    { title: "bad" },
  ]);
  const chats = storage.readChats();
  assert.deepEqual(plain(chats).map((chat) => chat.id), ["chat-2", "chat-1"]);
  assert.deepEqual(plain(chats[1].attachedFiles), []);
});

test("tasks migrate old records with runtime profile, tool settings, and event defaults", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-tasks-"));
  const storage = loadStorage(userData);

  storage.writeJsonFile(path.join(userData, "tasks.json"), [
    {
      id: "task-1",
      repositoryId: "repo",
      prompt: "fix pytest in tests/test_app.py",
      originalRepoPath: userData,
      worktreePath: userData,
      workspaceKind: "git",
      state: "running",
      originalBranch: "main",
      baseCommit: "abc",
      agentBranch: "",
      permissionMode: "normal",
      createdAt: "2026-01-01T00:00:00.000Z",
      changedFiles: [],
      enabledTools: ["read", "bogus", "command", "read"],
      reviewFiles: "bad",
      events: "bad",
    },
  ]);

  const [task] = storage.readTasks();
  assert.equal(task.runtimeProfile, "python");
  assert.equal(task.workspaceMode, "local");
  assert.equal(task.reasoningMode, "reasoning");
  assert.deepEqual(plain(task.enabledTools), ["read", "command"]);
  assert.deepEqual(plain(task.reviewFiles), []);
  assert.deepEqual(plain(task.events), []);
});

test("endpoint settings round-trip secrets through safeStorage without writing plaintext", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-endpoint-"));
  const storage = loadStorage(userData);

  const saved = storage.writeModelEndpointSettings({
    mode: "server",
    software: "vllm",
    baseUrl: " https://veil.example.internal/ ",
    secret: "super-secret-token",
    headers: [
      { name: " X-Org ", value: "org-secret" },
      { name: "", value: "ignored" },
    ],
  });

  assert.equal(saved.mode, "server");
  assert.equal(saved.software, "vllm");
  assert.equal(saved.baseUrl, "https://veil.example.internal/");
  assert.equal(storage.readModelEndpointSettings().secret, "super-secret-token");
  assert.deepEqual(plain(storage.readModelEndpointSettings().headers), [
    { name: "X-Org", value: "org-secret" },
    { name: "", value: "ignored" },
  ]);

  const rawSettings = fs.readFileSync(path.join(userData, "settings.json"), "utf8");
  assert.doesNotMatch(rawSettings, /super-secret-token/);
  assert.doesNotMatch(rawSettings, /org-secret/);
});

test("tool, skill, harness, and notes settings sanitize invalid input", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-settings-"));
  const storage = loadStorage(userData);

  assert.equal(storage.writeHarnessProfileSetting("marketing"), "marketing");
  storage.writeJsonFile(path.join(userData, "settings.json"), { harnessProfile: "invalid" });
  assert.equal(storage.readHarnessProfileSetting(), "engineering");

  storage.writeJsonFile(path.join(userData, "settings.json"), {
    tools: { read: false, write: "no", debugger: true, nope: false },
    skills: { "good-skill": false, "../bad": true, also_good: true, bad: "yes" },
  });
  assert.equal(storage.readToolSettings().read, false);
  assert.equal(storage.readToolSettings().write, true);
  assert.equal(storage.readToolSettings().debugger, true);
  assert.deepEqual(plain(storage.readSkillSettings()), { "good-skill": false, also_good: true });

  const notes = storage.writeNotes("a".repeat(5));
  assert.equal(storage.readNotes().content, "aaaaa");
  assert.match(notes.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});
