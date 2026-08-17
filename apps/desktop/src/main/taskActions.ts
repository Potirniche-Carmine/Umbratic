import { getPermissionMode } from "./mainRuntime";
import { assertReusableWorktreeForRepository, chatWorktreeTaskId, findReusableWorktreeTask, taskUsesIsolatedWorktree, worktreeRootTaskId } from "./worktreeOps";
import { chatId, createChat, hiddenChatRepository, hiddenChatWorkspacePath, taskId } from "./chatStore";
import { activeRunnerProcesses, activeStartTaskRequests, appendUserMessage, clearPendingPermissionsForTask, emit, getTask, missingSnapshotValue, pendingRunnerPrompts, pendingTaskCancelWaits, pendingTaskFollowUps, pendingTaskSteers, publicTask, recentStartTaskRequests, recordProductTelemetry, runnerGracefulCancelDeadlineMs, saveTask } from "./mainRuntime";
import { capabilityNeedsForPrompt, runnerPromptForTask } from "./taskPromptContext";
import { inspectRepository } from "./repositoryOps";
import { refreshReview } from "./reviewFiles";
import { createWorktreeAndRunRunner, runRunnerTask } from "./taskRunner";
import { isBinarySnapshotValue, sanitizeAttachments, snapshotFolder } from "./workspaceSnapshot";
import { worktreeRootForRepo } from "./worktreeOps";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { chatTitleFromFirstMessage } from "../shared/chatTitle";

import {
  capabilityTelemetrySnapshot,
  probeLocalCapabilities,
} from "./capabilities";
import {
  runnerRequest,
  runnerBinaryPath,
  stopRunnerProcess,
} from "./runnerAdapter";
import { remoteCapabilityReport } from "./remoteHost";
import { validatedRemoteDirectory } from "./remoteConnections";
import { checkRemoteRunnerReady } from "./remoteRunner";
import {
  umbraticPolicyVersion,
  umbraticRunnerName,
  umbraticRunnerVersion,
  isGeneratedRuntimePath,
} from "./policy";
import {
  readChats,
  readContextLengthSetting,
  readModelEndpointSettings,
  readProjects,
  readTask,
} from "./storage";
import { readToolSettings } from "./settingsStorage";
import { enabledToolsFromSettings, normalizeEnabledTools } from "./toolSettings";
import type {
  ChatAttachment,
  ChatRecord,
  RepositoryInfo,
  TaskInfo,
  TaskRecord,
  TaskRemote,
  WorkspaceMode,
} from "./types";
import { hasSymlinkComponent, isRecord, pathInside, requiredString, slugify } from "./utils";
import { isResponseFeedbackReason, removeResponseFeedback } from "../shared/taskEvents";
import {
  assertFolderUndoBaseline,
  restoreTurnCheckpointFile,
  UNDO_UNSAFE_NO_CHECKPOINT,
} from "./checkpoints/service";

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
    remoteConnectionId: typeof input.remoteConnectionId === "string" ? input.remoteConnectionId.trim() : "",
    remoteDirectory: typeof input.remoteDirectory === "string" ? input.remoteDirectory.trim() : "",
    worktreeTaskId: typeof input.worktreeTaskId === "string" ? input.worktreeTaskId.trim() : "",
    prompt: typeof input.prompt === "string" ? input.prompt.trim() : "",
    attachedFiles,
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

/**
 * Resolves the remote host a run was asked for, refusing early if that host
 * cannot host it. A run that would fail after the chat has already accepted the
 * message reads as a broken app; a refusal here reads as a setting to fix.
 */
async function requestedTaskRemote(input: Record<string, unknown>): Promise<TaskRemote | undefined> {
  const connectionId = typeof input.remoteConnectionId === "string" ? input.remoteConnectionId.trim() : "";
  if (!connectionId) return undefined;
  const readiness = await checkRemoteRunnerReady(connectionId);
  if (!readiness.ok) throw new Error(readiness.message);
  const connection = readiness.connection;
  const directory = validatedRemoteDirectory(
    typeof input.remoteDirectory === "string" && input.remoteDirectory.trim()
      ? input.remoteDirectory
      : connection.defaultDirectory,
  );
  return { connectionId: connection.id, name: connection.name, host: connection.host, directory };
}

export async function startTaskOnce(input: Record<string, unknown>): Promise<TaskInfo> {
  const remote = await requestedTaskRemote(input);
  // A remote run has no local project. Its local identity is the same private
  // scratch workspace a chat without a folder gets, which is where attachments
  // land; the only path the runner ever sees is the remote directory.
  const requestedRepositoryId = remote
    ? ""
    : typeof input.repositoryId === "string" && input.repositoryId.trim() ? input.repositoryId.trim() : "";
  const prompt = requiredString(input.prompt, "prompt");
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
  const requestedEnabledTools = normalizeEnabledTools(input.enabledTools, enabledToolsFromSettings(readToolSettings()));
  const capabilityReport = remote
    ? await remoteCapabilityReport(remote.connectionId)
    : await probeLocalCapabilities({ runnerPath: runnerBinaryPath() });
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
    existingTask.remote = remote;
    if (remote) {
      existingTask.workspaceMode = "local";
      existingTask.workspaceKind = "folder";
      existingTask.worktreePath = remote.directory;
    } else if (!existingTask.agentBranch) {
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
  const worktreePath = remote
    ? remote.directory
    : shouldCreateWorktree ? path.join(worktreeRootForRepo(refreshed.rootPath), id) : refreshed.rootPath;
  const task: TaskRecord = {
    id,
    chatId: chat?.id,
    remote,
    repositoryId,
    prompt,
    workspaceKind: remote ? "folder" : refreshed.kind,
    workspaceMode: shouldCreateWorktree ? "worktree" : "local",
    modelEndpointMode,
    hiddenWorkspace,
    state: "running",
    originalBranch: refreshed.originalBranch,
    baseCommit: refreshed.baseCommit,
    agentBranch: branch,
    worktreePath,
    permissionMode: getPermissionMode(),
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

/** One file back to its pre-turn content, from the folder snapshot. */
export function restoreFolderTaskFile(task: TaskRecord, filePath: string) {
  const baseline = task.baselineFiles ?? {};
  if (isBinarySnapshotValue(baseline[filePath])) {
    throw new Error(`Undo cannot safely restore the earlier binary content of ${filePath}.`);
  }
  const absolute = path.resolve(task.worktreePath, filePath);
  if (!pathInside(task.worktreePath, absolute) || hasSymlinkComponent(task.worktreePath, absolute)) {
    throw new Error(`Refusing to restore a path outside the task folder: ${filePath}`);
  }
  if (fs.existsSync(absolute) && fs.lstatSync(absolute).isSymbolicLink()) {
    throw new Error(`Refusing to restore through a symbolic link: ${filePath}`);
  }
  // Absent from the baseline means the turn created it, and putting it back
  // means it goes away again.
  if (!Object.prototype.hasOwnProperty.call(baseline, filePath) || baseline[filePath] === missingSnapshotValue) {
    if (fs.existsSync(absolute)) fs.rmSync(absolute, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, baseline[filePath]);
}

/**
 * Undo one reviewed file, and only that file.
 *
 * There is deliberately no whole-turn counterpart: a single mis-click should
 * never be able to take back more than the file somebody was looking at, and
 * anything broader is a thing to ask the model for, where it is visible and
 * reversible.
 */
export async function revertReviewFile(input: unknown): Promise<TaskInfo | null> {
  if (!isRecord(input)) {
    throw new Error("Invalid revert input.");
  }
  const task = getTask(requiredString(input.taskId, "taskId"));
  const filePath = requiredString(input.path, "path").replace(/\\/g, "/");
  if (isGeneratedRuntimePath(filePath)) {
    throw new Error(`${filePath} is generated at runtime and is not restored by undo.`);
  }
  if (!task.reviewFiles.some((file) => file.path === filePath)) {
    throw new Error(`${filePath} is not part of this review.`);
  }
  if (taskUsesIsolatedWorktree(task)) {
    if (!fs.existsSync(task.worktreePath)) {
      throw new Error(UNDO_UNSAFE_NO_CHECKPOINT);
    }
    await restoreTurnCheckpointFile(task, filePath);
  } else {
    assertFolderUndoBaseline(task);
    restoreFolderTaskFile(task, filePath);
  }
  recordProductTelemetry("task.undone", {
    taskId: task.id,
    chatId: task.chatId,
    repositoryId: task.repositoryId,
  });
  await refreshReview(task, task.reviewScope === "worktree" ? "worktree" : "task");
  saveTask(task);
  return publicTask(task);
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
