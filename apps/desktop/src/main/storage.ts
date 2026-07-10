import { app, safeStorage } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  defaultEndpointApiKey,
  defaultEndpointBaseUrlForSoftware,
  defaultEndpointModelId,
  defaultEndpointSoftware,
  defaultHarnessProfileId,
  defaultLocalModelId,
  defaultModelEndpointMode,
  endpointEditingAllowed,
  isHarnessProfileId,
  isModelEndpointMode,
  isModelEndpointSoftware,
  managedModelEndpointDefaults,
} from "./config";
import { umbraticPolicyVersion, umbraticRunnerName, umbraticRunnerVersion } from "./policy";
import { defaultToolSettings, enabledToolsFromSettings, isRunnerToolId, toolSettingsFromEnabledTools } from "./toolSettings";
import type {
  CapabilityProbeCategory,
  CapabilityProbeImportance,
  CapabilityProbeStatus,
  CapabilityTelemetryProbe,
  ChatRecord,
  HarnessProfileId,
  LocalProviderId,
  ModelEndpointMode,
  ModelEndpointSettings,
  RepositoryInfo,
  RunnerToolId,
  TaskRecord,
  UserNotes,
} from "./types";

function dataFile(name: string): string {
  return path.join(app.getPath("userData"), name);
}

function appDatabasePath(): string {
  return dataFile("umbratic.sqlite");
}

function chatsDatabasePath(): string {
  return path.join(os.homedir(), ".umbratic", "chats", "umbratic.sqlite");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function writeJsonFile(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

type PayloadRow = {
  payload: string;
};

type RecordTableName = "projects" | "tasks" | "chats";

function withStorageDatabase<T>(filePath: string, action: (db: DatabaseSync) => T): T {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    ensureStorageSchema(db);
    return action(db);
  } finally {
    db.close();
  }
}

function withAppDatabase<T>(action: (db: DatabaseSync) => T): T {
  return withStorageDatabase(appDatabasePath(), action);
}

function ensureStorageSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      original_branch TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      dirty INTEGER NOT NULL,
      status_summary TEXT NOT NULL,
      payload TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY NOT NULL,
      repository_id TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      payload TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      repository_path TEXT,
      payload TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY NOT NULL,
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY NOT NULL,
      content TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS chats_updated_at_index ON chats(updated_at DESC);
    CREATE INDEX IF NOT EXISTS chats_repository_path_index ON chats(repository_path);
    CREATE INDEX IF NOT EXISTS tasks_created_at_index ON tasks(created_at DESC);
    CREATE INDEX IF NOT EXISTS tasks_repository_id_index ON tasks(repository_id);
    PRAGMA user_version = 1;
  `);
}

function runTransaction(db: DatabaseSync, action: () => void) {
  db.exec("BEGIN IMMEDIATE;");
  try {
    action();
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

function parsePayload(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function readPayloads(db: DatabaseSync, tableName: RecordTableName): unknown[] {
  const orderBy = tableName === "chats" ? "updated_at DESC, position ASC" : "position ASC";
  return (db.prepare(`SELECT payload FROM ${tableName} ORDER BY ${orderBy}`).all() as PayloadRow[]).map((row) =>
    parsePayload(row.payload),
  );
}

function normalizeProjectRecord(project: unknown): RepositoryInfo | null {
  if (
    !isRecord(project) ||
    typeof project.id !== "string" ||
    typeof project.name !== "string" ||
    typeof project.rootPath !== "string" ||
    typeof project.originalBranch !== "string" ||
    typeof project.baseCommit !== "string" ||
    typeof project.dirty !== "boolean" ||
    typeof project.statusSummary !== "string" ||
    !fs.existsSync(project.rootPath)
  ) {
    return null;
  }
  const kind = project.kind === "folder" || project.kind === "git" || project.kind === undefined ? (project.kind ?? "git") : null;
  if (!kind) return null;
  return {
    ...(project as RepositoryInfo),
    kind,
  };
}

function normalizeProjects(projects: unknown[]): RepositoryInfo[] {
  return projects
    .map((project) => normalizeProjectRecord(project))
    .filter((project): project is RepositoryInfo => !!project);
}

function replaceProjectsInDatabase(db: DatabaseSync, projects: RepositoryInfo[]) {
  runTransaction(db, () => {
    db.prepare("DELETE FROM projects").run();
    const insert = db.prepare(`
      INSERT INTO projects (
        id,
        name,
        root_path,
        kind,
        original_branch,
        base_commit,
        dirty,
        status_summary,
        payload,
        position
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    projects.forEach((project, index) => {
      insert.run(
        project.id,
        project.name,
        project.rootPath,
        project.kind,
        project.originalBranch,
        project.baseCommit,
        project.dirty ? 1 : 0,
        project.statusSummary,
        JSON.stringify(project),
        index,
      );
    });
  });
}

export function readProjects(): RepositoryInfo[] {
  return withAppDatabase((db) => normalizeProjects(readPayloads(db, "projects")));
}

export function writeProjects(projects: RepositoryInfo[]) {
  withAppDatabase((db) => replaceProjectsInDatabase(db, normalizeProjects(projects)));
}

function normalizeStoredEnabledTools(value: unknown): RunnerToolId[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<RunnerToolId>();
  for (const item of value) {
    if (isRunnerToolId(item)) seen.add(item);
  }
  return Array.from(seen);
}

function isCapabilityProbeStatus(value: unknown): value is CapabilityProbeStatus {
  return value === "available" || value === "missing" || value === "error" || value === "unknown";
}

function isCapabilityProbeCategory(value: unknown): value is CapabilityProbeCategory {
  return value === "required" || value === "recommended" || value === "optional-engineering" || value === "optional-artifacts";
}

function isCapabilityProbeImportance(value: unknown): value is CapabilityProbeImportance {
  return value === "required" || value === "recommended" || value === "optional";
}

function normalizeStoredCapabilityProbes(value: unknown): CapabilityTelemetryProbe[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const probes: CapabilityTelemetryProbe[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (
      typeof item.id !== "string" ||
      !item.id ||
      !isCapabilityProbeStatus(item.status) ||
      !isCapabilityProbeCategory(item.category) ||
      !isCapabilityProbeImportance(item.importance)
    ) {
      continue;
    }
    const workflows = Array.isArray(item.workflows)
      ? item.workflows.filter((workflow): workflow is string => typeof workflow === "string" && workflow.trim().length > 0).slice(0, 12)
      : [];
    probes.push({
      id: item.id.slice(0, 96),
      status: item.status,
      category: item.category,
      importance: item.importance,
      workflows,
      versionFamily: typeof item.versionFamily === "string" && item.versionFamily ? item.versionFamily.slice(0, 48) : undefined,
      affectedCurrentRun: item.affectedCurrentRun === true ? true : undefined,
    });
  }
  return probes;
}

function normalizeTaskRecord(task: unknown): TaskRecord | null {
  if (
    !isRecord(task) ||
    typeof task.id !== "string" ||
    typeof task.originalRepoPath !== "string" ||
    typeof task.worktreePath !== "string"
  ) {
    return null;
  }
  const { runtimeProfile: _legacyRuntimeProfile, ...storedTask } = task;
  void _legacyRuntimeProfile;
  return {
    ...(storedTask as TaskRecord),
    workspaceKind: task.workspaceKind === "folder" ? "folder" : "git",
    workspaceMode: task.workspaceMode === "worktree" || (typeof task.agentBranch === "string" && task.agentBranch) ? "worktree" : "local",
    reasoningMode: task.reasoningMode === "fast" ? "fast" : "reasoning",
    runnerName: typeof task.runnerName === "string" && task.runnerName ? task.runnerName : umbraticRunnerName,
    runnerVersion: typeof task.runnerVersion === "string" && task.runnerVersion ? task.runnerVersion : umbraticRunnerVersion,
    policyVersion: typeof task.policyVersion === "string" && task.policyVersion ? task.policyVersion : umbraticPolicyVersion,
    enabledTools: normalizeStoredEnabledTools(task.enabledTools) ?? enabledToolsFromSettings(defaultToolSettings()),
    capabilityProbes: normalizeStoredCapabilityProbes(task.capabilityProbes),
    reviewFiles: Array.isArray(task.reviewFiles) ? (task.reviewFiles as TaskRecord["reviewFiles"]) : [],
    events: Array.isArray(task.events) ? (task.events as TaskRecord["events"]) : [],
  };
}

function normalizeTasks(tasks: unknown[]): TaskRecord[] {
  return tasks
    .map((task) => normalizeTaskRecord(task))
    .filter((task): task is TaskRecord => !!task);
}

function replaceTasksInDatabase(db: DatabaseSync, tasks: TaskRecord[]) {
  runTransaction(db, () => {
    db.prepare("DELETE FROM tasks").run();
    const insert = db.prepare(`
      INSERT INTO tasks (
        id,
        repository_id,
        state,
        created_at,
        payload,
        position
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    tasks.forEach((task, index) => {
      insert.run(
        task.id,
        typeof task.repositoryId === "string" ? task.repositoryId : "",
        typeof task.state === "string" ? task.state : "",
        typeof task.createdAt === "string" ? task.createdAt : "",
        JSON.stringify(task),
        index,
      );
    });
  });
}

export function readTasks(): TaskRecord[] {
  return withAppDatabase((db) => normalizeTasks(readPayloads(db, "tasks")));
}

export function writeTasks(tasks: TaskRecord[]) {
  withAppDatabase((db) => replaceTasksInDatabase(db, normalizeTasks(tasks)));
}

function pathKey(pathValue: string): string {
  const resolved = path.resolve(pathValue);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizeChatRecord(chat: unknown): ChatRecord | null {
  if (
    !isRecord(chat) ||
    typeof chat.id !== "string" ||
    typeof chat.title !== "string" ||
    typeof chat.createdAt !== "string" ||
    typeof chat.updatedAt !== "string"
  ) {
    return null;
  }
  const repositoryPath =
    typeof chat.repositoryPath === "string" && chat.repositoryPath.trim()
      ? path.resolve(chat.repositoryPath)
      : undefined;
  const worktreePath =
    typeof chat.worktreePath === "string" && chat.worktreePath.trim()
      ? path.resolve(chat.worktreePath)
      : undefined;
  return {
    ...chat,
    repositoryName:
      typeof chat.repositoryName === "string" && chat.repositoryName.trim()
        ? chat.repositoryName.trim().slice(0, 120)
        : undefined,
    repositoryPath,
    worktreeRootTaskId:
      typeof chat.worktreeRootTaskId === "string" && /^task-[A-Za-z0-9_-]+$/.test(chat.worktreeRootTaskId)
        ? chat.worktreeRootTaskId
        : undefined,
    worktreePath,
    worktreeBranch:
      typeof chat.worktreeBranch === "string" && chat.worktreeBranch.trim()
        ? chat.worktreeBranch.trim().slice(0, 160)
        : undefined,
    worktreeBaseCommit:
      typeof chat.worktreeBaseCommit === "string" && /^[A-Fa-f0-9]{7,64}$/.test(chat.worktreeBaseCommit)
        ? chat.worktreeBaseCommit
        : undefined,
    draftPrompt: typeof chat.draftPrompt === "string" ? chat.draftPrompt : "",
    attachedFiles: Array.isArray(chat.attachedFiles)
      ? chat.attachedFiles.filter((file) => file && typeof file.path === "string" && typeof file.name === "string")
      : [],
  } as ChatRecord;
}

function normalizeChats(chats: unknown[]): ChatRecord[] {
  return chats
    .map((chat) => normalizeChatRecord(chat))
    .filter((chat): chat is ChatRecord => !!chat)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function putNewestChat(chats: Map<string, ChatRecord>, chat: ChatRecord) {
  const existing = chats.get(chat.id);
  if (!existing || chat.updatedAt.localeCompare(existing.updatedAt) >= 0) {
    chats.set(chat.id, chat);
  }
}

function replaceChatsInDatabase(db: DatabaseSync, chats: ChatRecord[]) {
  runTransaction(db, () => {
    db.prepare("DELETE FROM chats").run();
    const insert = db.prepare(`
      INSERT INTO chats (
        id,
        title,
        created_at,
        updated_at,
        repository_path,
        payload,
        position
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    chats.forEach((chat, index) => {
      insert.run(
        chat.id,
        chat.title,
        chat.createdAt,
        chat.updatedAt,
        chat.repositoryPath ?? null,
        JSON.stringify(chat),
        index,
      );
    });
  });
}

function upsertChatInDatabase(db: DatabaseSync, chat: ChatRecord) {
  db.prepare(`
    INSERT OR REPLACE INTO chats (
      id,
      title,
      created_at,
      updated_at,
      repository_path,
      payload,
      position
    ) VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT position FROM chats WHERE id = ?), 0))
  `).run(
    chat.id,
    chat.title,
    chat.createdAt,
    chat.updatedAt,
    chat.repositoryPath ?? null,
    JSON.stringify(chat),
    chat.id,
  );
}

function readChatsFromDatabase(filePath: string): ChatRecord[] {
  if (!fs.existsSync(filePath)) return [];
  return withStorageDatabase(filePath, (db) => normalizeChats(readPayloads(db, "chats")));
}

function readChatFromDatabase(filePath: string, chatId: string): ChatRecord | null {
  if (!fs.existsSync(filePath)) return null;
  return withStorageDatabase(filePath, (db) => {
    const row = db.prepare("SELECT payload FROM chats WHERE id = ?").get(chatId) as PayloadRow | undefined;
    return row ? normalizeChatRecord(parsePayload(row.payload)) : null;
  });
}

function legacyProjectDatabasePath(rootPath: string): string {
  return path.join(rootPath, ".umbratic", "umbratic.sqlite");
}

function readLegacyProjectChats(project: RepositoryInfo): ChatRecord[] {
  return readChatsFromDatabase(legacyProjectDatabasePath(project.rootPath));
}

function writeChatsToDatabase(chats: ChatRecord[]) {
  withStorageDatabase(chatsDatabasePath(), (db) => replaceChatsInDatabase(db, chats));
}

function readLegacyAppChats(): ChatRecord[] {
  return readChatsFromDatabase(appDatabasePath());
}

function migrateLegacyChatsToHomeDatabase() {
  const dbPath = chatsDatabasePath();
  if (fs.existsSync(dbPath)) return;
  const chats = new Map<string, ChatRecord>();
  for (const chat of readLegacyAppChats()) {
    putNewestChat(chats, chat);
  }
  for (const project of readProjects()) {
    const projectKey = pathKey(project.rootPath);
    for (const chat of readLegacyProjectChats(project)) {
      if (chat.repositoryPath && pathKey(chat.repositoryPath) !== projectKey) {
        continue;
      }
      putNewestChat(chats, {
        ...chat,
        repositoryName: chat.repositoryName ?? project.name,
        repositoryPath: project.rootPath,
      });
    }
  }
  if (chats.size > 0) {
    writeChatsToDatabase(Array.from(chats.values()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
  }
}

export function readChats(): ChatRecord[] {
  migrateLegacyChatsToHomeDatabase();
  const chats = new Map<string, ChatRecord>();
  for (const chat of readChatsFromDatabase(chatsDatabasePath())) {
    putNewestChat(chats, chat);
  }
  return Array.from(chats.values()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function readChat(chatId: string): ChatRecord | null {
  migrateLegacyChatsToHomeDatabase();
  return readChatFromDatabase(chatsDatabasePath(), chatId);
}

function chatWithProjectMetadata(chat: ChatRecord): ChatRecord {
  if (!chat.repositoryPath) return chat;
  const project = readProjects().find((row) => pathKey(row.rootPath) === pathKey(chat.repositoryPath as string));
  if (!project) return chat;
  return {
    ...chat,
    repositoryName: chat.repositoryName ?? project.name,
    repositoryPath: project.rootPath,
  };
}

export function writeChat(chat: ChatRecord) {
  const normalized = normalizeChatRecord(chat);
  if (!normalized) return;
  withStorageDatabase(chatsDatabasePath(), (db) => upsertChatInDatabase(db, chatWithProjectMetadata(normalized)));
}

export function writeChats(chats: ChatRecord[]) {
  const projects = readProjects();
  const projectsByPath = new Map(projects.map((project) => [pathKey(project.rootPath), project]));
  const nextChats: ChatRecord[] = [];

  for (const chat of normalizeChats(chats)) {
    const project = chat.repositoryPath ? projectsByPath.get(pathKey(chat.repositoryPath)) : undefined;
    if (!project) {
      nextChats.push(chat);
      continue;
    }
    nextChats.push({
      ...chat,
      repositoryName: chat.repositoryName ?? project.name,
      repositoryPath: project.rootPath,
    });
  }

  writeChatsToDatabase(nextChats);
}

type RawSettings = {
  selectedModel?: { providerId?: string; modelId?: string };
  modelEndpoint?: Partial<Omit<ModelEndpointSettings, "headers" | "secret">> & {
    version?: unknown;
    secret?: unknown;
    headers?: unknown;
  };
  tools?: Partial<Record<RunnerToolId, boolean>>;
  skills?: Record<string, boolean>;
  harnessProfile?: unknown;
};

type SettingsRow = {
  payload: string;
};

type NoteRow = {
  content: string;
  updated_at: string;
};

const appSettingsKey = "app";
const userNotesId = "user";
const modelEndpointSettingsVersion = 3;

function readRawSettings(): RawSettings {
  return withAppDatabase((db) => {
    const row = db.prepare("SELECT payload FROM settings WHERE key = ?").get(appSettingsKey) as SettingsRow | undefined;
    const settings = row ? parsePayload(row.payload) : {};
    return isRecord(settings) ? (settings as RawSettings) : {};
  });
}

function writeRawSettings(settings: RawSettings) {
  withAppDatabase((db) => {
    db.prepare("INSERT OR REPLACE INTO settings (key, payload) VALUES (?, ?)").run(appSettingsKey, JSON.stringify(settings));
  });
}

type StoredProtectedString = {
  encoding: "electron-safe-storage-v1";
  encrypted: string;
};

type StoredModelEndpointSettings = Omit<ModelEndpointSettings, "headers" | "secret"> & {
  version: typeof modelEndpointSettingsVersion;
  secret: "" | StoredProtectedString;
  headers: Array<{ name: string; value: "" | StoredProtectedString }>;
};

function readProtectedString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value) || value.encoding !== "electron-safe-storage-v1" || typeof value.encrypted !== "string") return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(value.encrypted, "base64"));
  } catch {
    return undefined;
  }
}

function writeProtectedString(value: string): "" | StoredProtectedString {
  if (!value) return "";
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure storage is not available, so endpoint tokens were not saved.");
  }
  return {
    encoding: "electron-safe-storage-v1",
    encrypted: safeStorage.encryptString(value).toString("base64"),
  };
}

function normalizeEndpointHeaders(value: unknown): Array<{ name: string; value: string }> {
  const rows = Array.isArray(value) ? value : [];
  const headers = rows.slice(0, 2).map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return { name: "", value: "" };
    const record = row as Record<string, unknown>;
    return {
      name: typeof record.name === "string" ? record.name.trim() : "",
      value: readProtectedString(record.value) ?? "",
    };
  });
  while (headers.length < 2) headers.push({ name: "", value: "" });
  return headers;
}

function activeModelEndpointSettings(settings: RawSettings): RawSettings["modelEndpoint"] | undefined {
  const endpoint = settings.modelEndpoint;
  if (!endpoint) return undefined;
  if (endpoint.version === modelEndpointSettingsVersion) return endpoint;
  if (endpoint.mode !== "local") return endpoint;
  // Version 2 stored the local Veil URL in baseUrl. Version 3 stores the
  // underlying Ollama/vLLM URL instead, so preserve the mode while resetting
  // the fields whose meaning changed.
  return {
    mode: "local",
    software: endpoint.software,
  };
}

export function hasStoredModelEndpointSettings(): boolean {
  const settings = readRawSettings();
  return !!activeModelEndpointSettings(settings);
}

export function readModelEndpointSettings(): ModelEndpointSettings {
  const settings = readRawSettings();
  const endpoint = activeModelEndpointSettings(settings) ?? {};
  const managed = managedModelEndpointDefaults();
  const mode =
    managed?.mode ??
    (endpoint.mode === "local" || endpoint.mode === "server" ? endpoint.mode : defaultModelEndpointMode());
  const managedBaseUrl = managed?.baseUrl;
  const managedSoftware = managed?.software;
  const storedBaseUrl = typeof endpoint.baseUrl === "string" && endpoint.baseUrl.trim() ? endpoint.baseUrl.trim() : undefined;
  const software =
    managedSoftware ?? (isModelEndpointSoftware(endpoint.software) ? endpoint.software : defaultEndpointSoftware(mode, managedBaseUrl ?? storedBaseUrl));
  const modelId =
    mode === "local"
      ? typeof endpoint.modelId === "string" && endpoint.modelId.trim()
        ? endpoint.modelId.trim()
        : defaultLocalModelId
      : defaultEndpointModelId;
  return {
    mode,
    software,
    baseUrl: managedBaseUrl ?? storedBaseUrl ?? defaultEndpointBaseUrlForSoftware(mode, software),
    modelId,
    secret: mode === "local" ? "" : managed?.secret ?? readProtectedString(endpoint.secret) ?? defaultEndpointApiKey,
    headers: mode === "local" ? normalizeEndpointHeaders([]) : normalizeEndpointHeaders(endpoint.headers),
  };
}

function protectEndpointSettings(settings: ModelEndpointSettings): StoredModelEndpointSettings {
  return {
    ...settings,
    version: modelEndpointSettingsVersion,
    secret: writeProtectedString(settings.secret),
    headers: settings.headers.map((header) => ({
      name: header.name,
      value: writeProtectedString(header.value),
    })),
  };
}

export function writeModelEndpointSettings(input: Partial<ModelEndpointSettings>): ModelEndpointSettings {
  const current = readModelEndpointSettings();
  const managed = managedModelEndpointDefaults();
  const hasManagedEndpoint = !!(managed?.baseUrl || managed?.mode || managed?.software);
  const canEditEndpoint = endpointEditingAllowed() && !hasManagedEndpoint;
  const nextMode = canEditEndpoint && isModelEndpointMode(input.mode) ? input.mode : current.mode;
  const nextSoftware = isModelEndpointSoftware(input.software)
    ? canEditEndpoint
      ? input.software
      : current.software
    : current.mode === nextMode
      ? current.software
      : defaultEndpointSoftware(nextMode);
  const next: ModelEndpointSettings = {
    mode: nextMode,
    software: nextSoftware,
    baseUrl:
      !canEditEndpoint
        ? current.baseUrl
        : typeof input.baseUrl === "string" && input.baseUrl.trim()
          ? input.baseUrl.trim()
          : defaultEndpointBaseUrlForSoftware(nextMode, nextSoftware),
    modelId:
      nextMode === "local"
        ? typeof input.modelId === "string"
          ? input.modelId.trim()
          : current.mode === "local"
            ? current.modelId
            : defaultLocalModelId
        : defaultEndpointModelId,
    secret:
      nextMode === "local"
        ? ""
        : managed?.secret ?? (typeof input.secret === "string" ? input.secret : current.mode === "server" ? current.secret : ""),
    headers:
      nextMode === "local"
        ? normalizeEndpointHeaders([])
        : normalizeEndpointHeaders(input.headers ?? (current.mode === "server" ? current.headers : [])),
  };
  const settings = readRawSettings();
  writeRawSettings({
    ...settings,
    selectedModel: { providerId: "company-endpoint", modelId: next.modelId },
    modelEndpoint: protectEndpointSettings(next),
  });
  return next;
}

export function readToolSettings(): Record<RunnerToolId, boolean> {
  const settings = readRawSettings();
  const rawTools = settings.tools && typeof settings.tools === "object" ? settings.tools : {};
  return {
    ...defaultToolSettings(),
    ...Object.fromEntries(
      Object.entries(rawTools).filter(([id, value]) => isRunnerToolId(id) && typeof value === "boolean"),
    ),
  } as Record<RunnerToolId, boolean>;
}

export function writeToolSettings(input: Partial<Record<RunnerToolId, boolean>>): Record<RunnerToolId, boolean> {
  const current = readToolSettings();
  const sanitized: Partial<Record<RunnerToolId, boolean>> = {};
  for (const [id, value] of Object.entries(input)) {
    if (isRunnerToolId(id) && typeof value === "boolean") {
      sanitized[id] = value;
    }
  }
  const next = {
    ...current,
    ...sanitized,
  };
  const settings = readRawSettings();
  writeRawSettings({
    ...settings,
    tools: toolSettingsFromEnabledTools(enabledToolsFromSettings(next)),
  });
  return next;
}

export function readSkillSettings(): Record<string, boolean> {
  const settings = readRawSettings();
  const rawSkills = settings.skills && typeof settings.skills === "object" ? settings.skills : {};
  return Object.fromEntries(
    Object.entries(rawSkills).filter(([id, value]) => /^[A-Za-z0-9_-]{1,96}$/.test(id) && typeof value === "boolean"),
  );
}

export function writeSkillSettings(input: Record<string, boolean>): Record<string, boolean> {
  const current = readSkillSettings();
  const sanitized: Record<string, boolean> = {};
  for (const [id, value] of Object.entries(input)) {
    if (/^[A-Za-z0-9_-]{1,96}$/.test(id) && typeof value === "boolean") {
      sanitized[id] = value;
    }
  }
  const next = { ...current, ...sanitized };
  const settings = readRawSettings();
  writeRawSettings({
    ...settings,
    skills: next,
  });
  return next;
}

export function readHarnessProfileSetting(): HarnessProfileId {
  const settings = readRawSettings();
  return isHarnessProfileId(settings.harnessProfile) ? settings.harnessProfile : defaultHarnessProfileId;
}

export function writeHarnessProfileSetting(profileId: HarnessProfileId): HarnessProfileId {
  const next = isHarnessProfileId(profileId) ? profileId : defaultHarnessProfileId;
  const settings = readRawSettings();
  writeRawSettings({
    ...settings,
    harnessProfile: next,
  });
  return next;
}

export function readSettings(): { selectedModel?: { providerId: LocalProviderId; modelId: string }; modelEndpoint: ModelEndpointSettings; harnessProfile: HarnessProfileId } {
  const modelEndpoint = readModelEndpointSettings();
  const harnessProfile = readHarnessProfileSetting();
  if (modelEndpoint.modelId.trim()) {
    return { selectedModel: { providerId: "company-endpoint", modelId: modelEndpoint.modelId.trim() }, modelEndpoint, harnessProfile };
  }
  return { modelEndpoint, harnessProfile };
}

export function readNotes(): UserNotes {
  const notes = withAppDatabase((db) => db.prepare("SELECT content, updated_at FROM notes WHERE id = ?").get(userNotesId) as NoteRow | undefined);
  return {
    content: typeof notes?.content === "string" ? notes.content : "",
    updatedAt: typeof notes?.updated_at === "string" ? notes.updated_at : "",
  };
}

export function writeNotes(content: string): UserNotes {
  const notes = {
    content,
    updatedAt: new Date().toISOString(),
  };
  withAppDatabase((db) => {
    db.prepare("INSERT OR REPLACE INTO notes (id, content, updated_at) VALUES (?, ?, ?)").run(userNotesId, notes.content, notes.updatedAt);
  });
  return notes;
}
