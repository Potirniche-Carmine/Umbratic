import { getPermissionMode } from "./mainRuntime";
import { resolveSelectedModel, submitSteeredRunnerTurn } from "./backendSettings";
import { chatAttachmentDirectory } from "./chatStore";
import { PendingTaskSteer, RunnerPrompt, activeRunnerProcesses, appendUserMessage, applyTaskPolicyMetadata, clearPendingPermissionsForTask, emit, failTask, getTask, pendingPermissions, pendingRunnerPrompts, pendingTaskCancelWaits, pendingTaskSteers, recordProductTelemetry, saveTask, taskStillRunning } from "./mainRuntime";
import { runnerPromptForTask, runnerPromptParts, runnerPromptText } from "./taskPromptContext";
import { refreshReview, reviewPatchHash } from "./reviewFiles";
import { prepareTaskTurnCheckpoint } from "./taskCommands";
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

export async function handleRunnerPermission(
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
    : isWorkspaceReadPermission(type)
      ? ({ commandClass: "read" as const, risky: false })
    : safetyCommandClass
      ? ({ commandClass: safetyCommandClass, risky: safety?.action !== "allow" })
      : classifyCommandText(title, task.worktreePath);

  if (isWorkspaceReadPermission(type)) {
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
    task.state = getPermissionMode() === "auto_safe" ? "running" : "awaiting_worktree_approval";
    saveTask(task);
    await replyRunnerPermission(run, id, false).catch(() => undefined);
    if (getPermissionMode() === "auto_safe") {
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

  if (canAutoResolvePermission(task.permissionMode, type, classification, typeof safety?.action === "string" ? safety.action : undefined)) {
    emit({ type: "permission.resolved", taskId: task.id, id, decision: "allow" });
    await replyRunnerPermission(run, id, true);
    return "resolved";
  }

  const request: PermissionRequest = {
    id,
    kind: type.includes("edit") ? "edit" : isWorkspaceReadPermission(type) ? "read" : "bash",
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

  pendingPermissions.set(id, {
    taskId: task.id,
    onAllow: () => replyRunnerPermission(run, id, true),
    onDeny: () => replyRunnerPermission(run, id, false),
  });
  // Persist the in-memory transcript at permission wait so a crash does not
  // lose the turn so far while the UI is parked on approval.
  saveTask(task);
  return "pending";
}

export async function runRunnerTask(
  taskIdValue: string,
  promptForRun?: RunnerPrompt,
  intentPrompt?: string,
  attachments: ChatAttachment[] = [],
) {
  const task = getTask(taskIdValue);
  let run: RunnerProcess | null = null;
  let runnerFailureDetails: { category?: string; code?: string; detail?: string } = {};
  let intent = intentPrompt ?? task.prompt;
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
      ? await refreshModelContextLength(selected, endpointProvider())
      : { ...selected, contextLength: task.model?.contextLength ?? readContextLengthSetting() };
    task.model = selectedForRun;
    applyTaskPolicyMetadata(task);
    saveTask(task);
    await prepareTaskTurnCheckpoint(task);
    let prompt = promptForRun
      ?? (await runnerPromptForTask(
        task,
        intent,
        attachments,
        selectedForRun.contextLength ?? readContextLengthSetting(),
      ));
    let promptParts = runnerPromptParts(prompt);
    run = await startUmbraticRunnerServer(
      task,
      selectedForRun,
      task.chatId ? chatAttachmentDirectory(task.chatId) : undefined,
    );
    if (readModelEndpointSettings().mode === "server") {
      const sessionToken = await ensureCompanySession(companyTransportOptions());
      await setRunnerProviderSession(run, sessionToken);
      run.providerSessionRefresh = setInterval(() => {
        void renewCompanySession(companyTransportOptions())
          .then((token) => setRunnerProviderSession(run as RunnerProcess, token))
          .catch(() => {
            if (run) stopRunnerProcess(run);
          });
      }, 8 * 60 * 1000);
      run.providerSessionRefresh.unref();
    }
    if (!taskStillRunning(task)) {
      return;
    }
    activeRunnerProcesses.set(task.id, run);
    task.diagnosticLogPath = run.diagnosticLogPath;
    saveTask(task);

    let delegatedToWorktree = false;
    let completed = false;
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: Error) => void;
    let completion!: Promise<void>;
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

    const fail = (message: string) => {
      if (completed) return;
      completed = true;
      rejectCompletion(new Error(message));
    };

    let session!: { id: string };
    const launchPendingSteer = (pending: PendingTaskSteer) => {
      appendUserMessage(task, pending.prompt, pending.attachments);
      void runnerPromptForTask(task, pending.prompt, pending.attachments,
        selectedForRun.contextLength ?? readContextLengthSetting(), { useDurableContext: true })
        .then((parts) => {
          intent = pending.prompt;
          prompt = parts;
          promptParts = parts;
          return submitSteeredRunnerTurn(run as RunnerProcess, session.id, parts, selectedForRun);
        })
        .then(() => {
          pending.resolve();
        })
        .catch((cause) => {
          const message = String(cause instanceof Error ? cause.message : cause);
          pending.reject(new Error(message));
          fail(message);
        });
    };

    const runnerEvents = new RunnerEventAdapter({
      task,
      emit,
      onPermission: (permission, safety) =>
        handleRunnerPermission(
          task,
          run as RunnerProcess,
          permission,
          prompt,
          intent,
          safety,
        ),
      onDelegated: () => {
        delegatedToWorktree = true;
      },
      onStepSettled: (conversationStateValue) => {
        const conversationState = normalizeConversationState(conversationStateValue);
        if (!conversationState || !task.chatId) {
          return;
        }
        const chat = readChat(task.chatId);
        if (chat) {
          writeChat({ ...chat, conversationState });
        }
      },
      onFinish: finish,
      onAborted: () => {
        // A steer aborts the current run to replace it; the queue dequeue event
        // launches the next turn, so the task must not settle here. A user
        // cancel ends the turn quietly with no error and no retry banner.
        if (pendingTaskSteers.has(task.id)) return;
        emit({ type: "turn.outcome", taskId: task.id, outcome: "aborted" });
        finish();
      },
      onFailure: (message, details) => {
        if (pendingTaskSteers.has(task.id)) {
          if (details) runnerFailureDetails = details;
          return;
        }
        if (details) runnerFailureDetails = details;
        fail(message);
      },
      onInvalid: (invalid) => {
        recordLocalDiagnostic({
          level: "warn",
          source: "runner",
          event: "runner.event.invalid",
          taskId: task.id,
          message: invalid.message,
          data: { code: invalid.code, type: invalid.type },
        });
      },
      onQueueUpdated: (queueEvent) => {
        if (queueEvent.disposition !== "dequeued") return;
        if (queueEvent.action !== "steer" && queueEvent.action !== "follow_up") return;
        const pending = pendingTaskSteers.get(task.id);
        if (!pending || pending.actionId !== queueEvent.actionId) return;
        pendingTaskSteers.delete(task.id);
        if (completed) armCompletion();
        launchPendingSteer(pending);
      },
    });

    const handleRunnerEvent = (event: Record<string, unknown>) => {
      if (event.type === "run.settled") {
        const cancelWait = pendingTaskCancelWaits.get(task.id);
        if (cancelWait) {
          pendingTaskCancelWaits.delete(task.id);
          cancelWait();
        }
      }
      // Always settle adapter state before launching queue work.
      runnerEvents.handle(event);
    };
    const stream = beginRunnerEventStream(run, handleRunnerEvent);
    void stream.done.catch((error) => {
      if (!run?.abortController.signal.aborted) {
        runnerEvents.failStream(
          String(error instanceof Error ? error.message : error),
        );
      }
    });
    await stream.ready;
    // Runner sessions live only inside the runner process started above.
    // Because Umbratic starts a fresh process for each task run, a persisted
    // runnerSessionId from an earlier process is stale and cannot be reused.
    let conversationState = task.chatId ? readChat(task.chatId)?.conversationState : undefined;
    try {
      session = await runnerRequest<{ id: string }>(run, "/session", {
        method: "POST",
        body: { conversationState: conversationState ?? null },
      });
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      if (!conversationState || !message.includes("invalid_conversation_state")) {
        throw error;
      }
      if (task.chatId) {
        const chat = readChat(task.chatId);
        if (chat) {
          writeChat({ ...chat, conversationState: undefined });
        }
      }
      recordLocalDiagnostic({
        level: "warn",
        source: "desktop",
        event: "conversation_state.invalid",
        message: "Persisted chat conversation state was invalid and was cleared; falling back to event history.",
        data: { taskId: task.id, chatId: task.chatId },
      });
      conversationState = undefined;
      if (!promptForRun) {
        prompt = await runnerPromptForTask(
          task,
          intent,
          attachments,
          selectedForRun.contextLength ?? readContextLengthSetting(),
          { useDurableContext: false },
        );
        promptParts = runnerPromptParts(prompt);
      }
      session = await runnerRequest<{ id: string }>(run, "/session", {
        method: "POST",
        body: { conversationState: null },
      });
    }
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
    emit({
      type: "review.ready",
      taskId: task.id,
      changedFiles: task.changedFiles,
      reviewFiles: rendererReviewFiles(reviewFiles, hiddenRendererReviewPaths(task)),
      latestTest: task.latestTest,
    });
    run.abortController.abort();
    await stream.done.catch(() => undefined);
  } catch (error) {
    failTask(task, String(error instanceof Error ? error.message : error), runnerFailureDetails);
  } finally {
    clearPendingPermissionsForTask(task.id);
    activeRunnerProcesses.delete(task.id);
    const pendingSteer = pendingTaskSteers.get(task.id);
    if (pendingSteer) {
      pendingTaskSteers.delete(task.id);
      pendingSteer.reject(new Error("The task stopped before Umbratic could steer it."));
    }
    if (run) {
      stopRunnerProcess(run);
    }
  }
}

export async function createWorktreeAndRunRunner(
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
