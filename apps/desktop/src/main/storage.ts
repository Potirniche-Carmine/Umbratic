import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  isModelEndpointMode,
} from "./config";
import { isRunnerToolId } from "./toolSettings";
import { normalizeReviewFile } from "../shared/reviewDiff";
import { chatActivityUtcIso, compareUtcIsoDesc, normalizeUtcIso } from "../shared/utcDate";
import type {
  CapabilityProbeCategory,
  CapabilityProbeImportance,
  CapabilityProbeStatus,
  CapabilityTelemetryProbe,
  ChatRecord,
  RepositoryInfo,
  RunnerToolId,
  TaskRecord,
  TaskCheckpoint,
  TaskWorkspace,
} from "./types";

import {
  appDatabasePath,
  chatsDatabasePath,
  parsePayload,
  readPayloads,
  runTransaction,
  withAppDatabase,
  withChatsDatabase,
  withStorageDatabase,
} from "./storageDatabase";
import { isRecord, pathKey } from "./utils";
import type { PayloadRow, PositionRow } from "./storageDatabase";

export * from "./storageDatabase";
export * from "./diagnosticsStorage";
export * from "./settingsStorage";

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
    (project.kind !== "folder" && project.kind !== "git") ||
    !fs.existsSync(project.rootPath)
  ) {
    return null;
  }
  return {
    ...(project as RepositoryInfo),
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
    typeof task.worktreePath !== "string" ||
    (task.workspaceKind !== "git" && task.workspaceKind !== "folder") ||
    (task.workspaceMode !== "local" && task.workspaceMode !== "worktree") ||
    (task.permissionMode !== "normal" && task.permissionMode !== "auto_safe") ||
    !Array.isArray(task.changedFiles) ||
    !Array.isArray(task.reviewFiles) ||
    !Array.isArray(task.events)
  ) {
    return null;
  }
  return {
    ...(task as TaskRecord),
    modelEndpointMode: isModelEndpointMode(task.modelEndpointMode) ? task.modelEndpointMode : undefined,
    enabledTools: normalizeStoredEnabledTools(task.enabledTools),
    capabilityProbes: normalizeStoredCapabilityProbes(task.capabilityProbes),
    reviewFiles: task.reviewFiles
      .filter((file): file is Record<string, unknown> => isRecord(file) && typeof file.path === "string")
      .map((file) => normalizeReviewFile(file as { path: string; patch?: string })),
    reviewScope: task.reviewScope === "worktree" || task.reviewScope === "task" ? task.reviewScope : undefined,
    reviewBaselineLabel: typeof task.reviewBaselineLabel === "string" ? task.reviewBaselineLabel : undefined,
    reviewBaselineOid: typeof task.reviewBaselineOid === "string" ? task.reviewBaselineOid : undefined,
    events: task.events as TaskRecord["events"],
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
    reviewFiles: task.reviewFiles.map(({ hunks: _hunks, ...file }) => file),
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

export function normalizeConversationState(value: unknown): ChatRecord["conversationState"] | undefined {
  // Conversation state carries no version field; a payload with one is discarded.
  if (!isRecord(value) || "version" in value || typeof value.sourceTaskId !== "string"
    || !value.sourceTaskId || value.sourceTaskId.length > 200 || typeof value.updatedAt !== "string"
    || !value.updatedAt || value.updatedAt.length > 80 || typeof value.sourceDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(value.sourceDigest) || !Array.isArray(value.tail) || value.tail.length > 32
    || !isRecord(value.usage) || typeof value.usage.estimatedPromptTokens !== "number"
    || !Number.isSafeInteger(value.usage.estimatedPromptTokens) || value.usage.estimatedPromptTokens < 0
    || typeof value.usage.compactionCount !== "number" || !Number.isSafeInteger(value.usage.compactionCount)
    || value.usage.compactionCount < 0
    || !(value.usage.observedPromptTokens === null || (typeof value.usage.observedPromptTokens === "number"
      && Number.isSafeInteger(value.usage.observedPromptTokens) && value.usage.observedPromptTokens >= 0))
    || !(value.summary === null || (typeof value.summary === "string" && value.summary.length <= 24_000))) {
    return undefined;
  }
  const tail = value.tail.map((message) => {
    if (!isRecord(message) || !["user", "assistant", "tool"].includes(String(message.role))) return null;
    if (message.toolCallId !== undefined && typeof message.toolCallId !== "string") return null;
    if (message.toolCalls !== undefined && !Array.isArray(message.toolCalls)) return null;
    return {
      role: message.role as "user" | "assistant" | "tool",
      content: message.content,
      ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
      ...(Array.isArray(message.toolCalls) ? { toolCalls: message.toolCalls } : {}),
    };
  });
  if (tail.some((message) => !message) || Buffer.byteLength(JSON.stringify(value), "utf8") > 128 * 1024) return undefined;
  const normalizedTail = tail as NonNullable<ChatRecord["conversationState"]>["tail"];
  if (!conversationStateTailIsComplete(normalizedTail)) return undefined;
  return {
    sourceTaskId: value.sourceTaskId,
    updatedAt: value.updatedAt,
    summary: typeof value.summary === "string" ? value.summary : null,
    tail: normalizedTail,
    sourceDigest: value.sourceDigest,
    usage: {
      estimatedPromptTokens: value.usage.estimatedPromptTokens as number,
      observedPromptTokens: typeof value.usage.observedPromptTokens === "number" ? value.usage.observedPromptTokens : null,
      compactionCount: value.usage.compactionCount as number,
    },
  };
}

function conversationStateTailIsComplete(tail: NonNullable<ChatRecord["conversationState"]>["tail"]): boolean {
  if (tail[0]?.role === "tool") return false;
  const seen = new Set<string>();
  let pending: string[] = [];
  for (const message of tail) {
    if (message.role === "tool") {
      const id = message.toolCallId;
      if (!id) return false;
      const index = pending.indexOf(id);
      if (index < 0) return false;
      pending.splice(index, 1);
      continue;
    }
    if (pending.length) return false;
    if (message.toolCallId) return false;
    const ids = Array.isArray(message.toolCalls)
      ? message.toolCalls
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
    createdAt: normalizeUtcIso(chat.createdAt) ?? chat.createdAt,
    updatedAt: normalizeUtcIso(chat.updatedAt) ?? chat.updatedAt,
    modelEndpointMode: isModelEndpointMode(chat.modelEndpointMode) ? chat.modelEndpointMode : undefined,
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
    conversationState: normalizeConversationState(chat.conversationState),
  } as ChatRecord;
}

function normalizeChats(chats: unknown[]): ChatRecord[] {
  return chats
    .map((chat) => normalizeChatRecord(chat))
    .filter((chat): chat is ChatRecord => !!chat)
    .sort((left, right) => compareUtcIsoDesc(left.updatedAt, right.updatedAt));
}

function putNewestChat(chats: Map<string, ChatRecord>, chat: ChatRecord) {
  const existing = chats.get(chat.id);
  if (!existing || compareUtcIsoDesc(existing.updatedAt, chat.updatedAt) >= 0) {
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
  const retain = filePath === appDatabasePath() || filePath === chatsDatabasePath();
  return withStorageDatabase(filePath, (db) => normalizeChats(readPayloads(db, "chats")), retain);
}

function readChatFromDatabase(filePath: string, chatId: string): ChatRecord | null {
  if (!fs.existsSync(filePath)) return null;
  const retain = filePath === appDatabasePath() || filePath === chatsDatabasePath();
  return withStorageDatabase(filePath, (db) => {
    const row = db.prepare("SELECT payload FROM chats WHERE id = ?").get(chatId) as PayloadRow | undefined;
    return row ? normalizeChatRecord(parsePayload(row.payload)) : null;
  }, retain);
}

function writeChatsToDatabase(chats: ChatRecord[]) {
  withChatsDatabase((db) => replaceChatsInDatabase(db, chats));
}

function chatWithTaskActivity(chat: ChatRecord, task: TaskRecord | null | undefined): ChatRecord {
  if (!task) return chat;
  const updatedAt = chatActivityUtcIso(task, chat.updatedAt) ?? chat.updatedAt;
  return updatedAt === chat.updatedAt ? chat : { ...chat, updatedAt };
}

export function readChats(): ChatRecord[] {
  const tasks = new Map(readTasks().map((task) => [task.id, task]));
  const chats = new Map<string, ChatRecord>();
  for (const chat of readChatsFromDatabase(chatsDatabasePath())) {
    putNewestChat(chats, chatWithTaskActivity(chat, chat.taskId ? tasks.get(chat.taskId) : undefined));
  }
  return Array.from(chats.values()).sort((left, right) => compareUtcIsoDesc(left.updatedAt, right.updatedAt));
}

export function readChat(chatId: string): ChatRecord | null {
  const chat = readChatFromDatabase(chatsDatabasePath(), chatId);
  if (!chat) return null;
  return chatWithTaskActivity(chat, chat.taskId ? readTask(chat.taskId) : null);
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
  const task = normalized.taskId ? readTask(normalized.taskId) : null;
  withChatsDatabase((db) => upsertChatInDatabase(db, chatWithProjectMetadata(chatWithTaskActivity(normalized, task))));
}

export function writeChats(chats: ChatRecord[]) {
  const projects = readProjects();
  const projectsByPath = new Map(projects.map((project) => [pathKey(project.rootPath), project]));
  const tasks = new Map(readTasks().map((task) => [task.id, task]));
  const nextChats: ChatRecord[] = [];

  for (const chat of normalizeChats(chats)) {
    const withActivity = chatWithTaskActivity(chat, chat.taskId ? tasks.get(chat.taskId) : undefined);
    const project = withActivity.repositoryPath ? projectsByPath.get(pathKey(withActivity.repositoryPath)) : undefined;
    if (!project) {
      nextChats.push(withActivity);
      continue;
    }
    nextChats.push({
      ...withActivity,
      repositoryName: withActivity.repositoryName ?? project.name,
      repositoryPath: project.rootPath,
    });
  }

  writeChatsToDatabase(nextChats);
}
