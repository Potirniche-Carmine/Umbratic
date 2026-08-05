import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { appDatabaseFile, chatsDatabaseFile } from "./appPaths";

export function appDatabasePath(): string {
  return appDatabaseFile(app.getPath("userData"));
}

export function localDatabasePath(): string {
  return appDatabasePath();
}

export function chatsDatabasePath(): string {
  return chatsDatabaseFile(app.getPath("userData"));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
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

export type PayloadRow = {
  payload: string;
};

export type PositionRow = {
  position: number | null;
};

export type DiagnosticRow = {
  id: number;
  at: string;
  level: string;
  source: string;
  event: string;
  task_id: string | null;
  message: string | null;
  data: string;
};

export type DiagnosticStatsRow = {
  bytes: number;
  entries: number;
};

export type ProductTelemetryRow = {
  payload: string;
};

export type RecordTableName = "projects" | "tasks" | "chats";

type RetainedDatabase = {
  db: DatabaseSync;
  filePath: string;
};

const retainedDatabases = new Map<string, RetainedDatabase>();

function configureStorageDatabase(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON;");
  // WAL keeps the process-lifetime handles usable while tests and recovery
  // readers open the same files briefly.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA journal_size_limit = 16777216;");
  db.exec("PRAGMA wal_autocheckpoint = 1000;");
  const pageSize = Number((db.prepare("PRAGMA page_size").get() as { page_size?: number }).page_size) || 4096;
  const maximumDatabaseBytes = 512 * 1024 * 1024;
  db.exec(`PRAGMA max_page_count = ${Math.max(1, Math.floor(maximumDatabaseBytes / pageSize))};`);
  ensureStorageSchema(db);
}

function openRetainedStorageDatabase(filePath: string): DatabaseSync {
  const existing = retainedDatabases.get(filePath);
  if (existing) {
    return existing.db;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  configureStorageDatabase(db);
  retainedDatabases.set(filePath, { db, filePath });
  return db;
}

function withEphemeralStorageDatabase<T>(filePath: string, action: (db: DatabaseSync) => T): T {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  try {
    configureStorageDatabase(db);
    return action(db);
  } finally {
    db.close();
  }
}

export function withStorageDatabase<T>(filePath: string, action: (db: DatabaseSync) => T, retain = false): T {
  if (retain) {
    return action(openRetainedStorageDatabase(filePath));
  }
  const existing = retainedDatabases.get(filePath);
  if (existing) {
    return action(existing.db);
  }
  return withEphemeralStorageDatabase(filePath, action);
}

export function withAppDatabase<T>(action: (db: DatabaseSync) => T): T {
  return withStorageDatabase(appDatabasePath(), action, true);
}

export function withChatsDatabase<T>(action: (db: DatabaseSync) => T): T {
  return withStorageDatabase(chatsDatabasePath(), action, true);
}

/** Close process-lifetime SQLite handles. Safe to call more than once. */
export function closeStorageDatabases(): void {
  for (const { db } of retainedDatabases.values()) {
    try {
      db.close();
    } catch {
      /* Best-effort shutdown; a later open recreates the handle. */
    }
  }
  retainedDatabases.clear();
}

/** Test helper: number of retained SQLite handles in this process. */
export function retainedStorageDatabaseCount(): number {
  return retainedDatabases.size;
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
      index_tree_oid TEXT,
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
}

export function runTransaction(db: DatabaseSync, action: () => void) {
  db.exec("BEGIN IMMEDIATE;");
  try {
    action();
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

export function parsePayload(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export function readPayloads(db: DatabaseSync, tableName: RecordTableName): unknown[] {
  const orderBy = tableName === "chats" ? "updated_at DESC, position ASC" : "position ASC";
  return (db.prepare(`SELECT payload FROM ${tableName} ORDER BY ${orderBy}`).all() as PayloadRow[]).map((row) =>
    parsePayload(row.payload),
  );
}
