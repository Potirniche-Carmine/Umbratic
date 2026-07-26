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
  localEndpointForced,
  managedModelEndpointDefaults,
} from "./config";
import { umbraticPolicyVersion, umbraticRunnerName, umbraticRunnerVersion } from "./policy";
import { defaultToolSettings, enabledToolsFromSettings, isRunnerToolId, toolSettingsFromEnabledTools } from "./toolSettings";
import { normalizeReviewFile } from "../shared/reviewDiff";
import { DEFAULT_CONTEXT_LENGTH, normalizeContextLength } from "../shared/contextWindow";
import type {
  CapabilityProbeCategory,
  CapabilityProbeImportance,
  CapabilityProbeStatus,
  CapabilityTelemetryProbe,
  ChatRecord,
  HarnessProfileId,
  LocalProviderId,
  LocalDiagnosticInfo,
  LocalDiagnosticLevel,
  LocalDiagnosticRecord,
  ModelEndpointMode,
  ModelEndpointSettings,
  PermissionMode,
  ProductTelemetryEvent,
  RepositoryInfo,
  RunnerToolId,
  TaskRecord,
  TaskCheckpoint,
  TaskWorkspace,
  UserNotes,
} from "./types";

function dataFile(name: string): string {
  return path.join(app.getPath("userData"), name);
}

function appDatabasePath(): string {
  return dataFile("umbratic.sqlite");
}

export function localDatabasePath(): string {
  return appDatabasePath();
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

type PositionRow = {
  position: number | null;
};

type DiagnosticRow = {
  id: number;
  at: string;
  level: string;
  source: string;
  event: string;
  task_id: string | null;
  message: string | null;
  data: string;
};

type DiagnosticStatsRow = {
  bytes: number;
  entries: number;
};

type ProductTelemetryRow = {
  payload: string;
};

export type LocalDiagnosticInput = {
  at?: string;
  level: LocalDiagnosticLevel;
  source: string;
  event: string;
  taskId?: string;
  message?: string;
  data?: unknown;
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
  const schemaVersion = Number((db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version) || 0;
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

    CREATE TABLE IF NOT EXISTS diagnostic_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      level TEXT NOT NULL,
      source TEXT NOT NULL,
      event TEXT NOT NULL,
      task_id TEXT,
      message TEXT,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS product_telemetry_events (
      id TEXT PRIMARY KEY NOT NULL,
      type TEXT NOT NULL,
      at TEXT NOT NULL,
      task_id TEXT,
      repository_id TEXT,
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_checkpoints (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      parent_checkpoint_id TEXT,
      source TEXT NOT NULL,
      label TEXT,
      commit_oid TEXT NOT NULL,
      tree_oid TEXT NOT NULL,
      created_at TEXT NOT NULL,
      state TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      logical_bytes INTEGER,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY(parent_checkpoint_id) REFERENCES task_checkpoints(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS task_workspaces (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      branch TEXT NOT NULL,
      path TEXT NOT NULL,
      source_checkpoint_id TEXT,
      created_at TEXT NOT NULL,
      state TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY(source_checkpoint_id) REFERENCES task_checkpoints(id) ON DELETE SET NULL,
      UNIQUE(task_id, number),
      UNIQUE(path)
    );

    CREATE INDEX IF NOT EXISTS chats_updated_at_index ON chats(updated_at DESC);
    CREATE INDEX IF NOT EXISTS chats_repository_path_index ON chats(repository_path);
    CREATE INDEX IF NOT EXISTS tasks_created_at_index ON tasks(created_at DESC);
    CREATE INDEX IF NOT EXISTS tasks_repository_id_index ON tasks(repository_id);
    CREATE INDEX IF NOT EXISTS diagnostic_logs_at_index ON diagnostic_logs(at DESC);
    CREATE INDEX IF NOT EXISTS diagnostic_logs_task_id_index ON diagnostic_logs(task_id);
    CREATE INDEX IF NOT EXISTS product_telemetry_events_at_index ON product_telemetry_events(at ASC);
    CREATE INDEX IF NOT EXISTS product_telemetry_events_task_id_index ON product_telemetry_events(task_id);
    CREATE INDEX IF NOT EXISTS task_checkpoints_task_state_created_index ON task_checkpoints(task_id, state, created_at DESC);
    CREATE INDEX IF NOT EXISTS task_workspaces_task_state_created_index ON task_workspaces(task_id, state, created_at DESC);
  `);
  if (schemaVersion < 4) {
    db.exec(`
      DELETE FROM diagnostic_logs WHERE level NOT IN ('warn', 'error');
      PRAGMA user_version = 4;
    `);
  }
  if (schemaVersion < 5) {
    const checkpointColumns = db.prepare("PRAGMA table_info(task_checkpoints)").all() as Array<{ name: string }>;
    if (!checkpointColumns.some((column) => column.name === "index_tree_oid")) {
      db.exec("ALTER TABLE task_checkpoints ADD COLUMN index_tree_oid TEXT;");
    }
    db.exec("PRAGMA user_version = 5;");
  }
}

function normalizedDiagnosticText(value: string | undefined, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, limit);
}

export function appendLocalDiagnostic(input: LocalDiagnosticInput): void {
  if (input.level !== "warn" && input.level !== "error") return;
  const source = normalizedDiagnosticText(input.source, 80);
  const event = normalizedDiagnosticText(input.event, 160);
  if (!source || !event) return;
  const at = typeof input.at === "string" && Number.isFinite(Date.parse(input.at)) ? input.at : new Date().toISOString();
  const data = JSON.stringify(input.data ?? {});
  withAppDatabase((db) => {
    db.prepare(`
      INSERT INTO diagnostic_logs (at, level, source, event, task_id, message, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      at,
      input.level,
      source,
      event,
      normalizedDiagnosticText(input.taskId, 128) ?? null,
      normalizedDiagnosticText(input.message, 4000) ?? null,
      data,
    );
  });
}

export function readLocalDiagnosticInfo(): LocalDiagnosticInfo {
  return withAppDatabase((db) => {
    const row = db.prepare(`
      SELECT
        COUNT(*) AS entries,
        COALESCE(SUM(
          LENGTH(CAST(at AS BLOB)) +
          LENGTH(CAST(level AS BLOB)) +
          LENGTH(CAST(source AS BLOB)) +
          LENGTH(CAST(event AS BLOB)) +
          COALESCE(LENGTH(CAST(task_id AS BLOB)), 0) +
          COALESCE(LENGTH(CAST(message AS BLOB)), 0) +
          LENGTH(CAST(data AS BLOB))
        ), 0) AS bytes
      FROM diagnostic_logs
    `).get() as DiagnosticStatsRow;
    return { bytes: Number(row.bytes) || 0, entries: Number(row.entries) || 0 };
  });
}

export function readLocalDiagnostics(): LocalDiagnosticRecord[] {
  return withAppDatabase((db) => {
    const rows = db.prepare(`
      SELECT id, at, level, source, event, task_id, message, data
      FROM diagnostic_logs
      ORDER BY id ASC
    `).all() as DiagnosticRow[];
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      level: row.level as LocalDiagnosticLevel,
      source: row.source,
      event: row.event,
      ...(row.task_id ? { taskId: row.task_id } : {}),
      ...(row.message ? { message: row.message } : {}),
      data: parsePayload(row.data) ?? {},
    }));
  });
}

export function clearLocalDiagnostics(): LocalDiagnosticInfo {
  return withAppDatabase((db) => {
    db.exec("DELETE FROM diagnostic_logs; VACUUM;");
    return { bytes: 0, entries: 0 };
  });
}

export function writeProductTelemetryEvent(event: ProductTelemetryEvent): void {
  withAppDatabase((db) => {
    db.prepare(`
      INSERT OR REPLACE INTO product_telemetry_events (id, type, at, task_id, repository_id, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.type,
      event.at,
      event.taskId ?? null,
      event.repositoryId ?? null,
      JSON.stringify(event),
    );
  });
}

export function readProductTelemetryEvents(): ProductTelemetryEvent[] {
  return withAppDatabase((db) => (
    db.prepare("SELECT payload FROM product_telemetry_events ORDER BY at ASC, id ASC").all() as ProductTelemetryRow[]
  ).map((row) => parsePayload(row.payload)).filter((event): event is ProductTelemetryEvent => (
    isRecord(event) && typeof event.id === "string" && typeof event.type === "string" && typeof event.at === "string"
  )));
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
    permissionMode: task.permissionMode === "auto_safe" || task.permissionMode === "bypass" ? "auto_safe" : "normal",
    reasoningMode: task.reasoningMode === "fast" ? "fast" : "reasoning",
    runnerName: typeof task.runnerName === "string" && task.runnerName ? task.runnerName : umbraticRunnerName,
    runnerVersion: typeof task.runnerVersion === "string" && task.runnerVersion ? task.runnerVersion : umbraticRunnerVersion,
    policyVersion: typeof task.policyVersion === "string" && task.policyVersion ? task.policyVersion : umbraticPolicyVersion,
    enabledTools: normalizeStoredEnabledTools(task.enabledTools) ?? enabledToolsFromSettings(defaultToolSettings()),
    capabilityProbes: normalizeStoredCapabilityProbes(task.capabilityProbes),
    reviewFiles: Array.isArray(task.reviewFiles)
      ? task.reviewFiles
          .filter((file): file is Record<string, unknown> => isRecord(file) && typeof file.path === "string")
          .map((file) => normalizeReviewFile(file as { path: string; diff?: string; patch?: string }))
      : [],
    reviewScope: task.reviewScope === "worktree" ? "worktree" : "task",
    reviewBaselineLabel: typeof task.reviewBaselineLabel === "string" ? task.reviewBaselineLabel : undefined,
    reviewBaselineOid: typeof task.reviewBaselineOid === "string" ? task.reviewBaselineOid : undefined,
    events: Array.isArray(task.events) ? (task.events as TaskRecord["events"]) : [],
  };
}

function normalizeTasks(tasks: unknown[]): TaskRecord[] {
  return tasks
    .map((task) => normalizeTaskRecord(task))
    .filter((task): task is TaskRecord => !!task);
}

function serializeTask(task: TaskRecord): string {
  return JSON.stringify({
    ...task,
    reviewFiles: task.reviewFiles.map(({ patch: _patch, hunks: _hunks, ...file }) => file),
  });
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
        serializeTask(task),
        index,
      );
    });
  });
}

function upsertTaskRowInDatabase(db: DatabaseSync, task: TaskRecord, promote: boolean) {
  const existing = db.prepare("SELECT position FROM tasks WHERE id = ?").get(task.id) as PositionRow | undefined;
  const maximum = db.prepare("SELECT MAX(position) AS position FROM tasks").get() as PositionRow;
  let position = existing?.position ?? ((maximum.position ?? -1) + 1);
  if (promote && position !== 0) {
    db.prepare("UPDATE tasks SET position = position + 1 WHERE id <> ?").run(task.id);
    position = 0;
  }
  db.prepare(`
      INSERT INTO tasks (
        id,
        repository_id,
        state,
        created_at,
        payload,
        position
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        repository_id = excluded.repository_id,
        state = excluded.state,
        created_at = excluded.created_at,
        payload = excluded.payload,
        position = excluded.position
  `).run(
    task.id,
    typeof task.repositoryId === "string" ? task.repositoryId : "",
    typeof task.state === "string" ? task.state : "",
    typeof task.createdAt === "string" ? task.createdAt : "",
    serializeTask(task),
    position,
  );
}

function upsertTaskInDatabase(db: DatabaseSync, task: TaskRecord, promote: boolean) {
  runTransaction(db, () => upsertTaskRowInDatabase(db, task, promote));
}

export function readTasks(): TaskRecord[] {
  return withAppDatabase((db) => normalizeTasks(readPayloads(db, "tasks")));
}

export function readTask(taskId: string): TaskRecord | null {
  return withAppDatabase((db) => {
    const row = db.prepare("SELECT payload FROM tasks WHERE id = ?").get(taskId) as PayloadRow | undefined;
    return row ? normalizeTaskRecord(parsePayload(row.payload)) : null;
  });
}

export function writeTasks(tasks: TaskRecord[]) {
  withAppDatabase((db) => replaceTasksInDatabase(db, normalizeTasks(tasks)));
}

export function writeTask(task: TaskRecord, promote = true) {
  const normalized = normalizeTaskRecord(task);
  if (!normalized) return;
  withAppDatabase((db) => upsertTaskInDatabase(db, normalized, promote));
}

type CheckpointRow = {
  id: string; task_id: string; workspace_id: string; parent_checkpoint_id: string | null;
  source: string; label: string | null; commit_oid: string; tree_oid: string; index_tree_oid: string | null; created_at: string;
  state: string; pinned: number; logical_bytes: number | null;
};

type WorkspaceRow = {
  id: string; task_id: string; number: number; branch: string; path: string;
  source_checkpoint_id: string | null; created_at: string; state: string;
};

export function writeTaskCheckpoint(checkpoint: TaskCheckpoint): void {
  withAppDatabase((db) => insertTaskCheckpoint(db, checkpoint));
}

function insertTaskCheckpoint(db: DatabaseSync, checkpoint: TaskCheckpoint): void {
  db.prepare(`
    INSERT OR REPLACE INTO task_checkpoints
      (id, task_id, workspace_id, parent_checkpoint_id, source, label, commit_oid, tree_oid, index_tree_oid, created_at, state, pinned, logical_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    checkpoint.id, checkpoint.taskId, checkpoint.workspaceId, checkpoint.parentCheckpointId ?? null,
    checkpoint.source, checkpoint.label ?? null, checkpoint.commitOid, checkpoint.treeOid,
    checkpoint.indexTreeOid ?? null, checkpoint.createdAt, checkpoint.state, checkpoint.pinned ? 1 : 0, checkpoint.logicalBytes ?? null,
  );
}

export function completeTaskCheckpoint(task: TaskRecord, checkpoint: TaskCheckpoint): void {
  if (checkpoint.state !== "ready" || task.id !== checkpoint.taskId || task.latestCheckpointId !== checkpoint.id) {
    throw new Error("Checkpoint completion requires matching ready checkpoint and task pointer state.");
  }
  const normalized = normalizeTaskRecord(task);
  if (!normalized) throw new Error("Checkpoint completion contains an invalid task.");
  withAppDatabase((db) => runTransaction(db, () => {
    insertTaskCheckpoint(db, checkpoint);
    upsertTaskRowInDatabase(db, normalized, false);
  }));
}

export function readTaskCheckpoints(taskId: string): TaskCheckpoint[] {
  return withAppDatabase((db) => (db.prepare(`
    SELECT * FROM task_checkpoints WHERE task_id = ? ORDER BY created_at DESC, id DESC
  `).all(taskId) as CheckpointRow[]).map((row) => ({
    id: row.id, taskId: row.task_id, workspaceId: row.workspace_id,
    ...(row.parent_checkpoint_id ? { parentCheckpointId: row.parent_checkpoint_id } : {}),
    source: row.source as TaskCheckpoint["source"], ...(row.label ? { label: row.label } : {}),
    commitOid: row.commit_oid, treeOid: row.tree_oid,
    ...(row.index_tree_oid ? { indexTreeOid: row.index_tree_oid } : {}),
    createdAt: row.created_at,
    state: row.state as TaskCheckpoint["state"], pinned: row.pinned === 1,
    ...(row.logical_bytes !== null ? { logicalBytes: row.logical_bytes } : {}),
  })));
}

export function deleteTaskCheckpoint(checkpointId: string): void {
  withAppDatabase((db) => db.prepare("DELETE FROM task_checkpoints WHERE id = ?").run(checkpointId));
}

export function writeTaskWorkspace(workspace: TaskWorkspace): void {
  withAppDatabase((db) => db.prepare(`
    INSERT OR REPLACE INTO task_workspaces
      (id, task_id, number, branch, path, source_checkpoint_id, created_at, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    workspace.id, workspace.taskId, workspace.number, workspace.branch, workspace.path,
    workspace.sourceCheckpointId ?? null, workspace.createdAt, workspace.state,
  ));
}

export function readTaskWorkspaces(taskId: string): TaskWorkspace[] {
  return withAppDatabase((db) => (db.prepare(`
    SELECT * FROM task_workspaces WHERE task_id = ? ORDER BY number DESC
  `).all(taskId) as WorkspaceRow[]).map((row) => ({
    id: row.id, taskId: row.task_id, number: row.number, branch: row.branch, path: row.path,
    ...(row.source_checkpoint_id ? { sourceCheckpointId: row.source_checkpoint_id } : {}),
    createdAt: row.created_at, state: row.state as TaskWorkspace["state"],
  })));
}

export function activateTaskWorkspace(
  task: TaskRecord,
  active: TaskWorkspace,
  previous?: TaskWorkspace,
): void {
  const normalized = normalizeTaskRecord(task);
  if (!normalized) throw new Error("Task workspace switch contains an invalid task.");
  withAppDatabase((db) => runTransaction(db, () => {
    if (previous) {
      db.prepare(`
        INSERT OR REPLACE INTO task_workspaces
          (id, task_id, number, branch, path, source_checkpoint_id, created_at, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(previous.id, previous.taskId, previous.number, previous.branch, previous.path,
        previous.sourceCheckpointId ?? null, previous.createdAt, previous.state);
    }
    db.prepare(`
      INSERT OR REPLACE INTO task_workspaces
        (id, task_id, number, branch, path, source_checkpoint_id, created_at, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(active.id, active.taskId, active.number, active.branch, active.path,
      active.sourceCheckpointId ?? null, active.createdAt, active.state);
    upsertTaskRowInDatabase(db, normalized, false);
  }));
}

function pathKey(pathValue: string): string {
  const resolved = path.resolve(pathValue);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function normalizeContextState(value: unknown): ChatRecord["contextState"] | undefined {
  if (!isRecord(value) || value.version !== 1 || typeof value.sourceTaskId !== "string"
    || !value.sourceTaskId || value.sourceTaskId.length > 200 || typeof value.updatedAt !== "string"
    || !value.updatedAt || value.updatedAt.length > 80 || typeof value.sourceDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(value.sourceDigest) || !Array.isArray(value.tail) || value.tail.length > 32
    || !isRecord(value.usage) || typeof value.usage.estimatedPromptTokens !== "number"
    || !Number.isSafeInteger(value.usage.estimatedPromptTokens)
    || value.usage.estimatedPromptTokens < 0 || typeof value.usage.compactionCount !== "number"
    || !Number.isSafeInteger(value.usage.compactionCount) || value.usage.compactionCount < 0
    || (value.usage.observedPromptTokens !== undefined
      && (typeof value.usage.observedPromptTokens !== "number"
        || !Number.isSafeInteger(value.usage.observedPromptTokens) || value.usage.observedPromptTokens < 0))
    || (value.summary !== undefined && (typeof value.summary !== "string" || value.summary.length > 24_000))) {
    return undefined;
  }
  const tail = value.tail.map((message) => {
    if (!isRecord(message) || !["user", "assistant", "tool"].includes(String(message.role))) return null;
    if (message.tool_call_id !== undefined && typeof message.tool_call_id !== "string") return null;
    if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) return null;
    return {
      role: message.role as "user" | "assistant" | "tool",
      content: message.content,
      ...(typeof message.tool_call_id === "string" ? { tool_call_id: message.tool_call_id } : {}),
      ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}),
    };
  });
  if (tail.some((message) => !message) || Buffer.byteLength(JSON.stringify(value), "utf8") > 128 * 1024) return undefined;
  const normalizedTail = tail as NonNullable<ChatRecord["contextState"]>["tail"];
  if (!contextStateTailIsComplete(normalizedTail)) return undefined;
  return {
    version: 1,
    sourceTaskId: value.sourceTaskId,
    updatedAt: value.updatedAt,
    ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
    tail: normalizedTail,
    sourceDigest: value.sourceDigest,
    usage: {
      estimatedPromptTokens: value.usage.estimatedPromptTokens as number,
      ...(typeof value.usage.observedPromptTokens === "number"
        ? { observedPromptTokens: value.usage.observedPromptTokens }
        : {}),
      compactionCount: value.usage.compactionCount as number,
    },
  };
}

function contextStateTailIsComplete(tail: NonNullable<ChatRecord["contextState"]>["tail"]): boolean {
  if (tail[0]?.role === "tool") return false;
  const seen = new Set<string>();
  let pending: string[] = [];
  for (const message of tail) {
    if (message.role === "tool") {
      const id = message.tool_call_id;
      if (!id) return false;
      const index = pending.indexOf(id);
      if (index < 0) return false;
      pending.splice(index, 1);
      continue;
    }
    if (pending.length) return false;
    if (message.tool_call_id) return false;
    const ids = Array.isArray(message.tool_calls)
      ? message.tool_calls
          .map((call) => (isRecord(call) && typeof call.id === "string" ? call.id : ""))
          .filter(Boolean)
      : [];
    for (const id of ids) {
      if (seen.has(id) || id.length > 160) return false;
      seen.add(id);
    }
    pending = ids;
  }
  return pending.length === 0;
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
    contextState: normalizeContextState(chat.contextState),
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
  contextLength?: unknown;
  permissionMode?: unknown;
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

export type PublicModelEndpointSettings = Omit<ModelEndpointSettings, "headers"> & {
  secretConfigured: boolean;
  headers: Array<{ name: string; value: string; valueConfigured: boolean }>;
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
  const forceLocal = localEndpointForced();
  const mode =
    forceLocal ? "local" : managed?.mode ??
    (endpoint.mode === "local" || endpoint.mode === "server" ? endpoint.mode : defaultModelEndpointMode());
  const managedBaseUrl = forceLocal ? undefined : managed?.baseUrl;
  const managedSoftware = forceLocal ? undefined : managed?.software;
  const storedLocalEndpoint = endpoint.mode === "local";
  const storedEndpointAllowed = !forceLocal || storedLocalEndpoint;
  const storedLocalVllm = endpoint.mode === "local" && endpoint.software === "vllm";
  const storedBaseUrl = storedEndpointAllowed && !storedLocalVllm && typeof endpoint.baseUrl === "string" && endpoint.baseUrl.trim()
    ? endpoint.baseUrl.trim()
    : undefined;
  const software =
    mode === "local"
      ? "ollama"
      : forceLocal
      ? storedLocalEndpoint && isModelEndpointSoftware(endpoint.software)
        ? endpoint.software
        : defaultEndpointSoftware("local")
      : managedSoftware ?? (isModelEndpointSoftware(endpoint.software) ? endpoint.software : defaultEndpointSoftware(mode, managedBaseUrl ?? storedBaseUrl));
  const modelId =
    mode === "local"
      ? storedLocalEndpoint && typeof endpoint.modelId === "string" && endpoint.modelId.trim()
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

export function publicModelEndpointSettings(settings: ModelEndpointSettings): PublicModelEndpointSettings {
  return {
    ...settings,
    secret: "",
    secretConfigured: !!settings.secret,
    headers: settings.headers.map((header) => ({
      name: header.name,
      value: "",
      valueConfigured: !!header.value,
    })),
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
  const nextSoftware = nextMode === "local"
    ? "ollama"
    : isModelEndpointSoftware(input.software)
      ? canEditEndpoint
        ? input.software
        : current.software
      : current.mode === nextMode
        ? current.software
        : defaultEndpointSoftware(nextMode);
  const rejectedLocalVllm = nextMode === "local" && input.software === "vllm";
  const next: ModelEndpointSettings = {
    mode: nextMode,
    software: nextSoftware,
    baseUrl:
      !canEditEndpoint
        ? current.baseUrl
        : rejectedLocalVllm
          ? defaultEndpointBaseUrlForSoftware("local", "ollama")
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
        : managed?.secret ?? (typeof input.secret === "string" && input.secret ? input.secret : current.mode === "server" ? current.secret : ""),
    headers:
      nextMode === "local"
        ? normalizeEndpointHeaders([])
        : normalizeEndpointHeaders(input.headers ?? (current.mode === "server" ? current.headers : [])).map((header) => ({
            name: header.name,
            value: header.value || current.headers.find((existing) => existing.name === header.name)?.value || "",
          })),
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

export function readContextLengthSetting(): number {
  return normalizeContextLength(readRawSettings().contextLength ?? DEFAULT_CONTEXT_LENGTH);
}

export function writeContextLengthSetting(value: unknown): number {
  const contextLength = normalizeContextLength(value);
  const settings = readRawSettings();
  writeRawSettings({
    ...settings,
    contextLength,
  });
  return contextLength;
}

export function readPermissionModeSetting(): PermissionMode {
  return readRawSettings().permissionMode === "auto_safe" ? "auto_safe" : "normal";
}

export function writePermissionModeSetting(value: unknown): PermissionMode {
  const permissionMode: PermissionMode = value === "auto_safe" || value === "bypass" ? "auto_safe" : "normal";
  const settings = readRawSettings();
  writeRawSettings({
    ...settings,
    permissionMode,
  });
  return permissionMode;
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
