import { taskUsesIsolatedWorktree } from "./worktreeOps";
import { emit, getTask } from "./mainRuntime";
import { worktreeRootForRepo } from "./worktreeOps";
import {
  shell,
} from "electron";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";


import {
  readProjects,
} from "./storage";
import { commandAvailable, execFileOutput } from "./processCommands";
import type { IdeInfo, IdeOpenResult } from "./types";
import { isRecord, normalizeRelativePath, pathInside, requiredString } from "./utils";
import { codeLikeIdeArgs, macCodeLikeIdeArgs } from "./ideLaunch";

export async function launchCommand(command: string, args: string[]): Promise<IdeOpenResult> {
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

// Only the ids listAvailableIdes can return. Windsurf sat here with no detection
// path, so it could never be the ideId openTaskInIde looked up.
export const commandCandidatesByIde: Record<string, string[]> = {
  code: process.platform === "win32" ? ["code.cmd", "code"] : ["code"],
};

export function macApplicationExists(appName: string): boolean {
  if (process.platform !== "darwin") {
    return false;
  }
  const appBundle = appName.endsWith(".app") ? appName : `${appName}.app`;
  return [
    path.join("/Applications", appBundle),
    path.join(os.homedir(), "Applications", appBundle),
  ].some((appPath) => fs.existsSync(appPath));
}

export function fileManagerIcon(): IdeInfo["icon"] {
  if (process.platform === "darwin") return "finder";
  if (process.platform === "win32") return "explorer";
  return "files";
}

export async function firstAvailableCommand(candidates: string[]): Promise<string | null> {
  for (const command of candidates) {
    if (await commandAvailable(command)) {
      return command;
    }
  }
  return null;
}

export async function visualStudioExecutable(): Promise<string | null> {
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

export async function listAvailableIdes(): Promise<IdeInfo[]> {
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

export async function openTaskInIde(input: unknown): Promise<IdeOpenResult> {
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
    return { ok: false, message: "Worktree path is outside Umbratic control." };
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
  const withTarget = (result: IdeOpenResult): IdeOpenResult => {
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
  return withTarget(await openPathInIde(ideId, targetPath, relativeFilePath ? "file" : "folder", task.worktreePath));
}

export async function openRepositoryInIde(input: unknown): Promise<IdeOpenResult> {
  if (!isRecord(input)) {
    throw new Error("Invalid repository IDE input.");
  }
  const ideId = requiredString(input.ideId, "ideId");
  const repositoryId = requiredString(input.repositoryId, "repositoryId");
  const project = readProjects().find((row) => row.id === repositoryId);
  if (!project) {
    return { ok: false, message: "Repository has not been selected." };
  }
  if (!fs.existsSync(project.rootPath)) {
    return { ok: false, message: "Selected folder no longer exists." };
  }
  const result = await openPathInIde(ideId, project.rootPath, "folder");
  return result;
}

export async function openPathInIde(
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
    return launchCommand("open", macCodeLikeIdeArgs(targetPath, targetKind, workspacePath));
  }
  const error = await shell.openPath(targetPath);
  return error ? { ok: false, message: error } : { ok: true };
}
