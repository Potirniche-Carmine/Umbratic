import { getPermissionMode } from "./mainRuntime";
import { assertReusableWorktreeForRepository, chatWorktreeTaskId, findReusableWorktreeTask, taskUsesIsolatedWorktree, worktreeRootTaskId } from "./worktreeOps";
import { chatId, createChat, hiddenChatRepository, hiddenChatWorkspacePath, parseReasoningMode, taskId } from "./chatStore";
import { activeRunnerProcesses, activeStartTaskRequests, appendUserMessage, clearPendingPermissionsForTask, emit, failTask, getTask, missingSnapshotValue, pendingRunnerPrompts, pendingTaskCancelWaits, pendingTaskFollowUps, pendingTaskSteers, publicTask, recentStartTaskRequests, recordProductTelemetry, runnerGracefulCancelDeadlineMs, saveTask } from "./mainRuntime";
import { capabilityNeedsForPrompt, runnerPromptForTask } from "./taskPromptContext";
import { inspectRepository } from "./repositoryOps";
import { emitReviewChangedSinceReady, refreshReview } from "./reviewFiles";
import { createWorktreeAndRunRunner, runRunnerTask } from "./taskRunner";
import { isBinarySnapshotValue, readTextFileIfSafe, sanitizeAttachments, snapshotFolder } from "./workspaceSnapshot";
import { taskMetadataPath, worktreeRootForRepo } from "./worktreeOps";
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

export function closedTaskMessage(task: TaskRecord): string | undefined {
  if (task.state === "merged") {
    return taskUsesIsolatedWorktree(task)
      ? "This chat was closed after its approved merge. Start a new chat for more changes."
      : "This chat was closed after its workspace changes were approved. Start a new chat for more changes.";
  }
  return undefined;
}

export function taskUsesHiddenChatWorkspace(task: TaskRecord, chat: ChatRecord): boolean {
  return (
    task.hiddenWorkspace === true ||
    (task.repositoryId === `hidden-${chat.id}` && path.resolve(task.originalRepoPath) === hiddenChatWorkspacePath(chat.id))
  );
}

export function attachHiddenTaskToRepository(task: TaskRecord, repository: RepositoryInfo) {
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

export function startTaskRequestKey(input: Record<string, unknown>): string {
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

export function recentActiveStartTask(requestKey: string): TaskInfo | null {
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

export async function startTask(input: unknown): Promise<TaskInfo> {
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

export async function startTaskOnce(input: Record<string, unknown>): Promise<TaskInfo> {
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
  const modelEndpointMode = readModelEndpointSettings().mode;
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
    existingTask.permissionMode = getPermissionMode();
    existingTask.prompt = prompt;
    existingTask.reasoningMode = reasoningMode;
    existingTask.runnerName = umbraticRunnerName;
    existingTask.runnerVersion = umbraticRunnerVersion;
    existingTask.policyVersion = umbraticPolicyVersion;
    existingTask.modelEndpointMode = modelEndpointMode;
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
      modelEndpointMode,
      hiddenWorkspace,
      state: "running",
      originalBranch: reusableWorktreeTask.originalBranch,
      baseCommit: reusableWorktreeTask.baseCommit,
      agentBranch: reusableWorktreeTask.agentBranch,
      worktreePath: reusableWorktreeTask.worktreePath,
      permissionMode: getPermissionMode(),
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
    modelEndpointMode,
    hiddenWorkspace,
    state: "running",
    originalBranch: refreshed.originalBranch,
    baseCommit: refreshed.baseCommit,
    agentBranch: branch,
    worktreePath,
    permissionMode: getPermissionMode(),
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

export async function approveWorktreeCreation(input: unknown): Promise<void> {
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

export function secretScanText(text: string): string | null {
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

export async function approvalCheck(task: TaskRecord, name: string, run: () => Promise<string | void>): Promise<void> {
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

export async function approveTaskMerge(input: unknown): Promise<ApproveResult> {
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
      const patch = task.reviewFiles.map((file) => file.patch).join("\n");
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
      const patch = task.reviewFiles.map((file) => file.patch).join("\n");
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

export async function rejectTask(input: unknown): Promise<void> {
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
  if (cleanup && taskStatesThatCanOpen.has(task.state)) {
    if (taskUsesIsolatedWorktree(task)) {
      await restoreIsolatedWorktreeForReject(task, fs.existsSync(task.worktreePath));
      task.changedFiles = [];
      task.reviewFiles = [];
    } else {
      assertFolderRejectBaseline(task);
      restoreFolderTaskChanges(task, await refreshReview(task));
      task.changedFiles = [];
      task.reviewFiles = [];
    }
  } else if (!taskUsesIsolatedWorktree(task) && cleanup) {
    assertFolderRejectBaseline(task);
    restoreFolderTaskChanges(task, await refreshReview(task));
    task.changedFiles = [];
    task.reviewFiles = [];
  }
  task.state = "rejected";
  task.rejectedAt = new Date().toISOString();
  saveTask(task);
}

export function restoreFolderTaskChanges(task: TaskRecord, reviewFiles: ReviewFile[]) {
  const baseline = task.baselineFiles ?? {};
  const unsafeBinary = reviewFiles.find((file) => isBinarySnapshotValue(baseline[file.path]));
  if (unsafeBinary) {
    throw new Error(`Undo cannot safely restore the earlier binary content of ${unsafeBinary.path}.`);
  }
  for (const file of reviewFiles) {
    if (isGeneratedRuntimePath(file.path)) {
      continue;
    }
    const absolute = path.resolve(task.worktreePath, file.path);
    if (!pathInside(task.worktreePath, absolute) || hasSymlinkComponent(task.worktreePath, absolute)) {
      throw new Error(`Refusing to restore a path outside the task folder: ${file.path}`);
    }
    try {
      if (fs.existsSync(absolute) && fs.lstatSync(absolute).isSymbolicLink()) {
        throw new Error(`Refusing to restore through a symbolic link: ${file.path}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Refusing to restore")) throw error;
    }
    if (Object.prototype.hasOwnProperty.call(baseline, file.path)) {
      if (baseline[file.path] === missingSnapshotValue) {
        if (fs.existsSync(absolute)) fs.rmSync(absolute, { force: true });
        continue;
      }
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, baseline[file.path]);
      continue;
    }
    if (fs.existsSync(absolute)) {
      fs.rmSync(absolute, { force: true });
    }
  }
}

export async function keepWorktree(input: unknown): Promise<void> {
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

export async function cancelTask(input: unknown): Promise<void> {
  if (!isRecord(input)) {
    throw new Error("Invalid cancel input.");
  }
  const task = getTask(requiredString(input.taskId, "taskId"));
  const run = activeRunnerProcesses.get(task.id);
  if (run) {
    activeRunnerProcesses.delete(task.id);
    if (run.sessionId) {
      const actionId = `cancel-${crypto.randomUUID()}`;
      const settled = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          pendingTaskCancelWaits.delete(task.id);
          resolve();
        }, runnerGracefulCancelDeadlineMs);
        pendingTaskCancelWaits.set(task.id, () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await runnerRequest<{ disposition?: string }>(run, `/session/${encodeURIComponent(run.sessionId)}/queue`, {
        method: "POST",
        body: { action: "cancel", actionId },
      }).catch(() => undefined);
      await settled;
    }
    stopRunnerProcess(run);
  }
  pendingRunnerPrompts.delete(task.id);
  pendingTaskSteers.delete(task.id);
  pendingTaskFollowUps.delete(task.id);
  clearPendingPermissionsForTask(task.id);
  // Stopping a turn is a user decision, not a failure: the transcript keeps
  // whatever streamed and ends quietly with no error message.
  task.state = "completed";
  task.error = undefined;
  saveTask(task);
  emit({ type: "assistant.done", taskId: task.id });
}

export async function steerTask(input: unknown): Promise<void> {
  if (!isRecord(input)) throw new Error("Invalid steer input.");
  const task = getTask(requiredString(input.taskId, "taskId"));
  const prompt = requiredString(input.prompt, "prompt");
  const run = activeRunnerProcesses.get(task.id);
  if (task.state !== "running" || !run?.sessionId || !task.model) {
    throw new Error("This task is not ready for steering.");
  }
  if (pendingTaskSteers.has(task.id)) {
    throw new Error("A steer message is already pending.");
  }
  const attachments = sanitizeAttachments(input.attachedFiles, task.originalRepoPath, task.chatId ?? task.id);
  const actionId = `steer-${crypto.randomUUID()}`;
  // The running turn applies the steer itself, so it has to arrive as prompt
  // parts rather than bare text. They are built now because the steer lands
  // within a step or two; a follow-up waits long enough that its context has to
  // be rebuilt at launch instead.
  const parts = await runnerPromptForTask(
    task,
    prompt,
    attachments,
    task.model.contextLength ?? readContextLengthSetting(),
    { useDurableContext: true },
  );
  pendingTaskSteers.set(task.id, { actionId, prompt, attachments });
  try {
    await runnerRequest<{ disposition?: string; reasonCode?: string | null }>(
      run,
      `/session/${encodeURIComponent(run.sessionId as string)}/queue`,
      { method: "POST", body: { action: "steer", actionId, parts } },
    );
  } catch (cause) {
    if (pendingTaskSteers.get(task.id)?.actionId === actionId) {
      pendingTaskSteers.delete(task.id);
    }
    throw new Error(String(cause instanceof Error ? cause.message : cause));
  }
  // The message is the user's the moment they send it, so it joins the
  // transcript on acceptance rather than when the turn happens to absorb it.
  appendUserMessage(task, prompt, attachments);
}

/// Queues a message to run after the current turn delivers its final answer.
/// The runner owns the ordering and the release, so a turn that aborts or fails
/// leaves the queue untouched instead of launching into a broken conversation.
export async function queueFollowUpTask(input: unknown): Promise<{ actionId: string }> {
  if (!isRecord(input)) throw new Error("Invalid follow-up input.");
  const task = getTask(requiredString(input.taskId, "taskId"));
  const prompt = requiredString(input.prompt, "prompt");
  const run = activeRunnerProcesses.get(task.id);
  if (task.state !== "running" || !run?.sessionId) {
    throw new Error("This task is not ready for queued messages.");
  }
  const attachments = sanitizeAttachments(input.attachedFiles, task.originalRepoPath, task.chatId ?? task.id);
  const actionId = `follow-${crypto.randomUUID()}`;
  const response = await runnerRequest<{ disposition?: string; reasonCode?: string | null }>(
    run,
    `/session/${encodeURIComponent(run.sessionId as string)}/queue`,
    { method: "POST", body: { action: "follow_up", actionId } },
  );
  if (response?.disposition === "rejected") {
    throw new Error(response.reasonCode === "follow_up_capacity_exceeded"
      ? "Too many queued messages. Wait for one to run before adding another."
      : "Umbratic could not queue that message.");
  }
  const queued = pendingTaskFollowUps.get(task.id) ?? [];
  queued.push({ actionId, prompt, attachments });
  pendingTaskFollowUps.set(task.id, queued);
  return { actionId };
}

/// The queued messages the runner is still holding for this task, in release
/// order. The renderer reads this rather than tracking its own copy, so a
/// message released while the window was closed or reloaded does not linger as a
/// row that will never run.
export async function listQueuedTaskPrompts(input: unknown): Promise<Array<{ actionId: string; prompt: string; attachedFiles: ChatAttachment[] }>> {
  if (!isRecord(input)) throw new Error("Invalid queued message input.");
  const task = getTask(requiredString(input.taskId, "taskId"));
  return (pendingTaskFollowUps.get(task.id) ?? []).map((item) => ({
    actionId: item.actionId,
    prompt: item.prompt,
    attachedFiles: item.attachments,
  }));
}

/// Removes one queued message. Editing a queued message drops it and enqueues
/// the replacement, so an id never refers to text the user has changed.
export async function dropQueuedTaskPrompt(input: unknown): Promise<void> {
  if (!isRecord(input)) throw new Error("Invalid queued message input.");
  const task = getTask(requiredString(input.taskId, "taskId"));
  const actionId = requiredString(input.actionId, "actionId");
  const queued = (pendingTaskFollowUps.get(task.id) ?? []).filter((item) => item.actionId !== actionId);
  if (queued.length === 0) pendingTaskFollowUps.delete(task.id);
  else pendingTaskFollowUps.set(task.id, queued);
  const run = activeRunnerProcesses.get(task.id);
  if (!run?.sessionId) return;
  await runnerRequest<void>(run, `/session/${encodeURIComponent(run.sessionId)}/queue`, {
    method: "POST",
    body: { action: "drop", actionId },
  }).catch(() => undefined);
}

export async function setResponseFeedback(input: unknown): Promise<void> {
  if (!isRecord(input)) throw new Error("Invalid response feedback input.");
  const task = getTask(requiredString(input.taskId, "taskId"));
  const messageId = requiredString(input.messageId, "messageId").slice(0, 80);
  const rating = input.rating === null || input.rating === "good" || input.rating === "bad"
    ? input.rating
    : undefined;
  if (rating === undefined) throw new Error("Invalid response feedback rating.");
  const reason = rating && isResponseFeedbackReason(rating, input.reason) ? input.reason : undefined;
  if (input.reason !== undefined && !reason) throw new Error("Invalid response feedback reason.");
  const comment = typeof input.comment === "string" ? input.comment.trim().slice(0, 1000) : "";
  if (!/^assistant-\d+$/.test(messageId)) throw new Error("Invalid response message id.");
  task.events = removeResponseFeedback(task.events, task.id, messageId);
  saveTask(task);
  if (rating === null) return;
  emit({ type: "response.feedback", taskId: task.id, messageId, rating, ...(reason ? { reason } : {}), ...(comment ? { comment } : {}) });
}
