import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

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

function loadStorage(userData, home = userData) {
  setEnv({
    HOME: home,
    OLLAMA_BASE_URL: "",
    OLLAMA_API_KEY: "",
    USERPROFILE: home,
    UMBRATIC_ALLOW_ENDPOINT_EDIT: "true",
    UMBRATIC_FORCE_LOCAL_ENDPOINT: undefined,
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

function chatDbPath(home) {
  return path.join(home, ".umbratic", "chats", "umbratic.sqlite");
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

function insertLegacyChatPayload(filePath, chat, position = 0) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  withDb(filePath, (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        repository_path TEXT,
        payload TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.prepare(
      "INSERT OR REPLACE INTO chats (id, title, created_at, updated_at, repository_path, payload, position) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(chat.id, chat.title, chat.createdAt, chat.updatedAt, chat.repositoryPath ?? null, JSON.stringify(chat), position);
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
  assert.equal(fs.existsSync(chatDbPath(userData)), true);
  assert.equal(fs.existsSync(path.join(userData, "projects.json")), false);
  assert.equal(fs.existsSync(path.join(userData, "chats.json")), false);
});

test("project chats are stored under the home chat database", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-project-chats-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-home-project-chats-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-repo-"));
  const storage = loadStorage(userData, home);
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

  const homeChats = readPayloads(chatDbPath(home), "chats");
  assert.deepEqual(homeChats.map((chat) => chat.id), ["chat-project", "chat-global"]);
  assert.deepEqual(plain(storage.readChats()).map((chat) => chat.id), ["chat-project", "chat-global"]);
  assert.equal(fs.existsSync(projectDbPath(repo)), false);
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

  assert.deepEqual(readPayloads(chatDbPath(home), "chats").map((chat) => chat.id), [
    "chat-new-project",
    "chat-project",
    "chat-global",
  ]);
  assert.equal(fs.existsSync(projectDbPath(repo)), false);

  storage.writeChat({
    ...storage.readChat("chat-global"),
    draftPrompt: "updated global draft",
    updatedAt: "2026-01-05T00:00:00.000Z",
  });
  assert.equal(storage.readChat("chat-global").draftPrompt, "updated global draft");
  assert.deepEqual(new Set(readPayloads(chatDbPath(home), "chats").map((chat) => chat.id)), new Set([
    "chat-new-project",
    "chat-project",
    "chat-global",
  ]));
});

test("legacy project chat databases migrate once into the home chat database", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-legacy-project-chats-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-home-legacy-project-chats-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-repo-"));
  const storage = loadStorage(userData, home);
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
  insertLegacyChatPayload(projectDbPath(repo), {
    id: "chat-legacy-project",
    title: "Legacy project chat",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-03T00:00:00.000Z",
    repositoryPath: repo,
    draftPrompt: "legacy draft",
    attachedFiles: [],
  });

  assert.equal(fs.existsSync(chatDbPath(home)), false);
  assert.deepEqual(plain(storage.readChats()).map((chat) => chat.id), ["chat-legacy-project"]);
  assert.deepEqual(readPayloads(chatDbPath(home), "chats").map((chat) => chat.id), ["chat-legacy-project"]);

  storage.writeChats([]);
  assert.deepEqual(plain(storage.readChats()).map((chat) => chat.id), []);
});

test("tasks drop legacy runtime profiles and normalize tool settings and event defaults", () => {
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
    permissionMode: "bypass",
    createdAt: "2026-01-01T00:00:00.000Z",
    changedFiles: [],
    enabledTools: ["read", "bogus", "command", "read"],
    reviewFiles: "bad",
    events: "bad",
  });

  const [task] = storage.readTasks();
  assert.equal("runtimeProfile" in task, false);
  assert.equal(task.workspaceMode, "local");
  assert.equal(task.reasoningMode, "reasoning");
  assert.equal(task.permissionMode, "auto_safe");
  assert.deepEqual(plain(task.enabledTools), ["read", "command"]);
  assert.deepEqual(plain(task.reviewFiles), []);
  assert.deepEqual(plain(task.events), []);
  assert.equal(fs.existsSync(path.join(userData, "tasks.json")), false);
});

test("single-task writes update payloads without rewriting or reordering unrelated tasks", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-task-upsert-"));
  const storage = loadStorage(userData);
  const task = (id, prompt) => ({
    id,
    repositoryId: "repo",
    prompt,
    originalRepoPath: userData,
    worktreePath: userData,
    workspaceKind: "git",
    workspaceMode: "local",
    state: "running",
    originalBranch: "main",
    baseCommit: "abc",
    agentBranch: "",
    permissionMode: "normal",
    reasoningMode: "reasoning",
    createdAt: "2026-01-01T00:00:00.000Z",
    changedFiles: [],
    reviewFiles: [],
    events: [],
  });
  const first = task("task-1", "first");
  const second = task("task-2", "second");
  storage.writeTasks([first, second]);

  storage.writeTask({ ...second, state: "completed" });
  assert.deepEqual(plain(storage.readTasks()).map((row) => [row.id, row.state]), [
    ["task-2", "completed"],
    ["task-1", "running"],
  ]);

  storage.writeTask({ ...first, state: "failed" }, false);
  assert.deepEqual(plain(storage.readTasks()).map((row) => [row.id, row.state]), [
    ["task-2", "completed"],
    ["task-1", "failed"],
  ]);
  assert.equal(storage.readTask("task-1").state, "failed");
  assert.equal(storage.readTask("missing"), null);
});

test("checkpoint metadata persists and workspace activation switches the task atomically", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-workspace-switch-"));
  const storage = loadStorage(userData);
  const task = {
    id: "task-checkpoint",
    repositoryId: "repo",
    prompt: "checkpoint task",
    originalRepoPath: userData,
    worktreePath: path.join(userData, "worktree-1"),
    workspaceKind: "git",
    workspaceMode: "worktree",
    state: "completed",
    originalBranch: "main",
    baseCommit: "base",
    agentBranch: "umbratic/task-checkpoint",
    permissionMode: "normal",
    reasoningMode: "reasoning",
    createdAt: "2026-01-01T00:00:00.000Z",
    changedFiles: ["tracked.txt"],
    reviewFiles: [],
    events: [],
    activeWorkspaceId: "workspace-1",
  };
  storage.writeTask(task, false);
  storage.writeTaskWorkspace({
    id: "workspace-1", taskId: task.id, number: 1, branch: task.agentBranch,
    path: task.worktreePath, createdAt: task.createdAt, state: "active",
  });
  const checkpoint = {
    id: "checkpoint-1", taskId: task.id, workspaceId: "workspace-1", source: "manual",
    commitOid: "commit-1", treeOid: "tree-1", createdAt: "2026-01-01T00:01:00.000Z",
    state: "ready", pinned: true, logicalBytes: 42,
  };
  storage.completeTaskCheckpoint({ ...task, latestCheckpointId: checkpoint.id }, checkpoint);
  assert.equal(storage.readTask(task.id).latestCheckpointId, checkpoint.id);

  const replacement = {
    id: "workspace-2", taskId: task.id, number: 2, branch: "umbratic/task-checkpoint-restore-2",
    path: path.join(userData, "worktree-2"), sourceCheckpointId: "checkpoint-1",
    createdAt: "2026-01-01T00:02:00.000Z", state: "active",
  };
  storage.activateTaskWorkspace(
    { ...task, activeWorkspaceId: replacement.id, worktreePath: replacement.path, agentBranch: replacement.branch },
    replacement,
    { ...storage.readTaskWorkspaces(task.id)[0], state: "recovery" },
  );
  assert.equal(storage.readTask(task.id).activeWorkspaceId, "workspace-2");
  assert.deepEqual(plain(storage.readTaskWorkspaces(task.id)).map((workspace) => [workspace.id, workspace.state]), [
    ["workspace-2", "active"],
    ["workspace-1", "recovery"],
  ]);
  assert.equal(storage.readTaskCheckpoints(task.id)[0].logicalBytes, 42);

  assert.throws(() => storage.activateTaskWorkspace(
    { ...storage.readTask(task.id), activeWorkspaceId: "workspace-3" },
    { ...replacement, id: "workspace-3", number: 3, path: path.join(userData, "worktree-3"), sourceCheckpointId: "missing" },
  ));
  assert.equal(storage.readTask(task.id).activeWorkspaceId, "workspace-2");
  assert.equal(storage.readTaskWorkspaces(task.id).some((workspace) => workspace.id === "workspace-3"), false);
});

test("local diagnostics report logical size, exportable records, and clear independently of product telemetry", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-diagnostics-"));
  const storage = loadStorage(userData);

  storage.appendLocalDiagnostic({
    at: "2026-01-01T00:00:00.000Z",
    level: "info",
    source: "desktop",
    event: "permission.requested",
    taskId: "task-1",
    data: { kind: "edit" },
  });
  storage.appendLocalDiagnostic({
    at: "2026-01-01T00:00:00.000Z",
    level: "error",
    source: "desktop",
    event: "tool.failed",
    taskId: "task-1",
    message: "Edit failed.",
    data: { errorCode: "invalid_arguments" },
  });
  storage.writeProductTelemetryEvent({
    id: "event-1",
    type: "review.opened",
    at: "2026-01-01T00:00:01.000Z",
    taskId: "task-1",
    repositoryId: "repo-1",
    data: { scope: "task" },
  });

  const info = storage.readLocalDiagnosticInfo();
  assert.equal(info.entries, 1);
  assert.ok(info.bytes > 0);
  assert.deepEqual(plain(storage.readLocalDiagnostics()), [{
    id: 1,
    at: "2026-01-01T00:00:00.000Z",
    level: "error",
    source: "desktop",
    event: "tool.failed",
    taskId: "task-1",
    message: "Edit failed.",
    data: { errorCode: "invalid_arguments" },
  }]);
  assert.deepEqual(plain(storage.readProductTelemetryEvents()).map((event) => event.id), ["event-1"]);

  assert.deepEqual(plain(storage.clearLocalDiagnostics()), { bytes: 0, entries: 0 });
  assert.deepEqual(plain(storage.readLocalDiagnostics()), []);
  assert.deepEqual(plain(storage.readProductTelemetryEvents()).map((event) => event.id), ["event-1"]);
});

test("local diagnostics migration removes previously stored debug and info records", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-diagnostics-migration-"));
  const storage = loadStorage(userData);

  storage.appendLocalDiagnostic({
    level: "warn",
    source: "desktop",
    event: "command.finished",
    message: "Command failed.",
  });
  withDb(appDbPath(userData), (db) => {
    db.prepare(`
      INSERT INTO diagnostic_logs (at, level, source, event, task_id, message, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("2026-01-01T00:00:00.000Z", "info", "desktop", "permission.requested", null, null, "{}");
    db.exec("PRAGMA user_version = 2;");
  });

  assert.deepEqual(plain(storage.readLocalDiagnostics()).map((entry) => entry.level), ["warn"]);
  assert.equal(withDb(appDbPath(userData), (db) => db.prepare("PRAGMA user_version").get().user_version), 4);
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
  assert.deepEqual(plain(storage.publicModelEndpointSettings(storage.readModelEndpointSettings())), {
    mode: "server",
    software: "vllm",
    baseUrl: "https://veil.example.internal/",
    modelId: "veil-managed",
    secret: "",
    secretConfigured: true,
    headers: [
      { name: "X-Org", value: "", valueConfigured: true },
      { name: "", value: "", valueConfigured: true },
    ],
  });

  const rawSettings = readSettingsPayloadText(userData);
  assert.doesNotMatch(rawSettings, /super-secret-token/);
  assert.doesNotMatch(rawSettings, /org-secret/);
  assert.equal(fs.existsSync(path.join(userData, "settings.json")), false);
});
test("endpoint settings default to local and migrate the old local Veil URL semantics", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-endpoint-default-"));
  const storage = loadStorage(userData);

  assert.equal(storage.hasStoredModelEndpointSettings(), false);
  assert.equal(storage.readModelEndpointSettings().mode, "local");
  assert.equal(storage.readModelEndpointSettings().software, "ollama");
  assert.equal(storage.readModelEndpointSettings().baseUrl, "http://127.0.0.1:11434");
  assert.equal(storage.readModelEndpointSettings().modelId, "");

  writeSettingsPayload(userData, {
    modelEndpoint: {
      mode: "local",
      software: "ollama",
      baseUrl: "http://127.0.0.1:8080",
      modelId: "veil-managed",
      secret: "",
      headers: [
        { name: "", value: "" },
        { name: "", value: "" },
      ],
    },
  });
  assert.equal(storage.hasStoredModelEndpointSettings(), true);
  assert.equal(storage.readModelEndpointSettings().mode, "local");
  assert.equal(storage.readModelEndpointSettings().baseUrl, "http://127.0.0.1:11434");
  assert.equal(storage.readModelEndpointSettings().modelId, "");

  const savedLocal = storage.writeModelEndpointSettings({
    mode: "local",
    software: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    modelId: "llama3.2",
    secret: "must-not-be-stored",
    headers: [{ name: "X-Ignored", value: "also-not-stored" }],
  });
  assert.equal(savedLocal.mode, "local");
  assert.equal(savedLocal.modelId, "llama3.2");
  assert.equal(savedLocal.secret, "");
  assert.deepEqual(plain(savedLocal.headers), [{ name: "", value: "" }, { name: "", value: "" }]);
  assert.equal(storage.hasStoredModelEndpointSettings(), true);
  assert.equal(storage.readModelEndpointSettings().mode, "local");

  const rawSettings = JSON.parse(readSettingsPayloadText(userData));
  assert.equal(rawSettings.modelEndpoint.version, 3);
  assert.doesNotMatch(JSON.stringify(rawSettings), /must-not-be-stored|also-not-stored/);
});

test("an explicitly forced local configuration overrides a stored server endpoint for the session", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-endpoint-forced-local-"));
  loadStorage(userData).readModelEndpointSettings();
  writeSettingsPayload(userData, {
    modelEndpoint: {
      version: 3,
      mode: "server",
      software: "vllm",
      baseUrl: "https://veil.example.internal",
      modelId: "veil-managed",
      secret: "",
      headers: [],
    },
  });
  process.env.UMBRATIC_FORCE_LOCAL_ENDPOINT = "1";
  process.env.UMBRATIC_LOCAL_RUNTIME_BASE_URL = "http://127.0.0.1:11434";
  process.env.UMBRATIC_LOCAL_MODEL_ID = "gemma4:12b-it-q4_K_M";
  process.env.UMBRATIC_MODEL_SOFTWARE = "ollama";
  const storage = loadTypeScriptModule(storagePath, { cache: new Map(), mocks: { electron: electronMock(userData) } });

  assert.deepEqual(plain(storage.readModelEndpointSettings()), {
    mode: "local",
    software: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    modelId: "gemma4:12b-it-q4_K_M",
    secret: "",
    headers: [{ name: "", value: "" }, { name: "", value: "" }],
  });

  storage.writeModelEndpointSettings({
    mode: "local",
    software: "vllm",
    baseUrl: "http://127.0.0.1:8000/v1",
    modelId: "user-selected-model",
  });

  assert.deepEqual(plain(storage.readModelEndpointSettings()), {
    mode: "local",
    software: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    modelId: "user-selected-model",
    secret: "",
    headers: [{ name: "", value: "" }, { name: "", value: "" }],
  });
});

test("tool, skill, harness, and notes settings sanitize invalid input", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-settings-"));
  const storage = loadStorage(userData);

  assert.equal(storage.writeHarnessProfileSetting("marketing"), "marketing");
  assert.equal(storage.readContextLengthSetting(), 64000);
  assert.equal(storage.writeContextLengthSetting(128000), 128000);
  assert.equal(storage.writeContextLengthSetting(999999), 256000);
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
