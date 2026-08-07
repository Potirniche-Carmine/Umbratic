import { scheduleManagedTelemetrySync } from "./backendSettings";
import { updateChatFromTask } from "./chatStore";
import {
  BrowserWindow,
  nativeImage,
} from "electron";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";


import {
  umbraticPolicyVersion,
  umbraticRunnerName,
  umbraticRunnerVersion,
  baseUrlHost,
} from "./policy";
import {
  readPermissionModeSetting,
  readTask,
  readTasks,
  writeChat,
  writeProductTelemetryEvent,
  writeTask,
  writeTasks,
} from "./storage";
import { recordBackendEventDiagnostic, recordLocalDiagnostic } from "./diagnostics";
import { appendBufferedBackendEvent, shouldBufferBackendEvent } from "./backendEventBuffer";
import type {
  BackendUiEvent,
  ChatAttachment,
  ChatRecord,
  ProductTelemetryEventType,
  RunnerProcess,
  PendingPermission,
  PermissionMode,
  TaskInfo,
  TaskRecord,
} from "./types";
import { type ContextPromptPart } from "./promptContext";
import {
  appendTaskEvent,
  compactTaskEvents,
  filterReviewPaths,
  hiddenRendererReviewPaths,
  isReviewReadyAssistantEvent,
  mergeTaskEvents,
  rendererReviewFiles,
} from "./taskReviewPresentation";

export type RunnerPromptPart = ContextPromptPart;
export type RunnerPrompt = string | RunnerPromptPart[];
/// A queued message the runner is holding. A steer is applied by the running
/// turn itself, so the client only tracks it to reconcile the transcript; a
/// follow-up is launched here once the runner releases it, which is why its
/// prompt and attachments have to survive until then.
export type PendingTaskPrompt = {
  actionId: string;
  prompt: string;
  attachments: ChatAttachment[];
};
export type PdfRenderWorkerResult =
  | { ok: true; pageCount: number; pages: Array<{ pageNumber: number; filePath: string }> }
  | { ok: false; error: string };
export const activeRunnerProcesses = new Map<string, RunnerProcess>();
export const activeStartTaskRequests = new Map<string, Promise<TaskInfo>>();
export const recentStartTaskRequests = new Map<string, { taskId: string; expiresAt: number }>();
export const pendingRunnerPrompts = new Map<string, RunnerPromptPart[]>();
export const pendingTaskSteers = new Map<string, PendingTaskPrompt>();
/// Queued follow-ups per task, in the order the runner holds them.
export const pendingTaskFollowUps = new Map<string, PendingTaskPrompt[]>();
export const pendingTaskCancelWaits = new Map<string, () => void>();
export const runnerGracefulCancelDeadlineMs = 2_000;
export const runtimeAppIconPath = path.resolve(__dirname, "../../assets/brand/Umbratic/umbratic-icon-512.png");
export const textAttachmentByteLimit = 512 * 1024;
export const chatAttachmentByteLimit = 25 * 1024 * 1024;
export const imageAttachmentByteLimit = 10 * 1024 * 1024;
export const pdfAttachmentByteLimit = 25 * 1024 * 1024;
export const pdfImagePageLimit = 12;
export const promptImageCharacterLimit = 56 * 1024 * 1024;
export const pdfImageScale = 1.4;
export const pdfRenderTimeoutMs = 30000;
export const ocrDigestPromptByteLimit = 12000;
export const binarySnapshotPrefix = "__UMBRATIC_BINARY_FILE__:";
export const missingSnapshotValue = "__UMBRATIC_MISSING_FILE__";
export const windowChromeDark = "#15161a";
export const windowChromeLight = "#ffffff";
export const windowChromeSymbolDark = "#d7dce2";
export const windowChromeSymbolLight = "#111827";
export const windowChromeHeight = 35;

export function appIcon() {
  if (!fs.existsSync(runtimeAppIconPath)) return undefined;
  const icon = nativeImage.createFromPath(runtimeAppIconPath);
  return icon.isEmpty() ? undefined : icon;
}

export function clearPendingPermissionsForTask(taskIdValue: string) {
  for (const [id, pending] of Array.from(pendingPermissions.entries())) {
    if (pending.taskId !== taskIdValue) continue;
    pendingPermissions.delete(id);
    emit({ type: "permission.resolved", taskId: taskIdValue, id, decision: "deny" });
    void Promise.resolve(pending.onDeny()).catch(() => undefined);
  }
}

let mainWindow: BrowserWindow | null = null;

/// The renderer target. Owned here because event dispatch needs it, but only
/// window creation sets it.
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function setMainWindow(window: BrowserWindow | null): void {
  mainWindow = window;
}
// Read lazily, never at import time: this module loads at process start,
// before Electron is ready, and a settings read that fails there would
// silently pin the session to "normal" while SQLite says auto_safe — every
// status push and new task reads this value, so the saved choice would be
// overridden for the whole session.
let permissionMode: PermissionMode | null = null;

export function getPermissionMode(): PermissionMode {
  permissionMode ??= readPermissionModeSetting();
  return permissionMode;
}

export function setPermissionModeValue(mode: PermissionMode): void {
  permissionMode = mode;
}
export const pendingPermissions = new Map<string, PendingPermission>();
export const pendingTaskEvents = new Map<string, BackendUiEvent[]>();
export const contextThresholdState = new Map<string, { above75: boolean; above90: boolean }>();
export let pendingTaskEventFlushTimer: NodeJS.Timeout | null = null;
export const pendingRendererEvents: BackendUiEvent[] = [];
export let pendingRendererEventFlushTimer: NodeJS.Timeout | null = null;
// Streaming deltas stay in memory. An optional long crash checkpoint may flush
// the blob; durable writes happen on turn complete / fail / abort / permission wait.
export const streamingTaskEventCrashCheckpointMs = 30_000;
export const rendererEventFlushDelayMs = 20;

export function recordProductTelemetry(
  type: ProductTelemetryEventType,
  input: {
    taskId?: string;
    chatId?: string;
    repositoryId?: string;
    data?: Record<string, string | number | boolean>;
  } = {},
): void {
  const event = {
    id: crypto.randomUUID(),
    type,
    at: new Date().toISOString(),
    ...input,
  };
  try {
    writeProductTelemetryEvent(event);
    scheduleManagedTelemetrySync();
  } catch (error) {
    recordLocalDiagnostic({
      level: "error",
      source: "desktop",
      event: "product_telemetry.persist_failed",
      taskId: input.taskId,
      message: error instanceof Error ? error.message : String(error),
      data: { type, error },
    });
  }
}

export function pruneClosedTaskInternalSnapshots(task: TaskRecord): TaskRecord {
  if (
    task.baselineFiles &&
    (task.state === "completed" || task.state === "approved" || task.state === "merged" || task.state === "rejected")
  ) {
    const { baselineFiles: _baselineFiles, ...nextTask } = task;
    void _baselineFiles;
    return nextTask;
  }
  return task;
}

export function compactClosedTaskStorage() {
  const tasks = readTasks();
  let changed = false;
  const compacted = tasks.map((task) => {
    const nextTask = pruneClosedTaskInternalSnapshots(task);
    if (nextTask !== task) changed = true;
    return nextTask;
  });
  if (changed) {
    writeTasks(compacted);
  }
}

export function saveChat(chat: ChatRecord) {
  writeChat(chat);
}

export function applyTaskPolicyMetadata(task: TaskRecord) {
  task.runnerName = task.runnerName || umbraticRunnerName;
  task.runnerVersion = task.runnerVersion || umbraticRunnerVersion;
  task.policyVersion = task.policyVersion || umbraticPolicyVersion;
  if (task.model) {
    task.providerId = task.model.providerId;
    task.modelId = task.model.modelId;
    task.modelBaseUrlHost = baseUrlHost(task.model.baseUrl);
  }
}

export function takePendingTaskEvents(taskIdValue: string): BackendUiEvent[] {
  const events = pendingTaskEvents.get(taskIdValue) ?? [];
  pendingTaskEvents.delete(taskIdValue);
  return events;
}

export function taskWithAppendedEvents(task: TaskRecord, events: BackendUiEvent[]): TaskRecord {
  if (events.length === 0) return task;
  return {
    ...task,
    events: events.reduce<BackendUiEvent[]>((current, event) => appendTaskEvent(current, event, 500), task.events ?? []),
  };
}

export function flushPendingTaskEvents() {
  if (pendingTaskEventFlushTimer) {
    clearTimeout(pendingTaskEventFlushTimer);
    pendingTaskEventFlushTimer = null;
  }
  if (pendingTaskEvents.size === 0) return;
  const queued = Array.from(pendingTaskEvents.entries());
  pendingTaskEvents.clear();
  let changed = false;
  for (const [taskIdValue, events] of queued) {
    const task = readTask(taskIdValue);
    if (!task || events.length === 0) continue;
    writeTask(taskWithAppendedEvents(task, events), false);
    changed = true;
  }
  if (changed) scheduleManagedTelemetrySync();
}

export function shouldDeferTaskEventFlush(event: BackendUiEvent): boolean {
  return event.type === "assistant.delta" || event.type === "assistant.progress.delta" || event.type === "command.output";
}

export function scheduleTaskEventFlush(delayMs = streamingTaskEventCrashCheckpointMs) {
  if (pendingTaskEventFlushTimer) {
    if (delayMs > 0) return;
    clearTimeout(pendingTaskEventFlushTimer);
    pendingTaskEventFlushTimer = null;
  }
  pendingTaskEventFlushTimer = setTimeout(flushPendingTaskEvents, delayMs);
}

export function saveTask(task: TaskRecord) {
  applyTaskPolicyMetadata(task);
  const queuedEvents = takePendingTaskEvents(task.id);
  const taskWithQueuedEvents = pruneClosedTaskInternalSnapshots(taskWithAppendedEvents(task, queuedEvents));
  const existing = readTask(task.id);
  const taskEvents = compactTaskEvents(Array.isArray(taskWithQueuedEvents.events) ? taskWithQueuedEvents.events : [], 500);
  const existingEvents = compactTaskEvents(Array.isArray(existing?.events) ? existing.events : [], 500);
  const events = mergeTaskEvents(existingEvents, taskEvents);
  const nextTask = {
    ...taskWithQueuedEvents,
    events,
  };
  writeTask(nextTask);
  updateChatFromTask(nextTask);
  scheduleManagedTelemetrySync();
}

export function publicTask(task: TaskRecord): TaskInfo {
  const {
    id,
    chatId,
    worktreeRootTaskId,
    repositoryId,
    prompt,
    workspaceKind,
    workspaceMode,
    state,
    originalBranch,
    baseCommit,
    agentBranch,
    worktreePath,
    permissionMode: mode,
    reasoningMode,
    runnerName,
    runnerVersion,
    policyVersion,
    createdAt,
    changedFiles,
    reviewFiles,
    reviewPatchHash,
    reviewScope,
    reviewBaselineLabel,
    reviewBaselineOid,
    events,
    latestTest,
    patchHash,
    error,
  } = task;
  const ignoredReviewPaths = hiddenRendererReviewPaths(task);
  const publicReviewFiles = rendererReviewFiles(reviewFiles, ignoredReviewPaths);
  const publicEvents = compactTaskEvents(events, 500).map((event) => {
    if (event.type !== "review.ready") return event;
    return {
      ...event,
      changedFiles: filterReviewPaths(event.changedFiles, ignoredReviewPaths),
      reviewFiles: rendererReviewFiles(event.reviewFiles, ignoredReviewPaths),
    };
  });
  return {
    id,
    chatId,
    worktreeRootTaskId,
    repositoryId,
    prompt,
    workspaceKind,
    workspaceMode,
    state,
    originalBranch,
    baseCommit,
    agentBranch,
    worktreePath,
    permissionMode: mode,
    reasoningMode,
    runnerName,
    runnerVersion,
    policyVersion,
    createdAt,
    changedFiles: filterReviewPaths(changedFiles, ignoredReviewPaths),
    reviewFiles: publicReviewFiles,
    reviewPatchHash,
    reviewScope,
    reviewBaselineLabel,
    reviewBaselineOid,
    events: publicEvents,
    latestTest,
    patchHash,
    error,
  };
}

export function getTask(taskId: string): TaskRecord {
  const task = readTask(taskId);
  if (!task) {
    throw new Error("Task was not found.");
  }
  return task;
}

export function recordTaskEvent(event: BackendUiEvent) {
  if (isReviewReadyAssistantEvent(event) || event.type === "review.ready") return;
  const events = pendingTaskEvents.get(event.taskId) ?? [];
  pendingTaskEvents.set(event.taskId, appendTaskEvent(events, event, 500));
  scheduleTaskEventFlush(shouldDeferTaskEventFlush(event) ? streamingTaskEventCrashCheckpointMs : 0);
}

export function flushRendererEvents() {
  if (pendingRendererEventFlushTimer) {
    clearTimeout(pendingRendererEventFlushTimer);
    pendingRendererEventFlushTimer = null;
  }
  if (pendingRendererEvents.length === 0) return;
  const events = pendingRendererEvents.splice(0);
  for (const event of events) {
    getMainWindow()?.webContents.send("umbratic:backend-event", event);
  }
}

export function dispatchRendererEvent(event: BackendUiEvent) {
  if (!shouldBufferBackendEvent(event)) {
    flushRendererEvents();
    getMainWindow()?.webContents.send("umbratic:backend-event", event);
    return;
  }
  appendBufferedBackendEvent(pendingRendererEvents, event);
  if (!pendingRendererEventFlushTimer) {
    pendingRendererEventFlushTimer = setTimeout(flushRendererEvents, rendererEventFlushDelayMs);
  }
}

/**
 * Events reaching here are constructed by this process against the
 * `BackendUiEvent` type, so their shape is a compile-time fact. The runtime
 * boundary that needs a decoder is the runner's stream, and `decodeRunnerEvent`
 * is that decoder. Re-parsing our own typed values here only meant a shape bug
 * became a silently dropped event instead of a type error.
 */
export function persistBackendEvent(event: BackendUiEvent): BackendUiEvent {
  recordBackendEventDiagnostic(event);
  recordTaskEvent(event);
  dispatchRendererEvent(event);
  return event;
}

export function contextThresholdEvents(event: Extract<BackendUiEvent, { type: "context.usage" }>): BackendUiEvent[] {
  if (event.phase === "preflight" || event.source === "heuristic") return [];
  const previous = contextThresholdState.get(event.taskId) ?? { above75: false, above90: false };
  const ratio = event.contextLength > 0 ? event.estimatedTokens / event.contextLength : 0;
  const above75 = ratio >= 0.75;
  const above90 = ratio >= 0.9;
  contextThresholdState.set(event.taskId, { above75, above90 });
  const events: BackendUiEvent[] = [];
  if (above75 && !previous.above75) {
    events.push({
      type: "context.threshold",
      taskId: event.taskId,
      threshold: 75,
      contextLength: event.contextLength,
      estimatedTokens: event.estimatedTokens,
      at: event.at,
    });
  }
  if (above90 && !previous.above90) {
    events.push({
      type: "context.threshold",
      taskId: event.taskId,
      threshold: 90,
      contextLength: event.contextLength,
      estimatedTokens: event.estimatedTokens,
      at: event.at,
    });
  }
  return events;
}

export function emit(event: BackendUiEvent) {
  const stampedEvent = persistBackendEvent({
    ...event,
    at: event.at ?? new Date().toISOString(),
  });
  if (stampedEvent.type === "context.usage") {
    for (const thresholdEvent of contextThresholdEvents(stampedEvent)) {
      persistBackendEvent(thresholdEvent);
    }
  }
}

export function appendUserMessage(task: TaskRecord, text: string, attachedFiles: ChatAttachment[]) {
  const event: BackendUiEvent = {
    type: "user.message",
    taskId: task.id,
    text,
    attachedFiles,
    at: new Date().toISOString(),
  };
  task.events = appendTaskEvent(task.events ?? [], event, 500);
  saveTask(task);
  dispatchRendererEvent(event);
}

export function failTask(
  task: TaskRecord,
  message: string,
  details: { category?: string; code?: string; detail?: string } = {},
) {
  task.state = "failed";
  task.error = message;
  saveTask(task);
  recordLocalDiagnostic({
    level: "error",
    source: "task",
    event: "task.error",
    taskId: task.id,
    message,
    data: { category: details.category, code: details.code },
  });
  emit({ type: "task.error", taskId: task.id, message, ...details });
}

export function taskStillRunning(task: TaskRecord): boolean {
  return task.state === "running";
}
