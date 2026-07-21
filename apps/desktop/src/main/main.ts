import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  IpcMainInvokeEvent,
  Menu,
  MenuItemConstructorOptions,
  nativeImage,
  OpenDialogOptions,
  shell,
  session,
} from "electron";
import { execFile, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { chatTitleFromFirstMessage, stableChatTitle } from "../shared/chatTitle";
import {
  attachmentPromptTokenBudget,
  attachmentTextExcerpt,
  estimateAttachmentTextTokens,
  estimateTextTokens,
} from "../shared/contextWindow";

import {
  endpointEditingAllowed,
  localProviderCatalog,
  managedModelEndpointDefaults,
  taskStatesThatCanOpen,
} from "./config";
import {
  capabilityPromptGuidance,
  capabilityTelemetrySnapshot,
  probeLocalCapabilities,
  type CapabilityPromptNeeds,
} from "./capabilities";
import { promptLooksLikeArtifactTask, promptLooksLikeOcrTask, type OcrInputKind } from "./artifactRuntime";
import { materializedChatAttachmentReviewPaths, priorChatAttachments } from "./attachmentContext";
import { searchRootFiles } from "./fileSearch";
import { generateOcrDocument, writeOcrArtifacts, type OcrDocument, type OcrPageInput } from "./ocrRuntime";
import {
  beginRunnerEventStream,
  runnerRequest,
  runnerBinaryPath,
  runnerDiagnosticsDirectory,
  replyRunnerPermission,
  startUmbraticRunnerServer,
  stopRunnerProcess,
} from "./runnerAdapter";
import {
  umbraticPolicyVersion,
  umbraticRunnerContractVersion,
  umbraticRunnerName,
  umbraticRunnerVersion,
  allowedLocalProviderIds,
  baseUrlHost,
  classifyCommandText,
  isBlockedPath,
  isGeneratedRuntimePath,
  isLocalhostUrl,
  promptLooksLikeCmakeTask,
  promptLooksLikePythonTask,
  runtimeDiagnostics,
  telemetryPolicyForMode,
} from "./policy";
import { getProviderJson } from "./providerClient";
import { ensureLocalVeil, stopLocalVeil, currentLocalVeilConnection } from "./localVeil";
import { probeVeilContextLength, shouldProbeVeilContext } from "./veilContext";
import {
  readChat,
  readChats,
  hasStoredModelEndpointSettings,
  readContextLengthSetting,
  readLocalDiagnosticInfo,
  readLocalDiagnostics,
  readHarnessProfileSetting,
  readModelEndpointSettings,
  publicModelEndpointSettings,
  readNotes,
  readProjects,
  readProductTelemetryEvents,
  readTask,
  readTaskCheckpoints,
  readTasks,
  clearLocalDiagnostics,
  writeHarnessProfileSetting,
  writeContextLengthSetting,
  writeModelEndpointSettings,
  writeChat,
  writeChats,
  writeJsonFile,
  writeNotes,
  writeProjects,
  writeProductTelemetryEvent,
  writeTask,
  writeTasks,
} from "./storage";
import { recordBackendEventDiagnostic, recordLocalDiagnostic, sanitizeDiagnosticValue } from "./diagnostics";
import { buildRedactedTelemetryBundle } from "./telemetry";
import {
  syncTelemetryBundle,
  telemetrySpoolDirectory,
  uploadTelemetrySpool,
  type TelemetryUploadEndpoint,
} from "./telemetrySync";
import { enabledToolsFromSettings, normalizeEnabledTools } from "./toolSettings";
import { RunnerAssistantOutputBuffer, type BufferedRunnerAssistantOutput } from "./runnerAssistantOutput";
import { appendBufferedBackendEvent, shouldBufferBackendEvent } from "./backendEventBuffer";
import {
  applyHarnessSystemSkillSettings,
  createSkill as createSkillService,
  getSkillDocument as getSkillDocumentService,
  importSkill as importSkillService,
  installBundledSystemSkills as installBundledSystemSkillsService,
  listSkills as listSkillsService,
  resetSystemSkill as resetSystemSkillService,
  saveSkillDocument as saveSkillDocumentService,
  saveSkillSettings as saveSkillSettingsService,
  skillsDirectoryPath as skillsDirectoryPathService,
} from "./skills";
import type {
  ApproveResult,
  BackendStatus,
  BackendUiEvent,
  CapabilityProbeReport,
  ChatAttachment,
  ChatRecord,
  CommandClass,
  CommandOutput,
  CommandResult,
  ContextCompressionStrategy,
  ContextContentKind,
  ContextStateV1,
  FileSearchResult,
  HarnessProfileId,
  IdeInfo,
  IdeOpenResult,
  LocalModelInfo,
  LocalModelProvider,
  LocalDiagnosticInfo,
  ProductTelemetryEventType,
  RunnerProcess,
  RunnerToolId,
  PendingPermission,
  PermissionMode,
  PermissionRequest,
  PastedAttachmentInput,
  ReasoningMode,
  RepositoryInfo,
  ReviewFile,
  ServiceStatus,
  TelemetrySyncResult,
  TaskInfo,
  TaskCheckpoint,
  TaskRecord,
  TaskState,
  ToolErrorCode,
  ToolResultStatus,
  UserNotes,
  WorkspaceKind,
  WorkspaceMode,
} from "./types";
import { commandText, isRecord, normalizeRelativePath, pathInside, requiredString, shortHash, slugify } from "./utils";
import { normalizeReviewFile, parseGitPorcelainPaths } from "../shared/reviewDiff";
import {
  createTaskCheckpoint,
  ensurePreCleanupCheckpoint,
  forkTaskFromCheckpoint,
  removeTaskCheckpoint,
  restoreTaskCheckpoint,
  setTaskCheckpointPinned,
} from "./checkpoints/service";
import { reconcileCheckpointLifecycle } from "./checkpoints/reconcile";
import { codeLikeIdeArgs, macCodeLikeIdeArgs } from "./ideLaunch";
import { boundedRecentLines } from "./historyContext";
import { limitPromptImages, type ContextPromptPart } from "./promptContext";

const isDev = !app.isPackaged;
const desktopBenchmarkStartedAt = performance.now();
const fallbackDevServerUrl = "http://127.0.0.1:5173/";
type RunnerPromptPart = ContextPromptPart;
type RunnerPrompt = string | RunnerPromptPart[];
type PdfRenderWorkerResult =
  | { ok: true; pageCount: number; pages: Array<{ pageNumber: number; filePath: string }> }
  | { ok: false; error: string };

const activeRunnerProcesses = new Map<string, RunnerProcess>();
const activeStartTaskRequests = new Map<string, Promise<TaskInfo>>();
const recentStartTaskRequests = new Map<string, { taskId: string; expiresAt: number }>();
const pendingRunnerPrompts = new Map<string, RunnerPromptPart[]>();
const runtimeAppIconPath = path.resolve(__dirname, "../../assets/brand/Umbratic/umbratic-icon-512.png");
const textAttachmentByteLimit = 512 * 1024;
const chatAttachmentByteLimit = 25 * 1024 * 1024;
const imageAttachmentByteLimit = 10 * 1024 * 1024;
const pdfAttachmentByteLimit = 25 * 1024 * 1024;
const pdfImagePageLimit = 12;
const promptImageCharacterLimit = 56 * 1024 * 1024;
const pdfImageScale = 1.4;
const pdfRenderTimeoutMs = 30000;
const ocrDigestPromptByteLimit = 12000;
const binarySnapshotPrefix = "__UMBRATIC_BINARY_FILE__:";
const windowChromeDark = "#15161a";
const windowChromeLight = "#ffffff";
const windowChromeSymbolDark = "#d7dce2";
const windowChromeSymbolLight = "#111827";
const windowChromeHeight = 35;

function appIcon() {
  if (!fs.existsSync(runtimeAppIconPath)) return undefined;
  const icon = nativeImage.createFromPath(runtimeAppIconPath);
  return icon.isEmpty() ? undefined : icon;
}

function clearPendingPermissionsForTask(taskIdValue: string) {
  for (const [id, pending] of Array.from(pendingPermissions.entries())) {
    if (pending.taskId !== taskIdValue) continue;
    pendingPermissions.delete(id);
    emit({ type: "permission.resolved", taskId: taskIdValue, id, decision: "deny" });
    void Promise.resolve(pending.onDeny()).catch(() => undefined);
  }
}

app.enableSandbox();
app.setName("Umbratic");

const appDataDirectory = app.getPath("appData");
const benchmarkUserData = process.env.UMBRATIC_USER_DATA_DIR?.trim();
const cleanUserData = benchmarkUserData ? path.resolve(benchmarkUserData) : path.join(appDataDirectory, "Umbratic");
const legacyUserData = path.join(appDataDirectory, "Umbratic AI");
try {
  if (!fs.existsSync(cleanUserData) && fs.existsSync(legacyUserData)) {
    fs.cpSync(legacyUserData, cleanUserData, { recursive: true });
  }
  fs.mkdirSync(cleanUserData, { recursive: true });
  app.setPath("userData", cleanUserData);
  if (isDev) {
    app.commandLine.appendSwitch("disable-http-cache");
    app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
  }
} catch {
  /* Electron will use the default userData path. */
}

let mainWindow: BrowserWindow | null = null;
let permissionMode: PermissionMode = "normal";
const pendingPermissions = new Map<string, PendingPermission>();
const pendingTaskEvents = new Map<string, BackendUiEvent[]>();
const contextThresholdState = new Map<string, { above75: boolean; above90: boolean }>();
let pendingTaskEventFlushTimer: NodeJS.Timeout | null = null;
const pendingRendererEvents: BackendUiEvent[] = [];
let pendingRendererEventFlushTimer: NodeJS.Timeout | null = null;
let telemetrySyncTimer: NodeJS.Timeout | null = null;
const streamingTaskEventFlushDelayMs = 2000;
const rendererEventFlushDelayMs = 20;

function recordProductTelemetry(
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

function finishInterruptedRunningTasks() {
  const now = new Date().toISOString();
  const tasks = readTasks();
  let changed = false;
  const repaired = tasks.map((task) => {
    if (task.state !== "running") return task;
    const events = Array.isArray(task.events) ? [...task.events] : [];
    const started = events.filter((event) => event.type === "command.started");
    const finished = new Set(events.filter((event) => event.type === "command.finished").map((event) => event.id));
    for (const event of started) {
      if (finished.has(event.id)) continue;
      events.push({ type: "command.finished", taskId: task.id, id: event.id, exitCode: null });
      changed = true;
    }
    changed = true;
    return {
      ...task,
      state: "failed" as const,
      error: "Task was interrupted before Umbratic runner finished.",
      events: [
        ...events,
        {
          type: "task.error" as const,
          taskId: task.id,
          message: "Task was interrupted before Umbratic runner finished.",
        },
      ].slice(-500),
      latestTest: task.latestTest ?? {
        command: "umbratic runner session",
        output: "Task was interrupted before Umbratic runner finished.",
        passed: false,
        exitCode: null,
        completedAt: now,
      },
    };
  });
  if (changed) {
    writeTasks(repaired);
  }
}

function pruneClosedTaskInternalSnapshots(task: TaskRecord): TaskRecord {
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

function compactClosedTaskStorage() {
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

function saveChat(chat: ChatRecord) {
  writeChat(chat);
}

function isReviewReadyAssistantEvent(event: BackendUiEvent): boolean {
  return event.type === "assistant.delta" && event.text.trim() === "Ready for review.";
}

function visibleTaskEvents(events: BackendUiEvent[]): BackendUiEvent[] {
  return events.filter((event) => !isReviewReadyAssistantEvent(event));
}

function boundedTaskEvents(events: BackendUiEvent[], limit: number): BackendUiEvent[] {
  if (events.length <= limit) return events;
  const recent = events.slice(-limit);
  const retained = events.slice(0, -limit).filter(
    (event) => event.type === "user.message" || event.type === "assistant.delta" || event.type === "assistant.done"
      || event.type === "response.feedback" || event.type === "tool.failed" || event.type === "context.threshold",
  );
  return [...retained, ...recent];
}

function appendTaskEvent(events: BackendUiEvent[], event: BackendUiEvent, limit: number): BackendUiEvent[] {
  const existing = visibleTaskEvents(events);
  if (event.type === "response.feedback") {
    return boundedTaskEvents([
      ...existing.filter(
        (storedEvent) =>
          !(storedEvent.type === "response.feedback" && storedEvent.taskId === event.taskId && storedEvent.messageId === event.messageId),
      ),
      event,
    ], limit);
  }
  if (
    event.type === "user.message" &&
    event.at &&
    existing.some(
      (storedEvent) =>
        storedEvent.type === "user.message" &&
        storedEvent.at === event.at &&
        taskEventSignature(storedEvent) === taskEventSignature(event),
    )
  ) {
    return existing;
  }
  const last = existing.at(-1);
  if (
    last &&
    event.type === "user.message" &&
    last.type === "user.message" &&
    event.at &&
    last.at === event.at &&
    taskEventSignature(last) === taskEventSignature(event)
  ) {
    return existing;
  }
  if (
    last &&
    (event.type === "assistant.delta" || event.type === "assistant.reasoning.delta") &&
    last.type === event.type &&
    last.taskId === event.taskId
  ) {
    return boundedTaskEvents([
      ...existing.slice(0, -1),
      {
        ...last,
        text: `${last.text}${event.text}`,
        endedAt: event.endedAt ?? event.at ?? last.endedAt ?? last.at,
      },
    ], limit);
  }
  if (
    last &&
    event.type === "command.output" &&
    last.type === "command.output" &&
    last.taskId === event.taskId &&
    last.id === event.id &&
    last.stream === event.stream
  ) {
    return boundedTaskEvents([
      ...existing.slice(0, -1),
      {
        ...last,
        text: `${last.text}${event.text}`,
        endedAt: event.endedAt ?? event.at ?? last.endedAt ?? last.at,
      },
    ], limit);
  }
  return boundedTaskEvents([...existing, event], limit);
}

function compactTaskEvents(events: BackendUiEvent[], limit: number): BackendUiEvent[] {
  return events.reduce<BackendUiEvent[]>((current, event) => appendTaskEvent(current, event, limit), []);
}

function taskEventSignature(event: BackendUiEvent): string {
  if (event.type === "user.message") {
    return JSON.stringify({
      type: event.type,
      taskId: event.taskId,
      at: event.at,
      text: event.text,
      attachedFiles: (event.attachedFiles ?? []).map((file) => ({
        path: file.path,
        name: file.name,
        storedPath: file.storedPath,
        originalPath: file.originalPath,
      })),
    });
  }
  if (event.type === "assistant.delta" || event.type === "assistant.reasoning.delta") {
    return JSON.stringify({
      type: event.type,
      taskId: event.taskId,
      text: event.text,
    });
  }
  if (event.type === "assistant.done") {
    return JSON.stringify({
      type: event.type,
      taskId: event.taskId,
    });
  }
  return JSON.stringify(event);
}

function mergeTaskEvents(...groups: BackendUiEvent[][]): BackendUiEvent[] {
  const merged: BackendUiEvent[] = [];
  const mergedCounts = new Map<string, number>();
  for (const group of groups) {
    const groupCounts = new Map<string, number>();
    for (const event of group) {
      const signature = taskEventSignature(event);
      const groupCount = (groupCounts.get(signature) ?? 0) + 1;
      groupCounts.set(signature, groupCount);
      if (groupCount <= (mergedCounts.get(signature) ?? 0)) continue;
      mergedCounts.set(signature, groupCount);
      merged.push(event);
    }
  }
  return compactTaskEvents(merged, 500);
}

function applyTaskPolicyMetadata(task: TaskRecord) {
  task.runnerName = task.runnerName || umbraticRunnerName;
  task.runnerVersion = task.runnerVersion || umbraticRunnerVersion;
  task.policyVersion = task.policyVersion || umbraticPolicyVersion;
  if (task.model) {
    task.providerId = task.model.providerId;
    task.modelId = task.model.modelId;
    task.modelBaseUrlHost = baseUrlHost(task.model.baseUrl);
  }
}

function takePendingTaskEvents(taskIdValue: string): BackendUiEvent[] {
  const events = pendingTaskEvents.get(taskIdValue) ?? [];
  pendingTaskEvents.delete(taskIdValue);
  return events;
}

function taskWithAppendedEvents(task: TaskRecord, events: BackendUiEvent[]): TaskRecord {
  if (events.length === 0) return task;
  return {
    ...task,
    events: events.reduce<BackendUiEvent[]>((current, event) => appendTaskEvent(current, event, 500), task.events ?? []),
  };
}

function flushPendingTaskEvents() {
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

function shouldDeferTaskEventFlush(event: BackendUiEvent): boolean {
  return event.type === "assistant.delta" || event.type === "assistant.reasoning.delta" || event.type === "command.output";
}

function scheduleTaskEventFlush(delayMs = streamingTaskEventFlushDelayMs) {
  if (pendingTaskEventFlushTimer) {
    if (delayMs > 0) return;
    clearTimeout(pendingTaskEventFlushTimer);
    pendingTaskEventFlushTimer = null;
  }
  pendingTaskEventFlushTimer = setTimeout(flushPendingTaskEvents, delayMs);
}

function saveTask(task: TaskRecord) {
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

function publicTask(task: TaskRecord): TaskInfo {
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
  const ignoredReviewPaths = hiddenChatAttachmentReviewPaths(task);
  const publicReviewFiles = filterReviewFiles(reviewFiles, ignoredReviewPaths);
  const publicEvents = compactTaskEvents(events, 500).map((event) => {
    if (event.type !== "review.ready") return event;
    return {
      ...event,
      changedFiles: filterReviewPaths(event.changedFiles, ignoredReviewPaths),
      reviewFiles: filterReviewFiles(event.reviewFiles, ignoredReviewPaths),
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

function hiddenChatAttachmentReviewPaths(task: TaskRecord): Set<string> {
  return materializedChatAttachmentReviewPaths(task.events ?? [], isHiddenChatTask(task));
}

function filterReviewPaths(files: readonly string[], ignoredPaths: ReadonlySet<string>): string[] {
  if (ignoredPaths.size === 0) return [...files];
  return files.filter((file) => !ignoredPaths.has(normalizeRelativePath(file)));
}

function filterReviewFiles(files: readonly ReviewFile[], ignoredPaths: ReadonlySet<string>): ReviewFile[] {
  if (ignoredPaths.size === 0) return [...files];
  return files.filter((file) => !ignoredPaths.has(normalizeRelativePath(file.path)));
}

function getTask(taskId: string): TaskRecord {
  const task = readTask(taskId);
  if (!task) {
    throw new Error("Task was not found.");
  }
  return task;
}

function taskUsesIsolatedWorktree(task: TaskRecord): boolean {
  return task.workspaceKind === "git" && task.workspaceMode === "worktree" && !!task.agentBranch;
}

function taskCanHostWorktreeChats(task: TaskRecord): boolean {
  return (
    taskUsesIsolatedWorktree(task) &&
    task.state !== "merged" &&
    task.state !== "rejected" &&
    !!task.worktreePath &&
    fs.existsSync(task.worktreePath) &&
    pathInside(worktreeRootForRepo(task.originalRepoPath), task.worktreePath)
  );
}

function worktreeRootTaskId(task: TaskRecord): string {
  return task.worktreeRootTaskId ?? task.id;
}

function findReusableWorktreeTask(taskIdValue?: string): TaskRecord | undefined {
  if (!taskIdValue || !/^task-[A-Za-z0-9_-]+$/.test(taskIdValue)) return undefined;
  return readTasks().find((row) => (row.id === taskIdValue || row.worktreeRootTaskId === taskIdValue) && taskCanHostWorktreeChats(row));
}

function worktreeHasActiveRun(worktreePath: string): boolean {
  const target = pathKey(worktreePath);
  for (const task of readTasks()) {
    if (!task.worktreePath || pathKey(task.worktreePath) !== target) continue;
    if (activeRunnerProcesses.has(task.id) || task.state === "running" || task.state === "awaiting_worktree_approval" || task.state === "approving") {
      return true;
    }
  }
  return false;
}

function assertReusableWorktreeForRepository(task: TaskRecord, repository: RepositoryInfo) {
  if (!taskCanHostWorktreeChats(task)) {
    throw new Error("This worktree is no longer open. Start a new worktree chat from the project.");
  }
  if (pathKey(task.originalRepoPath) !== pathKey(repository.rootPath)) {
    throw new Error("This worktree belongs to a different project.");
  }
  if (worktreeHasActiveRun(task.worktreePath)) {
    throw new Error("This worktree already has a chat in progress.");
  }
}

function chatWorktreeTaskId(chat?: ChatRecord): string | undefined {
  if (chat?.worktreeRootTaskId && /^task-[A-Za-z0-9_-]+$/.test(chat.worktreeRootTaskId)) {
    return chat.worktreeRootTaskId;
  }
  if (chat?.taskId && /^task-[A-Za-z0-9_-]+$/.test(chat.taskId)) {
    return chat.taskId;
  }
  return undefined;
}

function taskEnabledTools(task: TaskRecord): RunnerToolId[] {
  return normalizeEnabledTools(task.enabledTools, enabledToolsFromSettings({}));
}

function publicTaskById(input: unknown): TaskInfo | null {
  if (!isRecord(input) || typeof input.taskId !== "string" || !input.taskId.trim()) {
    return null;
  }
  const taskIdValue = input.taskId.trim();
  const task = readTask(taskIdValue);
  return task ? publicTask(task) : null;
}

type TaskCheckpointView = Pick<
  TaskCheckpoint,
  "id" | "source" | "label" | "createdAt" | "state" | "pinned" | "logicalBytes"
>;

function checkpointView(checkpoint: TaskCheckpoint): TaskCheckpointView {
  const { id, source, label, createdAt, state, pinned, logicalBytes } = checkpoint;
  return { id, source, ...(label ? { label } : {}), createdAt, state, pinned, ...(logicalBytes !== undefined ? { logicalBytes } : {}) };
}

function checkpointEligibility(task: TaskRecord, requireIdle = true, requireActiveWorktree = true): { supported: boolean; reason?: string } {
  if (task.workspaceKind !== "git" || task.workspaceMode !== "worktree" || !task.agentBranch) {
    return { supported: false, reason: "Checkpoints are available for Umbratic-owned Git task worktrees." };
  }
  if (requireIdle && (activeRunnerProcesses.has(task.id) || task.state === "running" || task.state === "approving")) {
    return { supported: false, reason: "Wait for the current task operation to finish before changing checkpoints." };
  }
  const managedRoot = worktreeRootForRepo(task.originalRepoPath);
  if (!task.worktreePath || !pathInside(managedRoot, task.worktreePath)) {
    return { supported: false, reason: "The active task worktree is missing or is outside Umbratic's managed worktree root." };
  }
  if (requireActiveWorktree && !fs.existsSync(task.worktreePath)) {
    return { supported: false, reason: "The active task worktree is missing. A ready checkpoint can still be restored." };
  }
  return { supported: true };
}

function checkpointTask(input: unknown): TaskRecord {
  if (!isRecord(input)) throw new Error("Invalid checkpoint input.");
  const task = getTask(requiredString(input.taskId, "taskId"));
  const eligibility = checkpointEligibility(task);
  if (!eligibility.supported) throw new Error(eligibility.reason);
  return task;
}

function lifecycleDurationBucket(startedAt: number): string {
  const duration = performance.now() - startedAt;
  if (duration < 100) return "lt_100ms";
  if (duration < 500) return "100_499ms";
  if (duration < 2000) return "500_1999ms";
  return "gte_2s";
}

function checkpointByteBucket(bytes?: number): string {
  if (!bytes || bytes < 1024) return "lt_1kib";
  if (bytes < 1024 * 1024) return "1kib_1mib";
  if (bytes < 100 * 1024 * 1024) return "1mib_100mib";
  return "gte_100mib";
}

function listTaskCheckpoints(input: unknown): {
  supported: boolean;
  reason?: string;
  changedFileCount: number;
  checkpoints: TaskCheckpointView[];
} {
  if (!isRecord(input)) throw new Error("Invalid checkpoint input.");
  const task = getTask(requiredString(input.taskId, "taskId"));
  return {
    ...checkpointEligibility(task),
    changedFileCount: task.changedFiles.length,
    checkpoints: readTaskCheckpoints(task.id).map(checkpointView),
  };
}

async function createCheckpoint(input: unknown): Promise<TaskCheckpointView> {
  const task = checkpointTask(input);
  const startedAt = performance.now();
  recordProductTelemetry("checkpoint.started", { taskId: task.id, repositoryId: task.repositoryId });
  try {
    const label = isRecord(input) && typeof input.label === "string" ? input.label : undefined;
    const checkpoint = await createTaskCheckpoint(task, "manual", label);
    saveTask(task);
    recordProductTelemetry("checkpoint.completed", {
      taskId: task.id,
      repositoryId: task.repositoryId,
      data: {
        durationBucket: lifecycleDurationBucket(startedAt),
        changedFileCount: task.changedFiles.length,
        byteBucket: checkpointByteBucket(checkpoint.logicalBytes),
      },
    });
    return checkpointView(checkpoint);
  } catch (error) {
    recordProductTelemetry("checkpoint.failed", {
      taskId: task.id,
      repositoryId: task.repositoryId,
      data: { durationBucket: lifecycleDurationBucket(startedAt) },
    });
    throw error;
  }
}

async function setCheckpointPinned(input: unknown): Promise<TaskCheckpointView> {
  const task = checkpointTask(input);
  if (!isRecord(input) || typeof input.pinned !== "boolean") throw new Error("Invalid checkpoint pin input.");
  return checkpointView(setTaskCheckpointPinned(task.id, requiredString(input.checkpointId, "checkpointId"), input.pinned));
}

async function deleteCheckpoint(input: unknown): Promise<void> {
  const task = checkpointTask(input);
  if (!isRecord(input)) throw new Error("Invalid checkpoint delete input.");
  await removeTaskCheckpoint(task, requiredString(input.checkpointId, "checkpointId"));
  saveTask(task);
}

async function forkCheckpoint(input: unknown): Promise<TaskInfo> {
  const sourceTask = checkpointTask(input);
  if (!isRecord(input)) throw new Error("Invalid checkpoint fork input.");
  const checkpointId = requiredString(input.checkpointId, "checkpointId");
  const startedAt = performance.now();
  const id = taskId();
  const targetTask: TaskRecord = {
    ...sourceTask,
    id,
    worktreeRootTaskId: id,
    prompt: `Forked from checkpoint ${checkpointId}`,
    state: "completed",
    agentBranch: `umbratic/${id}-fork`,
    worktreePath: path.join(worktreeRootForRepo(sourceTask.originalRepoPath), id),
    createdAt: new Date().toISOString(),
    changedFiles: [],
    reviewFiles: [],
    events: [],
    runnerSessionId: undefined,
    diagnosticLogPath: undefined,
    pendingPrompt: undefined,
    metadataPath: undefined,
    approvedAt: undefined,
    mergedAt: undefined,
    rejectedAt: undefined,
    activeWorkspaceId: undefined,
    latestCheckpointId: undefined,
    parentTaskId: sourceTask.id,
    sourceCheckpointId: checkpointId,
    reviewPatchHash: undefined,
    reviewBaselineLabel: "Fork checkpoint",
    reviewBaselineOid: undefined,
    patchHash: undefined,
    error: undefined,
  };
  try {
    const forked = await forkTaskFromCheckpoint({
      sourceTask,
      targetTask,
      checkpointId,
      managedRoot: worktreeRootForRepo(sourceTask.originalRepoPath),
    });
    saveTask(forked);
    recordProductTelemetry("fork.completed", {
      taskId: forked.id,
      chatId: forked.chatId,
      repositoryId: forked.repositoryId,
      data: { durationBucket: lifecycleDurationBucket(startedAt) },
    });
    return publicTask(forked);
  } catch (error) {
    recordProductTelemetry("fork.failed", {
      taskId: sourceTask.id,
      repositoryId: sourceTask.repositoryId,
      data: { durationBucket: lifecycleDurationBucket(startedAt) },
    });
    throw error;
  }
}

async function stopTaskForRestore(task: TaskRecord): Promise<void> {
  pendingRunnerPrompts.delete(task.id);
  clearPendingPermissionsForTask(task.id);
  const run = activeRunnerProcesses.get(task.id);
  if (!run) return;
  activeRunnerProcesses.delete(task.id);
  if (run.sessionId) {
    await runnerRequest<boolean>(run, `/session/${encodeURIComponent(run.sessionId)}/abort`, { method: "POST" }).catch(() => undefined);
  }
  stopRunnerProcess(run);
  if (run.child.exitCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      run.child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

async function restoreCheckpoint(input: unknown): Promise<TaskInfo> {
  if (!isRecord(input) || input.confirmed !== true) throw new Error("Restore confirmation is required.");
  const task = getTask(requiredString(input.taskId, "taskId"));
  const eligibility = checkpointEligibility(task, false, false);
  if (!eligibility.supported) throw new Error(eligibility.reason);
  const checkpointId = requiredString(input.checkpointId, "checkpointId");
  const startedAt = performance.now();
  recordProductTelemetry("restore.started", { taskId: task.id, repositoryId: task.repositoryId });
  await stopTaskForRestore(task);
  try {
    const restored = await restoreTaskCheckpoint({
      task,
      checkpointId,
      managedRoot: worktreeRootForRepo(task.originalRepoPath),
      skipRecoveryCheckpoint: !fs.existsSync(task.worktreePath),
    });
    saveTask(restored);
    recordProductTelemetry("restore.completed", {
      taskId: restored.id,
      repositoryId: restored.repositoryId,
      data: { durationBucket: lifecycleDurationBucket(startedAt) },
    });
    return publicTask(restored);
  } catch (error) {
    recordProductTelemetry("restore.failed", {
      taskId: task.id,
      repositoryId: task.repositoryId,
      data: { durationBucket: lifecycleDurationBucket(startedAt) },
    });
    throw error;
  }
}

function stableRepositoryId(rootPath: string): string {
  return crypto.createHash("sha256").update(path.resolve(rootPath).toLowerCase()).digest("hex").slice(0, 16);
}

function hiddenChatWorkspacePath(chatIdValue: string): string {
  return path.join(os.homedir(), ".umbratic", "chats", chatIdValue);
}

function hiddenChatRepository(chatIdValue: string): RepositoryInfo {
  const root = hiddenChatWorkspacePath(chatIdValue);
  fs.mkdirSync(root, { recursive: true });
  return {
    id: `hidden-${chatIdValue}`,
    name: "Unattached chat",
    rootPath: root,
    kind: "folder",
    originalBranch: "folder",
    baseCommit: crypto.createHash("sha256").update(`${root}:${Date.now()}`).digest("hex"),
    dirty: false,
    statusSummary: "hidden workspace",
  };
}

function isHiddenChatTask(task: TaskRecord): boolean {
  return !!task.chatId && task.repositoryId === `hidden-${task.chatId}` && path.resolve(task.originalRepoPath) === hiddenChatWorkspacePath(task.chatId);
}

function taskId(): string {
  return `task-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

function chatId(): string {
  return `chat-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

function chatAttachmentRoot(): string {
  return path.join(app.getPath("userData"), "chat-attachments");
}

function safeChatId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96) || "chat";
}

function chatAttachmentDirectory(chatIdValue: string): string {
  return path.join(chatAttachmentRoot(), safeChatId(chatIdValue));
}

function safeAttachmentFileName(value: string): string {
  const ext = path.extname(value).replace(/[^A-Za-z0-9.]/g, "").slice(0, 18);
  const stem = path
    .basename(value, path.extname(value))
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${stem || "attachment"}${ext}`;
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "application/pdf":
      return ".pdf";
    case "text/plain":
      return ".txt";
    case "text/markdown":
      return ".md";
    default:
      return "";
  }
}

function parseAttachmentDataUrl(value: string): { mimeType: string; buffer: Buffer } | null {
  const match = value.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) return null;
  const mimeType = (match[1] || "application/octet-stream").trim().toLowerCase();
  const payload = match[3] || "";
  try {
    const buffer = match[2]
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    return { mimeType, buffer };
  } catch {
    return null;
  }
}

function chatAttachmentFromRecord(file: Record<string, unknown>, chatIdValue: string): ChatAttachment | null {
  const rawPath = typeof file.path === "string" ? file.path.trim() : "";
  const rawName = typeof file.name === "string" && file.name.trim() ? file.name.trim().slice(0, 120) : "";
  const rawStoredPath = typeof file.storedPath === "string" ? file.storedPath.trim() : "";
  if (file.source !== "chat" || !rawStoredPath) return null;
  const storedPath = path.resolve(rawStoredPath);
  if (!pathInside(chatAttachmentDirectory(chatIdValue), storedPath) || !fs.existsSync(storedPath)) return null;
  const originalPath =
    typeof file.originalPath === "string" && file.originalPath.trim() ? file.originalPath.trim().slice(0, 500) : undefined;
  const name = rawName || path.basename(storedPath);
  const previewDataUrl =
    typeof file.previewDataUrl === "string" && file.previewDataUrl.startsWith("data:image/")
      ? file.previewDataUrl
      : imagePreviewDataUrl(storedPath);
  return {
    path: rawPath || `attachments/${path.basename(storedPath)}`,
    name,
    source: "chat",
    storedPath,
    originalPath,
    previewDataUrl,
    contextTokens: attachmentContextTokens(storedPath),
  };
}

function parseReasoningMode(value: unknown): ReasoningMode {
  void value;
  return "reasoning";
}

function createChat(input: unknown): ChatRecord {
  const requestedId =
    isRecord(input) && typeof input.id === "string" && /^chat-[A-Za-z0-9_-]+$/.test(input.id)
      ? input.id
      : undefined;
  const title =
    isRecord(input) && typeof input.title === "string" && input.title.trim()
      ? input.title.trim().slice(0, 72)
      : "New chat";
  const repositoryName =
    isRecord(input) && typeof input.repositoryName === "string" && input.repositoryName.trim()
      ? input.repositoryName.trim().slice(0, 120)
      : undefined;
  const repositoryPath =
    isRecord(input) && typeof input.repositoryPath === "string" && input.repositoryPath.trim()
      ? path.resolve(input.repositoryPath.trim())
      : undefined;
  const requestedWorktreeTaskId =
    isRecord(input) && typeof input.worktreeTaskId === "string" && input.worktreeTaskId.trim()
      ? input.worktreeTaskId.trim()
      : isRecord(input)
        ? chatWorktreeTaskId(input as ChatRecord)
        : undefined;
  const reusableWorktree = findReusableWorktreeTask(requestedWorktreeTaskId);
  if (requestedWorktreeTaskId && !reusableWorktree) {
    throw new Error("This worktree is no longer open. Start a new worktree chat from the project.");
  }
  const now = new Date().toISOString();
  const chat: ChatRecord = {
    id: requestedId ?? chatId(),
    title,
    createdAt: now,
    updatedAt: now,
    repositoryName,
    repositoryPath,
    worktreeRootTaskId: reusableWorktree ? worktreeRootTaskId(reusableWorktree) : undefined,
    worktreePath: reusableWorktree?.worktreePath,
    worktreeBranch: reusableWorktree?.agentBranch,
    worktreeBaseCommit: reusableWorktree?.baseCommit,
    draftPrompt: "",
    attachedFiles: [],
  };
  saveChat(chat);
  return chat;
}

function updateChatDraft(input: unknown): ChatRecord {
  if (!isRecord(input)) {
    throw new Error("Invalid chat draft input.");
  }
  const id = requiredString(input.chatId, "chatId");
  const existing = readChat(id);
  if (!existing) {
    throw new Error("Chat was not found.");
  }
  const attachedFiles = Array.isArray(input.attachedFiles)
    ? input.attachedFiles
        .filter((file): file is Record<string, unknown> => isRecord(file))
        .map((file) => {
          const chatAttachment = chatAttachmentFromRecord(file, id);
          if (chatAttachment) return chatAttachment;
          const relativePath = typeof file.path === "string" ? normalizeRelativePath(file.path).slice(0, 260) : "";
          const workspaceRoot = existing.worktreePath || existing.repositoryPath;
          const absolute = workspaceRoot && relativePath ? path.resolve(workspaceRoot, relativePath) : "";
          return {
            path: relativePath,
            name: typeof file.name === "string" ? file.name.slice(0, 120) : "",
            source: file.source === "workspace" ? "workspace" as const : undefined,
            previewDataUrl:
              typeof file.previewDataUrl === "string" && file.previewDataUrl.startsWith("data:image/")
                ? file.previewDataUrl
                : undefined,
            contextTokens:
              absolute && workspaceRoot && pathInside(workspaceRoot, absolute) && fs.existsSync(absolute)
                ? attachmentContextTokens(absolute)
                : undefined,
          };
        })
        .filter((file) => file.path && file.name)
        .slice(0, 16)
    : existing.attachedFiles ?? [];
  const draftPrompt = typeof input.draftPrompt === "string" ? input.draftPrompt.slice(0, 12000) : existing.draftPrompt ?? "";
  const next: ChatRecord = {
    ...existing,
    draftPrompt,
    attachedFiles,
    updatedAt: new Date().toISOString(),
  };
  writeChat(next);
  return next;
}

function updateChatProject(input: unknown): ChatRecord {
  if (!isRecord(input)) {
    throw new Error("Invalid chat project input.");
  }
  const id = requiredString(input.chatId, "chatId");
  const repositoryName = requiredString(input.repositoryName, "repositoryName").slice(0, 120);
  const repositoryPath = path.resolve(requiredString(input.repositoryPath, "repositoryPath"));
  const existing = readChat(id);
  if (!existing) {
    throw new Error("Chat was not found.");
  }
  const next: ChatRecord = {
    ...existing,
    repositoryName,
    repositoryPath,
  };
  writeChat(next);
  return next;
}

function deleteChat(input: unknown): { ok: true } {
  if (!isRecord(input)) {
    throw new Error("Invalid chat delete input.");
  }
  const id = requiredString(input.chatId, "chatId");
  if (!/^chat-[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error("Invalid chat id.");
  }
  writeChats(readChats().filter((chat) => chat.id !== id));
  deleteChatManagedFiles(id);
  return { ok: true };
}

function pathKey(pathValue: string): string {
  const resolved = path.resolve(pathValue);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function repositoryPathFromInput(input: unknown, action: string): string {
  if (!isRecord(input)) {
    throw new Error(`Invalid ${action} input.`);
  }
  return path.resolve(requiredString(input.repositoryPath, "repositoryPath"));
}

function deleteChatManagedFiles(chatIdValue: string) {
  fs.rmSync(hiddenChatWorkspacePath(chatIdValue), { recursive: true, force: true });
  fs.rmSync(chatAttachmentDirectory(chatIdValue), { recursive: true, force: true });
}

function deleteChatsForRepositoryPath(repositoryPath: string): string[] {
  const targetKey = pathKey(repositoryPath);
  const chats = readChats();
  const deleted = chats.filter((chat) => chat.repositoryPath && pathKey(chat.repositoryPath) === targetKey);
  if (!deleted.length) return [];
  writeChats(chats.filter((chat) => !chat.repositoryPath || pathKey(chat.repositoryPath) !== targetKey));
  for (const chat of deleted) {
    deleteChatManagedFiles(chat.id);
  }
  return deleted.map((chat) => chat.id);
}

function deleteProjectChats(input: unknown): { ok: true; deletedChatIds: string[] } {
  const repositoryPath = repositoryPathFromInput(input, "project chat delete");
  return { ok: true, deletedChatIds: deleteChatsForRepositoryPath(repositoryPath) };
}

function deleteProject(input: unknown): { ok: true; deletedChatIds: string[] } {
  const repositoryPath = repositoryPathFromInput(input, "project delete");
  const repositoryKey = pathKey(repositoryPath);
  const deletedChatIds = deleteChatsForRepositoryPath(repositoryPath);
  writeProjects(readProjects().filter((project) => pathKey(project.rootPath) !== repositoryKey));
  return { ok: true, deletedChatIds };
}

function getNotes(): UserNotes {
  return readNotes();
}

function updateNotes(input: unknown): UserNotes {
  if (!isRecord(input)) {
    throw new Error("Invalid notes input.");
  }
  const content = typeof input.content === "string" ? input.content.slice(0, 50000) : "";
  return writeNotes(content);
}

function updateChatFromTask(task: TaskRecord) {
  if (!task.chatId) {
    return;
  }
  const existing = readChat(task.chatId);
  const repository = task.hiddenWorkspace ? undefined : readProjects().find((project) => project.id === task.repositoryId);
  const isolatedWorktree = taskUsesIsolatedWorktree(task);
  const next: ChatRecord = {
    id: task.chatId,
    title: stableChatTitle(existing?.title, task.prompt),
    createdAt: existing?.createdAt ?? task.createdAt,
    updatedAt: new Date().toISOString(),
    taskId: task.id,
    taskState: task.state,
    repositoryName: repository?.name ?? existing?.repositoryName,
    repositoryPath: repository?.rootPath ?? existing?.repositoryPath,
    changedFiles: task.changedFiles.length,
    worktreeRootTaskId: isolatedWorktree ? worktreeRootTaskId(task) : undefined,
    worktreePath: isolatedWorktree ? task.worktreePath : undefined,
    worktreeBranch: isolatedWorktree ? task.agentBranch : undefined,
    worktreeBaseCommit: isolatedWorktree ? task.baseCommit : undefined,
    draftPrompt: existing?.draftPrompt ?? "",
    attachedFiles: existing?.attachedFiles ?? [],
  };
  writeChat(next);
}

const ignoredSnapshotDirectories = new Set([
  ".git",
  ".umbratic",
  ".venv",
  "venv",
  "node_modules",
  "dist",
  "dist-electron",
  "target",
  "build",
  "coverage",
  ".next",
  ".vite",
]);

function textLines(value: string): string[] {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function readTextFileIfSafe(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > textAttachmentByteLimit) {
      return null;
    }
    const buffer = fs.readFileSync(filePath);
    if (buffer.includes(0)) {
      return null;
    }
    return buffer.toString("utf8");
  } catch {
    return null;
  }
}

function readAttachmentTextIfSafe(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > chatAttachmentByteLimit) return null;
    const buffer = fs.readFileSync(filePath);
    if (buffer.includes(0)) return null;
    return buffer.toString("utf8");
  } catch {
    return null;
  }
}

function attachmentContextTokens(filePath: string): number | undefined {
  const text = readAttachmentTextIfSafe(filePath);
  return text === null ? undefined : estimateAttachmentTextTokens(text);
}

function binarySnapshotValue(stat: fs.Stats): string {
  return `${binarySnapshotPrefix}${stat.size}:${Math.floor(stat.mtimeMs)}`;
}

function isBinarySnapshotValue(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(binarySnapshotPrefix);
}

function isPdfFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".pdf";
}

function imageMimeType(filePath: string): string | null {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return null;
  }
}

function ocrInputKindForPath(filePath: string): OcrInputKind | null {
  if (isPdfFile(filePath)) return "pdf";
  return imageMimeType(filePath) ? "image" : null;
}

function attachmentPathHint(file: ChatAttachment): string {
  if (file.source === "chat" && typeof file.storedPath === "string" && file.storedPath.trim()) {
    return file.storedPath;
  }
  return file.path || file.name;
}

function ocrInputKindsForAttachments(attachments: ChatAttachment[]): OcrInputKind[] {
  const kinds = new Set<OcrInputKind>();
  for (const file of attachments) {
    const kind = ocrInputKindForPath(attachmentPathHint(file));
    if (kind) kinds.add(kind);
  }
  return [...kinds];
}

function imageDataUrlIfSafe(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    const mimeType = imageMimeType(filePath);
    if (!mimeType || !stat.isFile() || stat.size > imageAttachmentByteLimit) {
      return null;
    }
    const buffer = fs.readFileSync(filePath);
    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

function imagePreviewDataUrl(filePath: string): string | undefined {
  try {
    if (!imageMimeType(filePath)) return undefined;
    const image = nativeImage.createFromPath(filePath);
    if (image.isEmpty()) return undefined;
    const size = image.getSize();
    const longestSide = Math.max(size.width, size.height);
    const thumbnail = longestSide > 220
      ? image.resize({
          width: size.width >= size.height ? 220 : undefined,
          height: size.height > size.width ? 220 : undefined,
          quality: "good",
        })
      : image;
    return thumbnail.toDataURL();
  } catch {
    return undefined;
  }
}

function isPdfRenderWorkerResult(value: unknown): value is PdfRenderWorkerResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) {
    return typeof value.error === "string";
  }
  return (
    typeof value.pageCount === "number" &&
    Number.isInteger(value.pageCount) &&
    value.pageCount >= 0 &&
    Array.isArray(value.pages) &&
    value.pages.every(
      (page) =>
        isRecord(page) &&
        typeof page.pageNumber === "number" &&
        Number.isInteger(page.pageNumber) &&
        page.pageNumber > 0 &&
        typeof page.filePath === "string",
    )
  );
}

async function renderPdfAttachmentInWorker(filePath: string, outputDir: string): Promise<PdfRenderWorkerResult | null> {
  const workerPath = path.resolve(__dirname, "pdfRendererWorker.js");
  if (!fs.existsSync(workerPath)) {
    return null;
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  if ((process.versions as NodeJS.ProcessVersions & { electron?: string }).electron) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  const child = spawn(process.execPath, [workerPath], {
    cwd: path.dirname(workerPath),
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: PdfRenderWorkerResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      child.removeAllListeners("message");
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, pdfRenderTimeoutMs);

    child.stdout?.on("data", () => undefined);
    child.stderr?.on("data", () => undefined);
    child.once("message", (message: unknown) => {
      finish(isPdfRenderWorkerResult(message) ? message : null);
    });
    child.once("error", () => finish(null));
    child.once("exit", () => finish(null));

    if (typeof child.send !== "function") {
      finish(null);
      return;
    }
    child.send(
      {
        filePath,
        outputDir,
        pageLimit: pdfImagePageLimit,
        scale: pdfImageScale,
        byteLimit: pdfAttachmentByteLimit,
      },
      (error) => {
        if (error) finish(null);
      },
    );
  });
}

async function pdfAttachmentImageParts(filePath: string): Promise<{ pageCount: number; rendered: number; parts: RunnerPromptPart[] } | null> {
  let outputDir: string | null = null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > pdfAttachmentByteLimit) {
      return null;
    }
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-pdf-"));
    const result = await renderPdfAttachmentInWorker(filePath, outputDir);
    if (!result?.ok) {
      return null;
    }
    const pages = result.pages.slice().sort((left, right) => left.pageNumber - right.pageNumber);
    const parts: RunnerPromptPart[] = [];
    for (const page of pages) {
      const pagePath = path.resolve(page.filePath);
      if (!pathInside(outputDir, pagePath) || !fs.existsSync(pagePath)) {
        return null;
      }
      const png = fs.readFileSync(pagePath);
      parts.push({ type: "text", text: `PDF page ${page.pageNumber}:` });
      parts.push({ type: "image", data_url: `data:image/png;base64,${png.toString("base64")}` });
    }
    return { pageCount: result.pageCount, rendered: pages.length, parts };
  } catch {
    return null;
  } finally {
    if (outputDir) {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }
}

type OcrAttachmentArtifactResult =
  | {
      status: "created";
      jsonPath: string;
      markdownPath: string;
      markdown: string;
      document: OcrDocument;
    }
  | { status: "missing" | "failed"; message: string };

function ocrArtifactOutputDirectory(rootPath: string): string {
  return path.join(rootPath, ".umbratic", "artifacts", "ocr");
}

function ocrArtifactBaseName(label: string, document: OcrDocument, fallback: string): string {
  const stem = slugify(path.basename(label, path.extname(label)) || label);
  const sourceHash = document.source.sha256?.replace(/^sha256:/, "").slice(0, 12) || shortHash(fallback);
  return `${stem}-${sourceHash}`;
}

function ocrPromptDigest(markdown: string): string {
  if (Buffer.byteLength(markdown, "utf8") <= ocrDigestPromptByteLimit) return markdown.trim();
  const buffer = Buffer.from(markdown, "utf8").subarray(0, ocrDigestPromptByteLimit);
  return `${buffer.toString("utf8").trimEnd()}\n\n...(OCR digest truncated for prompt size; full OCR artifact is saved locally)`;
}

function relativeArtifactPath(rootPath: string, artifactPath: string): string {
  const resolved = path.resolve(artifactPath);
  return pathInside(rootPath, resolved) ? normalizeRelativePath(path.relative(rootPath, resolved)) : path.basename(resolved);
}

async function ocrAttachmentArtifact(
  rootPath: string,
  label: string,
  sourcePath: string,
  kind: OcrInputKind,
  capabilityReport: CapabilityProbeReport,
): Promise<OcrAttachmentArtifactResult> {
  const engineProbe = capabilityReport.probes.find((probe) => probe.id === "tesseract");
  if (engineProbe?.status !== "available") {
    return { status: "missing", message: "Local OCR engine is unavailable; no OCR artifact was generated." };
  }

  let outputDir: string | null = null;
  try {
    const pages: OcrPageInput[] = [];
    let sourcePageCount: number | undefined;
    if (kind === "pdf") {
      outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-ocr-pdf-"));
      const rendered = await renderPdfAttachmentInWorker(sourcePath, outputDir);
      if (!rendered?.ok) {
        return { status: "failed", message: "PDF pages could not be rendered for local OCR." };
      }
      sourcePageCount = rendered.pageCount;
      for (const page of rendered.pages.slice().sort((left, right) => left.pageNumber - right.pageNumber)) {
        const pagePath = path.resolve(page.filePath);
        if (!pathInside(outputDir, pagePath) || !fs.existsSync(pagePath)) {
          return { status: "failed", message: "Rendered PDF page was not available for local OCR." };
        }
        pages.push({ pageNumber: page.pageNumber, imagePath: pagePath });
      }
    } else {
      pages.push({ pageNumber: 1, imagePath: sourcePath });
      sourcePageCount = 1;
    }

    const document = await generateOcrDocument({
      sourcePath,
      pathLabel: label,
      kind,
      sourcePageCount,
      pages,
      engine: {
        id: "tesseract",
        command: engineProbe.detectedCommand ?? "tesseract",
        version: engineProbe.version,
      },
      pageLimit: kind === "pdf" ? pdfImagePageLimit : 1,
      imageScale: kind === "pdf" ? pdfImageScale : undefined,
    });
    const artifactDirectory = ocrArtifactOutputDirectory(rootPath);
    const fileBase = ocrArtifactBaseName(label, document, `${sourcePath}:${Date.now()}`);
    const artifactPaths = writeOcrArtifacts(document, artifactDirectory, fileBase);
    return {
      status: "created",
      jsonPath: artifactPaths.jsonPath,
      markdownPath: artifactPaths.markdownPath,
      markdown: fs.readFileSync(artifactPaths.markdownPath, "utf8"),
      document,
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { status: "failed", message: message.replace(/\s+/g, " ").trim().slice(0, 240) || "Local OCR failed." };
  } finally {
    if (outputDir) {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }
}

function snapshotFolder(rootPath: string): Record<string, string> {
  const root = path.resolve(rootPath);
  const snapshot: Record<string, string> = {};
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = normalizeRelativePath(path.relative(root, absolute));
      if (entry.isDirectory()) {
        if (!ignoredSnapshotDirectories.has(entry.name) && !isGeneratedRuntimePath(relative)) {
          stack.push(absolute);
        }
        continue;
      }
      if (!entry.isFile() || isGeneratedRuntimePath(relative)) {
        continue;
      }
      const text = readTextFileIfSafe(absolute);
      if (text !== null) {
        snapshot[relative] = text;
        continue;
      }
      try {
        const stat = fs.statSync(absolute);
        if (stat.isFile()) {
          snapshot[relative] = binarySnapshotValue(stat);
        }
      } catch {
        /* Ignore files that disappear while the snapshot is being collected. */
      }
    }
  }
  return snapshot;
}

function sanitizeAttachments(input: unknown, rootPath: string, chatIdValue: string): ChatAttachment[] {
  if (!Array.isArray(input)) return [];
  const root = path.resolve(rootPath);
  const seen = new Set<string>();
  const files: ChatAttachment[] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    const chatAttachment = chatAttachmentFromRecord(item, chatIdValue);
    if (chatAttachment) {
      const key = `chat:${chatAttachment.storedPath}`;
      if (!seen.has(key)) {
        seen.add(key);
        files.push(chatAttachment);
      }
      if (files.length >= 16) break;
      continue;
    }
    const rawPath = typeof item.path === "string" ? item.path.trim() : "";
    if (!rawPath) continue;
    const absolute = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(root, normalizeRelativePath(rawPath));
    if (!pathInside(root, absolute) || !fs.existsSync(absolute)) continue;
    const relative = normalizeRelativePath(path.relative(root, absolute));
    if (!relative || isGeneratedRuntimePath(relative) || isBlockedPath(relative) || seen.has(relative)) continue;
    const name =
      typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 120) : path.basename(relative);
    seen.add(relative);
    files.push({
      path: relative,
      name,
      source: "workspace",
      previewDataUrl: imagePreviewDataUrl(absolute),
      contextTokens: attachmentContextTokens(absolute),
    });
    if (files.length >= 16) break;
  }
  return files;
}

function repositoryTreePreview(rootPath: string, maxEntries = 90): string[] {
  const root = path.resolve(rootPath);
  const rows: string[] = [];
  const walk = (directory: string, depth: number) => {
    if (rows.length >= maxEntries || depth > 2) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries
      .filter((entry) => {
        const relative = normalizeRelativePath(path.relative(root, path.join(directory, entry.name)));
        return !isGeneratedRuntimePath(relative) && !isBlockedPath(relative) && !ignoredSnapshotDirectories.has(entry.name);
      })
      .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name))
      .forEach((entry) => {
        if (rows.length >= maxEntries) return;
        const absolute = path.join(directory, entry.name);
        const relative = normalizeRelativePath(path.relative(root, absolute));
        rows.push(`${"  ".repeat(depth)}- ${relative}${entry.isDirectory() ? "/" : ""}`);
        if (entry.isDirectory()) walk(absolute, depth + 1);
      });
  };
  walk(root, 0);
  return rows;
}

function keyWorkspaceFiles(rootPath: string): Array<{ path: string; text: string }> {
  const snippets: Array<{ path: string; text: string }> = [];
  let remaining = 12000;
  for (const relative of keyWorkspaceFileCandidates) {
    const absolute = path.resolve(rootPath, relative);
    if (!pathInside(rootPath, absolute) || !fs.existsSync(absolute)) continue;
    const text = readTextFileIfSafe(absolute);
    if (text === null) continue;
    const snippet = text.slice(0, Math.max(0, remaining));
    if (!snippet) break;
    snippets.push({ path: normalizeRelativePath(relative), text: snippet });
    remaining -= snippet.length;
    if (remaining <= 0) break;
  }
  return snippets;
}

const keyWorkspaceFileCandidates = ["README.md", "package.json", "apps/desktop/package.json", "src/package.json", "pyproject.toml"];

function findAgentInstructionFiles(rootPath: string): Array<{ path: string; text: string }> {
  const root = path.resolve(rootPath);
  const files: Array<{ path: string; text: string }> = [];
  const seen = new Set<string>();
  let remaining = 24000;
  const addFile = (absolute: string) => {
    const resolved = path.resolve(absolute);
    if (!pathInside(root, resolved) || seen.has(resolved) || !fs.existsSync(resolved)) return;
    const text = readTextFileIfSafe(resolved);
    if (text === null) return;
    const relative = normalizeRelativePath(path.relative(root, resolved)) || "AGENTS.md";
    const snippet = text.slice(0, Math.max(0, remaining));
    if (!snippet) return;
    files.push({ path: relative, text: snippet });
    seen.add(resolved);
    remaining -= snippet.length;
  };

  addFile(path.join(root, "AGENTS.md"));
  const walk = (directory: string, depth: number) => {
    if (remaining <= 0 || files.length >= 12 || depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (remaining <= 0 || files.length >= 12) return;
      const absolute = path.join(directory, entry.name);
      const relative = normalizeRelativePath(path.relative(root, absolute));
      if (entry.isFile() && entry.name === "AGENTS.md") {
        addFile(absolute);
        continue;
      }
      if (
        entry.isDirectory() &&
        depth < 3 &&
        !ignoredSnapshotDirectories.has(entry.name) &&
        !isGeneratedRuntimePath(relative) &&
        !isBlockedPath(relative)
      ) {
        walk(absolute, depth + 1);
      }
    }
  };
  walk(root, 0);
  return files;
}

function pushAgentInstructionContext(lines: string[], rootPath: string) {
  const files = findAgentInstructionFiles(rootPath);
  if (!files.length) return;
  lines.push(
    "",
    "Repository instruction files discovered in the workspace:",
  );
  for (const file of files) {
    lines.push(`\n### ${file.path}`, "```", file.text, "```");
  }
}

function compactHistoryText(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 16)).trimEnd()} ...(truncated)`;
}

function historyLineForEvent(event: BackendUiEvent): string | null {
  switch (event.type) {
    case "user.message":
      return `User: ${compactHistoryText(event.text, 1800)}`;
    case "assistant.delta":
      return `Assistant: ${compactHistoryText(event.text, 2400)}`;
    case "command.started":
      return `Tool started: ${compactHistoryText(event.command, 500)}`;
    case "command.output":
      return `Tool ${event.stream}: ${compactHistoryText(event.text, 900)}`;
    case "command.finished":
      return `Tool finished: exit code ${event.exitCode === null ? "unknown" : event.exitCode}`;
    case "permission.requested":
      return `Permission requested: ${compactHistoryText(event.request.summary, 500)}`;
    case "permission.resolved":
      return `Permission ${event.decision}.`;
    case "review.ready":
      return `Review ready: ${event.changedFiles.length} changed file${event.changedFiles.length === 1 ? "" : "s"}.`;
    case "review.changed_since_ready":
      return `Review changed since ready: ${event.changedFileCount} changed file${event.changedFileCount === 1 ? "" : "s"}.`;
    case "approval.check":
      return `Approval check ${event.status}: ${event.name}${event.detail ? ` (${compactHistoryText(event.detail, 300)})` : ""}`;
    case "merge.approval":
      return `Changes ${event.decision === "approved" ? "accepted" : "rejected"}.`;
    case "approval.completed":
      return `Approval completed for ${event.target}.`;
    case "merge.completed":
      return `Merge completed into ${event.targetBranch}.`;
    case "ide.opened":
      return `IDE open ${event.result}: ${event.filePath ?? event.target}.`;
    case "skill.selected":
      return `Skill selected: ${event.skillId} (${event.reason}, ${event.fullContent ? "full instructions" : "metadata only"})`;
    case "required_tool.failed":
      return `Required tool failed: ${event.requirement} (${event.reason}${event.detail ? `: ${compactHistoryText(event.detail, 300)}` : ""})`;
    case "task.error":
      return `Task error: ${compactHistoryText(event.message, 900)}`;
    case "context.usage":
    case "context.threshold":
    case "context.compressed":
    case "context.retrieved":
      return null;
    case "assistant.done":
    case "assistant.reasoning.delta":
    case "response.feedback":
    case "tool.failed":
    case "worktree.requested":
    case "worktree.created":
      return null;
  }
}

function priorChatContext(events: BackendUiEvent[], currentUserPrompt = ""): string {
  const historyEvents = visibleTaskEvents(events);
  const currentPrompt = currentUserPrompt.trim();
  if (currentPrompt) {
    const last = historyEvents.at(-1);
    if (last?.type === "user.message" && last.text.trim() === currentPrompt) {
      historyEvents.pop();
    }
  }
  const lines = historyEvents
    .map(historyLineForEvent)
    .filter((line): line is string => !!line);
  if (lines.length === 0) return "";
  return boundedRecentLines(lines);
}

function capabilityNeedsForPrompt(prompt: string, attachments: ChatAttachment[] = []): CapabilityPromptNeeds {
  return {
    python: promptLooksLikePythonTask(prompt) || promptLooksLikeArtifactTask(prompt),
    cmake: promptLooksLikeCmakeTask(prompt),
    artifacts: promptLooksLikeArtifactTask(prompt),
    ocr: promptLooksLikeOcrTask(prompt) || ocrInputKindsForAttachments(attachments).length > 0,
  };
}

function pushPromptText(parts: RunnerPromptPart[], lines: string[], emptyHeader = "Attached file contents:") {
  const text = lines.join("\n").trim();
  if (text && text !== emptyHeader) {
    parts.push({ type: "text", text });
  }
  lines.length = 0;
}

async function attachmentPromptParts(
  rootPath: string,
  attachments: ChatAttachment[],
  options: {
    userPrompt: string;
    capabilityReport: CapabilityProbeReport;
    textBudget: { remainingTokens: number };
    heading?: string;
  },
): Promise<RunnerPromptPart[]> {
  if (!attachments.length) return [];
  const parts: RunnerPromptPart[] = [];
  const heading = options.heading ?? "Attached file contents:";
  const lines = [heading];
  const shouldGenerateOcr = promptLooksLikeOcrTask(options.userPrompt);
  for (const file of attachments) {
    const isChatAttachment = file.source === "chat" && typeof file.storedPath === "string";
    const absolute = isChatAttachment ? path.resolve(file.storedPath as string) : path.resolve(rootPath, file.path);
    const label = isChatAttachment ? `${file.name} (chat attachment)` : file.path;
    lines.push(`\n### ${label}`);
    if (isChatAttachment && file.originalPath) {
      lines.push(`Original path: ${file.originalPath}`);
    }
    if (isChatAttachment) {
      const workspaceCopy = path.resolve(rootPath, file.path);
      if (pathInside(rootPath, workspaceCopy) && fs.existsSync(workspaceCopy)) {
        lines.push(`Workspace path: ${file.path}`);
      }
    }
    const allowed = isChatAttachment ? pathInside(chatAttachmentRoot(), absolute) : pathInside(rootPath, absolute);
    if (!allowed || !fs.existsSync(absolute)) {
      lines.push("(file is no longer available)");
      continue;
    }
    const ocrKind = ocrInputKindForPath(absolute);
    if (shouldGenerateOcr && ocrKind) {
      const ocr = await ocrAttachmentArtifact(rootPath, label, absolute, ocrKind, options.capabilityReport);
      if (ocr.status === "created") {
        lines.push(
          `Local OCR artifact generated: ${relativeArtifactPath(rootPath, ocr.markdownPath)} and ${relativeArtifactPath(rootPath, ocr.jsonPath)}.`,
          `OCR recognized ${ocr.document.metrics.recognizedLines} line${ocr.document.metrics.recognizedLines === 1 ? "" : "s"} with ${ocr.document.warnings.length} warning${ocr.document.warnings.length === 1 ? "" : "s"}.`,
          "```markdown",
          ocrPromptDigest(ocr.markdown),
          "```",
        );
      } else {
        lines.push(`Local OCR artifact was not generated: ${ocr.message}`);
      }
    }
    if (isPdfFile(absolute)) {
      const rendered = await pdfAttachmentImageParts(absolute);
      if (!rendered) {
        lines.push("(PDF pages could not be rendered for image input; the file may be encrypted, too large, or unsupported)");
        continue;
      }
      lines.push(
        rendered.rendered < rendered.pageCount
          ? `PDF rendered as images for the vision model: first ${rendered.rendered} of ${rendered.pageCount} pages.`
          : `PDF rendered as images for the vision model: ${rendered.pageCount} page${rendered.pageCount === 1 ? "" : "s"}.`,
      );
      pushPromptText(parts, lines, heading);
      parts.push(...rendered.parts);
      lines.push(heading);
      continue;
    }
    const imageDataUrl = imageDataUrlIfSafe(absolute);
    if (imageDataUrl) {
      lines.push("Image included below for the vision model.");
      pushPromptText(parts, lines, heading);
      parts.push({ type: "image", data_url: imageDataUrl });
      lines.push(heading);
      continue;
    }
    const text = readAttachmentTextIfSafe(absolute);
    if (text === null) {
      lines.push("(binary, too large, or unreadable text file)");
      continue;
    }
    const fullAccess = isChatAttachment
      ? `Complete attachment: use read_attachment with attachmentId ${JSON.stringify(path.basename(absolute))} and the reported byte offsets.`
      : `Complete workspace file: use read with filePath ${JSON.stringify(file.path)} and successive line offsets.`;
    lines.push(fullAccess);
    const excerpt = attachmentTextExcerpt(text, options.textBudget.remainingTokens);
    options.textBudget.remainingTokens = Math.max(
      0,
      options.textBudget.remainingTokens - estimateTextTokens(excerpt.text),
    );
    if (!excerpt.text) {
      lines.push("(initial excerpt omitted to preserve the active context window; the complete text remains available through the tool above)");
      continue;
    }
    lines.push("```");
    lines.push(excerpt.text);
    lines.push("```");
    if (excerpt.truncated) {
      lines.push("Initial context contains a head-and-tail excerpt; the middle remains available through the tool above.");
    }
  }
  pushPromptText(parts, lines, heading);
  return parts;
}

async function runnerPromptForTask(
  task: TaskRecord,
  userPrompt: string,
  attachments: ChatAttachment[],
  contextLength: number,
): Promise<RunnerPromptPart[]> {
  const repository = readProjects().find((project) => project.id === task.repositoryId);
  const rootPath = fs.existsSync(task.worktreePath) ? task.worktreePath : task.originalRepoPath;
  const capabilityReport = await probeLocalCapabilities({ runnerPath: runnerBinaryPath() });
  const capabilityNeeds = capabilityNeedsForPrompt(userPrompt, attachments);
  const hiddenChat = isHiddenChatTask(task);
  const tree = repositoryTreePreview(rootPath);
  const keyFiles = hiddenChat ? [] : keyWorkspaceFiles(rootPath);
  const lines = hiddenChat
    ? [
        "Umbratic chat context:",
        "- no project folder is selected for this chat",
        "- Umbratic created a private scratch workspace for attachments and any files produced during the conversation",
        `- scratch workspace: ${rootPath}`,
        "",
        "Scratch workspace file preview (bounded, not exhaustive):",
        tree.length ? tree.join("\n") : "- (empty)",
      ]
    : [
        "Umbratic workspace context:",
        `- opened folder: ${rootPath}`,
        `- repository name: ${repository?.name ?? path.basename(rootPath)}`,
        `- workspace kind: ${task.workspaceKind}`,
        `- branch/status: ${task.originalBranch} (${repository?.statusSummary ?? "unknown"})`,
        "",
        "Visible workspace file preview (bounded, not exhaustive):",
        tree.length ? tree.join("\n") : "- (no readable files found)",
      ];
  if (keyFiles.length) {
    lines.push("", "Key workspace files:");
    for (const file of keyFiles) {
      lines.push(`\n### ${file.path}`, "```", file.text, "```");
    }
  }
  pushAgentInstructionContext(lines, rootPath);
  const hasDurableContext = Boolean(task.chatId && readChat(task.chatId)?.contextState);
  const history = hasDurableContext ? "" : priorChatContext(task.events ?? [], userPrompt);
  if (history) {
    lines.push(
      "",
      "Conversation so far, for reference only:",
      history,
    );
  }
  lines.push("", capabilityPromptGuidance(capabilityReport, capabilityNeeds));
  const parts: RunnerPromptPart[] = [{ type: "text", text: lines.join("\n") }];
  const textBudget = { remainingTokens: attachmentPromptTokenBudget(contextLength) };
  const historicalAttachments = priorChatAttachments(task.events ?? [], userPrompt);
  parts.push(
    ...(await attachmentPromptParts(rootPath, historicalAttachments, {
      userPrompt,
      capabilityReport,
      textBudget,
      heading: "Previously attached file contents:",
    })),
  );
  parts.push(...(await attachmentPromptParts(rootPath, attachments, { userPrompt, capabilityReport, textBudget })));
  parts.push({
    type: "text",
    text: ["User request:", userPrompt].join("\n"),
  });
  return limitPromptImages(parts, pdfImagePageLimit, promptImageCharacterLimit);
}

function runnerPromptParts(prompt: RunnerPrompt): RunnerPromptPart[] {
  return typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt;
}

function runnerPromptText(prompt: RunnerPrompt): string {
  return typeof prompt === "string"
    ? prompt
    : prompt
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n\n");
}

function diffHeader(filePath: string, status: ReviewFile["status"]): string[] {
  const escaped = filePath.replace(/\\/g, "/");
  if (status === "added") {
    return [`diff --git a/${escaped} b/${escaped}`, "new file mode 100644", "--- /dev/null", `+++ b/${escaped}`];
  }
  if (status === "deleted") {
    return [`diff --git a/${escaped} b/${escaped}`, "deleted file mode 100644", `--- a/${escaped}`, "+++ /dev/null"];
  }
  return [`diff --git a/${escaped} b/${escaped}`, `--- a/${escaped}`, `+++ b/${escaped}`];
}

function lcsLineDiff(before: string[], after: string[]): string[] {
  const rows = before.length;
  const cols = after.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () => Array<number>(cols + 1).fill(0));
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let col = cols - 1; col >= 0; col -= 1) {
      table[row][col] =
        before[row] === after[col]
          ? table[row + 1][col + 1] + 1
          : Math.max(table[row + 1][col], table[row][col + 1]);
    }
  }
  const diff: string[] = [];
  let row = 0;
  let col = 0;
  while (row < rows || col < cols) {
    if (row < rows && col < cols && before[row] === after[col]) {
      diff.push(` ${before[row]}`);
      row += 1;
      col += 1;
    } else if (col < cols && (row === rows || table[row][col + 1] >= table[row + 1][col])) {
      diff.push(`+${after[col]}`);
      col += 1;
    } else if (row < rows) {
      diff.push(`-${before[row]}`);
      row += 1;
    }
  }
  return diff;
}

function buildTextDiff(filePath: string, before: string | null, after: string | null): ReviewFile | null {
  if (before === after) {
    return null;
  }
  const status: ReviewFile["status"] = before === null ? "added" : after === null ? "deleted" : "modified";
  const beforeLines = before === null ? [] : textLines(before);
  const afterLines = after === null ? [] : textLines(after);
  const body =
    status === "added"
      ? afterLines.map((line) => `+${line}`)
      : status === "deleted"
        ? beforeLines.map((line) => `-${line}`)
        : lcsLineDiff(beforeLines, afterLines);
  const hunk = `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`;
  return normalizeReviewFile({
    path: filePath,
    status,
    diff: [...diffHeader(filePath, status), hunk, ...body].join("\n"),
  });
}

function buildBinaryDiff(filePath: string, before: string | null, after: string | null): ReviewFile | null {
  if (before === after) {
    return null;
  }
  const status: ReviewFile["status"] = before === null ? "added" : after === null ? "deleted" : "modified";
  return normalizeReviewFile({
    path: filePath,
    status,
    diff: [...diffHeader(filePath, status), `Binary file ${status}: ${filePath}`].join("\n"),
  });
}

function buildSnapshotDiff(filePath: string, before: string | null, after: string | null): ReviewFile | null {
  if (isBinarySnapshotValue(before) || isBinarySnapshotValue(after)) {
    return buildBinaryDiff(filePath, before, after);
  }
  return buildTextDiff(filePath, before, after);
}

function worktreeRootForRepo(repoRoot: string): string {
  const resolved = path.resolve(repoRoot);
  return path.join(os.homedir(), ".umbratic", "worktrees", `${slugify(path.basename(resolved))}-${shortHash(resolved.toLowerCase())}`);
}

function umbraticWorktreesRoot(): string {
  return path.join(os.homedir(), ".umbratic", "worktrees");
}

function directoryIsEmpty(directory: string): boolean {
  try {
    return fs.readdirSync(directory).length === 0;
  } catch {
    return false;
  }
}

function removeEmptyDirectory(directory: string): boolean {
  try {
    fs.rmdirSync(directory);
    return !fs.existsSync(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return false;
    return false;
  }
}

function cleanupEmptyUmbraticWorktreeDirectories(task: TaskRecord) {
  const worktreesRoot = umbraticWorktreesRoot();
  const repoWorktreeRoot = worktreeRootForRepo(task.originalRepoPath);
  if (!pathInside(worktreesRoot, repoWorktreeRoot) || !pathInside(repoWorktreeRoot, task.worktreePath)) return;
  if (fs.existsSync(task.worktreePath) && directoryIsEmpty(task.worktreePath)) {
    removeEmptyDirectory(task.worktreePath);
  }
  removeEmptyDirectory(repoWorktreeRoot);
}

async function removeGitWorktree(task: TaskRecord) {
  if (!taskUsesIsolatedWorktree(task)) {
    return;
  }
  const repoWorktreeRoot = worktreeRootForRepo(task.originalRepoPath);
  if (!pathInside(repoWorktreeRoot, task.worktreePath)) {
    throw new Error("Worktree path is outside Umbratic control.");
  }
  if (fs.existsSync(task.worktreePath)) {
    const result = await gitResult(task.originalRepoPath, ["worktree", "remove", "--force", task.worktreePath]);
    if (!result.success) {
      if (!directoryIsEmpty(task.worktreePath)) {
        const message = (result.stderr || result.stdout || "Failed to remove worktree.").trim();
        throw new Error(message);
      }
      removeEmptyDirectory(task.worktreePath);
    }
  }
  cleanupEmptyUmbraticWorktreeDirectories(task);
}

function taskMetadataPath(task: TaskRecord): string {
  return path.join(app.getPath("userData"), "task-metadata", `${task.id}.json`);
}

function recordTaskEvent(event: BackendUiEvent) {
  if (isReviewReadyAssistantEvent(event)) return;
  const events = pendingTaskEvents.get(event.taskId) ?? [];
  pendingTaskEvents.set(event.taskId, appendTaskEvent(events, event, 500));
  scheduleTaskEventFlush(shouldDeferTaskEventFlush(event) ? streamingTaskEventFlushDelayMs : 0);
}

function flushRendererEvents() {
  if (pendingRendererEventFlushTimer) {
    clearTimeout(pendingRendererEventFlushTimer);
    pendingRendererEventFlushTimer = null;
  }
  if (pendingRendererEvents.length === 0) return;
  const events = pendingRendererEvents.splice(0);
  for (const event of events) {
    mainWindow?.webContents.send("umbratic:backend-event", event);
  }
}

function dispatchRendererEvent(event: BackendUiEvent) {
  if (!shouldBufferBackendEvent(event)) {
    flushRendererEvents();
    mainWindow?.webContents.send("umbratic:backend-event", event);
    return;
  }
  appendBufferedBackendEvent(pendingRendererEvents, event);
  if (!pendingRendererEventFlushTimer) {
    pendingRendererEventFlushTimer = setTimeout(flushRendererEvents, rendererEventFlushDelayMs);
  }
}

function persistBackendEvent(stampedEvent: BackendUiEvent) {
  recordBackendEventDiagnostic(stampedEvent);
  recordTaskEvent(stampedEvent);
  dispatchRendererEvent(stampedEvent);
}

function contextThresholdEvents(event: Extract<BackendUiEvent, { type: "context.usage" }>): BackendUiEvent[] {
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

function emit(event: BackendUiEvent) {
  const stampedEvent = { ...event, version: 1 as const, at: event.at ?? new Date().toISOString() } as BackendUiEvent;
  persistBackendEvent(stampedEvent);
  if (stampedEvent.type === "context.usage") {
    for (const thresholdEvent of contextThresholdEvents(stampedEvent)) {
      persistBackendEvent({ ...thresholdEvent, version: 1 as const } as BackendUiEvent);
    }
  }
}

function appendUserMessage(task: TaskRecord, text: string, attachedFiles: ChatAttachment[]) {
  const event = {
    type: "user.message",
    taskId: task.id,
    text,
    attachedFiles,
    at: new Date().toISOString(),
  } satisfies BackendUiEvent;
  task.events = appendTaskEvent(task.events ?? [], event, 500);
  saveTask(task);
  dispatchRendererEvent(event);
}

function failTask(
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

function taskStillRunning(task: TaskRecord): boolean {
  return task.state === "running";
}

function execFileOutput(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        timeout: options.timeout ?? 180000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}${stderr ? `\n${stderr}` : ""}`));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function execFileResult(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        timeout: options.timeout ?? 180000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const exitCode =
          error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
            ? ((error as NodeJS.ErrnoException & { code: number }).code)
            : error
              ? 1
              : 0;
        resolve({
          stdout: String(stdout),
          stderr: String(stderr) || (error ? String(error.message) : ""),
          exitCode,
          success: !error,
        });
      },
    );
  });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const output = await execFileOutput("git", args, { cwd });
  return output.stdout.trim();
}

async function gitResult(cwd: string, args: string[]): Promise<CommandResult> {
  return execFileResult("git", args, { cwd });
}

async function commandAvailable(command: string): Promise<boolean> {
  try {
    await execFileOutput(process.platform === "win32" ? "where.exe" : "which", [command], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function searchRepositoryFiles(input: unknown): Promise<FileSearchResult[]> {
  if (!isRecord(input)) {
    throw new Error("Invalid file search input.");
  }
  const repositoryId = requiredString(input.repositoryId, "repositoryId");
  const query = typeof input.query === "string" ? input.query.trim().slice(0, 120) : "";
  const limit = Math.min(30, Math.max(4, typeof input.limit === "number" ? input.limit : 10));
  const repository = readProjects().find((project) => project.id === repositoryId);
  if (!repository) {
    throw new Error("Repository has not been selected.");
  }
  const results = await searchRootFiles(repository.rootPath, query, limit);
  return results.map((result) => ({
    ...result,
    contextTokens: attachmentContextTokens(path.resolve(repository.rootPath, result.path)),
  }));
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

const veilManagedModelId = "veil-managed";

function endpointHeaders(headers: ReturnType<typeof readModelEndpointSettings>["headers"]): Record<string, string> {
  const next: Record<string, string> = {};
  for (const header of headers) {
    if (!header.name.trim() || !header.value) continue;
    next[header.name.trim()] = header.value;
  }
  return next;
}

function endpointProvider(): (typeof localProviderCatalog)[number] & {
  baseUrl: string;
  software: ReturnType<typeof readModelEndpointSettings>["software"];
  headers: Record<string, string>;
} {
  const provider = localProviderCatalog[0];
  const settings = readModelEndpointSettings();
  const localConnection = settings.mode === "local" ? currentLocalVeilConnection() : null;
  return {
    ...provider,
    providerName: "Umbratic Veil",
    software: settings.software,
    baseUrl: normalizeBaseUrl(localConnection?.baseUrl ?? settings.baseUrl),
    apiKey: localConnection?.authToken ?? settings.secret.trim(),
    headers: settings.mode === "local" ? {} : endpointHeaders(settings.headers),
    mtls: settings.mode === "server" ? provider.mtls : undefined,
  };
}

function configuredEndpointModel(): LocalModelInfo {
  const provider = endpointProvider();
  const settings = readModelEndpointSettings();
  return {
    providerId: provider.providerId,
    providerName: provider.providerName,
    modelId: veilManagedModelId,
    displayName: settings.mode === "local" ? settings.modelId : provider.providerName,
    baseUrl: provider.baseUrl,
  };
}

function configuredEndpointRoute(baseUrl: string, route: string): string {
  if (/^https?:\/\//i.test(route)) return route;
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  let normalizedRoute = route.replace(/^\/+/, "");
  if (/\/v\d+$/i.test(new URL(normalizedBaseUrl).pathname) && /^v\d+\//i.test(normalizedRoute)) {
    normalizedRoute = normalizedRoute.replace(/^v\d+\//i, "");
  }
  const baseSegment = new URL(normalizedBaseUrl).pathname.replace(/\/+$/, "").split("/").filter(Boolean).at(-1);
  const routeSegment = normalizedRoute.split("/").filter(Boolean)[0];
  if (baseSegment && baseSegment === routeSegment) {
    normalizedRoute = normalizedRoute.split("/").filter(Boolean).slice(1).join("/");
  }
  return new URL(normalizedRoute, `${normalizedBaseUrl}/`).toString();
}

function endpointHealthRoute(provider: ReturnType<typeof endpointProvider>): string {
  return configuredEndpointRoute(provider.baseUrl, "/api/health");
}

function endpointRequestHeaders(provider: ReturnType<typeof endpointProvider>): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`;
  }
  Object.assign(headers, provider.headers);
  return headers;
}

async function modelWithFreshContextLength(selected: LocalModelInfo): Promise<LocalModelInfo> {
  const provider = endpointProvider();
  const detected = await probeVeilContextLength({
    baseUrl: provider.baseUrl,
    headers: endpointRequestHeaders(provider),
    mtls: provider.mtls,
  });
  return {
    ...selected,
    contextLength: detected ?? readContextLengthSetting(),
  };
}

function telemetryUploadEndpoint(provider: ReturnType<typeof endpointProvider>): TelemetryUploadEndpoint {
  return {
    url: configuredEndpointRoute(provider.baseUrl, "/api/telemetry"),
    headers: endpointRequestHeaders(provider),
    mtls: provider.mtls,
  };
}

async function checkEndpointHealth(provider: ReturnType<typeof endpointProvider>): Promise<{ status: ServiceStatus; message?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const healthRoute = endpointHealthRoute(provider);
    const response = await getProviderJson(healthRoute, {
      headers: endpointRequestHeaders(provider),
      mtls: provider.mtls,
      signal: controller.signal,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const body = response.text;
      return {
        status: "unavailable",
        message: `Health check failed at ${new URL(healthRoute).pathname} with ${response.statusCode} ${response.statusMessage}${
          body.trim() ? `: ${body.trim().slice(0, 160)}` : ""
        }`,
      };
    }
    return { status: "ready", message: `Health check passed at ${new URL(healthRoute).pathname}.` };
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "Health check timed out."
        : `Health check failed: ${error instanceof Error ? error.message : String(error)}`;
    return { status: "unavailable", message };
  } finally {
    clearTimeout(timeout);
  }
}

async function saveModelEndpointSettings(input: Partial<ReturnType<typeof readModelEndpointSettings>>) {
  if (activeRunnerProcesses.size > 0) {
    throw new Error("Wait for the active run to finish before changing the model connection.");
  }
  const current = readModelEndpointSettings();
  const requested = { ...current, ...input };
  const candidate = requested.mode === "local" ? { ...requested, software: "ollama" as const } : requested;
  const baseUrl = typeof candidate.baseUrl === "string" ? candidate.baseUrl.trim() : "";
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new Error(`${candidate.mode === "local" ? "Runtime" : "Server"} URL is invalid.`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`${candidate.mode === "local" ? "Runtime" : "Server"} URL must use HTTP or HTTPS.`);
  }
  if (candidate.mode === "local" && !isLocalhostUrl(baseUrl)) {
    throw new Error("Local mode only connects to a model runtime on this computer. Use Server mode for remote infrastructure.");
  }
  if (candidate.mode === "local" && !candidate.modelId?.trim()) {
    throw new Error("Enter the local model name before connecting.");
  }
  const settings = writeModelEndpointSettings(candidate);
  const status = await getBackendStatus();
  return { settings: publicModelEndpointSettings(settings), status };
}

async function saveHarnessProfileSetting(input: unknown) {
  const settings = writeHarnessProfileSetting(input as HarnessProfileId);
  applyHarnessSystemSkillSettings(settings);
  const status = await getBackendStatus();
  return { settings, status };
}

async function saveContextLengthSetting(input: unknown) {
  if (activeRunnerProcesses.size > 0) {
    throw new Error("Wait for the active run to finish before changing the context length.");
  }
  const contextLength = writeContextLengthSetting(input);
  stopLocalVeil();
  const status = await getBackendStatus();
  return { contextLength, status };
}

async function resolveSelectedModel(): Promise<{ providers: LocalModelProvider[]; models: LocalModelInfo[]; selected: LocalModelInfo | null }> {
  const settings = readModelEndpointSettings();
  try {
    if (settings.mode === "local") {
      await ensureLocalVeil(settings, readContextLengthSetting(), (diagnostic) => {
        recordLocalDiagnostic({
          ...diagnostic,
          source: "veil",
        });
      });
    } else {
      stopLocalVeil();
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      providers: [{
        providerId: "company-endpoint",
        providerName: "Local Veil",
        baseUrl: settings.baseUrl,
        status: "unavailable",
        models: [],
        message,
      }],
      models: [],
      selected: null,
    };
  }
  const configured = configuredEndpointModel();
  const providerConfig = endpointProvider();
  const health = await checkEndpointHealth(providerConfig);
  const models: LocalModelInfo[] = health.status === "ready" ? [configured] : [];
  const selected = health.status === "ready" ? configured : null;
  const provider: LocalModelProvider = {
    providerId: configured.providerId,
    providerName: configured.providerName,
    baseUrl: configured.baseUrl,
    status: health.status,
    models,
    message:
      health.status === "ready" && settings.mode === "local"
        ? `Local Veil is running with ${settings.modelId}. Telemetry is off.`
        : health.message,
  };
  return { providers: [provider], models, selected };
}

async function getBackendStatus(): Promise<BackendStatus> {
  const { providers, models, selected } = await resolveSelectedModel();
  const runnerPath = runnerBinaryPath();
  const capabilityReport = await probeLocalCapabilities({ runnerPath });
  const managedEndpoint = managedModelEndpointDefaults();
  const endpointSettings = readModelEndpointSettings();
  const hasManagedEndpoint = !!(managedEndpoint?.baseUrl || managedEndpoint?.mode || managedEndpoint?.software);
  const endpointStatus = providers.some((provider) => provider.status === "ready")
    ? "ready"
    : providers.some((provider) => provider.status === "degraded")
      ? "degraded"
      : "unavailable";
  const messages = [
    runnerPath ? undefined : "Umbratic runner is not built in the app bundle.",
    selected ? undefined : "Veil health check is not ready.",
    ...providers.map((provider) => provider.message).filter((message): message is string => !!message),
  ].filter((message): message is string => !!message);

  return {
    runner: runnerPath ? "ready" : "unavailable",
    endpoint: endpointStatus,
    model: selected,
    models,
    providers,
    permissionMode,
    endpointConfig: {
      source: managedEndpoint
        ? "managed"
        : hasStoredModelEndpointSettings()
          ? "stored"
          : endpointSettings.mode === "local"
            ? "local-default"
            : "server-default",
      endpointEditingAllowed: endpointEditingAllowed() && !hasManagedEndpoint,
    },
    privacy: {
      share: "disabled",
      enabledProviders: providers.filter((provider) => provider.status === "ready").map((provider) => provider.providerId),
      webTools: "disabled",
    },
    diagnostics: {
      runnerName: umbraticRunnerName,
      runnerVersion: umbraticRunnerVersion,
      runnerContractVersion: umbraticRunnerContractVersion,
      policyVersion: umbraticPolicyVersion,
      runnerBinary: runnerPath ? "present" : "missing",
      configAssertions: "enabled",
      providerAllowlist: allowedLocalProviderIds,
      localhostOnlyModels: models.every((model) => isLocalhostUrl(model.baseUrl)),
      commandClassifier: "enabled",
      runnerDiagnosticsDirectory: runnerDiagnosticsDirectory(app.getPath("userData")),
      localLogs: readLocalDiagnosticInfo(),
      telemetry: telemetryPolicyForMode(endpointSettings.mode),
      runtimes: runtimeDiagnostics(),
      capabilities: capabilityReport,
    },
    message: messages.length ? messages.join(" ") : undefined,
  };
}

async function getCapabilityProbes(input: unknown): Promise<CapabilityProbeReport> {
  const force = isRecord(input) && input.force === true;
  return probeLocalCapabilities({ runnerPath: runnerBinaryPath(), force });
}

async function openSkillsFolder(): Promise<{ ok: true; directory: string } | { ok: false; message: string }> {
  const directory = skillsDirectoryPathService();
  try {
    await fs.promises.mkdir(directory, { recursive: true });
    const failure = await shell.openPath(directory);
    if (failure) {
      return { ok: false, message: failure };
    }
    return { ok: true, directory };
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
}

async function openRunnerDiagnosticsFolder(): Promise<{ ok: true; directory: string } | { ok: false; message: string }> {
  const directory = runnerDiagnosticsDirectory(app.getPath("userData"));
  try {
    await fs.promises.mkdir(directory, { recursive: true });
    const failure = await shell.openPath(directory);
    if (failure) return { ok: false, message: failure };
    return { ok: true, directory };
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
}

async function openSkillInEditor(input: unknown): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  const result = await getSkillDocumentService(input as { id?: string });
  if (!result.ok) return result;
  const failure = await shell.openPath(result.skill.path);
  if (failure) return { ok: false, message: failure };
  return { ok: true, path: result.skill.path };
}

async function importSkillFromDialog(input?: { sourcePath?: string }) {
  if (typeof input?.sourcePath === "string" && input.sourcePath.trim()) {
    return importSkillService({ sourcePath: input.sourcePath });
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, {
        title: "Import Umbratic Skill",
        properties: ["openFile", "openDirectory"],
        filters: [
          { name: "Skill folders or archives", extensions: ["md", "zip"] },
          { name: "All files", extensions: ["*"] },
        ],
      })
    : await dialog.showOpenDialog({
        title: "Import Umbratic Skill",
        properties: ["openFile", "openDirectory"],
        filters: [
          { name: "Skill folders or archives", extensions: ["md", "zip"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false as const, message: "Skill import was canceled." };
  }
  return importSkillService({ sourcePath: result.filePaths[0] });
}

async function exportTelemetryBundle(): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const result = mainWindow
    ? await dialog.showSaveDialog(mainWindow, {
        title: "Export Umbratic Telemetry",
        defaultPath: `umbratic-telemetry-${timestamp}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      })
    : await dialog.showSaveDialog({
        title: "Export Umbratic Telemetry",
        defaultPath: `umbratic-telemetry-${timestamp}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
  if (result.canceled || !result.filePath) {
    return { ok: false, message: "Export canceled." };
  }
  const bundle = buildRedactedTelemetryBundle(readTasks(), readProjects(), readProductTelemetryEvents(), readLocalDiagnostics());
  fs.mkdirSync(path.dirname(result.filePath), { recursive: true });
  fs.writeFileSync(result.filePath, `${JSON.stringify(bundle)}\n`, "utf8");
  return { ok: true, path: result.filePath };
}

async function exportLocalDiagnostics(): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const result = mainWindow
    ? await dialog.showSaveDialog(mainWindow, {
        title: "Export Umbratic Logs",
        defaultPath: `umbratic-logs-${timestamp}.jsonl`,
        filters: [{ name: "JSON Lines", extensions: ["jsonl"] }],
      })
    : await dialog.showSaveDialog({
        title: "Export Umbratic Logs",
        defaultPath: `umbratic-logs-${timestamp}.jsonl`,
        filters: [{ name: "JSON Lines", extensions: ["jsonl"] }],
      });
  if (result.canceled || !result.filePath) return { ok: false, message: "Export canceled." };
  const contents = readLocalDiagnostics().map((entry) => JSON.stringify(entry)).join("\n");
  fs.mkdirSync(path.dirname(result.filePath), { recursive: true });
  fs.writeFileSync(result.filePath, contents ? `${contents}\n` : "", "utf8");
  return { ok: true, path: result.filePath };
}

function clearLocalDiagnosticLogs(): LocalDiagnosticInfo {
  const info = clearLocalDiagnostics();
  const legacyDirectory = path.resolve(runnerDiagnosticsDirectory(app.getPath("userData")));
  if (pathInside(app.getPath("userData"), legacyDirectory) && fs.existsSync(legacyDirectory)) {
    fs.rmSync(legacyDirectory, { recursive: true, force: true });
  }
  return info;
}

function recordRendererProductEvent(input: unknown): void {
  if (!isRecord(input) || (input.type !== "review.opened" && input.type !== "ide.selected")) {
    throw new Error("Invalid product event input.");
  }
  const taskId = typeof input.taskId === "string" && /^task-[A-Za-z0-9_-]+$/.test(input.taskId) ? input.taskId : undefined;
  const task = taskId ? readTask(taskId) : null;
  const repositoryId = typeof input.repositoryId === "string" && input.repositoryId.length <= 128
    ? input.repositoryId
    : task?.repositoryId;
  if (input.type === "review.opened") {
    const scope = input.scope === "worktree" ? "worktree" : "task";
    const target = input.target === "project" ? "project" : "task";
    recordProductTelemetry("review.opened", {
      taskId,
      chatId: task?.chatId,
      repositoryId,
      data: { scope, target },
    });
    return;
  }
  const ideId = requiredString(input.ideId, "ideId");
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(ideId)) throw new Error("Invalid IDE selection.");
  const surface = input.surface === "review" ? "review" : "composer";
  recordProductTelemetry("ide.selected", {
    taskId,
    chatId: task?.chatId,
    repositoryId,
    data: { ideId, surface },
  });
}

async function retryTelemetrySpoolQueue(): Promise<void> {
  if (!telemetryPolicyForMode(readModelEndpointSettings().mode).syncEnabled) return;
  const provider = endpointProvider();
  await uploadTelemetrySpool({
    directory: telemetrySpoolDirectory(app.getPath("userData")),
    endpoint: telemetryUploadEndpoint(provider),
  });
}

async function syncTelemetryNow(): Promise<TelemetrySyncResult> {
  if (!telemetryPolicyForMode(readModelEndpointSettings().mode).syncEnabled) {
    throw new Error("Telemetry sync is disabled by policy.");
  }
  const provider = endpointProvider();
  const bundle = buildRedactedTelemetryBundle(readTasks(), readProjects(), readProductTelemetryEvents(), readLocalDiagnostics());
  return syncTelemetryBundle({
    directory: telemetrySpoolDirectory(app.getPath("userData")),
    bundle,
    endpoint: telemetryUploadEndpoint(provider),
  });
}

function scheduleManagedTelemetrySync() {
  if (!telemetryPolicyForMode(readModelEndpointSettings().mode).syncEnabled || telemetrySyncTimer) return;
  telemetrySyncTimer = setTimeout(() => {
    telemetrySyncTimer = null;
    void syncTelemetryNow().catch((cause) => {
      recordLocalDiagnostic({
        level: "warn",
        source: "telemetry",
        event: "sync.failed",
        message: String(cause instanceof Error ? cause.message : cause),
      });
    });
  }, 5000);
  telemetrySyncTimer.unref?.();
}

async function inspectRepository(selectedPath: string): Promise<RepositoryInfo> {
  const selected = path.resolve(selectedPath);
  if (!fs.existsSync(selected) || !fs.statSync(selected).isDirectory()) {
    throw new Error("Selected path is not a folder.");
  }
  let root = selected;
  let kind: WorkspaceKind = "folder";
  let branch = "folder";
  let baseCommit = crypto.createHash("sha256").update(`${selected}:${Date.now()}`).digest("hex");
  let statusSummary = "regular folder";
  let dirty = false;
  try {
    root = path.resolve(await gitOutput(selected, ["rev-parse", "--show-toplevel"]));
    kind = "git";
    branch = (await gitOutput(root, ["branch", "--show-current"]).catch(() => "")) || "HEAD";
    baseCommit = await gitOutput(root, ["rev-parse", "HEAD"]);
    const status = await gitOutput(root, ["status", "--porcelain"]).catch(() => "");
    const dirtyRows = status.split(/\r?\n/).filter(Boolean);
    dirty = dirtyRows.length > 0;
    statusSummary = dirtyRows.length === 0 ? "clean" : `${dirtyRows.length} pending change${dirtyRows.length === 1 ? "" : "s"}`;
  } catch {
    kind = "folder";
  }
  const repository: RepositoryInfo = {
    id: stableRepositoryId(root),
    name: path.basename(root) || root,
    rootPath: root,
    kind,
    originalBranch: branch,
    baseCommit,
    dirty,
    statusSummary,
  };
  writeProjects([repository, ...readProjects().filter((project) => project.id !== repository.id)]);
  return repository;
}

async function pickRepository(): Promise<{ canceled: true } | { canceled: false; repository: RepositoryInfo }> {
  const options: OpenDialogOptions = {
    title: "Select Repository",
    properties: ["openDirectory"],
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }
  return { canceled: false, repository: await inspectRepository(result.filePaths[0]) };
}

async function pickAttachmentFiles(input: unknown): Promise<{ canceled: true } | { canceled: false; files: ChatAttachment[] }> {
  if (!isRecord(input)) {
    throw new Error("Invalid attachment input.");
  }
  const chatIdValue = requiredString(input.chatId, "chatId");
  const repositoryId = typeof input.repositoryId === "string" && input.repositoryId.trim() ? input.repositoryId.trim() : "";
  const repository = repositoryId ? readProjects().find((project) => project.id === repositoryId) : undefined;
  const defaultPath = repository?.rootPath && fs.existsSync(repository.rootPath)
    ? path.resolve(repository.rootPath)
    : app.getPath("documents") || os.homedir();
  const options: OpenDialogOptions = {
    title: "Attach Files",
    defaultPath,
    properties: ["openFile", "multiSelections"],
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  const files: ChatAttachment[] = [];
  const seen = new Set<string>();
  const targetDirectory = chatAttachmentDirectory(chatIdValue);
  fs.mkdirSync(targetDirectory, { recursive: true });
  for (const filePath of result.filePaths) {
    const absolute = path.resolve(filePath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > chatAttachmentByteLimit || seen.has(absolute.toLowerCase())) continue;
    seen.add(absolute.toLowerCase());
    const originalName = path.basename(absolute);
    const storedName = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}-${safeAttachmentFileName(originalName)}`;
    const storedPath = path.join(targetDirectory, storedName);
    fs.copyFileSync(absolute, storedPath);
    files.push({
      path: `attachments/${storedName}`,
      name: originalName.slice(0, 120),
      source: "chat",
      storedPath,
      originalPath: absolute,
      previewDataUrl: imagePreviewDataUrl(storedPath),
      contextTokens: attachmentContextTokens(storedPath),
    });
    if (files.length >= 16) break;
  }
  if (!files.length) {
    throw new Error("No attachable files were selected.");
  }
  return { canceled: false, files };
}

function savePastedAttachments(input: unknown): { files: ChatAttachment[] } {
  if (!isRecord(input)) {
    throw new Error("Invalid pasted attachment input.");
  }
  const chatIdValue = requiredString(input.chatId, "chatId");
  const rawFiles = Array.isArray(input.files) ? input.files : [];
  const targetDirectory = chatAttachmentDirectory(chatIdValue);
  fs.mkdirSync(targetDirectory, { recursive: true });

  const files: ChatAttachment[] = [];
  for (const item of rawFiles) {
    if (!isRecord(item)) continue;
    const dataUrl = typeof item.dataUrl === "string" ? item.dataUrl : "";
    const parsed = parseAttachmentDataUrl(dataUrl);
    if (!parsed || parsed.buffer.length === 0 || parsed.buffer.length > chatAttachmentByteLimit) continue;
    const typed = item as PastedAttachmentInput;
    const rawName =
      typeof typed.name === "string" && typed.name.trim()
        ? typed.name.trim()
        : `pasted-${new Date().toISOString().replace(/[:.]/g, "-")}${extensionForMimeType(typed.mimeType || parsed.mimeType)}`;
    const ext = path.extname(rawName) ? "" : extensionForMimeType(typed.mimeType || parsed.mimeType);
    const originalName = `${rawName}${ext}`.slice(0, 160);
    const storedName = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}-${safeAttachmentFileName(originalName)}`;
    const storedPath = path.join(targetDirectory, storedName);
    fs.writeFileSync(storedPath, parsed.buffer);
    files.push({
      path: `attachments/${storedName}`,
      name: originalName.slice(0, 120),
      source: "chat",
      storedPath,
      originalPath: "clipboard",
      previewDataUrl: imagePreviewDataUrl(storedPath),
      contextTokens: attachmentContextTokens(storedPath),
    });
    if (files.length >= 16) break;
  }
  if (!files.length) {
    throw new Error("No pasteable files were found.");
  }
  return { files };
}

async function openChatAttachment(input: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!isRecord(input) || !isRecord(input.attachment)) {
    return { ok: false, message: "Invalid attachment." };
  }
  const attachment = input.attachment as Partial<ChatAttachment>;
  const repositoryId = typeof input.repositoryId === "string" && input.repositoryId.trim() ? input.repositoryId.trim() : "";
  let targetPath = "";

  if (attachment.source === "chat" && typeof attachment.storedPath === "string" && attachment.storedPath.trim()) {
    const storedPath = path.resolve(attachment.storedPath);
    if (!pathInside(chatAttachmentRoot(), storedPath)) {
      return { ok: false, message: "Attachment is outside Umbratic storage." };
    }
    targetPath = storedPath;
  } else if (attachment.source === "workspace" && typeof attachment.path === "string" && attachment.path.trim() && repositoryId) {
    const repository = readProjects().find((project) => project.id === repositoryId);
    if (!repository) {
      return { ok: false, message: "Repository was not found." };
    }
    const workspacePath = path.resolve(repository.rootPath, normalizeRelativePath(attachment.path));
    if (!pathInside(repository.rootPath, workspacePath)) {
      return { ok: false, message: "Attachment is outside the repository." };
    }
    targetPath = workspacePath;
  }

  if (!targetPath) {
    return { ok: false, message: "Attachment cannot be opened." };
  }
  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
    return { ok: false, message: "Attachment file no longer exists." };
  }

  const error = await shell.openPath(targetPath);
  return error ? { ok: false, message: error } : { ok: true };
}

async function getRepository(input: unknown): Promise<RepositoryInfo | null> {
  if (!isRecord(input)) {
    throw new Error("Invalid repository lookup input.");
  }
  const repositoryId = typeof input.repositoryId === "string" && input.repositoryId.trim() ? input.repositoryId.trim() : "";
  const repositoryPath =
    typeof input.repositoryPath === "string" && input.repositoryPath.trim() ? path.resolve(input.repositoryPath.trim()) : "";
  const existing =
    (repositoryId ? readProjects().find((project) => project.id === repositoryId) : undefined) ??
    (repositoryPath ? readProjects().find((project) => path.resolve(project.rootPath) === repositoryPath) : undefined);
  const targetPath = existing?.rootPath ?? repositoryPath;
  if (!targetPath) {
    return null;
  }
  if (!fs.existsSync(targetPath)) {
    return existing ?? null;
  }
  return inspectRepository(targetPath);
}

async function resolveRepositoryPath(input: unknown): Promise<string | null> {
  if (!isRecord(input)) {
    throw new Error("Invalid repository lookup input.");
  }
  const repositoryId = typeof input.repositoryId === "string" && input.repositoryId.trim() ? input.repositoryId.trim() : "";
  const repositoryPath =
    typeof input.repositoryPath === "string" && input.repositoryPath.trim() ? path.resolve(input.repositoryPath.trim()) : "";
  const existing =
    (repositoryId ? readProjects().find((project) => project.id === repositoryId) : undefined) ??
    (repositoryPath ? readProjects().find((project) => path.resolve(project.rootPath) === repositoryPath) : undefined);
  const targetPath = existing?.rootPath ?? repositoryPath;
  if (!targetPath || !fs.existsSync(targetPath)) {
    return null;
  }
  return targetPath;
}

async function listRepositoryBranches(
  input: unknown,
): Promise<{ ok: true; current: string; branches: string[] } | { ok: false; message: string }> {
  const targetPath = await resolveRepositoryPath(input);
  if (!targetPath) return { ok: false, message: "Repository not found." };
  try {
    const root = path.resolve(await gitOutput(targetPath, ["rev-parse", "--show-toplevel"]));
    const current = (await gitOutput(root, ["branch", "--show-current"]).catch(() => "")) || "HEAD";
    const raw = await gitOutput(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
    const branches = Array.from(
      new Set(
        raw
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
      ),
    ).sort((a, b) => a.localeCompare(b));
    return { ok: true, current, branches };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Failed to list branches." };
  }
}

async function checkoutRepositoryBranch(
  input: unknown,
): Promise<{ ok: true; repository: RepositoryInfo } | { ok: false; message: string }> {
  if (!isRecord(input)) {
    return { ok: false, message: "Invalid checkout input." };
  }
  const branch = typeof input.branch === "string" ? input.branch.trim() : "";
  if (!branch) {
    return { ok: false, message: "Branch name is required." };
  }
  const targetPath = await resolveRepositoryPath(input);
  if (!targetPath) return { ok: false, message: "Repository not found." };
  try {
    const root = path.resolve(await gitOutput(targetPath, ["rev-parse", "--show-toplevel"]));
    const result = await gitResult(root, ["checkout", branch]);
    if (!result.success) {
      const detail = (result.stderr || result.stdout || "").trim();
      return { ok: false, message: detail || `Failed to checkout ${branch}.` };
    }
    return { ok: true, repository: await inspectRepository(root) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Failed to checkout branch." };
  }
}

function requiresElevatedPermissionsApproval(classification: ReturnType<typeof classifyCommandText>): boolean {
  return classification.risky;
}

async function askPermission(
  task: TaskRecord,
  request: Omit<PermissionRequest, "id"> & { elevatedPermissionsRequiresApproval?: boolean },
): Promise<void> {
  const id = `perm-${crypto.randomBytes(6).toString("hex")}`;
  const { elevatedPermissionsRequiresApproval = false, ...visibleRequest } = request;
  const fullRequest: PermissionRequest = { id, ...visibleRequest };
  emit({ type: "permission.requested", taskId: task.id, request: fullRequest });
  if (task.permissionMode === "auto_safe" && !elevatedPermissionsRequiresApproval) {
    emit({ type: "permission.resolved", taskId: task.id, id, decision: "allow" });
    return;
  }
  return new Promise((resolve, reject) => {
    pendingPermissions.set(id, {
      taskId: task.id,
      onAllow: resolve,
      onDeny: () => reject(new Error("The user denied the requested tool action.")),
    });
  });
}

async function respondToToolPermission(input: unknown) {
  if (!isRecord(input)) {
    throw new Error("Invalid permission response.");
  }
  const taskIdValue = requiredString(input.taskId, "taskId");
  const id = requiredString(input.id, "permission id");
  if (input.decision !== "allow" && input.decision !== "deny") {
    throw new Error("Invalid permission decision.");
  }
  const decision = input.decision;
  const pending = pendingPermissions.get(id);
  if (!pending || pending.taskId !== taskIdValue) {
    throw new Error("Permission request is no longer pending.");
  }
  pendingPermissions.delete(id);
  emit({ type: "permission.resolved", taskId: taskIdValue, id, decision });
  if (decision === "allow") {
    await pending.onAllow();
  } else {
    await pending.onDeny();
  }
}

async function runnerPromptForTaskWithPermission(
  task: TaskRecord,
  userPrompt: string,
  attachments: ChatAttachment[],
  contextLength: number,
): Promise<RunnerPromptPart[]> {
  const rootPath = fs.existsSync(task.worktreePath) ? task.worktreePath : task.originalRepoPath;
  const needsWorkspaceSnapshot = !task.agentBranch || !!task.worktreeRootTaskId;
  if (needsWorkspaceSnapshot && !task.baselineFiles) {
    task.baselineFiles = snapshotFolder(rootPath);
    saveTask(task);
  }
  return runnerPromptForTask(task, userPrompt, attachments, contextLength);
}

async function runCommandForTask(
  task: TaskRecord,
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number },
): Promise<CommandResult> {
  const displayCommand = commandText(command, args);
  const classification = classifyCommandText(displayCommand, options.cwd);
  await askPermission(task, {
    kind: "bash",
    summary: displayCommand,
    command: displayCommand,
    commandClass: classification.commandClass,
    cwd: options.cwd,
    elevatedPermissionsRequiresApproval: requiresElevatedPermissionsApproval(classification),
  });
  const id = `cmd-${crypto.randomBytes(6).toString("hex")}`;
  emit({
    type: "command.started",
    taskId: task.id,
    id,
    command: displayCommand,
    cwd: options.cwd,
    kind: "bash",
    commandClass: classification.commandClass,
  });
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill();
      }
    }, options.timeout ?? 180000);
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout = `${stdout}${text}`.slice(-12000);
      emit({ type: "command.output", taskId: task.id, id, stream: "stdout", text });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr = `${stderr}${text}`.slice(-12000);
      emit({ type: "command.output", taskId: task.id, id, stream: "stderr", text });
    });
    child.once("error", (error) => {
      settled = true;
      clearTimeout(timer);
      stderr = `${stderr}${error.message}`;
      emit({ type: "command.output", taskId: task.id, id, stream: "stderr", text: error.message });
      emit({ type: "command.finished", taskId: task.id, id, exitCode: 1 });
      resolve({ stdout, stderr, exitCode: 1, success: false });
    });
    child.once("exit", (code) => {
      settled = true;
      clearTimeout(timer);
      emit({ type: "command.finished", taskId: task.id, id, exitCode: code });
      resolve({ stdout, stderr, exitCode: code, success: code === 0 });
    });
  });
}

async function getChangedFiles(worktreePath: string, baseCommit: string): Promise<string[]> {
  if (baseCommit === "HEAD") {
    const status = await gitResult(worktreePath, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]);
    if (!status.success) {
      throw new Error((status.stderr || "Failed to read repository status.").trim());
    }
    return parseGitPorcelainPaths(status.stdout)
      .map((file) => normalizeRelativePath(file))
      .filter(Boolean);
  }
  const tracked = await gitOutput(worktreePath, ["diff", "--name-only", "--diff-filter=ACMRTD", baseCommit]);
  const untracked = await gitOutput(worktreePath, ["ls-files", "--others", "--exclude-standard"]);
  return Array.from(
    new Set(
      [...tracked.split(/\r?\n/), ...untracked.split(/\r?\n/)]
        .map((row) => normalizeRelativePath(row.trim()))
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b));
}

function folderReviewFiles(task: TaskRecord): ReviewFile[] {
  const before = task.baselineFiles ?? {};
  const after = snapshotFolder(task.worktreePath);
  const paths = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
    .filter((file) => !isGeneratedRuntimePath(file))
    .sort((a, b) => a.localeCompare(b));
  return paths
    .map((file) => buildSnapshotDiff(file, before[file] ?? null, after[file] ?? null))
    .filter((file): file is ReviewFile => !!file);
}

async function gitWorkspaceReviewFiles(repositoryPath: string, baseline: string): Promise<ReviewFile[]> {
  const changed = (await getChangedFiles(repositoryPath, baseline))
    .filter((file) => !isGeneratedRuntimePath(file))
    .sort((a, b) => a.localeCompare(b));
  const files: ReviewFile[] = [];
  for (const file of changed) {
    const absolute = path.join(repositoryPath, file);
    const status = await gitFileStatus(repositoryPath, baseline, file);
    const diff = await gitOutput(repositoryPath, ["diff", "--no-ext-diff", "--binary", "--find-renames", "--find-copies", "--unified=20", baseline, "--", file]).catch(
      () => "",
    );
    if (diff.trim()) {
      files.push(normalizeReviewFile({ path: file, status, diff }));
      continue;
    }
    const text = readTextFileIfSafe(absolute);
    if (text !== null) {
      const review = buildTextDiff(file, null, text);
      if (review) {
        files.push(review);
      }
      continue;
    }
    const review = buildBinaryDiff(
      file,
      status === "added" ? null : "before",
      status === "deleted" ? null : "after",
    );
    if (review) {
      files.push(review);
    }
  }
  return files;
}

async function gitReviewFiles(task: TaskRecord, baseline = task.baseCommit, repositoryPath = task.worktreePath): Promise<ReviewFile[]> {
  if (task.baselineFiles && baseline !== "HEAD") {
    return folderReviewFiles(task);
  }
  return gitWorkspaceReviewFiles(repositoryPath, baseline);
}

async function gitFileStatus(repositoryPath: string, baseline: string, file: string): Promise<ReviewFile["status"]> {
  const absolute = path.join(repositoryPath, file);
  const afterExists = fs.existsSync(absolute);
  const before = await gitResult(repositoryPath, ["cat-file", "-e", `${baseline}:${file.replace(/\\/g, "/")}`]);
  if (!before.success && afterExists) {
    return "added";
  }
  if (before.success && !afterExists) {
    return "deleted";
  }
  return "modified";
}

async function refreshReview(
  task: TaskRecord,
  scope: "task" | "worktree" = "task",
  wholeDiffWorkspacePath?: string,
): Promise<ReviewFile[]> {
  const workspacePath = scope === "worktree" && wholeDiffWorkspacePath
    ? wholeDiffWorkspacePath
    : fs.existsSync(task.worktreePath)
      ? task.worktreePath
      : task.originalRepoPath;
  const worktreeIsGit = scope === "worktree"
    && (await gitResult(workspacePath, ["rev-parse", "--is-inside-work-tree"])).success;
  const discoveredReviewFiles = task.workspaceKind === "folder" && !worktreeIsGit
    ? folderReviewFiles(task)
    : scope === "worktree"
      ? await gitReviewFiles(task, "HEAD", workspacePath)
      : await gitReviewFiles(task);
  const reviewFiles = filterReviewFiles(discoveredReviewFiles, hiddenChatAttachmentReviewPaths(task));
  task.reviewFiles = reviewFiles;
  task.changedFiles = reviewFiles.map((file) => file.path);
  task.reviewScope = scope;
  task.reviewBaselineLabel = scope === "worktree" ? "Whole diff" : "Turn changes";
  task.reviewBaselineOid = scope === "worktree"
    ? await gitOutput(workspacePath, ["rev-parse", "--short", "HEAD"]).catch(() => "HEAD")
    : (task.workspaceKind === "folder" && !worktreeIsGit) || !taskUsesIsolatedWorktree(task)
      ? "task start"
      : task.baseCommit.slice(0, 10) || "task start";
  return reviewFiles;
}

function reviewPatchHash(reviewFiles: ReviewFile[]): string {
  const normalized = reviewFiles
    .map((file) => `${file.path}\0${file.status}\0${file.diff}`)
    .sort()
    .join("\0");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function emitReviewChangedSinceReady(task: TaskRecord, reviewFiles: ReviewFile[]) {
  const currentPatchHash = reviewPatchHash(reviewFiles);
  if (!task.reviewPatchHash || task.reviewPatchHash === currentPatchHash) {
    return currentPatchHash;
  }
  emit({
    type: "review.changed_since_ready",
    taskId: task.id,
    previousPatchHash: task.reviewPatchHash,
    currentPatchHash,
    changedFileCount: reviewFiles.length,
  });
  return currentPatchHash;
}

async function refreshTaskReview(input: unknown): Promise<TaskInfo | null> {
  if (!isRecord(input)) {
    throw new Error("Invalid review refresh input.");
  }
  const task = getTask(requiredString(input.taskId, "taskId"));
  const scope = input.scope === "worktree"
    ? "worktree"
    : input.scope === "task"
      ? "task"
      : task.reviewScope === "worktree"
        ? "worktree"
        : "task";
  let requestedWholeDiffPath: string | undefined;
  if (scope === "worktree" && typeof input.repositoryPath === "string" && input.repositoryPath.trim()) {
    const selectedPath = path.resolve(input.repositoryPath.trim());
    if (!fs.existsSync(selectedPath) || !fs.statSync(selectedPath).isDirectory()) {
      throw new Error("The selected project folder is no longer available.");
    }
    requestedWholeDiffPath = path.resolve(
      await gitOutput(selectedPath, ["rev-parse", "--show-toplevel"]).catch(() => selectedPath),
    );
  }
  const wholeWorkspaceStillAvailable = scope === "worktree" && fs.existsSync(task.originalRepoPath);
  if (!fs.existsSync(task.worktreePath) && !wholeWorkspaceStillAvailable && !requestedWholeDiffPath) {
    return publicTask(task);
  }
  await refreshReview(task, scope, requestedWholeDiffPath);
  saveTask(task);
  return publicTask(task);
}

async function refreshWorkspaceReview(input: unknown): Promise<{ reviewFiles: ReviewFile[]; baselineOid: string }> {
  if (!isRecord(input)) {
    throw new Error("Invalid workspace review input.");
  }
  const selectedPath = path.resolve(requiredString(input.repositoryPath, "repository path"));
  if (!fs.existsSync(selectedPath) || !fs.statSync(selectedPath).isDirectory()) {
    throw new Error("The selected project folder is no longer available.");
  }
  const repositoryPath = path.resolve(await gitOutput(selectedPath, ["rev-parse", "--show-toplevel"]));
  const reviewFiles = await gitWorkspaceReviewFiles(repositoryPath, "HEAD");
  const baselineOid = await gitOutput(repositoryPath, ["rev-parse", "--short", "HEAD"]).catch(() => "HEAD");
  return { reviewFiles, baselineOid };
}

async function handleRunnerPermission(
  task: TaskRecord,
  run: RunnerProcess,
  permission: Record<string, unknown>,
  promptForRun: RunnerPrompt,
  intentPrompt: string,
  safety?: Record<string, unknown>,
): Promise<"pending" | "resolved" | "worktree_requested"> {
  const id = typeof permission.id === "string" ? permission.id : "";
  if (!id || pendingPermissions.has(id)) return "pending";
  const type =
    (typeof permission.type === "string" && permission.type) ||
    (typeof permission.permission === "string" && permission.permission) ||
    (typeof permission.permissionKind === "string" && permission.permissionKind) ||
    "tool";
  const title =
    (typeof permission.title === "string" && permission.title.trim()) ||
    (typeof permission.summary === "string" && permission.summary.trim()) ||
    type;
  const safetyCommandClass = typeof safety?.commandClass === "string" ? safety.commandClass as CommandClass : undefined;
  const classification = type.includes("edit")
    ? ({ commandClass: "edit" as const, risky: false })
    : type === "read" || type === "search"
      ? ({ commandClass: "read" as const, risky: false })
    : safetyCommandClass
      ? ({ commandClass: safetyCommandClass, risky: safety?.action !== "allow" })
      : classifyCommandText(title, task.worktreePath);

  if (type === "read" || type === "search") {
    emit({ type: "permission.resolved", taskId: task.id, id, decision: "allow" });
    await replyRunnerPermission(run, id, true);
    return "resolved";
  }

  if (task.workspaceKind === "git" && task.workspaceMode === "worktree" && !task.agentBranch && type === "edit") {
    task.agentBranch = `umbratic/${task.id}-${slugify(intentPrompt)}`;
    task.worktreePath = path.join(worktreeRootForRepo(task.originalRepoPath), task.id);
    task.runnerSessionId = undefined;
    task.diagnosticLogPath = undefined;
    task.pendingPrompt = runnerPromptText(promptForRun);
    pendingRunnerPrompts.set(task.id, runnerPromptParts(promptForRun));
    task.state = permissionMode === "auto_safe" ? "running" : "awaiting_worktree_approval";
    saveTask(task);
    await replyRunnerPermission(run, id, false).catch(() => undefined);
    if (permissionMode === "auto_safe") {
      void createWorktreeAndRunRunner(task, promptForRun);
    } else {
      emit({
        type: "worktree.requested",
        taskId: task.id,
        branch: task.agentBranch,
        path: task.worktreePath,
        baseCommit: task.baseCommit,
      });
      recordProductTelemetry("worktree.requested", {
        taskId: task.id,
        chatId: task.chatId,
        repositoryId: task.repositoryId,
      });
    }
    return "worktree_requested";
  }

  const request: PermissionRequest = {
    id,
    kind: type.includes("edit") ? "edit" : type === "read" || type === "search" ? "read" : "bash",
    summary: title,
    command: title,
    commandClass: classification.commandClass,
    cwd: task.worktreePath,
    ...(typeof safety?.explanation === "string" ? { consequence: safety.explanation.slice(0, 500) } : {}),
    ...(isRecord(safety?.matchedSpan) && typeof safety.matchedSpan.preview === "string"
      ? { riskyFragment: safety.matchedSpan.preview.slice(0, 240) }
      : {}),
    ...(typeof safety?.suggestion === "string" ? { suggestion: safety.suggestion.slice(0, 500) } : {}),
  };
  emit({ type: "permission.requested", taskId: task.id, request });

  if (type === "webfetch" || type === "websearch") {
    emit({ type: "permission.resolved", taskId: task.id, id, decision: "deny" });
    await replyRunnerPermission(run, id, false);
    return "resolved";
  }

  if (
    task.permissionMode === "auto_safe" &&
    (type === "read" || type === "search" || type === "edit" || (type === "bash" && safety?.action === "allow")) &&
    !requiresElevatedPermissionsApproval(classification)
  ) {
    emit({ type: "permission.resolved", taskId: task.id, id, decision: "allow" });
    await replyRunnerPermission(run, id, true);
    return "resolved";
  }

  pendingPermissions.set(id, {
    taskId: task.id,
    onAllow: () => replyRunnerPermission(run, id, true),
    onDeny: () => replyRunnerPermission(run, id, false),
  });
  return "pending";
}

async function runRunnerTask(
  taskIdValue: string,
  promptForRun?: RunnerPrompt,
  intentPrompt?: string,
  attachments: ChatAttachment[] = [],
) {
  const task = getTask(taskIdValue);
  let run: RunnerProcess | null = null;
  let runnerFailureDetails: { category?: string; code?: string; detail?: string } = {};
  const intent = intentPrompt ?? task.prompt;
  try {
    const { providers, selected } = await resolveSelectedModel();
    if (!taskStillRunning(task)) {
      return;
    }
    if (!selected) {
      failTask(task, providers[0]?.message ?? "Veil health check is not ready.");
      return;
    }
    const selectedForRun = shouldProbeVeilContext(task.model, selected)
      ? await modelWithFreshContextLength(selected)
      : { ...selected, contextLength: task.model?.contextLength ?? readContextLengthSetting() };
    task.model = selectedForRun;
    applyTaskPolicyMetadata(task);
    saveTask(task);
    const prompt = promptForRun
      ?? (await runnerPromptForTaskWithPermission(
        task,
        intent,
        attachments,
        selectedForRun.contextLength ?? readContextLengthSetting(),
      ));
    const promptParts = runnerPromptParts(prompt);
    run = await startUmbraticRunnerServer(
      task,
      selectedForRun,
      task.chatId ? chatAttachmentDirectory(task.chatId) : undefined,
    );
    if (!taskStillRunning(task)) {
      return;
    }
    activeRunnerProcesses.set(task.id, run);
    task.diagnosticLogPath = run.diagnosticLogPath;
    saveTask(task);

    const toolRuns = new Map<string, {
      commandId: string;
      command: string;
      kind: PermissionRequest["kind"];
      toolKind?: string;
      input: unknown;
      stdout: string[];
      stderr: string[];
      finished: boolean;
    }>();
    let latestCommandSafety: Record<string, unknown> | undefined;
    const assistantOutput = new RunnerAssistantOutputBuffer();
    let delegatedToWorktree = false;
    let completed = false;
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: Error) => void;
    let completion: Promise<void>;
    const armCompletion = () => {
      completed = false;
      completion = new Promise<void>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
    };
    armCompletion();

    const finish = () => {
      if (completed) return;
      completed = true;
      resolveCompletion();
    };

    const finishOpenToolRuns = () => {
      for (const current of toolRuns.values()) {
        if (current.finished) continue;
        current.finished = true;
        emit({ type: "command.finished", taskId: task.id, id: current.commandId, exitCode: 0 });
      }
    };

    const fail = (message: string) => {
      if (completed) return;
      completed = true;
      rejectCompletion(new Error(message));
    };

    const eventAt = (event: Record<string, unknown>): string | undefined => (
      typeof event.at === "string" ? event.at : undefined
    );
    const eventEndedAt = (event: Record<string, unknown>): string | undefined => (
      typeof event.endedAt === "string" ? event.endedAt : undefined
    );

    const emitAssistantText = (text: string, at?: string, endedAt?: string) => {
      if (!text || text.trim() === "Ready for review.") return;
      emit({ type: "assistant.delta", taskId: task.id, text, at, endedAt });
    };

    const emitReasoningText = (text: string, at?: string, endedAt?: string) => {
      if (!text || task.reasoningMode !== "reasoning") return;
      emit({ type: "assistant.reasoning.delta", taskId: task.id, text, at, endedAt });
    };

    const emitBufferedAssistantOutput = (output: BufferedRunnerAssistantOutput | null) => {
      if (!output) return;
      if (output.kind === "assistant") {
        emitAssistantText(output.text, output.at, output.endedAt);
        return;
      }
      emitReasoningText(output.text, output.at, output.endedAt);
    };

    const ensureToolRun = (
      toolCallId: string,
      command: string,
      kind: PermissionRequest["kind"],
      commandClass: CommandClass,
      toolKind?: string,
      input?: unknown,
    ) => {
      const existing = toolRuns.get(toolCallId);
      if (existing) {
        if (toolKind && !existing.toolKind) existing.toolKind = toolKind;
        if (input !== undefined) existing.input = input;
        return existing;
      }
      const current = {
        commandId: `ar-${toolCallId}`,
        command,
        kind,
        toolKind,
        input: input ?? {},
        stdout: [] as string[],
        stderr: [] as string[],
        finished: false,
      };
      toolRuns.set(toolCallId, current);
      emit({
        type: "command.started",
        taskId: task.id,
        id: current.commandId,
        command,
        cwd: task.worktreePath,
        kind,
        commandClass,
        toolKind,
        input,
      });
      return current;
    };

    const onEvent = (event: Record<string, unknown>) => {
      const type = typeof event.type === "string" ? event.type : "";
      const eventTaskId = typeof event.taskId === "string" ? event.taskId : task.id;
      if (eventTaskId !== task.id) return;

      if (type === "assistant.delta" && typeof event.text === "string") {
        emitBufferedAssistantOutput(assistantOutput.append(event.text, eventAt(event), eventEndedAt(event)));
        return;
      }

      if (type === "assistant.answer.started") {
        emitBufferedAssistantOutput(assistantOutput.startAnswer());
        return;
      }

      if (type === "assistant.reasoning.delta" && typeof event.text === "string") {
        emitBufferedAssistantOutput(assistantOutput.continueWorking());
        emitReasoningText(event.text, eventAt(event), eventEndedAt(event));
        return;
      }

      if (type === "tool.requested") {
        emitBufferedAssistantOutput(assistantOutput.continueWorking());
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : `tool-${toolRuns.size + 1}`;
        const toolKind = typeof event.toolKind === "string" ? event.toolKind : "tool";
        const runnerToolKind = (
          toolKind === "read" || toolKind === "write" || toolKind === "edit" || toolKind === "search" || toolKind === "command"
        ) ? toolKind as RunnerToolId : undefined;
        const command = typeof event.summary === "string" && event.summary.trim() ? event.summary.trim() : toolKind;
        const kind: PermissionRequest["kind"] =
          toolKind === "command"
            ? "bash"
            : toolKind === "read" || toolKind === "search" || toolKind === "read_skill"
              ? "read"
              : "edit";
        const fallbackClass = kind === "bash" ? classifyCommandText(command, task.worktreePath).commandClass : kind;
        const commandClass = typeof event.commandClass === "string" ? event.commandClass as CommandClass : fallbackClass;
        ensureToolRun(toolCallId, command, kind, commandClass, runnerToolKind ?? toolKind, event.arguments);
        return;
      }

      if (type === "command.safety.decision") {
        latestCommandSafety = event;
        return;
      }

      if (type === "tool.output") {
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
        if (!toolCallId) return;
        const stream = event.stream === "stderr" ? "stderr" : "stdout";
        const text = typeof event.text === "string" ? event.text : "";
        const current = ensureToolRun(toolCallId, toolCallId, "bash", "shell");
        if (text) {
          current[stream].push(text);
          emit({
            type: "command.output",
            taskId: task.id,
            id: current.commandId,
            stream,
            text: text.slice(0, 12000),
            at: eventAt(event),
            endedAt: eventEndedAt(event),
          });
        }
        return;
      }

      if (type === "tool.finished") {
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
        if (!toolCallId) return;
        const current = ensureToolRun(toolCallId, toolCallId, "bash", "shell");
        if (!current.finished) {
          current.finished = true;
          const exitCode = typeof event.exitCode === "number" ? event.exitCode : null;
          const status = typeof event.status === "string" ? event.status as ToolResultStatus : undefined;
          const errorCode = typeof event.errorCode === "string" ? event.errorCode as ToolErrorCode : undefined;
          const errorMessage = typeof event.errorMessage === "string" ? event.errorMessage : undefined;
          const durationMs = typeof event.durationMs === "number" && Number.isFinite(event.durationMs) ? event.durationMs : undefined;
          emit({
            type: "command.finished",
            taskId: task.id,
            id: current.commandId,
            exitCode,
            ...(status ? { status } : {}),
            ...(errorCode ? { errorCode } : {}),
            ...(errorMessage ? { errorMessage: errorMessage.slice(0, 1000) } : {}),
            ...(durationMs !== undefined ? { durationMs } : {}),
            at: eventAt(event),
          });
          if (exitCode !== 0 || (status && status !== "success")) {
            emit({
              type: "tool.failed",
              taskId: task.id,
              id: current.commandId,
              toolKind: current.toolKind ?? "tool",
              input: current.input,
              response: {
                stdout: current.stdout.join(""),
                stderr: current.stderr.join(""),
                ...(typeof event.response === "string" ? { toolResponse: event.response } : {}),
                exitCode,
                ...(status ? { status } : {}),
                ...(errorCode ? { errorCode } : {}),
                ...(errorMessage ? { errorMessage } : {}),
              },
              at: eventAt(event),
            });
          }
        }
        return;
      }

      if (type === "context.compressed") {
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
        const toolKind = typeof event.toolKind === "string" ? event.toolKind : "tool";
        const kind = (typeof event.kind === "string" ? event.kind : "plain_text") as ContextContentKind;
        const strategy = (typeof event.strategy === "string" ? event.strategy : "passthrough") as ContextCompressionStrategy;
        const originalBytes = typeof event.originalBytes === "number" && Number.isFinite(event.originalBytes) ? event.originalBytes : 0;
        const outputBytes = typeof event.outputBytes === "number" && Number.isFinite(event.outputBytes) ? event.outputBytes : 0;
        emit({
          type: "context.compressed",
          taskId: task.id,
          toolCallId,
          toolKind,
          kind,
          strategy,
          ...(typeof event.hash === "string" ? { hash: event.hash } : {}),
          originalBytes,
          outputBytes,
          at: eventAt(event),
        });
        return;
      }

      if (type === "context.usage") {
        const validNonNegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
        if (!(validNonNegative(event.contextLength) && event.contextLength > 0)
          || !validNonNegative(event.contentTokens)
          || !validNonNegative(event.reserveTokens)) return;
        if (event.promptTokens !== undefined && (!validNonNegative(event.promptTokens) || event.promptTokens !== event.contentTokens)) return;
        if (event.completionTokens !== undefined && !validNonNegative(event.completionTokens)) return;
        const contextLength = event.contextLength;
        const contentTokens = event.contentTokens;
        const reserveTokens = event.reserveTokens;
        const estimatedTokens = contentTokens + reserveTokens;
        emit({
          type: "context.usage",
          taskId: task.id,
          contextLength,
          contentTokens,
          ...(event.promptTokens !== undefined ? { promptTokens: event.promptTokens } : {}),
          ...(event.completionTokens !== undefined ? { completionTokens: event.completionTokens } : {}),
          reserveTokens,
          estimatedTokens,
          ...(event.phase === "preflight" || event.phase === "observed" ? { phase: event.phase } : {}),
          ...(event.source === "heuristic" || event.source === "provider" ? { source: event.source } : {}),
          ...(event.confidence === "low" || event.confidence === "high" ? { confidence: event.confidence } : {}),
          at: eventAt(event),
        });
        return;
      }

      if (type === "context.retrieved") {
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
        const hash = typeof event.hash === "string" ? event.hash : "";
        const offset = typeof event.offset === "number" && Number.isFinite(event.offset) ? event.offset : 0;
        const bytesShown = typeof event.bytesShown === "number" && Number.isFinite(event.bytesShown) ? event.bytesShown : 0;
        const totalBytes = typeof event.totalBytes === "number" && Number.isFinite(event.totalBytes) ? event.totalBytes : 0;
        emit({
          type: "context.retrieved",
          taskId: task.id,
          toolCallId,
          hash,
          offset,
          bytesShown,
          totalBytes,
          at: eventAt(event),
        });
        return;
      }

      if (type === "permission.requested") {
        const permission = {
          id: typeof event.permissionId === "string" ? event.permissionId : "",
          type: typeof event.permissionKind === "string" ? event.permissionKind : "tool",
          title: typeof event.summary === "string" ? event.summary : "",
        };
        const safety = latestCommandSafety;
        latestCommandSafety = undefined;
        void handleRunnerPermission(task, run as RunnerProcess, permission, prompt, intent, safety)
          .then((result) => {
            if (result === "worktree_requested") {
              delegatedToWorktree = true;
              finish();
            }
          })
          .catch((error) => fail(String(error instanceof Error ? error.message : error)));
        return;
      }

      if (type === "runner.error") {
        emitBufferedAssistantOutput(assistantOutput.fail());
        const message = typeof event.message === "string" && event.message.trim() ? event.message : "Umbratic runner failed.";
        runnerFailureDetails = {
          ...(typeof event.category === "string" ? { category: event.category.slice(0, 80) } : {}),
          ...(typeof event.code === "string" ? { code: event.code.slice(0, 120) } : {}),
          ...(typeof event.detail === "string" ? { detail: event.detail.slice(0, 1000) } : {}),
        };
        fail(message);
        return;
      }

      if (type === "session.idle") {
        finishOpenToolRuns();
        emitBufferedAssistantOutput(assistantOutput.complete());
        finish();
      }
    };

    const stream = beginRunnerEventStream(run, onEvent);
    void stream.done.catch((error) => {
      if (!run?.abortController.signal.aborted) {
        emitBufferedAssistantOutput(assistantOutput.fail());
        fail(String(error instanceof Error ? error.message : error));
      }
    });
    await stream.ready;
    // Runner sessions live only inside the runner process started above.
    // Because Umbratic starts a fresh process for each task run, a persisted
    // runnerSessionId from an earlier process is stale and cannot be reused.
    const contextState = task.chatId ? readChat(task.chatId)?.contextState : undefined;
    const session = await runnerRequest<{ id: string }>(run, "/session", {
      method: "POST",
      body: { contextState: contextState ?? null },
    });
    run.sessionId = session.id;
    task.runnerSessionId = session.id;
    saveTask(task);
    await runnerRequest<void>(run, `/session/${encodeURIComponent(session.id)}/prompt_async`, {
      method: "POST",
      body: {
        model: { providerID: selected.providerId, modelID: selected.modelId },
        agent: "build",
        parts: promptParts,
      },
    });

    const waitForCompletion = () =>
      Promise.race([
        completion,
        new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("Umbratic runner task timed out.")), 45 * 60 * 1000)),
      ]);

    await waitForCompletion();

    if (task.chatId) {
      const snapshot = await runnerRequest<ContextStateV1>(
        run,
        `/session/${encodeURIComponent(session.id)}/context`,
      );
      const chat = readChat(task.chatId);
      if (chat) {
        writeChat({ ...chat, contextState: snapshot });
      }
    }

    if (delegatedToWorktree || task.state === "awaiting_worktree_approval") {
      return;
    }

    if (run.abortController.signal.aborted || !taskStillRunning(task)) {
      return;
    }

    task.latestTest = {
      command: `umbratic runner session ${session.id}`,
      output: "Umbratic runner session completed",
      passed: true,
      exitCode: 0,
      completedAt: new Date().toISOString(),
    };
    const reviewFiles = await refreshReview(task);
    if (reviewFiles.length === 0) {
      task.state = "completed";
      saveTask(task);
      emit({ type: "assistant.done", taskId: task.id });
      return;
    }
    task.state = "review_ready";
    task.reviewPatchHash = reviewPatchHash(reviewFiles);
    saveTask(task);
    emit({ type: "assistant.done", taskId: task.id });
    emit({ type: "review.ready", taskId: task.id, changedFiles: task.changedFiles, reviewFiles, latestTest: task.latestTest });
    run.abortController.abort();
    await stream.done.catch(() => undefined);
  } catch (error) {
    failTask(task, String(error instanceof Error ? error.message : error), runnerFailureDetails);
  } finally {
    clearPendingPermissionsForTask(task.id);
    activeRunnerProcesses.delete(task.id);
    if (run) {
      stopRunnerProcess(run);
    }
  }
}

async function createWorktreeAndRunRunner(
  task: TaskRecord,
  promptForRun?: RunnerPrompt,
  attachments: ChatAttachment[] = [],
  intentPrompt?: string,
) {
  try {
    fs.mkdirSync(path.dirname(task.worktreePath), { recursive: true });
    await execFileOutput("git", ["worktree", "add", "-b", task.agentBranch, task.worktreePath, task.baseCommit], {
      cwd: task.originalRepoPath,
      timeout: 120000,
    });
    task.state = "running";
    if (promptForRun && task.pendingPrompt === runnerPromptText(promptForRun)) {
      task.pendingPrompt = undefined;
    }
    pendingRunnerPrompts.delete(task.id);
    saveTask(task);
    emit({ type: "worktree.created", taskId: task.id, branch: task.agentBranch, path: task.worktreePath });
    recordProductTelemetry("worktree.created", {
      taskId: task.id,
      chatId: task.chatId,
      repositoryId: task.repositoryId,
    });
    void runRunnerTask(task.id, promptForRun, intentPrompt, attachments);
  } catch (error) {
    failTask(task, String(error instanceof Error ? error.message : error));
  }
}

function closedTaskMessage(task: TaskRecord): string | undefined {
  if (task.state === "merged") {
    return taskUsesIsolatedWorktree(task)
      ? "This chat was closed after its approved merge. Start a new chat for more changes."
      : "This chat was closed after its workspace changes were approved. Start a new chat for more changes.";
  }
  return undefined;
}

function taskUsesHiddenChatWorkspace(task: TaskRecord, chat: ChatRecord): boolean {
  return (
    task.hiddenWorkspace === true ||
    (task.repositoryId === `hidden-${chat.id}` && path.resolve(task.originalRepoPath) === hiddenChatWorkspacePath(chat.id))
  );
}

function attachHiddenTaskToRepository(task: TaskRecord, repository: RepositoryInfo) {
  task.repositoryId = repository.id;
  task.workspaceKind = repository.kind;
  task.workspaceMode = "local";
  task.hiddenWorkspace = false;
  task.originalBranch = repository.originalBranch;
  task.baseCommit = repository.baseCommit;
  task.agentBranch = "";
  task.worktreePath = repository.rootPath;
  task.originalRepoPath = repository.rootPath;
  task.originalWasDirty = repository.dirty;
  task.baselineFiles = snapshotFolder(repository.rootPath);
  task.runnerName = umbraticRunnerName;
  task.runnerVersion = umbraticRunnerVersion;
  task.policyVersion = umbraticPolicyVersion;
  task.runnerSessionId = undefined;
  task.diagnosticLogPath = undefined;
  task.pendingPrompt = undefined;
  task.changedFiles = [];
  task.reviewFiles = [];
  task.latestTest = undefined;
  task.patchHash = undefined;
  task.metadataPath = undefined;
}

function startTaskRequestKey(input: Record<string, unknown>): string {
  const attachedFiles = Array.isArray(input.attachedFiles)
    ? input.attachedFiles.map((file) => {
        if (!isRecord(file)) return {};
        return {
          path: typeof file.path === "string" ? file.path : "",
          name: typeof file.name === "string" ? file.name : "",
          storedPath: typeof file.storedPath === "string" ? file.storedPath : "",
          originalPath: typeof file.originalPath === "string" ? file.originalPath : "",
        };
      })
    : [];
  const enabledTools = Array.isArray(input.enabledTools)
    ? input.enabledTools.filter((tool): tool is string => typeof tool === "string").sort()
    : [];
  return JSON.stringify({
    repositoryId: typeof input.repositoryId === "string" ? input.repositoryId.trim() : "",
    worktreeTaskId: typeof input.worktreeTaskId === "string" ? input.worktreeTaskId.trim() : "",
    prompt: typeof input.prompt === "string" ? input.prompt.trim() : "",
    attachedFiles,
    reasoningMode: input.reasoningMode === "fast" ? "fast" : "reasoning",
    useWorktree: input.useWorktree === true,
    enabledTools,
  });
}

function recentActiveStartTask(requestKey: string): TaskInfo | null {
  const recent = recentStartTaskRequests.get(requestKey);
  if (!recent) return null;
  if (recent.expiresAt <= Date.now()) {
    recentStartTaskRequests.delete(requestKey);
    return null;
  }
  const task = readTask(recent.taskId);
  if (!task) {
    recentStartTaskRequests.delete(requestKey);
    return null;
  }
  if (
    activeRunnerProcesses.has(task.id) ||
    task.state === "running" ||
    task.state === "awaiting_worktree_approval" ||
    task.state === "approving"
  ) {
    return publicTask(task);
  }
  return null;
}

async function startTask(input: unknown): Promise<TaskInfo> {
  if (!isRecord(input)) {
    throw new Error("Invalid task input.");
  }
  const requestKey = startTaskRequestKey(input);
  const activeRequest = activeStartTaskRequests.get(requestKey);
  if (activeRequest) return activeRequest;
  const recentTask = recentActiveStartTask(requestKey);
  if (recentTask) return recentTask;

  const request = startTaskOnce(input);
  activeStartTaskRequests.set(requestKey, request);
  try {
    const task = await request;
    recentStartTaskRequests.set(requestKey, { taskId: task.id, expiresAt: Date.now() + 15000 });
    return task;
  } finally {
    activeStartTaskRequests.delete(requestKey);
  }
}

async function startTaskOnce(input: Record<string, unknown>): Promise<TaskInfo> {
  const requestedRepositoryId =
    typeof input.repositoryId === "string" && input.repositoryId.trim() ? input.repositoryId.trim() : "";
  const prompt = requiredString(input.prompt, "prompt");
  const reasoningMode = parseReasoningMode(input.reasoningMode);
  const requestedChatId = typeof input.chatId === "string" && input.chatId.trim() ? input.chatId.trim() : undefined;
  const inputWorktreeTaskId =
    typeof input.worktreeTaskId === "string" && input.worktreeTaskId.trim() ? input.worktreeTaskId.trim() : undefined;
  const hiddenWorkspace = !requestedRepositoryId;
  const existingChat = requestedChatId ? readChats().find((row) => row.id === requestedChatId) : undefined;
  const requestedWorktreeTaskId = inputWorktreeTaskId ?? chatWorktreeTaskId(existingChat);
  const nextChatId = existingChat?.id ?? requestedChatId ?? chatId();
  const repositoryForChat = hiddenWorkspace
    ? hiddenChatRepository(nextChatId)
    : readProjects().find((project) => project.id === requestedRepositoryId);
  if (!repositoryForChat) {
    throw new Error("Repository has not been selected.");
  }
  const refreshed = hiddenWorkspace ? repositoryForChat : await inspectRepository(repositoryForChat.rootPath);
  const chat =
    existingChat ??
    createChat({
      id: nextChatId,
      title: chatTitleFromFirstMessage(prompt),
      repositoryName: refreshed.name,
      repositoryPath: hiddenWorkspace ? undefined : refreshed.rootPath,
    });
  const repositoryId = refreshed.id;
  const sanitizedAttachments = sanitizeAttachments(input.attachedFiles, refreshed.rootPath, chat.id);
  const attachments = sanitizedAttachments;
  const existingTask = chat?.taskId ? readTask(chat.taskId) ?? undefined : undefined;
  const reusableWorktreeTask = requestedWorktreeTaskId ? findReusableWorktreeTask(requestedWorktreeTaskId) : undefined;
  const requestedWorkspaceMode: WorkspaceMode =
    !hiddenWorkspace && refreshed.kind === "git" && input.useWorktree === true ? "worktree" : "local";
  if (requestedWorktreeTaskId && requestedWorkspaceMode === "worktree" && !reusableWorktreeTask) {
    throw new Error("This worktree is no longer open. Start a new worktree chat from the project.");
  }
  const requestedEnabledTools = normalizeEnabledTools(input.enabledTools, enabledToolsFromSettings({}));
  const capabilityReport = await probeLocalCapabilities({ runnerPath: runnerBinaryPath() });
  const taskCapabilityProbes = capabilityTelemetrySnapshot(capabilityReport, capabilityNeedsForPrompt(prompt, attachments));

  if (existingTask) {
    const closedMessage = closedTaskMessage(existingTask);
    if (closedMessage) {
      throw new Error(closedMessage);
    }
    if (activeRunnerProcesses.has(existingTask.id) || existingTask.state === "awaiting_worktree_approval" || existingTask.state === "approving") {
      throw new Error("This chat already has a task in progress.");
    }
    if (existingTask.repositoryId !== repositoryId) {
      if (!hiddenWorkspace && taskUsesHiddenChatWorkspace(existingTask, chat)) {
        attachHiddenTaskToRepository(existingTask, refreshed);
      } else {
        throw new Error("This chat belongs to a different folder. Start a new chat for this folder.");
      }
    }
    existingTask.permissionMode = permissionMode;
    existingTask.prompt = prompt;
    existingTask.reasoningMode = reasoningMode;
    existingTask.runnerName = umbraticRunnerName;
    existingTask.runnerVersion = umbraticRunnerVersion;
    existingTask.policyVersion = umbraticPolicyVersion;
    existingTask.enabledTools = requestedEnabledTools;
    existingTask.capabilityProbes = taskCapabilityProbes;
    existingTask.hiddenWorkspace = existingTask.hiddenWorkspace || hiddenWorkspace;
    existingTask.error = undefined;
    if (existingTask.workspaceKind === "git" && requestedWorkspaceMode === "worktree" && !existingTask.agentBranch) {
      existingTask.originalBranch = refreshed.originalBranch;
      existingTask.baseCommit = refreshed.baseCommit;
      existingTask.agentBranch = `umbratic/${existingTask.id}-${slugify(prompt)}`;
      existingTask.worktreePath = path.join(worktreeRootForRepo(refreshed.rootPath), existingTask.id);
      existingTask.workspaceMode = "worktree";
      existingTask.originalRepoPath = refreshed.rootPath;
      existingTask.originalWasDirty = refreshed.dirty;
      existingTask.runnerSessionId = undefined;
      existingTask.diagnosticLogPath = undefined;
      existingTask.pendingPrompt = undefined;
      pendingRunnerPrompts.delete(existingTask.id);
      existingTask.state = "running";
      saveTask(existingTask);
      appendUserMessage(existingTask, prompt, attachments);
      await createWorktreeAndRunRunner(existingTask, undefined, attachments, prompt);
      return publicTask(existingTask);
    }

    existingTask.state = "running";
    if (!existingTask.agentBranch) {
      existingTask.workspaceMode = "local";
      existingTask.worktreePath = refreshed.rootPath;
    }
    existingTask.pendingPrompt = undefined;
    existingTask.diagnosticLogPath = undefined;
    pendingRunnerPrompts.delete(existingTask.id);
    existingTask.originalBranch = existingTask.agentBranch ? existingTask.originalBranch : refreshed.originalBranch;
    existingTask.baseCommit = existingTask.agentBranch ? existingTask.baseCommit : refreshed.baseCommit;
    existingTask.originalRepoPath = refreshed.rootPath;
    existingTask.originalWasDirty = refreshed.dirty;
    saveTask(existingTask);
    appendUserMessage(existingTask, prompt, attachments);
    void runRunnerTask(existingTask.id, undefined, prompt, attachments);
    return publicTask(existingTask);
  }

  if (reusableWorktreeTask && requestedWorkspaceMode === "worktree") {
    assertReusableWorktreeForRepository(reusableWorktreeTask, refreshed);
    const id = taskId();
    const task: TaskRecord = {
      id,
      chatId: chat?.id,
      worktreeRootTaskId: worktreeRootTaskId(reusableWorktreeTask),
      repositoryId,
      prompt,
      workspaceKind: "git",
      workspaceMode: "worktree",
      hiddenWorkspace,
      state: "running",
      originalBranch: reusableWorktreeTask.originalBranch,
      baseCommit: reusableWorktreeTask.baseCommit,
      agentBranch: reusableWorktreeTask.agentBranch,
      worktreePath: reusableWorktreeTask.worktreePath,
      permissionMode,
      reasoningMode,
      runnerName: umbraticRunnerName,
      runnerVersion: umbraticRunnerVersion,
      policyVersion: umbraticPolicyVersion,
      createdAt: new Date().toISOString(),
      changedFiles: [],
      reviewFiles: [],
      events: [],
      originalRepoPath: reusableWorktreeTask.originalRepoPath,
      originalWasDirty: reusableWorktreeTask.originalWasDirty,
      baselineFiles: undefined,
      enabledTools: requestedEnabledTools,
      capabilityProbes: taskCapabilityProbes,
    };
    saveTask(task);
    appendUserMessage(task, prompt, attachments);
    void runRunnerTask(task.id, undefined, prompt, attachments);
    return publicTask(task);
  }

  const id = taskId();
  const shouldCreateWorktree = requestedWorkspaceMode === "worktree";
  const branch = shouldCreateWorktree ? `umbratic/${id}-${slugify(prompt)}` : "";
  const worktreePath = shouldCreateWorktree ? path.join(worktreeRootForRepo(refreshed.rootPath), id) : refreshed.rootPath;
  const task: TaskRecord = {
    id,
    chatId: chat?.id,
    repositoryId,
    prompt,
    workspaceKind: refreshed.kind,
    workspaceMode: shouldCreateWorktree ? "worktree" : "local",
    hiddenWorkspace,
    state: "running",
    originalBranch: refreshed.originalBranch,
    baseCommit: refreshed.baseCommit,
    agentBranch: branch,
    worktreePath,
    permissionMode,
    reasoningMode,
    runnerName: umbraticRunnerName,
    runnerVersion: umbraticRunnerVersion,
    policyVersion: umbraticPolicyVersion,
    createdAt: new Date().toISOString(),
    changedFiles: [],
    reviewFiles: [],
    events: [],
    originalRepoPath: refreshed.rootPath,
    originalWasDirty: refreshed.dirty,
    baselineFiles: undefined,
    enabledTools: requestedEnabledTools,
    capabilityProbes: taskCapabilityProbes,
  };
  saveTask(task);
  appendUserMessage(task, prompt, attachments);
  if (shouldCreateWorktree) {
    recordProductTelemetry("worktree.requested", {
      taskId: task.id,
      chatId: task.chatId,
      repositoryId: task.repositoryId,
    });
    await createWorktreeAndRunRunner(task, undefined, attachments, prompt);
  } else {
    void runRunnerTask(task.id, undefined, prompt, attachments);
  }
  return publicTask(task);
}

async function approveWorktreeCreation(input: unknown): Promise<void> {
  if (!isRecord(input)) {
    throw new Error("Invalid worktree approval input.");
  }
  const task = getTask(requiredString(input.taskId, "taskId"));
  const approved = input.approved === true;
  if (task.state !== "awaiting_worktree_approval") {
    throw new Error("Task is not waiting for worktree approval.");
  }
  if (!approved) {
    recordProductTelemetry("worktree.denied", {
      taskId: task.id,
      chatId: task.chatId,
      repositoryId: task.repositoryId,
    });
    task.state = "rejected";
    task.pendingPrompt = undefined;
    pendingRunnerPrompts.delete(task.id);
    task.rejectedAt = new Date().toISOString();
    saveTask(task);
    emit({ type: "task.error", taskId: task.id, message: "Worktree creation was declined." });
    return;
  }
  recordProductTelemetry("worktree.approved", {
    taskId: task.id,
    chatId: task.chatId,
    repositoryId: task.repositoryId,
  });
  const promptForRun = pendingRunnerPrompts.get(task.id) ?? task.pendingPrompt ?? task.prompt;
  task.pendingPrompt = undefined;
  pendingRunnerPrompts.delete(task.id);
  saveTask(task);
  await createWorktreeAndRunRunner(task, promptForRun);
}

function secretScanText(text: string): string | null {
  const patterns: Array<[string, RegExp]> = [
    ["private key", /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/],
    ["generic secret assignment", /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{20,}/i],
    ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
    ["GitHub token", /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/],
  ];
  for (const [label, pattern] of patterns) {
    if (pattern.test(text)) {
      return label;
    }
  }
  return null;
}

async function approvalCheck(task: TaskRecord, name: string, run: () => Promise<string | void>): Promise<void> {
  emit({ type: "approval.check", taskId: task.id, name, status: "running" });
  try {
    const result = await run();
    const detail = typeof result === "string" ? result : undefined;
    emit({ type: "approval.check", taskId: task.id, name, status: "passed", detail });
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error);
    emit({ type: "approval.check", taskId: task.id, name, status: "failed", detail });
    throw error;
  }
}

async function approveTaskMerge(input: unknown): Promise<ApproveResult> {
  if (!isRecord(input)) {
    throw new Error("Invalid approval input.");
  }
  const task = getTask(requiredString(input.taskId, "taskId"));
  recordProductTelemetry("task.accepted", {
    taskId: task.id,
    chatId: task.chatId,
    repositoryId: task.repositoryId,
  });
  emit({ type: "merge.approval", taskId: task.id, decision: "approved" });
  task.state = "approving";
  saveTask(task);
  try {
    let allowedFiles: string[] = [];
    let patchHash = "";

    await approvalCheck(task, "agent run completed", async () => {
      if (!task.latestTest?.passed) {
        throw new Error("Umbratic runner has not completed successfully for this task.");
      }
      return task.latestTest.command;
    });
    await approvalCheck(task, "blocked files", async () => {
      const reviewFiles = await refreshReview(task);
      emitReviewChangedSinceReady(task, reviewFiles);
      const dangerous = reviewFiles.map((file) => file.path).filter((file) => isBlockedPath(file));
      if (dangerous.length > 0) {
        throw new Error(`Blocked path changed: ${dangerous.join(", ")}`);
      }
      allowedFiles = reviewFiles.map((file) => file.path).filter((file) => !isGeneratedRuntimePath(file));
      if (allowedFiles.length === 0) {
        throw new Error("No allowed file changes to approve.");
      }
      task.changedFiles = allowedFiles;
      return `${allowedFiles.length} file${allowedFiles.length === 1 ? "" : "s"}`;
    });
    await approvalCheck(task, "secret scan", async () => {
      const patch = task.reviewFiles.map((file) => file.diff).join("\n");
      const diffHit = secretScanText(patch);
      if (diffHit) {
        throw new Error(`Potential ${diffHit} in patch.`);
      }
      for (const file of allowedFiles) {
        const absolute = path.join(task.worktreePath, file);
        const text = readTextFileIfSafe(absolute);
        if (text) {
          const hit = secretScanText(text);
          if (hit) {
            throw new Error(`Potential ${hit} in ${file}.`);
          }
        }
      }
      return "passed";
    });
    await approvalCheck(task, "record metadata", async () => {
      const patch = task.reviewFiles.map((file) => file.diff).join("\n");
      patchHash = crypto.createHash("sha256").update(patch).digest("hex");
      task.state = "approved";
      task.approvedAt = new Date().toISOString();
      task.patchHash = patchHash;
      task.metadataPath = taskMetadataPath(task);
      writeJsonFile(task.metadataPath, {
        id: task.id,
        workspaceKind: task.workspaceKind,
        workspaceMode: task.workspaceMode,
        originalRepoPath: task.originalRepoPath,
        originalBranch: task.originalBranch,
        baseCommit: task.baseCommit,
        agentBranch: task.agentBranch,
        worktreePath: task.worktreePath,
        changedFiles: task.changedFiles,
        latestTest: task.latestTest,
        patchHash,
        approvedAt: task.approvedAt,
      });
      saveTask(task);
      return patchHash.slice(0, 12);
    });
    const target = taskUsesIsolatedWorktree(task)
      ? task.agentBranch || task.worktreePath
      : task.workspaceKind === "git"
        ? task.originalBranch
        : "folder";
    emit({ type: "approval.completed", taskId: task.id, target, patchHash });
    return { ok: true, targetBranch: target, commit: patchHash, patchHash, metadataPath: task.metadataPath ?? "" };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    failTask(task, message);
    return { ok: false, message };
  }
}

async function rejectTask(input: unknown): Promise<void> {
  if (!isRecord(input)) {
    throw new Error("Invalid reject input.");
  }
  const task = getTask(requiredString(input.taskId, "taskId"));
  recordProductTelemetry("task.undone", {
    taskId: task.id,
    chatId: task.chatId,
    repositoryId: task.repositoryId,
  });
  const run = activeRunnerProcesses.get(task.id);
  if (run) {
    activeRunnerProcesses.delete(task.id);
    stopRunnerProcess(run);
  }
  pendingRunnerPrompts.delete(task.id);
  clearPendingPermissionsForTask(task.id);
  const cleanup = input.cleanup === true;
  emit({ type: "merge.approval", taskId: task.id, decision: "rejected", cleanup, reason: "user rejected review" });
  if (taskUsesIsolatedWorktree(task) && cleanup && taskStatesThatCanOpen.has(task.state)) {
    if (fs.existsSync(task.worktreePath)) {
      await ensurePreCleanupCheckpoint(task);
      const reset = await gitResult(task.worktreePath, ["reset", "--hard", task.baseCommit]);
      if (!reset.success) {
        throw new Error((reset.stderr || reset.stdout || "Failed to reset worktree changes.").trim());
      }
      const clean = await gitResult(task.worktreePath, ["clean", "-fd"]);
      if (!clean.success) {
        throw new Error((clean.stderr || clean.stdout || "Failed to remove untracked worktree files.").trim());
      }
    }
    task.changedFiles = [];
    task.reviewFiles = [];
  }
  if (!taskUsesIsolatedWorktree(task) && cleanup) {
    const reviewFiles = await refreshReview(task);
    restoreFolderTaskChanges(task, reviewFiles);
    task.changedFiles = [];
    task.reviewFiles = [];
  }
  task.state = "rejected";
  task.rejectedAt = new Date().toISOString();
  saveTask(task);
}

function restoreFolderTaskChanges(task: TaskRecord, reviewFiles: ReviewFile[]) {
  const baseline = task.baselineFiles ?? {};
  for (const file of reviewFiles) {
    if (isGeneratedRuntimePath(file.path)) {
      continue;
    }
    const absolute = path.resolve(task.worktreePath, file.path);
    if (!pathInside(task.worktreePath, absolute)) {
      throw new Error(`Refusing to restore a path outside the task folder: ${file.path}`);
    }
    if (Object.prototype.hasOwnProperty.call(baseline, file.path)) {
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, baseline[file.path]);
      continue;
    }
    if (fs.existsSync(absolute)) {
      fs.rmSync(absolute, { force: true });
    }
  }
}

async function keepWorktree(input: unknown): Promise<void> {
  if (!isRecord(input)) {
    throw new Error("Invalid keep-worktree input.");
  }
  const task = getTask(requiredString(input.taskId, "taskId"));
  recordProductTelemetry("worktree.kept", {
    taskId: task.id,
    chatId: task.chatId,
    repositoryId: task.repositoryId,
  });
  emit({
    type: "task.error",
    taskId: task.id,
    message: `${taskUsesIsolatedWorktree(task) ? "Worktree" : "Folder"} retained at ${task.worktreePath}`,
  });
}

async function cancelTask(input: unknown): Promise<void> {
  if (!isRecord(input)) {
    throw new Error("Invalid cancel input.");
  }
  const task = getTask(requiredString(input.taskId, "taskId"));
  const run = activeRunnerProcesses.get(task.id);
  if (run) {
    activeRunnerProcesses.delete(task.id);
    if (run.sessionId) {
      await runnerRequest<boolean>(run, `/session/${encodeURIComponent(run.sessionId)}/abort`, { method: "POST" }).catch(
        () => undefined,
      );
    }
    stopRunnerProcess(run);
  }
  pendingRunnerPrompts.delete(task.id);
  clearPendingPermissionsForTask(task.id);
  task.state = "failed";
  task.error = "Task was cancelled.";
  saveTask(task);
  emit({ type: "task.error", taskId: task.id, message: task.error });
}

async function setResponseFeedback(input: unknown): Promise<void> {
  if (!isRecord(input)) {
    throw new Error("Invalid response feedback input.");
  }
  const task = getTask(requiredString(input.taskId, "taskId"));
  const messageId = requiredString(input.messageId, "messageId").slice(0, 80);
  const rating = input.rating === "bad" ? "bad" : "good";
  const comment = typeof input.comment === "string" ? input.comment.trim().slice(0, 1000) : "";
  if (!/^assistant-\d+$/.test(messageId)) {
    throw new Error("Invalid response message id.");
  }
  task.events = task.events.filter(
    (event) => !(event.type === "response.feedback" && event.messageId === messageId),
  );
  saveTask(task);
  emit({ type: "response.feedback", taskId: task.id, messageId, rating, ...(comment ? { comment } : {}) });
}

async function launchCommand(command: string, args: string[]): Promise<IdeOpenResult> {
  try {
    const isWindows = process.platform === "win32";
    const isBatch = isWindows && /\.(cmd|bat)$/i.test(command);
    const child = isBatch
      ? spawn("cmd.exe", ["/c", command, ...args], { detached: true, stdio: "ignore", windowsHide: true })
      : spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error instanceof Error ? error.message : error) };
  }
}

const commandCandidatesByIde: Record<string, string[]> = {
  code: process.platform === "win32" ? ["code.cmd", "code"] : ["code"],
  windsurf: process.platform === "win32" ? ["windsurf.cmd", "windsurf"] : ["windsurf"],
};

function macApplicationExists(appName: string): boolean {
  if (process.platform !== "darwin") {
    return false;
  }
  const appBundle = appName.endsWith(".app") ? appName : `${appName}.app`;
  return [
    path.join("/Applications", appBundle),
    path.join(os.homedir(), "Applications", appBundle),
  ].some((appPath) => fs.existsSync(appPath));
}

function fileManagerIcon(): IdeInfo["icon"] {
  if (process.platform === "darwin") return "finder";
  if (process.platform === "win32") return "explorer";
  return "files";
}

async function firstAvailableCommand(candidates: string[]): Promise<string | null> {
  for (const command of candidates) {
    if (await commandAvailable(command)) {
      return command;
    }
  }
  return null;
}

async function visualStudioExecutable(): Promise<string | null> {
  const pathCommand = await firstAvailableCommand(process.platform === "win32" ? ["devenv.exe", "devenv"] : ["devenv"]);
  if (pathCommand) {
    return pathCommand;
  }
  if (process.platform !== "win32") {
    return null;
  }
  const installerRoot = process.env["ProgramFiles(x86)"] || process.env.ProgramFiles;
  if (!installerRoot) {
    return null;
  }
  const vswhere = path.join(installerRoot, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!fs.existsSync(vswhere)) {
    return null;
  }
  try {
    const output = await execFileOutput(
      vswhere,
      ["-latest", "-products", "*", "-requires", "Microsoft.Component.MSBuild", "-property", "productPath"],
      { timeout: 5000 },
    );
    const executable = output.stdout.trim().split(/\r?\n/).find(Boolean);
    return executable && fs.existsSync(executable) ? executable : null;
  } catch {
    return null;
  }
}

async function listAvailableIdes(): Promise<IdeInfo[]> {
  const ides: IdeInfo[] = [];
  if ((await firstAvailableCommand(commandCandidatesByIde.code)) || macApplicationExists("Visual Studio Code")) {
    ides.push({ id: "code", label: "VS Code", icon: "vscode" });
  }
  if (await visualStudioExecutable()) {
    ides.push({ id: "visualstudio", label: "Visual Studio", icon: "visualstudio" });
  }
  ides.push({
    id: "explorer",
    label: process.platform === "darwin" ? "Finder" : process.platform === "win32" ? "Explorer" : "Files",
    icon: fileManagerIcon(),
  });
  return ides;
}

async function openTaskInIde(input: unknown): Promise<IdeOpenResult> {
  if (!isRecord(input)) {
    throw new Error("Invalid IDE input.");
  }
  const task = getTask(requiredString(input.taskId, "taskId"));
  const ideId = requiredString(input.ideId, "ideId");
  const relativeFilePath =
    typeof input.filePath === "string" && input.filePath.trim()
      ? normalizeRelativePath(input.filePath.trim())
      : undefined;
  if (!fs.existsSync(task.worktreePath)) {
    return { ok: false, message: "Task folder no longer exists." };
  }
  if (taskUsesIsolatedWorktree(task) && !pathInside(worktreeRootForRepo(task.originalRepoPath), task.worktreePath)) {
    return { ok: false, message: "Worktree path is outside Umbratic control." };
  }
  if (relativeFilePath && path.isAbsolute(relativeFilePath)) {
    return { ok: false, message: "File path must be relative to the review folder." };
  }
  const targetPath = relativeFilePath ? path.join(task.worktreePath, relativeFilePath) : task.worktreePath;
  if (!pathInside(task.worktreePath, targetPath)) {
    return { ok: false, message: "File path is outside the review folder." };
  }
  if (!fs.existsSync(targetPath)) {
    return { ok: false, message: relativeFilePath ? "Changed file no longer exists." : "Review folder no longer exists." };
  }
  const withTelemetry = (result: IdeOpenResult): IdeOpenResult => {
    emit({
      type: "ide.opened",
      taskId: task.id,
      ideId,
      target: relativeFilePath ? "file" : "workspace",
      filePath: relativeFilePath,
      result: result.ok ? "success" : "failed",
      message: result.ok ? undefined : result.message,
    });
    recordProductTelemetry("ide.opened", {
      taskId: task.id,
      chatId: task.chatId,
      repositoryId: task.repositoryId,
      data: {
        ideId,
        target: relativeFilePath ? "file" : "workspace",
        result: result.ok ? "success" : "failed",
      },
    });
    return result;
  };
  return withTelemetry(await openPathInIde(ideId, targetPath, relativeFilePath ? "file" : "folder", task.worktreePath));
}

async function openRepositoryInIde(input: unknown): Promise<IdeOpenResult> {
  if (!isRecord(input)) {
    throw new Error("Invalid repository IDE input.");
  }
  const ideId = requiredString(input.ideId, "ideId");
  const repositoryPath = await resolveRepositoryPath(input);
  if (!repositoryPath) {
    return { ok: false, message: "Select a folder first." };
  }
  if (!fs.existsSync(repositoryPath)) {
    return { ok: false, message: "Selected folder no longer exists." };
  }
  const result = await openPathInIde(ideId, repositoryPath, "folder");
  recordProductTelemetry("ide.opened", {
    repositoryId: typeof input.repositoryId === "string" ? input.repositoryId : undefined,
    data: { ideId, target: "workspace", result: result.ok ? "success" : "failed" },
  });
  return result;
}

async function openPathInIde(
  ideId: string,
  targetPath: string,
  targetKind: "file" | "folder",
  workspacePath?: string,
): Promise<IdeOpenResult> {
  if (ideId === "explorer") {
    if (targetKind === "file") {
      shell.showItemInFolder(targetPath);
      return { ok: true };
    }
    const error = await shell.openPath(targetPath);
    return error ? { ok: false, message: error } : { ok: true };
  }
  if (ideId === "visualstudio") {
    const command = await visualStudioExecutable();
    if (command) {
      return launchCommand(command, [targetPath]);
    }
  }
  const command = await firstAvailableCommand(commandCandidatesByIde[ideId] ?? []);
  if (command) {
    return launchCommand(command, codeLikeIdeArgs(targetPath, targetKind, workspacePath));
  }
  if (ideId === "code" && macApplicationExists("Visual Studio Code")) {
    return launchCommand("open", macCodeLikeIdeArgs(targetPath, targetKind, workspacePath));
  }
  const error = await shell.openPath(targetPath);
  return error ? { ok: false, message: error } : { ok: true };
}

function setPermissionMode(input: unknown): Promise<BackendStatus> {
  permissionMode = input === "auto_safe" || input === "bypass" ? "auto_safe" : "normal";
  recordProductTelemetry("permission.mode_changed", { data: { mode: permissionMode } });
  return getBackendStatus();
}

function devServerUrl(): URL {
  const rawUrl = process.env.UMBRATIC_DEV_SERVER_URL || fallbackDevServerUrl;
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port) {
      return url;
    }
  } catch {
    /* Fall through to the default Vite URL. */
  }
  return new URL(fallbackDevServerUrl);
}

function rendererEntryUrl(): URL {
  const url = devServerUrl();
  const params = new URLSearchParams(process.env.UMBRATIC_RENDERER_QUERY || "");
  for (const [key, value] of params) {
    if (/^[A-Za-z0-9_-]{1,40}$/.test(key) && /^[A-Za-z0-9_.:-]{0,80}$/.test(value)) {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

function isTrustedDevUrl(url: URL): boolean {
  const trusted = devServerUrl();
  return url.protocol === trusted.protocol && url.hostname === trusted.hostname && url.port === trusted.port;
}

function trustedSender(event: IpcMainInvokeEvent): boolean {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    return false;
  }
  const rawUrl = event.senderFrame?.url || event.sender.getURL();
  try {
    const url = new URL(rawUrl);
    if (isDev) {
      return isTrustedDevUrl(url);
    }
    return url.href === pathToFileURL(path.resolve(__dirname, "../../dist/index.html")).href;
  } catch {
    return false;
  }
}

function assertTrustedSender(event: IpcMainInvokeEvent) {
  if (!trustedSender(event)) {
    throw new Error("Blocked IPC from an untrusted renderer.");
  }
}

function handleIpc<T>(channel: string, handler: (input: unknown, event: IpcMainInvokeEvent) => Promise<T> | T) {
  ipcMain.handle(channel, async (event, input: unknown) => {
    try {
      assertTrustedSender(event);
      return await handler(input, event);
    } catch (cause) {
      const message = String(cause instanceof Error ? cause.message : cause);
      recordLocalDiagnostic({
        level: "error",
        source: "ipc",
        event: channel,
        taskId: isRecord(input) && typeof input.taskId === "string" ? input.taskId : undefined,
        message,
        data: {
          input: sanitizeDiagnosticValue(input),
          stack: cause instanceof Error ? cause.stack : undefined,
        },
      });
      throw cause;
    }
  });
}

function setWindowChromeTheme(theme: "dark" | "light") {
  if (process.platform !== "win32" || !mainWindow) return { ok: true };
  mainWindow.setTitleBarOverlay({
    color: theme === "light" ? windowChromeLight : windowChromeDark,
    symbolColor: theme === "light" ? windowChromeSymbolLight : windowChromeSymbolDark,
    height: windowChromeHeight,
  });
  return { ok: true };
}

function allowedAppUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (isDev) {
      return isTrustedDevUrl(url);
    }
    return url.href === pathToFileURL(path.resolve(__dirname, "../../dist/index.html")).href;
  } catch {
    return false;
  }
}

async function createWindow() {
  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";
  const icon = appIcon();

  // Packaged macOS apps should use the bundle icon so Liquid Glass appearances
  // can be applied by the system; this PNG override is only for dev runs.
  if (isDev && isMac && app.dock && icon) {
    app.dock.setIcon(icon);
  }

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const isFrame = details.resourceType === "mainFrame" || details.resourceType === "subFrame";
    callback({ cancel: isFrame && !allowedAppUrl(details.url) });
  });

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#101112",
    icon,
    title: "Umbratic",
    titleBarStyle: isMac ? "hiddenInset" : isWin ? "hidden" : "default",
    titleBarOverlay: isWin
      ? {
          color: windowChromeDark,
          symbolColor: windowChromeSymbolDark,
          height: windowChromeHeight,
        }
      : undefined,
    webPreferences: {
      preload: path.resolve(__dirname, "../preload/preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!allowedAppUrl(url)) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.on("context-menu", (_event, params) => {
    if (!mainWindow) return;
    const template: MenuItemConstructorOptions[] = params.isEditable
      ? [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { type: "separator" },
          { role: "selectAll" },
        ]
      : [
          { role: "copy", enabled: !!params.selectionText },
          { role: "paste" },
          { type: "separator" },
          { role: "selectAll" },
        ];
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });

  if (isDev) {
    await mainWindow.loadURL(rendererEntryUrl().toString());
  } else {
    await mainWindow.loadFile(path.resolve(__dirname, "../../dist/index.html"));
  }
  const benchmarkFile = process.env.UMBRATIC_BENCHMARK_FILE?.trim();
  if (benchmarkFile) {
    fs.mkdirSync(path.dirname(benchmarkFile), { recursive: true });
    fs.writeFileSync(
      benchmarkFile,
      `${JSON.stringify({ pid: process.pid, rendererLoadedMs: performance.now() - desktopBenchmarkStartedAt })}\n`,
      "utf8",
    );
  }
}

app.whenReady().then(async () => {
  try {
    installBundledSystemSkillsService();
  } catch (error) {
    recordLocalDiagnostic({
      level: "error",
      source: "desktop",
      event: "skills.install.failed",
      message: String(error instanceof Error ? error.message : error),
      data: { stack: error instanceof Error ? error.stack : undefined },
    });
    console.error("Unable to install bundled skills.", error);
  }
  finishInterruptedRunningTasks();
  compactClosedTaskStorage();
  const checkpointRecovery = await reconcileCheckpointLifecycle((task) => worktreeRootForRepo(task.originalRepoPath));
  if (checkpointRecovery.inspectedTasks > 0) {
    recordLocalDiagnostic({
      level: checkpointRecovery.missingActiveWorkspaces > 0 ? "error" : "warn",
      source: "desktop",
      event: "checkpoint.reconciled",
      message: "Recovered interrupted checkpoint lifecycle records.",
      data: checkpointRecovery,
    });
  }
  handleIpc("umbratic:list-projects", () => readProjects());
  handleIpc("umbratic:list-chats", () => readChats());
  handleIpc("umbratic:create-chat", (input) => createChat(input));
  handleIpc("umbratic:update-chat-draft", (input) => updateChatDraft(input));
  handleIpc("umbratic:update-chat-project", (input) => updateChatProject(input));
  handleIpc("umbratic:delete-chat", (input) => deleteChat(input));
  handleIpc("umbratic:delete-project-chats", (input) => deleteProjectChats(input));
  handleIpc("umbratic:delete-project", (input) => deleteProject(input));
  handleIpc("umbratic:get-notes", () => getNotes());
  handleIpc("umbratic:update-notes", (input) => updateNotes(input));
  handleIpc("umbratic:get-task", (input) => publicTaskById(input));
  handleIpc("umbratic:list-task-checkpoints", (input) => listTaskCheckpoints(input));
  handleIpc("umbratic:create-task-checkpoint", (input) => createCheckpoint(input));
  handleIpc("umbratic:set-task-checkpoint-pinned", (input) => setCheckpointPinned(input));
  handleIpc("umbratic:delete-task-checkpoint", (input) => deleteCheckpoint(input));
  handleIpc("umbratic:fork-task-checkpoint", (input) => forkCheckpoint(input));
  handleIpc("umbratic:restore-task-checkpoint", (input) => restoreCheckpoint(input));
  handleIpc("umbratic:refresh-task-review", (input) => refreshTaskReview(input));
  handleIpc("umbratic:refresh-workspace-review", (input) => refreshWorkspaceReview(input));
  handleIpc("umbratic:search-files", (input) => searchRepositoryFiles(input));
  handleIpc("umbratic:pick-repository", () => pickRepository());
  handleIpc("umbratic:pick-attachment-files", (input) => pickAttachmentFiles(input));
  handleIpc("umbratic:save-pasted-attachments", (input) => savePastedAttachments(input));
  handleIpc("umbratic:open-chat-attachment", (input) => openChatAttachment(input));
  handleIpc("umbratic:get-repository", (input) => getRepository(input));
  handleIpc("umbratic:list-repository-branches", (input) => listRepositoryBranches(input));
  handleIpc("umbratic:checkout-repository-branch", (input) => checkoutRepositoryBranch(input));
  handleIpc("umbratic:get-backend-status", () => getBackendStatus());
  handleIpc("umbratic:get-capability-probes", (input) => getCapabilityProbes(input));
  handleIpc("umbratic:get-model-endpoint-settings", () => {
    const settings = readModelEndpointSettings();
    return publicModelEndpointSettings(settings);
  });
  handleIpc("umbratic:save-model-endpoint-settings", (input) =>
    saveModelEndpointSettings(input as Partial<ReturnType<typeof readModelEndpointSettings>>),
  );
  handleIpc("umbratic:get-harness-profile", () => readHarnessProfileSetting());
  handleIpc("umbratic:save-harness-profile", (input) => saveHarnessProfileSetting(input));
  handleIpc("umbratic:get-context-length", () => readContextLengthSetting());
  handleIpc("umbratic:save-context-length", (input) => saveContextLengthSetting(input));
  handleIpc("umbratic:export-telemetry", () => exportTelemetryBundle());
  handleIpc("umbratic:export-local-diagnostics", () => exportLocalDiagnostics());
  handleIpc("umbratic:clear-local-diagnostics", () => clearLocalDiagnosticLogs());
  handleIpc("umbratic:record-product-event", (input) => recordRendererProductEvent(input));
  handleIpc("umbratic:list-skills", () => listSkillsService());
  handleIpc("umbratic:save-skill-settings", (input) => saveSkillSettingsService(input));
  handleIpc("umbratic:open-skills-folder", () => openSkillsFolder());
  handleIpc("umbratic:open-runner-diagnostics-folder", () => openRunnerDiagnosticsFolder());
  handleIpc("umbratic:open-skill-in-editor", (input) => openSkillInEditor(input));
  handleIpc("umbratic:import-skill", (input) => importSkillFromDialog(input as { sourcePath?: string } | undefined));
  handleIpc("umbratic:create-skill", (input) => createSkillService(input as { name?: string }));
  handleIpc("umbratic:get-skill-document", (input) => getSkillDocumentService(input as { id?: string }));
  handleIpc("umbratic:save-skill-document", (input) => saveSkillDocumentService(input as { id?: string; content?: string }));
  handleIpc("umbratic:reset-system-skill", (input) => resetSystemSkillService(input as { id?: string }));
  handleIpc("umbratic:set-permission-mode", (mode) => setPermissionMode(mode));
  handleIpc("umbratic:list-available-ides", () => listAvailableIdes());
  handleIpc("umbratic:open-repository-in-ide", (input) => openRepositoryInIde(input));
  handleIpc("umbratic:start-task", (input) => startTask(input));
  handleIpc("umbratic:approve-worktree-creation", (input) => approveWorktreeCreation(input));
  handleIpc("umbratic:respond-tool-permission", (input) => respondToToolPermission(input));
  handleIpc("umbratic:open-task-in-ide", (input) => openTaskInIde(input));
  handleIpc("umbratic:approve-task-merge", (input) => approveTaskMerge(input));
  handleIpc("umbratic:reject-task", (input) => rejectTask(input));
  handleIpc("umbratic:keep-worktree", (input) => keepWorktree(input));
  handleIpc("umbratic:cancel-task", (input) => cancelTask(input));
  handleIpc("umbratic:set-response-feedback", (input) => setResponseFeedback(input));
  handleIpc("umbratic:set-window-chrome-theme", (input) => {
    const theme = input === "light" ? "light" : "dark";
    return setWindowChromeTheme(theme);
  });
  Menu.setApplicationMenu(null);
  await createWindow();
  void getBackendStatus();
  void retryTelemetrySpoolQueue().catch((cause) => {
    recordLocalDiagnostic({
      level: "warn",
      source: "telemetry",
      event: "spool.retry.failed",
      message: String(cause instanceof Error ? cause.message : cause),
    });
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  stopLocalVeil();
  flushRendererEvents();
  flushPendingTaskEvents();
  for (const [id, pending] of pendingPermissions) {
    pendingPermissions.delete(id);
    void pending.onDeny();
  }
  for (const [taskId, run] of activeRunnerProcesses) {
    activeRunnerProcesses.delete(taskId);
    stopRunnerProcess(run);
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});
