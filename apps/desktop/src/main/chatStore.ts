import { chatWorktreeTaskId, findReusableWorktreeTask, taskUsesIsolatedWorktree, worktreeRootTaskId } from "./worktreeOps";
import { saveChat } from "./mainRuntime";
import { imagePreviewDataUrl } from "./workspaceSnapshot";
import {
  app,
  BrowserWindow,
  dialog,
  IpcMainInvokeEvent,
  Menu,
  MenuItemConstructorOptions,
  nativeImage,
  OpenDialogOptions,
  shell,
  session,
} from "electron";
import { spawn } from "node:child_process";
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
  estimateTextTokens,
} from "../shared/contextWindow";

import {
  endpointEditingAllowed,
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
import { attachmentContextTokens, priorChatAttachments, readAttachmentTextIfSafe } from "./attachmentContext";
import { generateOcrDocument, writeOcrArtifacts, type OcrDocument, type OcrPageInput } from "./ocrRuntime";
import {
  beginRunnerEventStream,
  runnerRequest,
  runnerBinaryPath,
  runnerDiagnosticsDirectory,
  replyRunnerPermission,
  setRunnerProviderSession,
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
  canAutoResolvePermission,
  classifyCommandText,
  isBlockedPath,
  isGeneratedRuntimePath,
  isLocalhostUrl,
  isWorkspaceReadPermission,
  promptLooksLikeCmakeTask,
  promptLooksLikePythonTask,
  runtimeDiagnostics,
  telemetryPolicyForMode,
} from "./policy";
import {
  connectCompanySession,
  companyConnectionStatus,
  disconnectCompanyDevice,
  disconnectCompanySession,
  enrollCompanyDevice,
  ensureCompanySession,
  renewCompanySession,
} from "./companyIdentity";
import { companyTransportOptions, configuredEndpointModel, endpointProvider, normalizeBaseUrl } from "./endpointConfig";
import { ensureLocalVeil, probeLocalModels as probeLocalRuntimeModels, stopLocalVeil } from "./localVeil";
import { loadWindowWithModelWarmup } from "./modelWarmup";
import { shouldProbeVeilContext } from "./veilContext";
import {
  readChat,
  readChats,
  hasStoredModelEndpointSettings,
  readContextLengthSetting,
  readCachedLocalModels,
  readLocalDiagnosticInfo,
  readLocalDiagnostics,
  readHarnessProfileSetting,
  readModelEndpointSettings,
  readModelEndpointSettingsForMode,
  publicModelEndpointSettings,
  readNotes,
  readPermissionModeSetting,
  readProjects,
  readProductTelemetryEvents,
  readStartupSettings, readTask,
  readTaskCheckpoints,
  readTasks,
  clearLocalDiagnostics,
  writeHarnessProfileSetting,
  writeCachedLocalModels,
  writeContextLengthSetting,
  writeModelEndpointSettings,
  writeChat,
  writeChats,
  writeJsonFile,
  writeNotes,
  writePermissionModeSetting,
  writeProjects,
  writeProductTelemetryEvent,
  writeTask,
  writeTasks,
  closeStorageDatabases,
  normalizeConversationState,
} from "./storage";
import { recordBackendEventDiagnostic, recordLocalDiagnostic, sanitizeDiagnosticValue } from "./diagnostics";
import { buildRedactedTelemetryBundle } from "./telemetry";
import {
  syncTelemetryBundle,
  telemetrySpoolDirectory,
  uploadTelemetrySpool,
} from "./telemetrySync";
import { checkEndpointHealth, modelWithFreshContextLength as refreshModelContextLength, telemetryUploadEndpoint } from "./modelEndpointRuntime";
import { commandAvailable, execFileOutput, execFileResult, gitOutput, gitResult } from "./processCommands";
import { searchRepositoryFiles } from "./repositorySearch";
import { enabledToolsFromSettings, normalizeEnabledTools } from "./toolSettings";
import { RunnerEventAdapter } from "./runnerEventAdapter";
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
  UserNotes,
  WorkspaceKind,
  WorkspaceMode,
} from "./types";
import { commandText, hasSymlinkComponent, isRecord, normalizeRelativePath, pathInside, requiredString, shortHash, slugify } from "./utils";
import { normalizeReviewFile, parseGitPorcelainPaths, reviewContextLines, buildTextDiff } from "../shared/reviewDiff";
import { isResponseFeedbackReason, removeResponseFeedback } from "../shared/taskEvents";
import { backendEventDiagnostic, parseBackendUiEvent } from "../shared/backendEvents";
import {
  registerDesktopIpcHandlers,
  type DesktopIpcHandlers,
} from "./ipcRegistry";
import { readTaskDocumentReview } from "./documentReview";
import {
  assertFolderRejectBaseline,
  createTaskCheckpoint,
  createTurnCheckpoint,
  forkTaskFromCheckpoint,
  removeTaskCheckpoint,
  restoreIsolatedWorktreeForReject,
  restoreTaskCheckpoint,
  setTaskCheckpointPinned,
} from "./checkpoints/service";
import { reconcileCheckpointLifecycle } from "./checkpoints/reconcile";
import { codeLikeIdeArgs, macCodeLikeIdeArgs } from "./ideLaunch";
import { boundedRecentLines } from "./historyContext";
import { limitPromptImages, shouldIncludeWorkspaceContext, type ContextPromptPart } from "./promptContext";
import { findAgentInstructionFiles } from "./repositoryInstructions";
import * as appPaths from "./appPaths";
import { startLocalCacheMaintenance, stopLocalCacheMaintenance } from "./cacheMaintenance";
import {
  appendTaskEvent,
  compactTaskEvents,
  filterReviewPaths,
  hiddenRendererReviewPaths,
  isReviewReadyAssistantEvent,
  mergeTaskEvents,
  rendererReviewFiles,
  visibleTaskEvents,
} from "./taskReviewPresentation";

export function stableRepositoryId(rootPath: string): string {
  return crypto.createHash("sha256").update(path.resolve(rootPath).toLowerCase()).digest("hex").slice(0, 16);
}

export function hiddenChatWorkspacePath(chatIdValue: string): string {
  return path.join(appPaths.scratchWorkspacesDirectory(app.getPath("userData")), chatIdValue);
}

export function hiddenChatRepository(chatIdValue: string): RepositoryInfo {
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

export function isHiddenChatTask(task: TaskRecord): boolean {
  return !!task.chatId && task.repositoryId === `hidden-${task.chatId}` && path.resolve(task.originalRepoPath) === hiddenChatWorkspacePath(task.chatId);
}

export function taskId(): string {
  return `task-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

export function chatId(): string {
  return `chat-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

export function chatAttachmentRoot(): string {
  return appPaths.chatAttachmentsDirectory(app.getPath("userData"));
}

export function safeChatId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96) || "chat";
}

export function chatAttachmentDirectory(chatIdValue: string): string {
  return path.join(chatAttachmentRoot(), safeChatId(chatIdValue));
}

export function safeAttachmentFileName(value: string): string {
  const ext = path.extname(value).replace(/[^A-Za-z0-9.]/g, "").slice(0, 18);
  const stem = path
    .basename(value, path.extname(value))
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${stem || "attachment"}${ext}`;
}

export function extensionForMimeType(mimeType: string): string {
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

export function parseAttachmentDataUrl(value: string): { mimeType: string; buffer: Buffer } | null {
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

export function chatAttachmentFromRecord(file: Record<string, unknown>, chatIdValue: string): ChatAttachment | null {
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

export function parseReasoningMode(value: unknown): ReasoningMode {
  return value === "fast" ? "fast" : "reasoning";
}

export function createChat(input: unknown): ChatRecord {
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
    modelEndpointMode: readModelEndpointSettings().mode,
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
export function updateChatDraft(input: unknown): ChatRecord {
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
export function updateChatProject(input: unknown): ChatRecord {
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
export function deleteChat(input: unknown): { ok: true } {
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

export function pathKey(pathValue: string): string {
  const resolved = path.resolve(pathValue);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function projectFromId(input: unknown, action: string): RepositoryInfo {
  if (!isRecord(input)) {
    throw new Error(`Invalid ${action} input.`);
  }
  const projectId = requiredString(
    typeof input.projectId === "string" ? input.projectId : input.repositoryId,
    "projectId",
  );
  const project = readProjects().find((row) => row.id === projectId);
  if (!project) {
    throw new Error("Project not found.");
  }
  return project;
}

export function deleteChatManagedFiles(chatIdValue: string) {
  fs.rmSync(hiddenChatWorkspacePath(chatIdValue), { recursive: true, force: true });
  fs.rmSync(chatAttachmentDirectory(chatIdValue), { recursive: true, force: true });
}

export function deleteChatsForRepositoryPath(repositoryPath: string): string[] {
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

export function deleteProjectChats(input: unknown): { ok: true; deletedChatIds: string[] } {
  const project = projectFromId(input, "project chat delete");
  return { ok: true, deletedChatIds: deleteChatsForRepositoryPath(project.rootPath) };
}

export function deleteProject(input: unknown): { ok: true; deletedChatIds: string[] } {
  const project = projectFromId(input, "project delete");
  const repositoryKey = pathKey(project.rootPath);
  const deletedChatIds = deleteChatsForRepositoryPath(project.rootPath);
  writeProjects(readProjects().filter((row) => pathKey(row.rootPath) !== repositoryKey));
  return { ok: true, deletedChatIds };
}

export function getNotes(): UserNotes {
  return readNotes();
}

export function updateNotes(input: unknown): UserNotes {
  if (!isRecord(input)) {
    throw new Error("Invalid notes input.");
  }
  const content = typeof input.content === "string" ? input.content.slice(0, 50000) : "";
  return writeNotes(content);
}

export function updateChatFromTask(task: TaskRecord) {
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
    modelEndpointMode: task.modelEndpointMode ?? existing?.modelEndpointMode,
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
    ...(existing?.conversationState ? { conversationState: existing.conversationState } : {}),
  };
  writeChat(next);
}
