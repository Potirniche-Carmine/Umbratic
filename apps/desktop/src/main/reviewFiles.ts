import { taskUsesIsolatedWorktree } from "./worktreeOps";
import { emit, getTask, missingSnapshotValue, publicTask, saveTask } from "./mainRuntime";
import { buildBinaryDiff, buildSnapshotDiff } from "./taskPromptContext";
import { readTextFileIfSafe, snapshotFileValue, snapshotFolder } from "./workspaceSnapshot";
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

export async function getChangedFiles(worktreePath: string, baseCommit: string): Promise<string[]> {
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

export function folderReviewFiles(task: TaskRecord): ReviewFile[] {
  const before = task.baselineFiles ?? {};
  const after = snapshotFolder(task.worktreePath);
  const paths = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
    .filter((file) => !isGeneratedRuntimePath(file))
    .sort((a, b) => a.localeCompare(b));
  return paths
    .map((file) => buildSnapshotDiff(file, before[file] ?? null, after[file] ?? null))
    .filter((file): file is ReviewFile => !!file);
}

export async function gitWorkspaceReviewFiles(repositoryPath: string, baseline: string): Promise<ReviewFile[]> {
  const changed = (await getChangedFiles(repositoryPath, baseline))
    .filter((file) => !isGeneratedRuntimePath(file))
    .sort((a, b) => a.localeCompare(b));
  const files: ReviewFile[] = [];
  for (const file of changed) {
    const review = await gitWorkspaceReviewFile(repositoryPath, baseline, file);
    if (review) files.push(review);
  }
  return files;
}

export async function gitWorkspaceReviewFile(repositoryPath: string, baseline: string, file: string): Promise<ReviewFile | null> {
  const absolute = path.join(repositoryPath, file);
  const status = await gitFileStatus(repositoryPath, baseline, file);
  const diff = await gitOutput(repositoryPath, ["diff", "--no-ext-diff", "--binary", "--find-renames", "--find-copies", `--unified=${reviewContextLines}`, baseline, "--", file]).catch(
    () => "",
  );
  if (diff.trim()) return normalizeReviewFile({ path: file, status, patch: diff });
  const text = readTextFileIfSafe(absolute);
  if (text !== null) return buildTextDiff(file, null, text);
  return buildBinaryDiff(
    file,
    status === "added" ? null : "before",
    status === "deleted" ? null : "after",
  );
}

export async function gitLocalReviewFiles(task: TaskRecord): Promise<ReviewFile[]> {
  const baselineFiles = task.baselineFiles ?? {};
  const baselinePaths = new Set(Object.keys(baselineFiles));
  const currentPaths = await getChangedFiles(task.worktreePath, task.baseCommit);
  const paths = Array.from(new Set([...baselinePaths, ...currentPaths]))
    .filter((file) => !isGeneratedRuntimePath(file))
    .sort((left, right) => left.localeCompare(right));
  const files: ReviewFile[] = [];
  for (const file of paths) {
    let review: ReviewFile | null;
    if (baselinePaths.has(file)) {
      const beforeValue = baselineFiles[file];
      const afterValue = snapshotFileValue(path.join(task.worktreePath, file));
      review = buildSnapshotDiff(
        file,
        beforeValue === missingSnapshotValue ? null : beforeValue,
        afterValue === missingSnapshotValue ? null : afterValue,
      );
    } else {
      review = await gitWorkspaceReviewFile(task.worktreePath, task.baseCommit, file);
    }
    if (review) files.push(review);
  }
  return files;
}

export async function gitReviewFiles(task: TaskRecord, baseline = task.baseCommit, repositoryPath = task.worktreePath): Promise<ReviewFile[]> {
  if (task.baselineFiles && baseline !== "HEAD") {
    return task.workspaceKind === "git" ? gitLocalReviewFiles(task) : folderReviewFiles(task);
  }
  return gitWorkspaceReviewFiles(repositoryPath, baseline);
}

export async function gitFileStatus(repositoryPath: string, baseline: string, file: string): Promise<ReviewFile["status"]> {
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

export async function refreshReview(
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
  const reviewFiles = discoveredReviewFiles;
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

export function reviewPatchHash(reviewFiles: ReviewFile[]): string {
  const normalized = reviewFiles
    .map((file) => `${file.path}\0${file.status}\0${file.patch}`)
    .sort()
    .join("\0");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

export function emitReviewChangedSinceReady(task: TaskRecord, reviewFiles: ReviewFile[]) {
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

export async function refreshTaskReview(input: unknown): Promise<TaskInfo | null> {
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

export async function refreshWorkspaceReview(input: unknown): Promise<{ reviewFiles: ReviewFile[]; baselineOid: string }> {
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
