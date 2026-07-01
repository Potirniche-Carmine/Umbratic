import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

function appDbPath(userData) {
  return path.join(userData, "umbratic.sqlite");
}

function projectDbPath(repo) {
  return path.join(repo, ".umbratic", "umbratic.sqlite");
}

function withDb(filePath, action) {
  const db = new DatabaseSync(filePath);
  try {
    return action(db);
  } finally {
    db.close();
  }
}

function readPayloads(filePath, tableName) {
  return withDb(filePath, (db) =>
    db
      .prepare(`SELECT payload FROM ${tableName} ORDER BY position ASC`)
      .all()
      .map((row) => JSON.parse(row.payload)),
  );
}

function writeSettingsPayload(userData, payload) {
  withDb(appDbPath(userData), (db) => {
    db.prepare("INSERT OR REPLACE INTO settings (key, payload) VALUES (?, ?)").run("app", JSON.stringify(payload));
  });
}

function readSettingsPayloadText(userData) {
  return withDb(appDbPath(userData), (db) => db.prepare("SELECT payload FROM settings WHERE key = ?").get("app").payload);
}

function insertTaskPayload(userData, task) {
  withDb(appDbPath(userData), (db) => {
    db.prepare(
      "INSERT INTO tasks (id, repository_id, state, created_at, payload, position) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(task.id, task.repositoryId ?? "", task.state ?? "", task.createdAt ?? "", JSON.stringify(task), 0);
  });
}

test("projects and chats are normalized from SQLite storage", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-storage-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-repo-"));
  const storage = loadStorage(userData);

  storage.writeProjects([
    { id: "repo", name: "Repo", rootPath: repo, originalBranch: "main", baseCommit: "abc", dirty: false, statusSummary: "clean" },
    { id: "missing", name: "Missing", rootPath: path.join(userData, "missing"), originalBranch: "main", baseCommit: "abc", dirty: false, statusSummary: "clean" },
  ]);
  assert.deepEqual(plain(storage.readProjects()).map((project) => project.id), ["repo"]);
  assert.equal(storage.readProjects()[0].kind, "git");

  storage.writeChats([
    {
      id: "chat-2",
      title: "Second",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
      attachedFiles: [{ path: "a.ts", name: "a.ts" }],
      worktreeRootTaskId: "task-root",
      worktreePath: path.join(userData, "worktree"),
      worktreeBranch: "umbratic/task-root-second",
      worktreeBaseCommit: "abcdef1234567890",
    },
    { id: "chat-1", title: "First", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", attachedFiles: [{ path: 1, name: "bad" }] },
    { title: "bad" },
  ]);
  const chats = storage.readChats();
  assert.deepEqual(plain(chats).map((chat) => chat.id), ["chat-2", "chat-1"]);
  assert.equal(chats[0].worktreeRootTaskId, "task-root");
  assert.equal(chats[0].worktreePath, path.resolve(userData, "worktree"));
  assert.equal(chats[0].worktreeBranch, "umbratic/task-root-second");
  assert.equal(chats[0].worktreeBaseCommit, "abcdef1234567890");
  assert.deepEqual(plain(chats[1].attachedFiles), []);
  assert.equal(fs.existsSync(appDbPath(userData)), true);
  assert.equal(fs.existsSync(path.join(userData, "projects.json")), false);
  assert.equal(fs.existsSync(path.join(userData, "chats.json")), false);
});

test("project chats are stored under the project's .umbratic directory", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-project-chats-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-repo-"));
  const storage = loadStorage(userData);
  const project = {
    id: "repo",
    name: "Repo",
    rootPath: repo,
    kind: "git",
    originalBranch: "main",
    baseCommit: "abc",
    dirty: false,
    statusSummary: "clean",
  };
  storage.writeProjects([project]);

  storage.writeChats([
    {
      id: "chat-project",
      title: "Project chat",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
      repositoryName: "Repo",
      repositoryPath: repo,
      draftPrompt: "project draft",
      attachedFiles: [],
    },
    {
      id: "chat-global",
      title: "Global chat",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      draftPrompt: "global draft",
      attachedFiles: [],
    },
  ]);

  const appChats = readPayloads(appDbPath(userData), "chats");
  assert.deepEqual(appChats.map((chat) => chat.id), ["chat-global"]);
  const projectChats = readPayloads(projectDbPath(repo), "chats");
  assert.deepEqual(projectChats.map((chat) => chat.id), ["chat-project"]);
  assert.deepEqual(plain(storage.readChats()).map((chat) => chat.id), ["chat-project", "chat-global"]);
  assert.equal(fs.existsSync(path.join(repo, ".umbratic", "chats.json")), false);

  storage.writeChats([
    ...storage.readChats(),
    {
      id: "chat-new-project",
      title: "New project chat",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-04T00:00:00.000Z",
      repositoryPath: repo,
      draftPrompt: "new draft",
      attachedFiles: [],
    },
  ]);

  assert.deepEqual(readPayloads(appDbPath(userData), "chats").map((chat) => chat.id), ["chat-global"]);
  assert.deepEqual(readPayloads(projectDbPath(repo), "chats").map((chat) => chat.id), ["chat-new-project", "chat-project"]);
});

test("tasks normalize stored records with runtime profile, tool settings, and event defaults", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-tasks-"));
  const storage = loadStorage(userData);

  storage.readTasks();
  insertTaskPayload(userData, {
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
  });

  const [task] = storage.readTasks();
  assert.equal(task.runtimeProfile, "python");
  assert.equal(task.workspaceMode, "local");
  assert.equal(task.reasoningMode, "reasoning");
  assert.deepEqual(plain(task.enabledTools), ["read", "command"]);
  assert.deepEqual(plain(task.reviewFiles), []);
  assert.deepEqual(plain(task.events), []);
  assert.equal(fs.existsSync(path.join(userData, "tasks.json")), false);
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

  const rawSettings = readSettingsPayloadText(userData);
  assert.doesNotMatch(rawSettings, /super-secret-token/);
  assert.doesNotMatch(rawSettings, /org-secret/);
  assert.equal(fs.existsSync(path.join(userData, "settings.json")), false);
});

test("tool, skill, harness, and notes settings sanitize invalid input", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-settings-"));
  const storage = loadStorage(userData);

  assert.equal(storage.writeHarnessProfileSetting("marketing"), "marketing");
  writeSettingsPayload(userData, { harnessProfile: "invalid" });
  assert.equal(storage.readHarnessProfileSetting(), "engineering");

  writeSettingsPayload(userData, {
    tools: { read: false, write: "no", legacyTool: true, nope: false },
    skills: { "good-skill": false, "../bad": true, also_good: true, bad: "yes" },
  });
  assert.equal(storage.readToolSettings().read, false);
  assert.equal(storage.readToolSettings().write, true);
  assert.equal(Object.hasOwn(storage.readToolSettings(), "legacyTool"), false);
  assert.deepEqual(plain(storage.readSkillSettings()), { "good-skill": false, also_good: true });

  const notes = storage.writeNotes("a".repeat(5));
  assert.equal(storage.readNotes().content, "aaaaa");
  assert.match(notes.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(fs.existsSync(path.join(userData, "notes.json")), false);
  assert.equal(fs.existsSync(path.join(userData, "settings.json")), false);
});
