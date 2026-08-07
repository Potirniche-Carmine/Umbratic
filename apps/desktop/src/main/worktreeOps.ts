import { pathKey } from "./chatStore";
import { activeRunnerProcesses } from "./mainRuntime";
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

export function worktreeRootForRepo(repoRoot: string): string {
  const resolved = path.resolve(repoRoot);
  return path.join(appPaths.worktreesDirectory(app.getPath("userData")), `${slugify(path.basename(resolved))}-${shortHash(resolved.toLowerCase())}`);
}

export function umbraticWorktreesRoot(): string {
  return appPaths.worktreesDirectory(app.getPath("userData"));
}

export function directoryIsEmpty(directory: string): boolean {
  try {
    return fs.readdirSync(directory).length === 0;
  } catch {
    return false;
  }
}

export function removeEmptyDirectory(directory: string): boolean {
  try {
    fs.rmdirSync(directory);
    return !fs.existsSync(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return false;
    return false;
  }
}

export function cleanupEmptyUmbraticWorktreeDirectories(task: TaskRecord) {
  const worktreesRoot = umbraticWorktreesRoot();
  const repoWorktreeRoot = worktreeRootForRepo(task.originalRepoPath);
  if (!pathInside(worktreesRoot, repoWorktreeRoot) || !pathInside(repoWorktreeRoot, task.worktreePath)) return;
  if (fs.existsSync(task.worktreePath) && directoryIsEmpty(task.worktreePath)) {
    removeEmptyDirectory(task.worktreePath);
  }
  removeEmptyDirectory(repoWorktreeRoot);
}

export async function removeGitWorktree(task: TaskRecord) {
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

export function taskMetadataPath(task: TaskRecord): string {
  return path.join(appPaths.taskMetadataDirectory(app.getPath("userData")), `${task.id}.json`);
}

export function taskUsesIsolatedWorktree(task: TaskRecord): boolean {
  return task.workspaceKind === "git" && task.workspaceMode === "worktree" && !!task.agentBranch;
}

export function taskCanHostWorktreeChats(task: TaskRecord): boolean {
  return (
    taskUsesIsolatedWorktree(task) &&
    task.state !== "merged" &&
    task.state !== "rejected" &&
    !!task.worktreePath &&
    fs.existsSync(task.worktreePath) &&
    pathInside(worktreeRootForRepo(task.originalRepoPath), task.worktreePath)
  );
}

export function worktreeRootTaskId(task: TaskRecord): string {
  return task.worktreeRootTaskId ?? task.id;
}

export function findReusableWorktreeTask(taskIdValue?: string): TaskRecord | undefined {
  if (!taskIdValue || !/^task-[A-Za-z0-9_-]+$/.test(taskIdValue)) return undefined;
  return readTasks().find((row) => (row.id === taskIdValue || row.worktreeRootTaskId === taskIdValue) && taskCanHostWorktreeChats(row));
}

export function worktreeHasActiveRun(worktreePath: string): boolean {
  const target = pathKey(worktreePath);
  for (const task of readTasks()) {
    if (!task.worktreePath || pathKey(task.worktreePath) !== target) continue;
    if (activeRunnerProcesses.has(task.id) || task.state === "running" || task.state === "awaiting_worktree_approval" || task.state === "approving") {
      return true;
    }
  }
  return false;
}

export function assertReusableWorktreeForRepository(task: TaskRecord, repository: RepositoryInfo) {
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

export function chatWorktreeTaskId(chat?: ChatRecord): string | undefined {
  if (chat?.worktreeRootTaskId && /^task-[A-Za-z0-9_-]+$/.test(chat.worktreeRootTaskId)) {
    return chat.worktreeRootTaskId;
  }
  if (chat?.taskId && /^task-[A-Za-z0-9_-]+$/.test(chat.taskId)) {
    return chat.taskId;
  }
  return undefined;
}
