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

import {
  cCmakeRuntimeSystemPrompt,
  endpointEditingAllowed,
  localProviderCatalog,
  markdownRuntimeSystemPrompt,
  managedModelEndpointDefaults,
  pythonRuntimeSystemPrompt,
  taskStatesThatCanOpen,
  workspaceToolchainSystemPrompt,
} from "./config";
import {
  capabilityPromptGuidance,
  capabilityTelemetrySnapshot,
  harnessSkillCapabilityGuidance,
  probeLocalCapabilities,
  type CapabilityPromptNeeds,
} from "./capabilities";
import { artifactRuntimePromptGuidance, promptLooksLikeArtifactTask } from "./artifactRuntime";
import {
  beginRunnerEventStream,
  runnerRequest,
  runnerBinaryPath,
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
  isBarePythonCommand,
  isBlockedPath,
  isGeneratedRuntimePath,
  isLocalhostUrl,
  promptLooksLikeCmakeTask,
  promptLooksLikeMarkdownTask,
  promptLooksLikePythonTask,
  runtimeDiagnostics,
  runtimeProfileForPrompt,
  telemetryPolicyInfo,
} from "./policy";
import { getProviderJson } from "./providerClient";
import {
  readChats,
  hasStoredModelEndpointSettings,
  readHarnessProfileSetting,
  readModelEndpointSettings,
  readNotes,
  readProjects,
  readTasks,
  writeHarnessProfileSetting,
  writeModelEndpointSettings,
  writeChats,
  writeJsonFile,
  writeNotes,
  writeProjects,
  writeTasks,
} from "./storage";
import { buildRedactedTelemetryBundle } from "./telemetry";
import {
  syncTelemetryBundle,
  telemetrySpoolDirectory,
  uploadTelemetrySpool,
  type TelemetryUploadEndpoint,
} from "./telemetrySync";
import { enabledToolsFromSettings, normalizeEnabledTools } from "./toolSettings";
import {
  buildRequiredFileChangeRetryPrompt,
  canSatisfyFileChangeContract,
  cannotCreateFileBlocker,
  isFileChangingTool,
  noReviewFailureSummary,
  promptLooksLikeFileChange,
  requiredFileChangeTools,
  requiredToolFailureMessage,
  type RequiredToolContractReason,
} from "./requiredToolContract";
import {
  createSkill as createSkillService,
  getSkillDocument as getSkillDocumentService,
  importSkill as importSkillService,
  listSkills as listSkillsService,
  promptSkillsForRequest as promptSkillsForRequestService,
  saveSkillDocument as saveSkillDocumentService,
  saveSkillSettings as saveSkillSettingsService,
  skillsDirectoryPath as skillsDirectoryPathService,
  systemSkillsForProfile,
  type PromptSkillInfo,
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
  FileSearchResult,
  HarnessProfileId,
  IdeInfo,
  IdeOpenResult,
  LocalModelInfo,
  LocalModelProvider,
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
  TaskRecord,
  TaskState,
  ToolErrorCode,
  ToolResultStatus,
  UserNotes,
  WorkspaceKind,
  WorkspaceMode,
} from "./types";
import { commandText, isRecord, normalizeRelativePath, pathInside, requiredString, shortHash, slugify } from "./utils";

const isDev = !app.isPackaged;
const fallbackDevServerUrl = "http://127.0.0.1:5173/";
type RunnerPromptPart = { type: "text"; text: string } | { type: "image"; data_url: string };
type RunnerPrompt = string | RunnerPromptPart[];
type PdfRenderWorkerResult =
  | { ok: true; pageCount: number; pages: Array<{ pageNumber: number; filePath: string }> }
  | { ok: false; error: string };

const activeRunnerProcesss = new Map<string, RunnerProcess>();
const activeStartTaskRequests = new Map<string, Promise<TaskInfo>>();
const recentStartTaskRequests = new Map<string, { taskId: string; expiresAt: number }>();
const pendingRunnerPrompts = new Map<string, RunnerPromptPart[]>();
const runtimeAppIconPath = path.resolve(__dirname, "../../assets/brand/Umbratic/umbratic-icon-512.png");
const textAttachmentByteLimit = 512 * 1024;
const imageAttachmentByteLimit = 10 * 1024 * 1024;
const pdfAttachmentByteLimit = 25 * 1024 * 1024;
const pdfImagePageLimit = 12;
const pdfImageScale = 1.4;
const pdfRenderTimeoutMs = 30000;
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
app.setName("Umbratic AI");

const cleanUserData = path.join(app.getPath("appData"), "Umbratic AI");
try {
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
let pendingTaskEventFlushTimer: NodeJS.Timeout | null = null;
let telemetrySyncTimer: NodeJS.Timeout | null = null;

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
  const chats = [chat, ...readChats().filter((row) => row.id !== chat.id)];
  writeChats(chats);
}

function isReviewReadyAssistantEvent(event: BackendUiEvent): boolean {
  return event.type === "assistant.delta" && event.text.trim() === "Ready for review.";
}

function visibleTaskEvents(events: BackendUiEvent[]): BackendUiEvent[] {
  return events.filter((event) => !isReviewReadyAssistantEvent(event));
}

function appendTaskEvent(events: BackendUiEvent[], event: BackendUiEvent, limit: number): BackendUiEvent[] {
  const existing = visibleTaskEvents(events);
  if (event.type === "response.feedback") {
    return [
      ...existing.filter(
        (storedEvent) =>
          !(storedEvent.type === "response.feedback" && storedEvent.taskId === event.taskId && storedEvent.messageId === event.messageId),
      ),
      event,
    ].slice(-limit);
  }
  const last = existing.at(-1);
  if (
    last &&
    event.type === "user.message" &&
    last.type === "user.message" &&
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
    return [
      ...existing.slice(0, -1),
      {
        ...last,
        text: `${last.text}${event.text}`,
        endedAt: event.endedAt ?? event.at ?? last.endedAt ?? last.at,
      },
    ].slice(-limit);
  }
  if (
    last &&
    event.type === "command.output" &&
    last.type === "command.output" &&
    last.taskId === event.taskId &&
    last.id === event.id &&
    last.stream === event.stream
  ) {
    return [
      ...existing.slice(0, -1),
      {
        ...last,
        text: `${last.text}${event.text}`,
        endedAt: event.endedAt ?? event.at ?? last.endedAt ?? last.at,
      },
    ].slice(-limit);
  }
  return [...existing, event].slice(-limit);
}

function compactTaskEvents(events: BackendUiEvent[], limit: number): BackendUiEvent[] {
  return events.reduce<BackendUiEvent[]>((current, event) => appendTaskEvent(current, event, limit), []);
}

function taskEventSignature(event: BackendUiEvent): string {
  if (event.type === "user.message") {
    return JSON.stringify({
      type: event.type,
      taskId: event.taskId,
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

function applyTaskPolicyMetadata(task: TaskRecord, intentPrompt = task.prompt) {
  task.runnerName = task.runnerName || umbraticRunnerName;
  task.runnerVersion = task.runnerVersion || umbraticRunnerVersion;
  task.policyVersion = task.policyVersion || umbraticPolicyVersion;
  if (!task.runtimeProfile || task.runtimeProfile === "none" || intentPrompt !== task.prompt) {
    task.runtimeProfile = runtimeProfileForCurrentHarness(intentPrompt);
  }
  if (task.model) {
    task.providerId = task.model.providerId;
    task.modelId = task.model.modelId;
    task.modelBaseUrlHost = baseUrlHost(task.model.baseUrl);
  }
}

function runtimeProfileForCurrentHarness(prompt: string) {
  if (promptLooksLikeMarkdownTask(prompt)) return "markdown";
  return readHarnessProfileSetting() === "engineering" ? runtimeProfileForPrompt(prompt) : "none";
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
  const tasks = readTasks();
  let changed = false;
  const nextTasks = tasks.map((task) => {
    const events = queued.find(([taskIdValue]) => taskIdValue === task.id)?.[1] ?? [];
    if (events.length === 0) return task;
    changed = true;
    return taskWithAppendedEvents(task, events);
  });
  if (changed) {
    writeTasks(nextTasks);
    scheduleManagedTelemetrySync();
  }
}

function scheduleTaskEventFlush() {
  if (pendingTaskEventFlushTimer) return;
  pendingTaskEventFlushTimer = setTimeout(flushPendingTaskEvents, 250);
}

function saveTask(task: TaskRecord) {
  applyTaskPolicyMetadata(task);
  const queuedEvents = takePendingTaskEvents(task.id);
  const taskWithQueuedEvents = pruneClosedTaskInternalSnapshots(taskWithAppendedEvents(task, queuedEvents));
  const existingTasks = readTasks();
  const existing = existingTasks.find((row) => row.id === task.id);
  const taskEvents = compactTaskEvents(Array.isArray(taskWithQueuedEvents.events) ? taskWithQueuedEvents.events : [], 500);
  const existingEvents = compactTaskEvents(Array.isArray(existing?.events) ? existing.events : [], 500);
  const events = mergeTaskEvents(existingEvents, taskEvents);
  const nextTask = {
    ...taskWithQueuedEvents,
    events,
  };
  const tasks = [nextTask, ...existingTasks.filter((row) => row.id !== task.id)];
  writeTasks(tasks);
  updateChatFromTask(nextTask);
  scheduleManagedTelemetrySync();
}

function publicTask(task: TaskRecord): TaskInfo {
  const {
    id,
    chatId,
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
    runtimeProfile,
    createdAt,
    changedFiles,
    reviewFiles,
    events,
    latestTest,
    patchHash,
    error,
  } = task;
  return {
    id,
    chatId,
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
    runtimeProfile,
    createdAt,
    changedFiles,
    reviewFiles,
    events: compactTaskEvents(events, 500),
    latestTest,
    patchHash,
    error,
  };
}

function getTask(taskId: string): TaskRecord {
  const task = readTasks().find((row) => row.id === taskId);
  if (!task) {
    throw new Error("Task was not found.");
  }
  return task;
}

function taskUsesIsolatedWorktree(task: TaskRecord): boolean {
  return task.workspaceKind === "git" && task.workspaceMode === "worktree" && !!task.agentBranch;
}

function taskEnabledTools(task: TaskRecord): RunnerToolId[] {
  return normalizeEnabledTools(task.enabledTools, enabledToolsFromSettings({}));
}

function publicTaskById(input: unknown): TaskInfo | null {
  if (!isRecord(input) || typeof input.taskId !== "string" || !input.taskId.trim()) {
    return null;
  }
  const taskIdValue = input.taskId.trim();
  const task = readTasks().find((row) => row.id === taskIdValue);
  return task ? publicTask(task) : null;
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
  };
}

const titleStopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "can",
  "could",
  "for",
  "i",
  "in",
  "is",
  "it",
  "let",
  "lets",
  "make",
  "my",
  "of",
  "on",
  "please",
  "should",
  "that",
  "the",
  "this",
  "to",
  "we",
  "with",
  "would",
  "you",
]);

function parseReasoningMode(value: unknown): ReasoningMode {
  void value;
  return "reasoning";
}

function titleWord(word: string): string {
  if (!word) return word;
  if (word === word.toUpperCase() || word.includes("_") || word.includes("-")) return word;
  return `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}`;
}

function chatTitleFromPrompt(prompt: string): string {
  const text = prompt
    .split(/\n\s*\nAttached files:/i)[0]
    .replace(/[`*_#[\]()>.,!?;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = text.match(/[A-Za-z0-9][A-Za-z0-9'_-]*/g) ?? [];
  const summaryWords = words
    .filter((word) => !titleStopWords.has(word.toLowerCase().replace(/'s$/, "")))
    .slice(0, 5);
  const title = (summaryWords.length >= 3 ? summaryWords : words.slice(0, 5)).map(titleWord).join(" ");
  return title ? title.slice(0, 72) : "New chat";
}

function createChat(input: unknown): ChatRecord {
  const requestedId =
    isRecord(input) && typeof input.id === "string" && /^chat-[A-Za-z0-9_-]+$/.test(input.id)
      ? input.id
      : undefined;
  const shouldPersist = !isRecord(input) || input.persist !== false;
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
  const now = new Date().toISOString();
  const chat: ChatRecord = {
    id: requestedId ?? chatId(),
    title,
    createdAt: now,
    updatedAt: now,
    repositoryName,
    repositoryPath,
    draftPrompt: "",
    attachedFiles: [],
  };
  if (shouldPersist) {
    saveChat(chat);
  }
  return chat;
}

function updateChatDraft(input: unknown): ChatRecord {
  if (!isRecord(input)) {
    throw new Error("Invalid chat draft input.");
  }
  const id = requiredString(input.chatId, "chatId");
  const chats = readChats();
  const existing = chats.find((chat) => chat.id === id);
  if (!existing) {
    throw new Error("Chat was not found.");
  }
  const attachedFiles = Array.isArray(input.attachedFiles)
    ? input.attachedFiles
        .filter((file): file is Record<string, unknown> => isRecord(file))
        .map((file) => {
          const chatAttachment = chatAttachmentFromRecord(file, id);
          if (chatAttachment) return chatAttachment;
          return {
            path: typeof file.path === "string" ? normalizeRelativePath(file.path).slice(0, 260) : "",
            name: typeof file.name === "string" ? file.name.slice(0, 120) : "",
            source: file.source === "workspace" ? "workspace" as const : undefined,
            previewDataUrl:
              typeof file.previewDataUrl === "string" && file.previewDataUrl.startsWith("data:image/")
                ? file.previewDataUrl
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
  writeChats([next, ...chats.filter((chat) => chat.id !== id)]);
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
  fs.rmSync(hiddenChatWorkspacePath(id), { recursive: true, force: true });
  fs.rmSync(chatAttachmentDirectory(id), { recursive: true, force: true });
  return { ok: true };
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
  const chats = readChats();
  const existing = chats.find((chat) => chat.id === task.chatId);
  const repository = task.hiddenWorkspace ? undefined : readProjects().find((project) => project.id === task.repositoryId);
  const next: ChatRecord = {
    id: task.chatId,
    title: chatTitleFromPrompt(task.prompt),
    createdAt: existing?.createdAt ?? task.createdAt,
    updatedAt: new Date().toISOString(),
    taskId: task.id,
    taskState: task.state,
    repositoryName: repository?.name ?? existing?.repositoryName,
    repositoryPath: repository?.rootPath ?? existing?.repositoryPath,
    changedFiles: task.changedFiles.length,
    draftPrompt: existing?.draftPrompt ?? "",
    attachedFiles: existing?.attachedFiles ?? [],
  };
  writeChats([next, ...chats.filter((chat) => chat.id !== task.chatId)]);
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
    files.push({ path: relative, name, source: "workspace", previewDataUrl: imagePreviewDataUrl(absolute) });
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
  lines.push(
    "",
    "AGENTS.md instructions:",
    files.length
      ? "The following AGENTS.md files were discovered before this request. You must follow them as repository instructions. For files under nested directories, follow the nearest applicable AGENTS.md in addition to higher-level instructions."
      : "No AGENTS.md file was found in the opened workspace. If one appears while working, read and follow it before making changes.",
  );
  for (const file of files) {
    lines.push(`\n### ${file.path}`, "```", file.text, "```");
  }
}

type SelectedSkillSummary = Pick<PromptSkillInfo, "id" | "source" | "reason" | "fullContent">;

function pushSkillContext(lines: string[], userPrompt: string, capabilityReport?: CapabilityProbeReport): SelectedSkillSummary[] {
  const harnessProfile = readHarnessProfileSetting();
  const systemSkills = systemSkillsForProfile(
    harnessProfile,
    userPrompt,
    undefined,
    capabilityReport ? harnessSkillCapabilityGuidance(capabilityReport) : {},
  );
  const skills = promptSkillsForRequestService(userPrompt);
  const fullSkills = [...systemSkills, ...skills].filter((skill) => skill.fullContent);
  const metadataOnlySkills = [...systemSkills, ...skills].filter((skill) => !skill.fullContent);
  const selectedSkillSummaries = [...systemSkills, ...skills].map((skill) => ({
    id: skill.id,
    source: skill.source,
    reason: skill.reason,
    fullContent: skill.fullContent,
  }));
  lines.push(
    "",
    "Skills:",
    "Skills are editable procedural guidance. The available skill index gives the model only skill names and descriptions by default. Full skill instructions are included only when the user explicitly references $skill-id or the request strongly matches the skill metadata.",
    "The model must not claim to have read or applied a metadata-only skill. When full instructions are included for a skill, the model must read the whole skill before applying it.",
  );
  if (systemSkills.length || skills.length) {
    lines.push("", "Available skill index:");
    for (const skill of [...systemSkills, ...skills]) {
      const source = skill.source === "system" ? "system skill" : "personal skill";
      const status = skill.fullContent ? "full instructions included" : "metadata only";
      lines.push(`- ${skill.id}: ${skill.name} (${source}; ${status})${skill.description ? ` - ${skill.description}` : ""}`);
    }
  } else {
    lines.push("No system or personal skills were selected for this request.");
  }
  if (metadataOnlySkills.length) {
    lines.push(
      "",
      "Metadata-only skills:",
      "These skills are available by name and description only. Do not apply them unless full instructions are included in this prompt.",
    );
  }
  if (!fullSkills.length) return selectedSkillSummaries;
  lines.push("", "Selected skill instructions:");
  let remaining = 30000;
  for (const skill of fullSkills) {
    if (remaining <= 0) {
      lines.push("\n...(additional selected skills omitted because the skill context limit was reached)");
      break;
    }
    const content = skill.content.slice(0, remaining);
    remaining -= content.length;
    const description = skill.description ? `\nDescription: ${skill.description}` : "";
    const status =
      skill.reason === "explicit_request" ? "explicitly requested for this turn" : "selected by skill metadata match";
    lines.push(`\n### ${skill.name}${description}\nStatus: ${status}\nSource: ${skill.instructionPath}`, "```", content, "```");
  }
  return selectedSkillSummaries;
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
    case "assistant.done":
    case "assistant.reasoning.delta":
    case "response.feedback":
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
  const selected = lines.slice(-60);
  let remaining = 14000;
  const compacted: string[] = [];
  for (const line of selected) {
    if (remaining <= 0) break;
    const next = line.slice(0, remaining);
    compacted.push(next);
    remaining -= next.length + 1;
  }
  return compacted.join("\n");
}

function capabilityNeedsForPrompt(prompt: string): CapabilityPromptNeeds {
  return {
    python: promptLooksLikePythonTask(prompt) || promptLooksLikeArtifactTask(prompt),
    cmake: promptLooksLikeCmakeTask(prompt),
    artifacts: promptLooksLikeArtifactTask(prompt),
  };
}

function pushPromptText(parts: RunnerPromptPart[], lines: string[]) {
  const text = lines.join("\n").trim();
  if (text && text !== "Attached file contents:") {
    parts.push({ type: "text", text });
  }
  lines.length = 0;
}

async function attachmentPromptParts(rootPath: string, attachments: ChatAttachment[]): Promise<RunnerPromptPart[]> {
  if (!attachments.length) return [];
  const parts: RunnerPromptPart[] = [];
  const lines = ["Attached file contents:"];
  let remaining = 30000;
  for (const file of attachments) {
    const isChatAttachment = file.source === "chat" && typeof file.storedPath === "string";
    const absolute = isChatAttachment ? path.resolve(file.storedPath as string) : path.resolve(rootPath, file.path);
    const label = isChatAttachment ? `${file.name} (chat attachment)` : file.path;
    lines.push(`\n### ${label}`);
    if (isChatAttachment && file.originalPath) {
      lines.push(`Original path: ${file.originalPath}`);
    }
    const allowed = isChatAttachment ? pathInside(chatAttachmentRoot(), absolute) : pathInside(rootPath, absolute);
    if (!allowed || !fs.existsSync(absolute)) {
      lines.push("(file is no longer available)");
      continue;
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
      pushPromptText(parts, lines);
      parts.push(...rendered.parts);
      lines.push("Attached file contents:");
      continue;
    }
    const imageDataUrl = imageDataUrlIfSafe(absolute);
    if (imageDataUrl) {
      lines.push("Image included below for the vision model.");
      pushPromptText(parts, lines);
      parts.push({ type: "image", data_url: imageDataUrl });
      lines.push("Attached file contents:");
      continue;
    }
    if (remaining <= 0) continue;
    const text = readTextFileIfSafe(absolute);
    if (text === null) {
      lines.push("(binary, too large, or unreadable text file)");
      continue;
    }
    const snippet = text.slice(0, Math.max(0, remaining));
    remaining -= snippet.length;
    lines.push("```");
    lines.push(snippet);
    lines.push(text.length > snippet.length ? "\n...(truncated)" : "");
    lines.push("```");
  }
  pushPromptText(parts, lines);
  return parts;
}

async function runnerPromptForTask(task: TaskRecord, userPrompt: string, attachments: ChatAttachment[]): Promise<RunnerPromptPart[]> {
  const repository = readProjects().find((project) => project.id === task.repositoryId);
  const rootPath = fs.existsSync(task.worktreePath) ? task.worktreePath : task.originalRepoPath;
  const harnessProfile = readHarnessProfileSetting();
  const capabilityReport = await probeLocalCapabilities({ runnerPath: runnerBinaryPath() });
  const capabilityNeeds = capabilityNeedsForPrompt(userPrompt);
  const hiddenChat = isHiddenChatTask(task);
  const tree = repositoryTreePreview(rootPath);
  const keyFiles = hiddenChat ? [] : keyWorkspaceFiles(rootPath);
  const lines = hiddenChat
    ? [
        "Umbratic AI chat context:",
        "- no project folder is selected for this chat",
        "- Umbratic AI created a private scratch workspace for attachments and any files produced during the conversation",
        `- scratch workspace: ${rootPath}`,
        "",
        "Scratch workspace files:",
        tree.length ? tree.join("\n") : "- (empty)",
      ]
    : [
        "Umbratic AI workspace context:",
        `- opened folder: ${rootPath}`,
        `- repository name: ${repository?.name ?? path.basename(rootPath)}`,
        `- workspace kind: ${task.workspaceKind}`,
        `- branch/status: ${task.originalBranch} (${repository?.statusSummary ?? "unknown"})`,
        "",
        "Visible workspace files:",
        tree.length ? tree.join("\n") : "- (no readable files found)",
      ];
  const selectedSkills = pushSkillContext(lines, userPrompt, capabilityReport);
  for (const skill of selectedSkills) {
    emit({
      type: "skill.selected",
      taskId: task.id,
      skillId: skill.id,
      source: skill.source,
      reason: skill.reason,
      fullContent: skill.fullContent,
    });
  }
  if (keyFiles.length) {
    lines.push("", "Key workspace files:");
    for (const file of keyFiles) {
      lines.push(`\n### ${file.path}`, "```", file.text, "```");
    }
  }
  pushAgentInstructionContext(lines, rootPath);
  const history = priorChatContext(task.events ?? [], userPrompt);
  if (history) {
    lines.push(
      "",
      "Conversation so far, for reference only:",
      history,
      "",
      "Use the conversation above only as background. The next section is the current user request to answer now.",
    );
  }
  lines.push("", capabilityPromptGuidance(capabilityReport, capabilityNeeds));
  const artifactGuidance = artifactRuntimePromptGuidance(capabilityReport, userPrompt);
  if (artifactGuidance) {
    lines.push("", artifactGuidance);
  }
  if (harnessProfile === "engineering") {
    lines.push("", "Workspace tool policy:", workspaceToolchainSystemPrompt);
    if (promptLooksLikeCmakeTask(userPrompt)) {
      lines.push("", "C/CMake runtime policy for this request:", cCmakeRuntimeSystemPrompt);
    }
    if (promptLooksLikePythonTask(userPrompt)) {
      lines.push(
        "",
        "Python runtime policy for this request:",
        pythonRuntimeSystemPrompt,
        "Use `uv --version`, `uv python install 3.12` when needed, `uv venv .venv --python 3.12`, and then `uv run python <script.py>` or the direct `.venv` interpreter to verify. Do not run bare `python`, `python3`, or `py` as verification.",
      );
    }
  }
  if (promptLooksLikeMarkdownTask(userPrompt)) {
    lines.push("", "Markdown runtime policy for this request:", markdownRuntimeSystemPrompt);
  }
  const parts: RunnerPromptPart[] = [{ type: "text", text: lines.join("\n") }];
  parts.push(...(await attachmentPromptParts(rootPath, attachments)));
  parts.push({
    type: "text",
    text: [
      "User request:",
      userPrompt,
      "",
      hiddenChat
        ? "Answer as a normal chat unless the user asks you to create or inspect files. Treat the scratch workspace as private working storage, not as a meaningful project folder."
        : "Use the opened folder above as the current project. If answering about the codebase, summarize from the provided workspace context and inspect more files with tools only when needed.",
      "If the user asks you to create, write, edit, update, or otherwise change a file, you must call a workspace file-changing tool before saying the file was created or changed.",
      "If you create or modify files, do not paste the full code in your final response. Refer to the changed file paths by name so Umbratic AI can open them in Review.",
    ].join("\n"),
  });
  return parts;
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
  return {
    path: filePath,
    status,
    diff: [...diffHeader(filePath, status), hunk, ...body].join("\n"),
  };
}

function buildBinaryDiff(filePath: string, before: string | null, after: string | null): ReviewFile | null {
  if (before === after) {
    return null;
  }
  const status: ReviewFile["status"] = before === null ? "added" : after === null ? "deleted" : "modified";
  return {
    path: filePath,
    status,
    diff: [...diffHeader(filePath, status), `Binary file ${status}: ${filePath}`].join("\n"),
  };
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
    throw new Error("Worktree path is outside Umbratic AI control.");
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
  scheduleTaskEventFlush();
}

function emit(event: BackendUiEvent) {
  const stampedEvent = { ...event, at: event.at ?? new Date().toISOString() } as BackendUiEvent;
  recordTaskEvent(stampedEvent);
  mainWindow?.webContents.send("umbratic:backend-event", stampedEvent);
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
  mainWindow?.webContents.send("umbratic:backend-event", event);
}

function failTask(task: TaskRecord, message: string) {
  task.state = "failed";
  task.error = message;
  saveTask(task);
  emit({ type: "task.error", taskId: task.id, message });
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function addSearchResult(results: Map<string, FileSearchResult>, rootPath: string, relativePath: string, match: FileSearchResult["match"]) {
  const normalized = normalizeRelativePath(relativePath.trim());
  if (!normalized || path.isAbsolute(normalized) || isGeneratedRuntimePath(normalized) || isBlockedPath(normalized)) {
    return;
  }
  const absolute = path.join(rootPath, normalized);
  if (!pathInside(rootPath, absolute) || !fs.existsSync(absolute)) {
    return;
  }
  const existing = results.get(normalized);
  if (existing?.match === "path") {
    return;
  }
  results.set(normalized, { path: normalized, name: path.basename(normalized), match });
}

function rankedSearchResults(results: Iterable<FileSearchResult>, query: string, limit: number): FileSearchResult[] {
  const queryLower = query.toLowerCase();
  const score = (file: FileSearchResult) => {
    if (!queryLower) return 0;
    const name = file.name.toLowerCase();
    const filePath = file.path.toLowerCase();
    if (name.startsWith(queryLower)) return 0;
    if (filePath.startsWith(queryLower)) return 1;
    if (name.includes(queryLower)) return 2;
    if (filePath.includes(queryLower)) return 3;
    return file.match === "content" ? 4 : 5;
  };
  return Array.from(results)
    .sort((left, right) => score(left) - score(right) || left.path.length - right.path.length || left.path.localeCompare(right.path))
    .slice(0, limit);
}

function fallbackFileSearch(rootPath: string, query: string, limit: number): FileSearchResult[] {
  const root = path.resolve(rootPath);
  const queryLower = query.toLowerCase();
  const results = new Map<string, FileSearchResult>();
  const collectionLimit = Math.max(limit * 8, 80);
  const stack = [root];
  while (stack.length && results.size < collectionLimit) {
    const current = stack.pop();
    if (!current) continue;
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
      if (!entry.isFile()) continue;
      if (!queryLower || relative.toLowerCase().includes(queryLower)) {
        addSearchResult(results, root, relative, "path");
      }
      if (results.size >= collectionLimit) break;
    }
  }
  return rankedSearchResults(results.values(), query, limit);
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
  const rootPath = repository.rootPath;
  const results = new Map<string, FileSearchResult>();
  const ignoreArgs = [
    "--hidden",
    "-g",
    "!.git",
    "-g",
    "!node_modules",
    "-g",
    "!dist",
    "-g",
    "!dist-electron",
    "-g",
    "!.umbratic",
    "-g",
    "!.venv",
    "-g",
    "!venv",
  ];

  if (await commandAvailable("rg")) {
    const collectionLimit = Math.max(limit * 8, 80);
    const listed = await execFileResult("rg", ["--files", ...ignoreArgs], { cwd: rootPath, timeout: 15000 });
    for (const file of listed.stdout.split(/\r?\n/)) {
      if (!query || normalizeRelativePath(file).toLowerCase().includes(query.toLowerCase())) {
        addSearchResult(results, rootPath, file, "path");
      }
      if (results.size >= collectionLimit) break;
    }
    if (query.length >= 2 && results.size < collectionLimit) {
      const contentMatches = await execFileResult("rg", ["--ignore-case", "--files-with-matches", ...ignoreArgs, escapeRegExp(query)], {
        cwd: rootPath,
        timeout: 15000,
      });
      for (const file of contentMatches.stdout.split(/\r?\n/)) {
        addSearchResult(results, rootPath, file, "content");
        if (results.size >= collectionLimit) break;
      }
    }
  }

  if (results.size === 0) {
    for (const result of fallbackFileSearch(rootPath, query, limit)) {
      results.set(result.path, result);
    }
  }

  return rankedSearchResults(results.values(), query, limit);
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
  return {
    ...provider,
    providerName: "Umbratic Veil",
    software: settings.software,
    baseUrl: normalizeBaseUrl(settings.baseUrl),
    apiKey: settings.secret.trim(),
    headers: endpointHeaders(settings.headers),
    mtls: settings.mode === "server" ? provider.mtls : undefined,
  };
}

function configuredEndpointModel(): LocalModelInfo {
  const provider = endpointProvider();
  return {
    providerId: provider.providerId,
    providerName: provider.providerName,
    modelId: veilManagedModelId,
    displayName: provider.providerName,
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
  const settings = writeModelEndpointSettings(input);
  const status = await getBackendStatus();
  return { settings, status };
}

async function saveHarnessProfileSetting(input: unknown) {
  const settings = writeHarnessProfileSetting(input as HarnessProfileId);
  const status = await getBackendStatus();
  return { settings, status };
}

async function resolveSelectedModel(): Promise<{ providers: LocalModelProvider[]; models: LocalModelInfo[]; selected: LocalModelInfo | null }> {
  const configured = configuredEndpointModel();
  const providerConfig = endpointProvider();
  const health = await checkEndpointHealth(providerConfig);
  const models: LocalModelInfo[] = [];
  const selected = health.status === "ready" ? configured : null;
  const provider: LocalModelProvider = {
    providerId: configured.providerId,
    providerName: configured.providerName,
    baseUrl: configured.baseUrl,
    status: health.status,
    models,
    message: health.message,
  };
  return { providers: [provider], models, selected };
}

async function getBackendStatus(): Promise<BackendStatus> {
  const { providers, models, selected } = await resolveSelectedModel();
  const runnerPath = runnerBinaryPath();
  const capabilityReport = await probeLocalCapabilities({ runnerPath });
  const managedEndpoint = managedModelEndpointDefaults();
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
      source: managedEndpoint ? "managed" : hasStoredModelEndpointSettings() ? "stored" : "local-default",
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
      telemetry: telemetryPolicyInfo,
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
        title: "Export Umbratic AI Telemetry",
        defaultPath: `umbratic-telemetry-${timestamp}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      })
    : await dialog.showSaveDialog({
        title: "Export Umbratic AI Telemetry",
        defaultPath: `umbratic-telemetry-${timestamp}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
  if (result.canceled || !result.filePath) {
    return { ok: false, message: "Export canceled." };
  }
  const bundle = buildRedactedTelemetryBundle(readTasks(), readProjects());
  writeJsonFile(result.filePath, bundle);
  return { ok: true, path: result.filePath };
}

async function retryTelemetrySpoolQueue(): Promise<void> {
  if (!telemetryPolicyInfo.syncEnabled) return;
  const provider = endpointProvider();
  await uploadTelemetrySpool({
    directory: telemetrySpoolDirectory(app.getPath("userData")),
    endpoint: telemetryUploadEndpoint(provider),
  });
}

async function syncTelemetryNow(): Promise<TelemetrySyncResult> {
  if (!telemetryPolicyInfo.syncEnabled) {
    throw new Error("Telemetry sync is disabled by policy.");
  }
  const provider = endpointProvider();
  const bundle = buildRedactedTelemetryBundle(readTasks(), readProjects());
  return syncTelemetryBundle({
    directory: telemetrySpoolDirectory(app.getPath("userData")),
    bundle,
    endpoint: telemetryUploadEndpoint(provider),
  });
}

function scheduleManagedTelemetrySync() {
  if (!telemetryPolicyInfo.syncEnabled || telemetrySyncTimer) return;
  telemetrySyncTimer = setTimeout(() => {
    telemetrySyncTimer = null;
    void syncTelemetryNow().catch(() => undefined);
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
    if (!stat.isFile() || stat.size > 25 * 1024 * 1024 || seen.has(absolute.toLowerCase())) continue;
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
    if (!parsed || parsed.buffer.length === 0 || parsed.buffer.length > 25 * 1024 * 1024) continue;
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
      return { ok: false, message: "Attachment is outside Umbratic AI storage." };
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

function requiresBypassToolApproval(classification: ReturnType<typeof classifyCommandText>): boolean {
  return classification.risky;
}

async function askPermission(
  task: TaskRecord,
  request: Omit<PermissionRequest, "id"> & { bypassRequiresApproval?: boolean },
): Promise<void> {
  const id = `perm-${crypto.randomBytes(6).toString("hex")}`;
  const { bypassRequiresApproval = false, ...visibleRequest } = request;
  const fullRequest: PermissionRequest = { id, ...visibleRequest };
  emit({ type: "permission.requested", taskId: task.id, request: fullRequest });
  if (task.permissionMode === "bypass" && !bypassRequiresApproval) {
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
  const decision = input.decision === "deny" ? "deny" : "allow";
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
): Promise<RunnerPromptPart[]> {
  const rootPath = fs.existsSync(task.worktreePath) ? task.worktreePath : task.originalRepoPath;
  if (task.workspaceMode === "local" && !task.agentBranch && !task.baselineFiles) {
    task.baselineFiles = snapshotFolder(rootPath);
    saveTask(task);
  }
  return runnerPromptForTask(task, userPrompt, attachments);
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
    bypassRequiresApproval: requiresBypassToolApproval(classification),
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

async function gitReviewFiles(task: TaskRecord): Promise<ReviewFile[]> {
  if (!taskUsesIsolatedWorktree(task)) {
    return folderReviewFiles(task);
  }
  const changed = (await getChangedFiles(task.worktreePath, task.baseCommit))
    .filter((file) => !isGeneratedRuntimePath(file))
    .sort((a, b) => a.localeCompare(b));
  const files: ReviewFile[] = [];
  for (const file of changed) {
    const absolute = path.join(task.worktreePath, file);
    const status = await gitFileStatus(task, file);
    const diff = await gitOutput(task.worktreePath, ["diff", "--no-ext-diff", "--unified=80", task.baseCommit, "--", file]).catch(
      () => "",
    );
    if (diff.trim()) {
      files.push({ path: file, status, diff });
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

async function gitFileStatus(task: TaskRecord, file: string): Promise<ReviewFile["status"]> {
  const absolute = path.join(task.worktreePath, file);
  const afterExists = fs.existsSync(absolute);
  const before = await gitResult(task.worktreePath, ["cat-file", "-e", `${task.baseCommit}:${file.replace(/\\/g, "/")}`]);
  if (!before.success && afterExists) {
    return "added";
  }
  if (before.success && !afterExists) {
    return "deleted";
  }
  return "modified";
}

async function refreshReview(task: TaskRecord): Promise<ReviewFile[]> {
  const reviewFiles = task.workspaceKind === "folder" ? folderReviewFiles(task) : await gitReviewFiles(task);
  task.reviewFiles = reviewFiles;
  task.changedFiles = reviewFiles.map((file) => file.path);
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
  if (task.state === "approved" || task.state === "merged" || task.state === "rejected") {
    return publicTask(task);
  }
  if (!fs.existsSync(task.worktreePath)) {
    return publicTask(task);
  }
  await refreshReview(task);
  saveTask(task);
  return publicTask(task);
}

async function handleRunnerPermission(
  task: TaskRecord,
  run: RunnerProcess,
  permission: Record<string, unknown>,
  promptForRun: RunnerPrompt,
  intentPrompt: string,
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
  const classification = type.includes("edit")
    ? ({ commandClass: "edit" as const, risky: false })
    : type === "read" || type === "search"
      ? ({ commandClass: "read" as const, risky: false })
    : classifyCommandText(title, task.worktreePath);

  if (type === "bash" && isBarePythonCommand(title)) {
    emit({ type: "permission.resolved", taskId: task.id, id, decision: "deny" });
    await replyRunnerPermission(run, id, false);
    return "resolved";
  }

  if (type === "read" || type === "search") {
    emit({ type: "permission.resolved", taskId: task.id, id, decision: "allow" });
    await replyRunnerPermission(run, id, true);
    return "resolved";
  }

  if (task.workspaceKind === "git" && task.workspaceMode === "worktree" && !task.agentBranch && type === "edit") {
    task.agentBranch = `umbratic/${task.id}-${slugify(intentPrompt)}`;
    task.worktreePath = path.join(worktreeRootForRepo(task.originalRepoPath), task.id);
    task.runnerSessionId = undefined;
    task.pendingPrompt = runnerPromptText(promptForRun);
    pendingRunnerPrompts.set(task.id, runnerPromptParts(promptForRun));
    task.state = permissionMode === "bypass" ? "running" : "awaiting_worktree_approval";
    saveTask(task);
    await replyRunnerPermission(run, id, false).catch(() => undefined);
    if (permissionMode === "bypass") {
      void createWorktreeAndRunRunner(task, promptForRun);
    } else {
      emit({
        type: "worktree.requested",
        taskId: task.id,
        branch: task.agentBranch,
        path: task.worktreePath,
        baseCommit: task.baseCommit,
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
  };
  emit({ type: "permission.requested", taskId: task.id, request });

  if (type === "webfetch" || type === "websearch") {
    emit({ type: "permission.resolved", taskId: task.id, id, decision: "deny" });
    await replyRunnerPermission(run, id, false);
    return "resolved";
  }

  if (
    task.permissionMode === "bypass" &&
    (type === "read" || type === "search" || type === "edit" || type === "bash") &&
    !requiresBypassToolApproval(classification)
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
  const intent = intentPrompt ?? task.prompt;
  const expectsFileChanges = promptLooksLikeFileChange(intent);
  const enabledToolsForRun = taskEnabledTools(task);
  try {
    const { providers, selected } = await resolveSelectedModel();
    if (!selected) {
      failTask(task, providers[0]?.message ?? "Veil health check is not ready.");
      return;
    }
    task.model = selected;
    applyTaskPolicyMetadata(task, intent);
    saveTask(task);
    if (expectsFileChanges && !canSatisfyFileChangeContract(enabledToolsForRun)) {
      emit({
        type: "required_tool.failed",
        taskId: task.id,
        requirement: "file_change",
        reason: "file_tools_disabled",
        requiredTools: requiredFileChangeTools,
        attemptedTools: [],
        attempt: 0,
        detail: "File creation tools are disabled for this run.",
      });
      failTask(task, "File creation tools are disabled for this run.");
      return;
    }
    const prompt = promptForRun ?? (await runnerPromptForTaskWithPermission(task, intent, attachments));
    const promptParts = runnerPromptParts(prompt);
    run = await startUmbraticRunnerServer(task, selected);
    activeRunnerProcesss.set(task.id, run);

    const toolRuns = new Map<string, { commandId: string; command: string; kind: PermissionRequest["kind"]; toolKind?: RunnerToolId; finished: boolean }>();
    let delegatedToWorktree = false;
    let fileCreationToolRequested = false;
    let fileCreationToolSucceeded = false;
    let requiredToolAttempt = 1;
    const fileChangingToolCallIds = new Set<string>();
    const fileChangingToolsAttempted = new Set<RunnerToolId>();
    let assistantTextForCurrentAttempt = "";
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

    const emitAssistantText = (text: string, at?: string) => {
      if (!text || text.trim() === "Ready for review.") return;
      assistantTextForCurrentAttempt += text;
      emit({ type: "assistant.delta", taskId: task.id, text, at });
    };

    const emitReasoningText = (text: string, at?: string) => {
      if (!text || task.reasoningMode !== "reasoning") return;
      emit({ type: "assistant.reasoning.delta", taskId: task.id, text, at });
    };

    const attemptedFileChangeTools = () => requiredFileChangeTools.filter((tool) => fileChangingToolsAttempted.has(tool));

    const emitRequiredToolFailure = (
      reason: RequiredToolContractReason,
      detail: string,
      attempt = requiredToolAttempt,
    ) => {
      emit({
        type: "required_tool.failed",
        taskId: task.id,
        requirement: "file_change",
        reason,
        requiredTools: requiredFileChangeTools,
        attemptedTools: attemptedFileChangeTools(),
        attempt,
        detail,
      });
    };

    const ensureToolRun = (
      toolCallId: string,
      command: string,
      kind: PermissionRequest["kind"],
      commandClass: CommandClass,
      toolKind?: RunnerToolId,
    ) => {
      const existing = toolRuns.get(toolCallId);
      if (existing) {
        if (toolKind && !existing.toolKind) existing.toolKind = toolKind;
        return existing;
      }
      const current = { commandId: `ar-${toolCallId}`, command, kind, toolKind, finished: false };
      toolRuns.set(toolCallId, current);
      emit({
        type: "command.started",
        taskId: task.id,
        id: current.commandId,
        command,
        cwd: task.worktreePath,
        kind,
        commandClass,
      });
      return current;
    };

    const onEvent = (event: Record<string, unknown>) => {
      const type = typeof event.type === "string" ? event.type : "";
      const eventTaskId = typeof event.taskId === "string" ? event.taskId : task.id;
      if (eventTaskId !== task.id) return;

      if (type === "assistant.delta" && typeof event.text === "string") {
        emitAssistantText(event.text, eventAt(event));
        return;
      }

      if (type === "assistant.reasoning.delta" && typeof event.text === "string") {
        emitReasoningText(event.text, eventAt(event));
        return;
      }

      if (type === "tool.requested") {
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : `tool-${toolRuns.size + 1}`;
        const toolKind = typeof event.toolKind === "string" ? event.toolKind : "tool";
        const runnerToolKind = (
          toolKind === "read" || toolKind === "write" || toolKind === "edit" || toolKind === "search" || toolKind === "command"
        ) ? toolKind as RunnerToolId : undefined;
        const command = typeof event.summary === "string" && event.summary.trim() ? event.summary.trim() : toolKind;
        const kind: PermissionRequest["kind"] =
          toolKind === "command"
            ? "bash"
            : toolKind === "read" || toolKind === "search"
              ? "read"
              : "edit";
        const fallbackClass = kind === "bash" ? classifyCommandText(command, task.worktreePath).commandClass : kind;
        const commandClass = typeof event.commandClass === "string" ? event.commandClass as CommandClass : fallbackClass;
        if (runnerToolKind && isFileChangingTool(runnerToolKind)) {
          fileCreationToolRequested = true;
          fileChangingToolCallIds.add(toolCallId);
          fileChangingToolsAttempted.add(runnerToolKind);
        }
        ensureToolRun(toolCallId, command, kind, commandClass, runnerToolKind);
        return;
      }

      if (type === "tool.output") {
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
        if (!toolCallId) return;
        const stream = event.stream === "stderr" ? "stderr" : "stdout";
        const text = typeof event.text === "string" ? event.text : "";
        const current = ensureToolRun(toolCallId, toolCallId, "bash", "shell");
        if (text) {
          emit({ type: "command.output", taskId: task.id, id: current.commandId, stream, text: text.slice(0, 12000) });
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
          if (
            (
              fileChangingToolCallIds.has(toolCallId) ||
              current.toolKind === "write" ||
              current.toolKind === "edit" ||
              current.toolKind === "command" ||
              current.kind === "edit" ||
              current.command.startsWith("write ") ||
              current.command.startsWith("edit ")
            ) &&
            exitCode === 0
          ) {
            fileCreationToolSucceeded = true;
          }
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
        }
        return;
      }

      if (type === "permission.requested") {
        const permission = {
          id: typeof event.permissionId === "string" ? event.permissionId : "",
          type: typeof event.permissionKind === "string" ? event.permissionKind : "tool",
          title: typeof event.summary === "string" ? event.summary : "",
        };
        void handleRunnerPermission(task, run as RunnerProcess, permission, prompt, intent)
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
        const message = typeof event.message === "string" && event.message.trim() ? event.message : "Umbratic runner failed.";
        fail(message);
        return;
      }

      if (type === "session.idle") {
        finishOpenToolRuns();
        finish();
      }
    };

    const stream = beginRunnerEventStream(run, onEvent);
    void stream.done.catch((error) => {
      if (!run?.abortController.signal.aborted) {
        fail(String(error instanceof Error ? error.message : error));
      }
    });
    await stream.ready;
    // Runner sessions live only inside the runner process started above.
    // Because Umbratic AI starts a fresh process for each task run, a persisted
    // runnerSessionId from an earlier process is stale and cannot be reused.
    const session = await runnerRequest<{ id: string }>(run, "/session", {
      method: "POST",
      body: { title: chatTitleFromPrompt(intent) },
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

    if (delegatedToWorktree || task.state === "awaiting_worktree_approval") {
      return;
    }

    if (expectsFileChanges && !fileCreationToolRequested) {
      const previousAssistantText = compactHistoryText(assistantTextForCurrentAttempt.trim(), 1800);
      assistantTextForCurrentAttempt = "";
      armCompletion();
      emitRequiredToolFailure("missing_tool_call", "The first runner attempt ended without a file-changing tool call.", requiredToolAttempt);
      requiredToolAttempt = 2;
      await runnerRequest<void>(run, `/session/${encodeURIComponent(session.id)}/prompt_async`, {
        method: "POST",
        body: {
          parts: [
            {
              type: "text",
              text: buildRequiredFileChangeRetryPrompt({
                previousAssistantText,
                enabledTools: enabledToolsForRun,
              }),
            },
          ],
        },
      });
      await waitForCompletion();

      if (delegatedToWorktree) {
        return;
      }

      const blocker = !fileCreationToolRequested ? cannotCreateFileBlocker(assistantTextForCurrentAttempt) : null;
      if (blocker) {
        emitRequiredToolFailure("agent_reported_blocker", blocker, requiredToolAttempt);
        failTask(task, `Umbratic runner could not make requested file changes. ${blocker}`);
        return;
      }
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
      if (expectsFileChanges) {
        const summary = noReviewFailureSummary({
          toolRequested: fileCreationToolRequested,
          toolSucceeded: fileCreationToolSucceeded,
        });
        emitRequiredToolFailure(summary.reason, summary.detail, requiredToolAttempt);
        failTask(task, requiredToolFailureMessage(summary));
        return;
      }
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
    failTask(task, String(error instanceof Error ? error.message : error));
  } finally {
    clearPendingPermissionsForTask(task.id);
    activeRunnerProcesss.delete(task.id);
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
  task.runtimeProfile = runtimeProfileForCurrentHarness(task.prompt);
  task.runnerSessionId = undefined;
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
  const task = readTasks().find((row) => row.id === recent.taskId);
  if (!task) {
    recentStartTaskRequests.delete(requestKey);
    return null;
  }
  if (
    activeRunnerProcesss.has(task.id) ||
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
  const hiddenWorkspace = !requestedRepositoryId;
  const existingChat = requestedChatId ? readChats().find((row) => row.id === requestedChatId) : undefined;
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
      title: chatTitleFromPrompt(prompt),
      repositoryName: refreshed.name,
      repositoryPath: hiddenWorkspace ? undefined : refreshed.rootPath,
    });
  const repositoryId = refreshed.id;
  const attachments = sanitizeAttachments(input.attachedFiles, refreshed.rootPath, chat.id);
  const existingTask = chat?.taskId ? readTasks().find((row) => row.id === chat.taskId) : undefined;
  const requestedWorkspaceMode: WorkspaceMode =
    !hiddenWorkspace && refreshed.kind === "git" && input.useWorktree === true ? "worktree" : "local";
  const requestedEnabledTools = normalizeEnabledTools(input.enabledTools, enabledToolsFromSettings({}));
  const capabilityReport = await probeLocalCapabilities({ runnerPath: runnerBinaryPath() });
  const taskCapabilityProbes = capabilityTelemetrySnapshot(capabilityReport, capabilityNeedsForPrompt(prompt));

  if (existingTask) {
    const closedMessage = closedTaskMessage(existingTask);
    if (closedMessage) {
      throw new Error(closedMessage);
    }
    if (activeRunnerProcesss.has(existingTask.id) || existingTask.state === "awaiting_worktree_approval" || existingTask.state === "approving") {
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
    existingTask.reasoningMode = reasoningMode;
    existingTask.runnerName = umbraticRunnerName;
    existingTask.runnerVersion = umbraticRunnerVersion;
    existingTask.policyVersion = umbraticPolicyVersion;
    existingTask.runtimeProfile = runtimeProfileForCurrentHarness(prompt);
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
      existingTask.baselineFiles = undefined;
    }
    existingTask.pendingPrompt = undefined;
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
    runtimeProfile: runtimeProfileForCurrentHarness(prompt),
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
    task.state = "rejected";
    task.pendingPrompt = undefined;
    pendingRunnerPrompts.delete(task.id);
    task.rejectedAt = new Date().toISOString();
    saveTask(task);
    emit({ type: "task.error", taskId: task.id, message: "Worktree creation was declined." });
    return;
  }
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
  const run = activeRunnerProcesss.get(task.id);
  if (run) {
    activeRunnerProcesss.delete(task.id);
    stopRunnerProcess(run);
  }
  pendingRunnerPrompts.delete(task.id);
  clearPendingPermissionsForTask(task.id);
  const cleanup = input.cleanup === true;
  emit({ type: "merge.approval", taskId: task.id, decision: "rejected", cleanup, reason: "user rejected review" });
  if (taskUsesIsolatedWorktree(task) && cleanup && taskStatesThatCanOpen.has(task.state)) {
    if (fs.existsSync(task.worktreePath)) {
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
  const run = activeRunnerProcesss.get(task.id);
  if (run) {
    activeRunnerProcesss.delete(task.id);
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
  if (!/^assistant-\d+$/.test(messageId)) {
    throw new Error("Invalid response message id.");
  }
  task.events = task.events.filter(
    (event) => !(event.type === "response.feedback" && event.messageId === messageId),
  );
  saveTask(task);
  console.info("Recorded response feedback", { taskId: task.id, messageId, rating });
  emit({ type: "response.feedback", taskId: task.id, messageId, rating });
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
    return { ok: false, message: "Worktree path is outside Umbratic AI control." };
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
  return openPathInIde(ideId, repositoryPath, "folder");
}

function codeLikeIdeArgs(targetPath: string, targetKind: "file" | "folder", workspacePath?: string): string[] {
  if (targetKind === "file" && workspacePath) {
    return ["--reuse-window", workspacePath, "--goto", targetPath];
  }
  return targetKind === "file" ? [targetPath] : ["--new-window", targetPath];
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
    return launchCommand(
      "open",
      targetKind === "file" && workspacePath
        ? ["-a", "Visual Studio Code", workspacePath, "--args", "--reuse-window", "--goto", targetPath]
        : targetKind === "file"
          ? ["-a", "Visual Studio Code", targetPath]
        : ["-na", "Visual Studio Code", "--args", "--new-window", targetPath],
    );
  }
  const error = await shell.openPath(targetPath);
  return error ? { ok: false, message: error } : { ok: true };
}

function setPermissionMode(input: unknown): Promise<BackendStatus> {
  permissionMode = input === "bypass" ? "bypass" : "normal";
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
  const rawUrl = event.senderFrame?.url || event.sender.getURL();
  try {
    const url = new URL(rawUrl);
    if (isDev) {
      return isTrustedDevUrl(url);
    }
    return url.protocol === "file:";
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
    assertTrustedSender(event);
    return handler(input, event);
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
    return url.protocol === "file:";
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
    title: "Umbratic AI",
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
}

app.whenReady().then(async () => {
  finishInterruptedRunningTasks();
  compactClosedTaskStorage();
  handleIpc("umbratic:list-chats", () => readChats());
  handleIpc("umbratic:create-chat", (input) => createChat(input));
  handleIpc("umbratic:update-chat-draft", (input) => updateChatDraft(input));
  handleIpc("umbratic:delete-chat", (input) => deleteChat(input));
  handleIpc("umbratic:get-notes", () => getNotes());
  handleIpc("umbratic:update-notes", (input) => updateNotes(input));
  handleIpc("umbratic:get-task", (input) => publicTaskById(input));
  handleIpc("umbratic:refresh-task-review", (input) => refreshTaskReview(input));
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
  handleIpc("umbratic:get-model-endpoint-settings", () => readModelEndpointSettings());
  handleIpc("umbratic:save-model-endpoint-settings", (input) =>
    saveModelEndpointSettings(input as Partial<ReturnType<typeof readModelEndpointSettings>>),
  );
  handleIpc("umbratic:get-harness-profile", () => readHarnessProfileSetting());
  handleIpc("umbratic:save-harness-profile", (input) => saveHarnessProfileSetting(input));
  handleIpc("umbratic:export-telemetry", () => exportTelemetryBundle());
  handleIpc("umbratic:list-skills", () => listSkillsService());
  handleIpc("umbratic:save-skill-settings", (input) => saveSkillSettingsService(input));
  handleIpc("umbratic:open-skills-folder", () => openSkillsFolder());
  handleIpc("umbratic:open-skill-in-editor", (input) => openSkillInEditor(input));
  handleIpc("umbratic:import-skill", (input) => importSkillFromDialog(input as { sourcePath?: string } | undefined));
  handleIpc("umbratic:create-skill", (input) => createSkillService(input as { name?: string }));
  handleIpc("umbratic:get-skill-document", (input) => getSkillDocumentService(input as { id?: string }));
  handleIpc("umbratic:save-skill-document", (input) => saveSkillDocumentService(input as { id?: string; content?: string }));
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
  void retryTelemetrySpoolQueue().catch(() => undefined);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  flushPendingTaskEvents();
  for (const [id, pending] of pendingPermissions) {
    pendingPermissions.delete(id);
    void pending.onDeny();
  }
  for (const [taskId, run] of activeRunnerProcesss) {
    activeRunnerProcesss.delete(taskId);
    stopRunnerProcess(run);
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});
