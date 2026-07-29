import type { App } from "electron";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const productDirectoryName = "Umbratic";

export function defaultDesktopDataRoot(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA?.trim()
      || path.join(homeDirectory, "AppData", "Local");
    return path.join(localAppData, productDirectoryName);
  }
  if (platform === "darwin") {
    return path.join(homeDirectory, "Library", "Application Support", productDirectoryName);
  }
  const dataHome = environment.XDG_DATA_HOME?.trim()
    || path.join(homeDirectory, ".local", "share");
  return path.join(dataHome, productDirectoryName);
}

export function configureDesktopAppPaths(
  targetApp: Pick<App, "setAppLogsPath" | "setPath">,
  dataRoot: string,
): void {
  fs.mkdirSync(dataRoot, { recursive: true });
  targetApp.setPath("userData", dataRoot);
  targetApp.setPath("sessionData", electronSessionDirectory(dataRoot));
  targetApp.setPath("crashDumps", crashDumpsDirectory(dataRoot));
  targetApp.setAppLogsPath(electronLogsDirectory(dataRoot));
}

export function stateDirectory(dataRoot: string): string {
  return path.join(dataRoot, "state");
}

export function appDatabaseFile(dataRoot: string): string {
  return path.join(stateDirectory(dataRoot), "umbratic.sqlite");
}

export function chatsDatabaseFile(dataRoot: string): string {
  return path.join(stateDirectory(dataRoot), "chats.sqlite");
}

export function taskMetadataDirectory(dataRoot: string): string {
  return path.join(stateDirectory(dataRoot), "task-metadata");
}

export function chatAttachmentsDirectory(dataRoot: string): string {
  return path.join(dataRoot, "attachments", "chats");
}

export function skillsDirectory(dataRoot: string): string {
  return path.join(dataRoot, "skills");
}

export function scratchWorkspacesDirectory(dataRoot: string): string {
  return path.join(dataRoot, "workspaces", "scratch");
}

export function worktreesDirectory(dataRoot: string): string {
  return path.join(dataRoot, "worktrees");
}

export function runtimesDirectory(dataRoot: string): string {
  return path.join(dataRoot, "runtimes");
}

function workspaceStorageKey(workspacePath: string): string {
  const normalized = path.resolve(workspacePath);
  const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 20);
}

export function workspaceRuntimeDirectory(dataRoot: string, workspacePath: string): string {
  return path.join(runtimesDirectory(dataRoot), workspaceStorageKey(workspacePath));
}

export function workspaceOcrDirectory(dataRoot: string, workspacePath: string): string {
  return path.join(dataRoot, "artifacts", "ocr", workspaceStorageKey(workspacePath));
}

export function electronSessionDirectory(dataRoot: string): string {
  return path.join(dataRoot, "cache", "electron");
}

export function electronLogsDirectory(dataRoot: string): string {
  return path.join(dataRoot, "logs", "electron");
}

export function crashDumpsDirectory(dataRoot: string): string {
  return path.join(dataRoot, "logs", "crash-dumps");
}

export function runnerLogsDirectory(dataRoot: string): string {
  return path.join(dataRoot, "logs", "runner");
}

export function telemetrySpoolDirectoryPath(dataRoot: string): string {
  return path.join(dataRoot, "telemetry", "spool");
}
