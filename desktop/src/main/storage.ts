import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  defaultEndpointApiKey,
  defaultEndpointBaseUrl,
  defaultEndpointBaseUrlForSoftware,
  defaultEndpointModelId,
  defaultEndpointSoftware,
  endpointEditingAllowed,
  isModelEndpointMode,
  isModelEndpointSoftware,
  managedModelEndpointDefaults,
} from "./config";
import { isLocalhostUrl, umbraticPolicyVersion, umbraticRunnerName, umbraticRunnerVersion, runtimeProfileForPrompt } from "./policy";
import { defaultToolSettings, enabledToolsFromSettings, isRunnerToolId, toolSettingsFromEnabledTools } from "./toolSettings";
import type { ChatRecord, LocalProviderId, ModelEndpointMode, ModelEndpointSettings, RepositoryInfo, RunnerToolId, TaskRecord, UserNotes } from "./types";

type JsonCacheEntry = {
  mtimeMs: number;
  size: number;
  value: unknown;
};

const jsonFileCache = new Map<string, JsonCacheEntry>();

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

function cloneJsonValue<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    const stats = fs.statSync(filePath);
    const cached = jsonFileCache.get(filePath);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cloneJsonValue(cached.value as T);
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
    jsonFileCache.set(filePath, {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      value: cloneJsonValue(parsed),
    });
    return parsed;
  } catch {
    jsonFileCache.delete(filePath);
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
    const stats = fs.statSync(filePath);
    jsonFileCache.set(filePath, {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      value: cloneJsonValue(value),
    });
  } catch (error) {
    jsonFileCache.delete(filePath);
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

function normalizeStoredEnabledTools(value: unknown): RunnerToolId[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<RunnerToolId>();
  for (const item of value) {
    if (isRunnerToolId(item)) seen.add(item);
  }
  return Array.from(seen);
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
      workspaceMode: task.workspaceMode === "worktree" || (typeof task.agentBranch === "string" && task.agentBranch) ? "worktree" : "local",
      reasoningMode: task.reasoningMode === "fast" ? "fast" : "reasoning",
      runnerName: typeof task.runnerName === "string" && task.runnerName ? task.runnerName : umbraticRunnerName,
      runnerVersion: typeof task.runnerVersion === "string" && task.runnerVersion ? task.runnerVersion : umbraticRunnerVersion,
      policyVersion: typeof task.policyVersion === "string" && task.policyVersion ? task.policyVersion : umbraticPolicyVersion,
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
      enabledTools: normalizeStoredEnabledTools(task.enabledTools) ?? enabledToolsFromSettings(defaultToolSettings()),
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

type RawSettings = {
  selectedModel?: { providerId?: string; modelId?: string };
  modelEndpoint?: Partial<ModelEndpointSettings>;
  tools?: Partial<Record<RunnerToolId, boolean>>;
};

function defaultModelEndpointMode(): ModelEndpointMode {
  return isLocalhostUrl(defaultEndpointBaseUrl) ? "local" : "server";
}

export function hasStoredModelEndpointSettings(): boolean {
  const settings = readJsonFile<RawSettings>(settingsPath(), {});
  return !!settings.modelEndpoint;
}

export function readModelEndpointSettings(): ModelEndpointSettings {
  const settings = readJsonFile<RawSettings>(settingsPath(), {});
  const endpoint = settings.modelEndpoint ?? {};
  const managed = managedModelEndpointDefaults();
  const mode =
    managed?.mode ??
    (endpoint.mode === "local" || endpoint.mode === "server" ? endpoint.mode : defaultModelEndpointMode());
  const managedBaseUrl = managed?.baseUrl;
  const managedSoftware = managed?.software;
  const storedBaseUrl = typeof endpoint.baseUrl === "string" && endpoint.baseUrl.trim() ? endpoint.baseUrl.trim() : undefined;
  const storedModelId = typeof endpoint.modelId === "string" && endpoint.modelId.trim() ? endpoint.modelId.trim() : undefined;
  const software =
    managedSoftware ?? (isModelEndpointSoftware(endpoint.software) ? endpoint.software : defaultEndpointSoftware(mode, managedBaseUrl ?? storedBaseUrl));
  return {
    mode,
    software,
    baseUrl: managedBaseUrl ?? storedBaseUrl ?? defaultEndpointBaseUrlForSoftware(mode, software),
    modelId: managed?.modelId ?? storedModelId ?? defaultEndpointModelId,
    secret: managed?.secret ?? (typeof endpoint.secret === "string" ? endpoint.secret : mode === "local" ? "" : defaultEndpointApiKey),
  };
}

export function writeModelEndpointSettings(input: Partial<ModelEndpointSettings>): ModelEndpointSettings {
  const current = readModelEndpointSettings();
  const managed = managedModelEndpointDefaults();
  const hasManagedEndpoint = !!(managed?.baseUrl || managed?.mode || managed?.software);
  const canEditEndpoint = endpointEditingAllowed() && !hasManagedEndpoint;
  const nextMode = canEditEndpoint && isModelEndpointMode(input.mode) ? input.mode : current.mode;
  const nextSoftware = isModelEndpointSoftware(input.software)
    ? canEditEndpoint
      ? input.software
      : current.software
    : current.mode === nextMode
      ? current.software
      : defaultEndpointSoftware(nextMode);
  const next: ModelEndpointSettings = {
    mode: nextMode,
    software: nextSoftware,
    baseUrl:
      !canEditEndpoint
        ? current.baseUrl
        : typeof input.baseUrl === "string" && input.baseUrl.trim()
          ? input.baseUrl.trim()
          : defaultEndpointBaseUrlForSoftware(nextMode, nextSoftware),
    modelId: managed?.modelId ?? (typeof input.modelId === "string" ? input.modelId.trim() : current.modelId),
    secret: managed?.secret ?? (typeof input.secret === "string" ? input.secret : nextMode === "local" ? "" : current.secret),
  };
  const settings = readJsonFile<RawSettings>(settingsPath(), {});
  writeJsonFile(settingsPath(), {
    ...settings,
    selectedModel: { providerId: "company-endpoint", modelId: next.modelId },
    modelEndpoint: next,
  });
  return next;
}

export function readToolSettings(): Record<RunnerToolId, boolean> {
  const settings = readJsonFile<RawSettings>(settingsPath(), {});
  const rawTools = settings.tools && typeof settings.tools === "object" ? settings.tools : {};
  return {
    ...defaultToolSettings(),
    ...Object.fromEntries(
      Object.entries(rawTools).filter(([id, value]) => isRunnerToolId(id) && typeof value === "boolean"),
    ),
  } as Record<RunnerToolId, boolean>;
}

export function writeToolSettings(input: Partial<Record<RunnerToolId, boolean>>): Record<RunnerToolId, boolean> {
  const current = readToolSettings();
  const sanitized: Partial<Record<RunnerToolId, boolean>> = {};
  for (const [id, value] of Object.entries(input)) {
    if (isRunnerToolId(id) && typeof value === "boolean") {
      sanitized[id] = value;
    }
  }
  const next = {
    ...current,
    ...sanitized,
  };
  const settings = readJsonFile<RawSettings>(settingsPath(), {});
  writeJsonFile(settingsPath(), {
    ...settings,
    tools: toolSettingsFromEnabledTools(enabledToolsFromSettings(next)),
  });
  return next;
}

export function readSettings(): { selectedModel?: { providerId: LocalProviderId; modelId: string }; modelEndpoint: ModelEndpointSettings } {
  const modelEndpoint = readModelEndpointSettings();
  if (modelEndpoint.modelId.trim()) {
    return { selectedModel: { providerId: "company-endpoint", modelId: modelEndpoint.modelId.trim() }, modelEndpoint };
  }
  return { modelEndpoint };
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
