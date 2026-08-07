import { taskId } from "./chatStore";
import { activeRunnerProcesses, clearPendingPermissionsForTask, getTask, pendingRunnerPrompts, publicTask, recordProductTelemetry, saveTask } from "./mainRuntime";
import { worktreeRootForRepo } from "./worktreeOps";
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

export type TaskCheckpointView = Pick<
  TaskCheckpoint,
  "id" | "source" | "label" | "createdAt" | "state" | "pinned" | "logicalBytes"
>;

export function checkpointView(checkpoint: TaskCheckpoint): TaskCheckpointView {
  const { id, source, label, createdAt, state, pinned, logicalBytes } = checkpoint;
  return { id, source, ...(label ? { label } : {}), createdAt, state, pinned, ...(logicalBytes !== undefined ? { logicalBytes } : {}) };
}

export function checkpointEligibility(task: TaskRecord, requireIdle = true, requireActiveWorktree = true): { supported: boolean; reason?: string } {
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

export function checkpointTask(input: unknown): TaskRecord {
  if (!isRecord(input)) throw new Error("Invalid checkpoint input.");
  const task = getTask(requiredString(input.taskId, "taskId"));
  const eligibility = checkpointEligibility(task);
  if (!eligibility.supported) throw new Error(eligibility.reason);
  return task;
}

export function lifecycleDurationBucket(startedAt: number): string {
  const duration = performance.now() - startedAt;
  if (duration < 100) return "lt_100ms";
  if (duration < 500) return "100_499ms";
  if (duration < 2000) return "500_1999ms";
  return "gte_2s";
}

export function checkpointByteBucket(bytes?: number): string {
  if (!bytes || bytes < 1024) return "lt_1kib";
  if (bytes < 1024 * 1024) return "1kib_1mib";
  if (bytes < 100 * 1024 * 1024) return "1mib_100mib";
  return "gte_100mib";
}

export function listTaskCheckpoints(input: unknown): {
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

export async function createCheckpoint(input: unknown): Promise<TaskCheckpointView> {
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

export async function setCheckpointPinned(input: unknown): Promise<TaskCheckpointView> {
  const task = checkpointTask(input);
  if (!isRecord(input) || typeof input.pinned !== "boolean") throw new Error("Invalid checkpoint pin input.");
  return checkpointView(setTaskCheckpointPinned(task.id, requiredString(input.checkpointId, "checkpointId"), input.pinned));
}

export async function deleteCheckpoint(input: unknown): Promise<void> {
  const task = checkpointTask(input);
  if (!isRecord(input)) throw new Error("Invalid checkpoint delete input.");
  await removeTaskCheckpoint(task, requiredString(input.checkpointId, "checkpointId"));
  saveTask(task);
}

export async function forkCheckpoint(input: unknown): Promise<TaskInfo> {
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

export async function stopTaskForRestore(task: TaskRecord): Promise<void> {
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

export async function restoreCheckpoint(input: unknown): Promise<TaskInfo> {
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
