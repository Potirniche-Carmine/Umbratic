import { emit, pendingPermissions, saveTask } from "./mainRuntime";
import { getChangedFiles } from "./reviewFiles";
import { snapshotFolder, snapshotSelectedFiles } from "./workspaceSnapshot";
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";


import {
  classifyCommandText,
} from "./policy";
import type { CommandResult, PermissionRequest, TaskRecord } from "./types";
import { commandText, isRecord, requiredString } from "./utils";
import {
  createTurnCheckpoint,
} from "./checkpoints/service";

export function requiresElevatedPermissionsApproval(classification: ReturnType<typeof classifyCommandText>): boolean {
  return classification.risky;
}

export async function askPermission(
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

export async function respondToToolPermission(input: unknown) {
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

export async function prepareTaskTurnCheckpoint(task: TaskRecord): Promise<void> {
  // A remote task's workspace is on another machine. There is nothing here to
  // snapshot, and snapshotting the local stand-in would describe a folder the
  // run never touches.
  if (task.remote) {
    task.baselineFiles = undefined;
    task.turnCheckpointId = undefined;
    saveTask(task);
    return;
  }
  const rootPath = fs.existsSync(task.worktreePath) ? task.worktreePath : task.originalRepoPath;
  task.baselineFiles = task.workspaceKind === "git"
    ? snapshotSelectedFiles(rootPath, await getChangedFiles(rootPath, task.baseCommit))
    : snapshotFolder(rootPath);
  task.turnCheckpointId = undefined;
  task.undoFileHashes = undefined;
  if (task.workspaceKind === "git") {
    await createTurnCheckpoint(task);
  }
  saveTask(task);
}

export async function runCommandForTask(
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
      stdout = `${stdout}${text}`.slice(-16_384);
      emit({ type: "command.output", taskId: task.id, id, stream: "stdout", text });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr = `${stderr}${text}`.slice(-16_384);
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
