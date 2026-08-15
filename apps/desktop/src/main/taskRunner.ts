import { getPermissionMode } from "./mainRuntime";
import { resolveSelectedModel, submitSteeredRunnerTurn } from "./backendSettings";
import { chatAttachmentDirectory } from "./chatStore";
import { PendingTaskPrompt, RunnerPrompt, activeRunnerProcesses, appendUserMessage, applyTaskPolicyMetadata, clearPendingPermissionsForTask, emit, failTask, getTask, pendingPermissions, pendingRunnerPrompts, pendingTaskCancelWaits, pendingTaskFollowUps, pendingTaskSteers, recordProductTelemetry, saveTask, taskStillRunning } from "./mainRuntime";
import { runnerPromptForTask, runnerPromptParts, runnerPromptText } from "./taskPromptContext";
import { refreshWorkspaceGraph } from "./indexerService";
import { refreshReview, reviewPatchHash } from "./reviewFiles";
import { prioritizedReviewFiles } from "./reviewInsights";
import { prepareTaskTurnCheckpoint } from "./taskCommands";
import { worktreeRootForRepo } from "./worktreeOps";
import * as fs from "node:fs";
import * as path from "node:path";


import {
  beginRunnerEventStream,
  runnerRequest,
  replyRunnerPermission,
  setRunnerProviderSession,
  startUmbraticRunnerServer,
  stopRunnerProcess,
} from "./runnerAdapter";
import { startRemoteRunnerServer } from "./remoteRunner";
import {
  canAutoResolvePermission,
  classifyCommandText,
  isWorkspaceReadPermission,
} from "./policy";
import {
  ensureCompanySession,
  renewCompanySession,
} from "./companyIdentity";
import { companyTransportOptions, endpointProvider } from "./endpointConfig";
import {
  readChat,
  readContextLengthSetting,
  readModelEndpointSettings,
  writeChat,
  normalizeConversationState,
} from "./storage";
import { recordLocalDiagnostic } from "./diagnostics";
import { modelWithFreshContextLength as refreshModelContextLength } from "./modelEndpointRuntime";
import { execFileOutput } from "./processCommands";
import { RunnerEventAdapter } from "./runnerEventAdapter";
import type { ChatAttachment, CommandClass, RunnerProcess, PermissionRequest, TaskRecord } from "./types";
import { isRecord, slugify } from "./utils";
import {
  hiddenRendererReviewPaths,
  rendererReviewFiles,
} from "./taskReviewPresentation";


/// Removes and returns a queued message the runner just released. A steer that
/// outlives its run arrives here too: the running turn never reached a step
/// boundary to absorb it, so it becomes the next turn instead of being lost.
function takeQueuedPrompt(taskId: string, actionId: string): PendingTaskPrompt | undefined {
  const steer = pendingTaskSteers.get(taskId);
  if (steer?.actionId === actionId) {
    pendingTaskSteers.delete(taskId);
    return steer;
  }
  const queued = pendingTaskFollowUps.get(taskId) ?? [];
  const index = queued.findIndex((item) => item.actionId === actionId);
  if (index < 0) return undefined;
  const [released] = queued.splice(index, 1);
  if (queued.length === 0) pendingTaskFollowUps.delete(taskId);
  return released;
}

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
    // Sending a prompt is the explicit ask to use the model: load it if it is
    // not already up.
    const { providers, selected } = await resolveSelectedModel("always");
    if (!taskStillRunning(task)) {
      return;
    }
    if (!selected) {
      failTask(task, providers[0]?.message ?? "Veil health check is not ready.");
      return;
    }
    // Every run re-probes: the context length is Veil's to report, and a stale
    // one silently changes how much history a turn can carry.
    const selectedForRun = await refreshModelContextLength(selected, endpointProvider());
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
    run = task.remote
      ? await startRemoteRunnerServer(task, selectedForRun)
      : await startUmbraticRunnerServer(
          task,
          selectedForRun,
          task.chatId ? chatAttachmentDirectory(task.chatId) : undefined,
        );
    // Register the moment the process exists. Session setup below awaits the
    // network, and anything that happened in that window — a cancel, a model
    // settings change — used to act as if no run were in flight, because the
    // registry did not know about this one yet.
    activeRunnerProcesses.set(task.id, run);
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
      // Rejections are observed even when no wait is active. A queued turn
      // failing right as the task tears down used to reject a promise nobody
      // awaited, which surfaced as an UnhandledPromiseRejectionWarning instead
      // of an error the catch below could route to failTask.
      void completion.catch(() => undefined);
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
    // Starts a released queued message as its own turn. Its prompt context is
    // built here rather than when the message was queued, because the workspace
    // preview, capability probe, and attachment staging describe the moment the
    // turn begins, not the moment the user typed.
    const launchQueuedPrompt = (pending: PendingTaskPrompt) => {
      appendUserMessage(task, pending.prompt, pending.attachments);
      void runnerPromptForTask(task, pending.prompt, pending.attachments,
        selectedForRun.contextLength ?? readContextLengthSetting(), { useDurableContext: true })
        .then((parts) => {
          intent = pending.prompt;
          prompt = parts;
          promptParts = parts;
          return submitSteeredRunnerTurn(run as RunnerProcess, session.id, parts, selectedForRun);
        })
        .catch((cause) => {
          fail(String(cause instanceof Error ? cause.message : cause));
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
        // A steer no longer aborts, so an abort here is always a real stop: the
        // turn ends quietly with no error and no retry banner.
        emit({ type: "turn.outcome", taskId: task.id, outcome: "aborted" });
        finish();
      },
      onFailure: (message, details) => {
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
        // "applied" means the running turn already absorbed the steer at a step
        // boundary; the conversation has it and there is nothing to launch.
        if (queueEvent.disposition === "applied") {
          if (pendingTaskSteers.get(task.id)?.actionId === queueEvent.actionId) {
            pendingTaskSteers.delete(task.id);
          }
          return;
        }
        // "dequeued" only ever follows a turn that answered, so this is the
        // queued message becoming the next turn.
        if (queueEvent.disposition !== "dequeued") return;
        const released = takeQueuedPrompt(task.id, queueEvent.actionId);
        if (!released) return;
        if (completed) armCompletion();
        launchQueuedPrompt(released);
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
    // A turn that answered can be followed straight away by a queued message
    // the runner releases as the next turn. The wait has to drain that queue:
    // tearing down after the first completion killed the queued turn mid-launch
    // — its requests aborted against a stopped runner, the re-armed completion
    // rejected with no awaiter, and the queued message was silently lost.
    // Owning the re-arm here (completed is reset before awaiting again) also
    // closes the race where the release event lands after this line.
    while (
      !run.abortController.signal.aborted
      && taskStillRunning(task)
      && (!completed || pendingTaskFollowUps.has(task.id))
    ) {
      if (completed) armCompletion();
      await waitForCompletion();
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
    // Between-turn reindex, then insights for exactly this diff, both awaited
    // so the panel's first render is already ordered. Each degrades to absence
    // rather than throwing when the indexer is missing, which leaves the panel
    // on today's path ordering.
    await refreshWorkspaceGraph(task.worktreePath);
    const orderedReviewFiles = await prioritizedReviewFiles(
      task.worktreePath,
      task.baseCommit,
      task.reviewPatchHash,
      reviewFiles,
    );
    emit({ type: "assistant.done", taskId: task.id });
    emit({
      type: "review.ready",
      taskId: task.id,
      changedFiles: task.changedFiles,
      reviewFiles: rendererReviewFiles(orderedReviewFiles, hiddenRendererReviewPaths(task)),
      latestTest: task.latestTest,
    });
    run.abortController.abort();
    await stream.done.catch(() => undefined);
  } catch (error) {
    failTask(task, String(error instanceof Error ? error.message : error), runnerFailureDetails);
  } finally {
    clearPendingPermissionsForTask(task.id);
    activeRunnerProcesses.delete(task.id);
    pendingTaskSteers.delete(task.id);
    pendingTaskFollowUps.delete(task.id);
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
