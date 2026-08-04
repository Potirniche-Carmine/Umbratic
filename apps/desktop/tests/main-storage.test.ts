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
    UMBRATIC_MODEL_API_KEY: "",
    UMBRATIC_MODEL_BASE_URL: "",
    UMBRATIC_VEIL_BASE_URL: "",
    UMBRATIC_VEIL_TOKEN: "",
    VLLM_API_KEY: "",
  });
  return loadTypeScriptModule(storagePath, { cache: new Map(), mocks: { electron: electronMock(userData) } });
}

function appDbPath(userData) {
  return path.join(userData, "state", "umbratic.sqlite");
}

function projectDbPath(repo) {
  return path.join(repo, ".umbratic", "umbratic.sqlite");
}

function chatDbPath(userData) {
  return path.join(userData, "state", "chats.sqlite");
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
    { id: "repo", name: "Repo", rootPath: repo, kind: "git", originalBranch: "main", baseCommit: "abc", dirty: false, statusSummary: "clean" },
    { id: "missing", name: "Missing", rootPath: path.join(userData, "missing"), kind: "git", originalBranch: "main", baseCommit: "abc", dirty: false, statusSummary: "clean" },
  ]);
  assert.deepEqual(plain(storage.readProjects()).map((project) => project.id), ["repo"]);
  assert.equal(storage.readProjects()[0].kind, "git");

  storage.writeChats([
    {
      id: "chat-2",
      title: "Second",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
      modelEndpointMode: "server",
      attachedFiles: [{ path: "a.ts", name: "a.ts" }],
      worktreeRootTaskId: "task-root",
      worktreePath: path.join(userData, "worktree"),
      worktreeBranch: "umbratic/task-root-second",
      worktreeBaseCommit: "abcdef1234567890",
    },
    { id: "chat-1", title: "First", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", modelEndpointMode: "invalid", attachedFiles: [{ path: 1, name: "bad" }] },
    { title: "bad" },
  ]);
  const chats = storage.readChats();
  assert.deepEqual(plain(chats).map((chat) => chat.id), ["chat-2", "chat-1"]);
  assert.equal(chats[0].worktreeRootTaskId, "task-root");
  assert.equal(chats[0].worktreePath, path.resolve(userData, "worktree"));
  assert.equal(chats[0].worktreeBranch, "umbratic/task-root-second");
  assert.equal(chats[0].worktreeBaseCommit, "abcdef1234567890");
  assert.equal(chats[0].modelEndpointMode, "server");
  assert.equal(chats[1].modelEndpointMode, undefined);
  assert.deepEqual(plain(chats[1].attachedFiles), []);
  assert.equal(fs.existsSync(appDbPath(userData)), true);
  assert.equal(fs.existsSync(chatDbPath(userData)), true);
  assert.equal(fs.existsSync(path.join(userData, "projects.json")), false);
  assert.equal(fs.existsSync(path.join(userData, "chats.json")), false);
});

test("project chats are stored under the central data root", () => {
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

  const homeChats = readPayloads(chatDbPath(userData), "chats");
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

  assert.deepEqual(readPayloads(chatDbPath(userData), "chats").map((chat) => chat.id), [
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
  assert.deepEqual(new Set(readPayloads(chatDbPath(userData), "chats").map((chat) => chat.id)), new Set([
    "chat-new-project",
    "chat-project",
    "chat-global",
  ]));
});

test("tasks normalize current tool settings", () => {
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
    workspaceMode: "local",
    state: "running",
    originalBranch: "main",
    baseCommit: "abc",
    agentBranch: "",
    permissionMode: "auto_safe",
    reasoningMode: "reasoning",
    createdAt: "2026-01-01T00:00:00.000Z",
    changedFiles: [],
    enabledTools: ["read", "bogus", "command", "read"],
    reviewFiles: [],
    events: [],
  });

  const [task] = storage.readTasks();
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
    commitOid: "commit-1", treeOid: "tree-1", indexTreeOid: "index-tree-1", createdAt: "2026-01-01T00:01:00.000Z",
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
  assert.equal(storage.readTaskCheckpoints(task.id)[0].indexTreeOid, "index-tree-1");

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

test("endpoint settings round-trip secrets through safeStorage without writing plaintext", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-endpoint-"));
  const storage = loadStorage(userData);

  const saved = storage.writeModelEndpointSettings({
    mode: "server",
    baseUrl: " https://veil.example.internal/ ",
    secret: "super-secret-token",
    headers: [
      { name: " X-Org ", value: "org-secret" },
      { name: "", value: "ignored" },
    ],
  });

  assert.equal(saved.mode, "server");
  assert.equal(saved.baseUrl, "https://veil.example.internal/");
  assert.equal(storage.readModelEndpointSettings().secret, "super-secret-token");
  assert.deepEqual(plain(storage.readModelEndpointSettings().headers), [
    { name: "X-Org", value: "org-secret" },
    { name: "", value: "ignored" },
  ]);
  assert.deepEqual(plain(storage.publicModelEndpointSettings(storage.readModelEndpointSettings())), {
    mode: "server",
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
test("endpoint settings default to the local model runtime", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-endpoint-default-"));
  const storage = loadStorage(userData);

  assert.equal(storage.hasStoredModelEndpointSettings(), false);
  assert.equal(storage.readModelEndpointSettings().mode, "local");
  assert.equal(storage.readModelEndpointSettings().baseUrl, "http://127.0.0.1:11434");
  assert.equal(storage.readModelEndpointSettings().modelId, "");

  const savedLocal = storage.writeModelEndpointSettings({
    mode: "local",
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
  assert.deepEqual(
    Object.keys(rawSettings.modelEndpoint).sort(),
    ["baseUrl", "headers", "mode", "modelId", "secret"],
  );
  assert.doesNotMatch(JSON.stringify(rawSettings), /must-not-be-stored|also-not-stored/);
});

test("local model settings remain in SQLite after a switch to a company server", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-endpoint-modes-"));
  const storage = loadStorage(userData);

  storage.writeModelEndpointSettings({
    mode: "local",
    baseUrl: "http://127.0.0.1:11434",
    modelId: "qwen3:8b",
  });
  storage.writeModelEndpointSettings({
    mode: "server",
    baseUrl: "https://veil.example.internal",
    modelId: "veil-managed",
  });

  assert.equal(storage.readModelEndpointSettings().mode, "server");
  assert.deepEqual(plain(storage.readModelEndpointSettingsForMode("local")), {
    mode: "local",
    baseUrl: "http://127.0.0.1:11434",
    modelId: "qwen3:8b",
    secret: "",
    headers: [{ name: "", value: "" }, { name: "", value: "" }],
  });

  const rawSettings = JSON.parse(readSettingsPayloadText(userData));
  assert.equal(rawSettings.modelEndpoints.local.modelId, "qwen3:8b");
  assert.equal(rawSettings.modelEndpoints.server.baseUrl, "https://veil.example.internal");
});

test("local model discovery is cached in SQLite by normalized runtime URL", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-model-cache-"));
  const storage = loadStorage(userData);

  assert.deepEqual(plain(storage.readCachedLocalModels("http://127.0.0.1:11434")), []);
  assert.deepEqual(plain(storage.writeCachedLocalModels(
    "http://127.0.0.1:11434///",
    ["qwen3", " qwen3 ", "gemma3"],
  )), ["qwen3", "gemma3"]);
  assert.deepEqual(
    plain(storage.readCachedLocalModels("http://127.0.0.1:11434")),
    ["qwen3", "gemma3"],
  );

  const reloaded = loadStorage(userData);
  assert.deepEqual(
    plain(reloaded.readCachedLocalModels("http://127.0.0.1:11434/")),
    ["qwen3", "gemma3"],
  );
  assert.match(readSettingsPayloadText(userData), /"localModelCache"/);
});

test("an explicitly forced local configuration overrides a stored server endpoint for the session", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-endpoint-forced-local-"));
  loadStorage(userData).readModelEndpointSettings();
  writeSettingsPayload(userData, {
    modelEndpoint: {
      mode: "server",
      baseUrl: "https://veil.example.internal",
      modelId: "veil-managed",
      secret: "",
      headers: [],
    },
  });
  process.env.UMBRATIC_FORCE_LOCAL_ENDPOINT = "1";
  process.env.UMBRATIC_LOCAL_RUNTIME_BASE_URL = "http://127.0.0.1:11434";
  process.env.UMBRATIC_LOCAL_MODEL_ID = "gemma4:12b-it-q4_K_M";
  const storage = loadTypeScriptModule(storagePath, { cache: new Map(), mocks: { electron: electronMock(userData) } });

  assert.deepEqual(plain(storage.readModelEndpointSettings()), {
    mode: "local",
    baseUrl: "http://127.0.0.1:11434",
    modelId: "gemma4:12b-it-q4_K_M",
    secret: "",
    headers: [{ name: "", value: "" }, { name: "", value: "" }],
  });

  storage.writeModelEndpointSettings({
    mode: "local",
    baseUrl: "http://127.0.0.1:11500",
    modelId: "user-selected-model",
  });

  assert.deepEqual(plain(storage.readModelEndpointSettings()), {
    mode: "local",
    baseUrl: "http://127.0.0.1:11500",
    modelId: "user-selected-model",
    secret: "",
    headers: [{ name: "", value: "" }, { name: "", value: "" }],
  });
});

test("tool, skill, harness, permission, and notes settings sanitize invalid input", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-settings-"));
  const storage = loadStorage(userData);

  assert.equal(storage.writeHarnessProfileSetting("marketing"), "marketing");
  assert.equal(storage.readContextLengthSetting(), 64000);
  assert.equal(storage.writeContextLengthSetting(128000), 128000);
  assert.equal(storage.writeContextLengthSetting(999999), 256000);
  assert.equal(storage.readPermissionModeSetting(), "normal");
  assert.equal(storage.writePermissionModeSetting("auto_safe"), "auto_safe");
  assert.equal(loadStorage(userData).readPermissionModeSetting(), "auto_safe");
  writeSettingsPayload(userData, { harnessProfile: "invalid" });
  assert.equal(storage.readHarnessProfileSetting(), "engineering");
  assert.equal(storage.readPermissionModeSetting(), "normal");
  assert.equal(storage.writePermissionModeSetting("bypass"), "normal");
  assert.equal(storage.writePermissionModeSetting("invalid"), "normal");

  writeSettingsPayload(userData, {
    tools: { read: false, write: "no", unknownTool: true, nope: false },
    skills: { "good-skill": false, "../bad": true, also_good: true, bad: "yes" },
  });
  assert.equal(storage.readToolSettings().read, false);
  assert.equal(storage.readToolSettings().write, true);
  assert.equal(Object.hasOwn(storage.readToolSettings(), "unknownTool"), false);
  assert.deepEqual(plain(storage.readSkillSettings()), { "good-skill": false, also_good: true });

  const notes = storage.writeNotes("a".repeat(5));
  assert.equal(storage.readNotes().content, "aaaaa");
  assert.match(notes.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(fs.existsSync(path.join(userData, "notes.json")), false);
  assert.equal(fs.existsSync(path.join(userData, "settings.json")), false);
});

test("local diagnostics prune oldest rows after the entry budget", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-diagnostics-prune-"));
  const storage = loadStorage(userData);
  for (let index = 0; index < 2010; index += 1) {
    storage.appendLocalDiagnostic({
      level: "warn",
      source: "desktop",
      event: `event-${index}`,
      message: `warning ${index}`,
    });
  }
  const info = storage.readLocalDiagnosticInfo();
  assert.ok(info.entries <= 2000);
  assert.ok(info.entries >= 1990);
  const events = storage.readLocalDiagnostics().map((entry) => entry.event);
  assert.equal(events.includes("event-0"), false);
  assert.equal(events.includes("event-2009"), true);
});

test("each SQLite database has a 512 MiB page limit", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-database-limit-"));
  const originalExec = DatabaseSync.prototype.exec;
  const pageLimits = [];
  DatabaseSync.prototype.exec = function trackedExec(sql) {
    const match = String(sql).match(/PRAGMA max_page_count = (\d+)/);
    if (match) pageLimits.push(Number(match[1]));
    return originalExec.call(this, sql);
  };
  const storage = loadStorage(userData);
  try {
    storage.readProjects();
    storage.writeChat({
      id: "chat-limit",
      title: "Limit",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      attachedFiles: [],
    });
    assert.deepEqual(pageLimits, [131072, 131072]);
  } finally {
    DatabaseSync.prototype.exec = originalExec;
    storage.closeStorageDatabases();
  }
});

test("app and chat databases keep one process-lifetime handle", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-storage-lifetime-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-home-lifetime-"));
  const storage = loadStorage(userData, home);
  const task = (id, prompt) => ({
    id,
    repositoryId: "repo",
    chatId: "chat-lifetime",
    prompt,
    originalRepoPath: userData,
    worktreePath: userData,
    workspaceKind: "git",
    workspaceMode: "local",
    state: "completed",
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

  assert.equal(storage.retainedStorageDatabaseCount(), 0);

  storage.writeTask(task("task-lifetime", "hello"));
  assert.equal(storage.retainedStorageDatabaseCount(), 1);

  storage.writeTask(task("task-lifetime-2", "again"));
  assert.equal(storage.retainedStorageDatabaseCount(), 1, "repeated app writes must reuse the open handle");

  storage.writeChat({
    id: "chat-lifetime",
    title: "Lifetime",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    attachedFiles: [],
  });
  assert.equal(storage.retainedStorageDatabaseCount(), 2, "chat DB is a second retained handle");

  storage.writeChat({
    id: "chat-lifetime-2",
    title: "Lifetime two",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    attachedFiles: [],
  });
  assert.equal(storage.retainedStorageDatabaseCount(), 2);

  assert.equal(storage.readTasks().length, 2);
  assert.equal(storage.readChats().length, 2);

  storage.closeStorageDatabases();
  assert.equal(storage.retainedStorageDatabaseCount(), 0);

  assert.equal(storage.readTask("task-lifetime")?.prompt, "hello");
  assert.equal(storage.retainedStorageDatabaseCount(), 1, "reads reopen a retained handle after close");
  storage.closeStorageDatabases();
});

test("company device credentials keep the private key in safeStorage and expose only status", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-company-credential-"));
  const storage = loadStorage(userData);
  const credential = {
    baseUrl: "https://veil.example.com",
    orgUid: "org_enterprise",
    orgName: "Northwind",
    userUid: "usr_alice",
    deviceUid: "dev_laptop",
    deviceLabel: "Work laptop",
    publicKey: "public-key",
    privateKeyPkcs8: "private-key-material",
  };
  storage.writeCompanyDeviceCredential(credential);
  assert.deepEqual(plain(storage.readCompanyDeviceCredential()), credential);
  assert.deepEqual(plain(storage.companyConnectionStatus()), {
    state: "enrolled",
    baseUrl: credential.baseUrl,
    orgName: credential.orgName,
    deviceLabel: credential.deviceLabel,
  });
  assert.doesNotMatch(readSettingsPayloadText(userData), /private-key-material/);
  assert.equal(storage.readStartupSettings().companyConnection.state, "enrolled");
  storage.clearCompanyDeviceCredential();
  assert.deepEqual(plain(storage.companyConnectionStatus()), { state: "not_enrolled" });
});

test("current SQLite schemas do not repeat schema DDL on retained handles", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-storage-schema-"));
  const storage = loadStorage(userData);
  const originalExec = DatabaseSync.prototype.exec;
  let schemaSetupCount = 0;
  DatabaseSync.prototype.exec = function trackedExec(sql) {
    if (String(sql).includes("CREATE TABLE IF NOT EXISTS projects")) {
      schemaSetupCount += 1;
    }
    return originalExec.call(this, sql);
  };

  try {
    storage.readProjects();
    storage.readTasks();
    storage.readModelEndpointSettings();
    assert.equal(schemaSetupCount, 1);
  } finally {
    DatabaseSync.prototype.exec = originalExec;
    storage.closeStorageDatabases();
  }
});

test("startup settings use one SQLite settings-row read", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-desktop-startup-settings-"));
  const storage = loadStorage(userData);
  storage.writeHarnessProfileSetting("sales");
  storage.writeContextLengthSetting(128000);
  storage.writePermissionModeSetting("auto_safe");
  const originalPrepare = DatabaseSync.prototype.prepare;
  let settingsReads = 0;
  DatabaseSync.prototype.prepare = function trackedPrepare(sql) {
    if (String(sql).includes("SELECT payload FROM settings WHERE key")) settingsReads += 1;
    return originalPrepare.call(this, sql);
  };

  try {
    const settings = storage.readStartupSettings();
    assert.equal(settings.permissionMode, "auto_safe");
    assert.equal(settings.harnessProfile, "sales");
    assert.equal(settings.contextLength, 128000);
    assert.equal(settings.modelEndpoint.mode, "local");
    assert.equal(settingsReads, 1);
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    storage.closeStorageDatabases();
  }
});
