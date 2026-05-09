import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

import { aegisPolicyVersion, aegisRunnerName, aegisRunnerVersion, runtimeProfileForPrompt } from "./policy";
import type { ChatRecord, LocalProviderId, RepositoryInfo, TaskRecord, UserNotes } from "./types";

function dataFile(name: string): string {
  return path.join(app.getPath("userData"), name);
}

function projectsPath(): string {
  return dataFile("projects.json");
}

function tasksPath(): string {
  return dataFile("tasks.json");
}

function chatsPath(): string {
  return dataFile("chats.json");
}

function settingsPath(): string {
  return dataFile("settings.json");
}

function notesPath(): string {
  return dataFile("notes.json");
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFile(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function readProjects(): RepositoryInfo[] {
  return readJsonFile<RepositoryInfo[]>(projectsPath(), [])
    .filter(
      (project) =>
        project &&
        typeof project.id === "string" &&
        typeof project.rootPath === "string" &&
        (project.kind === "git" || project.kind === "folder" || project.kind === undefined) &&
        fs.existsSync(project.rootPath),
    )
    .map((project) => ({ ...project, kind: project.kind ?? "git" }));
}

export function writeProjects(projects: RepositoryInfo[]) {
  writeJsonFile(projectsPath(), projects);
}

export function readTasks(): TaskRecord[] {
  return readJsonFile<TaskRecord[]>(tasksPath(), [])
    .filter(
      (task) =>
        task &&
        typeof task.id === "string" &&
        typeof task.originalRepoPath === "string" &&
        typeof task.worktreePath === "string",
    )
    .map((task) => ({
      ...task,
      workspaceKind: task.workspaceKind ?? "git",
      reasoningMode: task.reasoningMode === "fast" ? "fast" : "reasoning",
      runnerName: typeof task.runnerName === "string" && task.runnerName ? task.runnerName : aegisRunnerName,
      runnerVersion: typeof task.runnerVersion === "string" && task.runnerVersion ? task.runnerVersion : aegisRunnerVersion,
      policyVersion: typeof task.policyVersion === "string" && task.policyVersion ? task.policyVersion : aegisPolicyVersion,
      runtimeProfile:
        task.runtimeProfile === "python" ||
        task.runtimeProfile === "markdown" ||
        task.runtimeProfile === "cmake" ||
        task.runtimeProfile === "powershell" ||
        task.runtimeProfile === "posix-shell" ||
        task.runtimeProfile === "node" ||
        task.runtimeProfile === "none"
          ? task.runtimeProfile
          : runtimeProfileForPrompt(task.prompt ?? ""),
      reviewFiles: Array.isArray(task.reviewFiles) ? task.reviewFiles : [],
      events: Array.isArray(task.events) ? task.events : [],
    }));
}

export function writeTasks(tasks: TaskRecord[]) {
  writeJsonFile(tasksPath(), tasks);
}

export function readChats(): ChatRecord[] {
  return readJsonFile<ChatRecord[]>(chatsPath(), [])
    .filter(
      (chat) =>
        chat &&
        typeof chat.id === "string" &&
        typeof chat.title === "string" &&
        typeof chat.createdAt === "string" &&
        typeof chat.updatedAt === "string",
    )
    .map((chat) => ({
      ...chat,
      draftPrompt: typeof chat.draftPrompt === "string" ? chat.draftPrompt : "",
      attachedFiles: Array.isArray(chat.attachedFiles)
        ? chat.attachedFiles.filter((file) => file && typeof file.path === "string" && typeof file.name === "string")
        : [],
    }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function writeChats(chats: ChatRecord[]) {
  writeJsonFile(chatsPath(), chats);
}

export function readSettings(): { selectedModel?: { providerId: LocalProviderId; modelId: string } } {
  const settings = readJsonFile<{ selectedModel?: { providerId?: string; modelId?: string } }>(settingsPath(), {});
  const modelId = settings.selectedModel?.modelId;
  if (typeof modelId === "string" && modelId.trim()) {
    return { selectedModel: { providerId: "local-endpoint", modelId: modelId.trim() } };
  }
  return {};
}

export function readNotes(): UserNotes {
  const notes = readJsonFile<{ content?: unknown; updatedAt?: unknown }>(notesPath(), {});
  return {
    content: typeof notes.content === "string" ? notes.content : "",
    updatedAt: typeof notes.updatedAt === "string" ? notes.updatedAt : "",
  };
}

export function writeNotes(content: string): UserNotes {
  const notes = {
    content,
    updatedAt: new Date().toISOString(),
  };
  writeJsonFile(notesPath(), notes);
  return notes;
}
