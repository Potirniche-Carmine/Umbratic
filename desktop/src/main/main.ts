import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  IpcMainInvokeEvent,
  Menu,
  MenuItemConstructorOptions,
  OpenDialogOptions,
  shell,
  session,
} from "electron";
import { execFile, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  defaultDisabledProviders,
  localProviderCatalog,
  preferredModelHints,
  pythonRuntimeSystemPrompt,
  reasoningSystemPrompt,
  taskStatesThatCanOpen,
} from "./config";
import {
  beginOpenCodeEventStream,
  eventSessionId,
  openCodeErrorMessage,
  openCodePermissionSummary,
  openCodePermissionType,
  openCodeRequest,
  openCodeToolCommand,
  opencodeBinaryPath,
  replyOpenCodePermission,
  startOpenCodeServer,
  stopOpenCodeRun,
} from "./opencodeHarness";
import {
  readChats,
  readProjects,
  readSettings,
  readTasks,
  writeChats,
  writeJsonFile,
  writeProjects,
  writeSelectedModel,
  writeTasks,
} from "./storage";
import type {
  ApproveResult,
  BackendStatus,
  BackendUiEvent,
  ChatAttachment,
  ChatRecord,
  CommandOutput,
  CommandResult,
  FileSearchResult,
  IdeInfo,
  IdeOpenResult,
  LocalModelInfo,
  LocalModelProvider,
  OpenCodeRun,
  PendingPermission,
  PermissionMode,
  PermissionRequest,
  ReasoningMode,
  RepositoryInfo,
  ReviewFile,
  TaskInfo,
  TaskRecord,
  TaskState,
  WorkspaceKind,
} from "./types";
import { commandText, isRecord, normalizeRelativePath, pathInside, requiredString, shortHash, slugify } from "./utils";

const isDev = !app.isPackaged;
const activeOpenCodeRuns = new Map<string, OpenCodeRun>();

function clearPendingPermissionsForTask(taskIdValue: string) {
  for (const [id, pending] of Array.from(pendingPermissions.entries())) {
    if (pending.taskId !== taskIdValue) continue;
    pendingPermissions.delete(id);
    emit({ type: "permission.resolved", taskId: taskIdValue, id, decision: "deny" });
    void Promise.resolve(pending.onDeny()).catch(() => undefined);
  }
}

app.enableSandbox();
app.setName("Aegis");

const cleanUserData = path.join(app.getPath("appData"), "Aegis");
try {
  fs.mkdirSync(cleanUserData, { recursive: true });
  app.setPath("userData", cleanUserData);
} catch {
  /* Electron will use the default userData path. */
}

let mainWindow: BrowserWindow | null = null;
let permissionMode: PermissionMode = "normal";
const pendingPermissions = new Map<string, PendingPermission>();

function finishInterruptedRunningTasks() {
  const now = new Date().toISOString();
  const tasks = readTasks();
  let changed = false;
  const repaired = tasks.map((task) => {
    if (task.state !== "running") return task;
    const events = Array.isArray(task.events) ? [...task.events] : [];
    const started = events.filter((event) => event.type === "command.started");
    const finished = new Set(events.filter((event) => event.type === "command.finished").map((event) => event.id));
    for (const event of started) {
      if (finished.has(event.id)) continue;
      events.push({ type: "command.finished", taskId: task.id, id: event.id, exitCode: null });
      changed = true;
    }
    changed = true;
    return {
      ...task,
      state: "failed" as const,
      error: "Task was interrupted before OpenCode finished.",
      events: [
        ...events,
        {
          type: "task.error" as const,
          taskId: task.id,
          message: "Task was interrupted before OpenCode finished.",
        },
      ].slice(-500),
      latestTest: task.latestTest ?? {
        command: "opencode session",
        output: "Task was interrupted before OpenCode finished.",
        passed: false,
        exitCode: null,
        completedAt: now,
      },
    };
  });
  if (changed) {
    writeTasks(repaired);
  }
}

function saveChat(chat: ChatRecord) {
  const chats = [chat, ...readChats().filter((row) => row.id !== chat.id)];
  writeChats(chats);
}

function isReviewReadyAssistantEvent(event: BackendUiEvent): boolean {
  return event.type === "assistant.delta" && event.text.trim() === "Ready for review.";
}

function visibleTaskEvents(events: BackendUiEvent[]): BackendUiEvent[] {
  return events.filter((event) => !isReviewReadyAssistantEvent(event));
}

function appendTaskEvent(events: BackendUiEvent[], event: BackendUiEvent, limit: number): BackendUiEvent[] {
  const existing = visibleTaskEvents(events);
  const last = existing.at(-1);
  if (
    last &&
    (event.type === "assistant.delta" || event.type === "assistant.reasoning.delta") &&
    last.type === event.type &&
    last.taskId === event.taskId
  ) {
    return [
      ...existing.slice(0, -1),
      {
        ...last,
        text: `${last.text}${event.text}`,
        endedAt: event.endedAt ?? event.at ?? last.endedAt ?? last.at,
      },
    ].slice(-limit);
  }
  if (
    last &&
    event.type === "command.output" &&
    last.type === "command.output" &&
    last.taskId === event.taskId &&
    last.id === event.id &&
    last.stream === event.stream
  ) {
    return [
      ...existing.slice(0, -1),
      {
        ...last,
        text: `${last.text}${event.text}`,
        endedAt: event.endedAt ?? event.at ?? last.endedAt ?? last.at,
      },
    ].slice(-limit);
  }
  return [...existing, event].slice(-limit);
}

function compactTaskEvents(events: BackendUiEvent[], limit: number): BackendUiEvent[] {
  return events.reduce<BackendUiEvent[]>((current, event) => appendTaskEvent(current, event, limit), []);
}

function saveTask(task: TaskRecord) {
  const existingTasks = readTasks();
  const existing = existingTasks.find((row) => row.id === task.id);
  const taskEvents = compactTaskEvents(Array.isArray(task.events) ? task.events : [], 500);
  const existingEvents = compactTaskEvents(Array.isArray(existing?.events) ? existing.events : [], 500);
  const nextTask = {
    ...task,
    events: existingEvents.length >= taskEvents.length ? existingEvents : taskEvents,
  };
  const tasks = [nextTask, ...existingTasks.filter((row) => row.id !== task.id)];
  writeTasks(tasks);
  updateChatFromTask(nextTask);
}

function publicTask(task: TaskRecord): TaskInfo {
  const {
    id,
    chatId,
    repositoryId,
    prompt,
    workspaceKind,
    state,
    originalBranch,
    baseCommit,
    agentBranch,
    worktreePath,
    permissionMode: mode,
    reasoningMode,
    createdAt,
    changedFiles,
    reviewFiles,
    events,
    latestTest,
    patchHash,
    error,
  } = task;
  return {
    id,
    chatId,
    repositoryId,
    prompt,
    workspaceKind,
    state,
    originalBranch,
    baseCommit,
    agentBranch,
    worktreePath,
    permissionMode: mode,
    reasoningMode,
    createdAt,
    changedFiles,
    reviewFiles,
    events: compactTaskEvents(events, 500),
    latestTest,
    patchHash,
    error,
  };
}

function getTask(taskId: string): TaskRecord {
  const task = readTasks().find((row) => row.id === taskId);
  if (!task) {
    throw new Error("Task was not found.");
  }
  return task;
}

function publicTaskById(input: unknown): TaskInfo | null {
  if (!isRecord(input) || typeof input.taskId !== "string" || !input.taskId.trim()) {
    return null;
  }
  const taskIdValue = input.taskId.trim();
  const task = readTasks().find((row) => row.id === taskIdValue);
  return task ? publicTask(task) : null;
}

function stableRepositoryId(rootPath: string): string {
  return crypto.createHash("sha256").update(path.resolve(rootPath).toLowerCase()).digest("hex").slice(0, 16);
}

function hiddenChatWorkspacePath(chatIdValue: string): string {
  return path.join(os.homedir(), ".aegis", "chats", chatIdValue);
}

function hiddenChatRepository(chatIdValue: string): RepositoryInfo {
  const root = hiddenChatWorkspacePath(chatIdValue);
  fs.mkdirSync(root, { recursive: true });
  return {
    id: `hidden-${chatIdValue}`,
    name: "Unattached chat",
    rootPath: root,
    kind: "folder",
    originalBranch: "folder",
    baseCommit: crypto.createHash("sha256").update(`${root}:${Date.now()}`).digest("hex"),
    dirty: false,
    statusSummary: "hidden workspace",
  };
}

function taskId(): string {
  return `task-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

function chatId(): string {
  return `chat-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

const titleStopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "can",
  "could",
  "for",
  "i",
  "in",
  "is",
  "it",
  "let",
  "lets",
  "make",
  "my",
  "of",
  "on",
  "please",
  "should",
  "that",
  "the",
  "this",
  "to",
  "we",
  "with",
  "would",
  "you",
]);

const mutatingPromptPattern =
  /\b(add|build|change|create|delete|edit|fix|generate|implement|make|modify|patch|refactor|remove|rename|replace|scaffold|update|write)\b/i;
const codeTargetPattern =
  /\b(file|code|component|function|class|module|page|screen|route|api|test|bug|readme|docs?|scripts?|scrip|python|style|css|html|tsx?|jsx?|py|json|yaml|yml|toml|md)\b/i;

function promptLooksLikeFileChange(prompt: string): boolean {
  const text = prompt.split(/\n\s*\nAttached files:/i)[0].trim();
  if (!text) return false;
  return mutatingPromptPattern.test(text) && codeTargetPattern.test(text);
}

function promptLooksLikePythonTask(prompt: string): boolean {
  return /\b(python|\.py|pyproject|uv|venv)\b/i.test(prompt);
}

function parseReasoningMode(value: unknown): ReasoningMode {
  return value === "fast" ? "fast" : "reasoning";
}

function titleWord(word: string): string {
  if (!word) return word;
  if (word === word.toUpperCase() || word.includes("_") || word.includes("-")) return word;
  return `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}`;
}

function chatTitleFromPrompt(prompt: string): string {
  const text = prompt
    .split(/\n\s*\nAttached files:/i)[0]
    .replace(/[`*_#[\]()>.,!?;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = text.match(/[A-Za-z0-9][A-Za-z0-9'_-]*/g) ?? [];
  const summaryWords = words
    .filter((word) => !titleStopWords.has(word.toLowerCase().replace(/'s$/, "")))
    .slice(0, 5);
  const title = (summaryWords.length >= 3 ? summaryWords : words.slice(0, 5)).map(titleWord).join(" ");
  return title ? title.slice(0, 72) : "New chat";
}

function createChat(input: unknown): ChatRecord {
  const title =
    isRecord(input) && typeof input.title === "string" && input.title.trim()
      ? input.title.trim().slice(0, 72)
      : "New chat";
  const repositoryName =
    isRecord(input) && typeof input.repositoryName === "string" && input.repositoryName.trim()
      ? input.repositoryName.trim().slice(0, 120)
      : undefined;
  const repositoryPath =
    isRecord(input) && typeof input.repositoryPath === "string" && input.repositoryPath.trim()
      ? path.resolve(input.repositoryPath.trim())
      : undefined;
  const now = new Date().toISOString();
  const chat: ChatRecord = {
    id: chatId(),
    title,
    createdAt: now,
    updatedAt: now,
    repositoryName,
    repositoryPath,
    draftPrompt: "",
    attachedFiles: [],
  };
  saveChat(chat);
  return chat;
}

function updateChatDraft(input: unknown): ChatRecord {
  if (!isRecord(input)) {
    throw new Error("Invalid chat draft input.");
  }
  const id = requiredString(input.chatId, "chatId");
  const chats = readChats();
  const existing = chats.find((chat) => chat.id === id);
  if (!existing) {
    throw new Error("Chat was not found.");
  }
  const attachedFiles = Array.isArray(input.attachedFiles)
    ? input.attachedFiles
        .filter((file): file is Record<string, unknown> => isRecord(file))
        .map((file) => ({
          path: typeof file.path === "string" ? normalizeRelativePath(file.path).slice(0, 260) : "",
          name: typeof file.name === "string" ? file.name.slice(0, 120) : "",
        }))
        .filter((file) => file.path && file.name)
        .slice(0, 16)
    : existing.attachedFiles ?? [];
  const draftPrompt = typeof input.draftPrompt === "string" ? input.draftPrompt.slice(0, 12000) : existing.draftPrompt ?? "";
  const next: ChatRecord = {
    ...existing,
    draftPrompt,
    attachedFiles,
    updatedAt: new Date().toISOString(),
  };
  writeChats([next, ...chats.filter((chat) => chat.id !== id)]);
  return next;
}

function deleteChat(input: unknown): { ok: true } {
  if (!isRecord(input)) {
    throw new Error("Invalid chat delete input.");
  }
  const id = requiredString(input.chatId, "chatId");
  writeChats(readChats().filter((chat) => chat.id !== id));
  return { ok: true };
}

function updateChatFromTask(task: TaskRecord) {
  if (!task.chatId) {
    return;
  }
  const chats = readChats();
  const existing = chats.find((chat) => chat.id === task.chatId);
  const repository = task.hiddenWorkspace ? undefined : readProjects().find((project) => project.id === task.repositoryId);
  const next: ChatRecord = {
    id: task.chatId,
    title: chatTitleFromPrompt(task.prompt),
    createdAt: existing?.createdAt ?? task.createdAt,
    updatedAt: new Date().toISOString(),
    taskId: task.id,
    taskState: task.state,
    repositoryName: repository?.name ?? existing?.repositoryName,
    repositoryPath: repository?.rootPath ?? existing?.repositoryPath,
    changedFiles: task.changedFiles.length,
    draftPrompt: existing?.draftPrompt ?? "",
    attachedFiles: existing?.attachedFiles ?? [],
  };
  writeChats([next, ...chats.filter((chat) => chat.id !== task.chatId)]);
}

const ignoredSnapshotDirectories = new Set([
  ".git",
  ".aegis",
  ".venv",
  "venv",
  "node_modules",
  "dist",
  "dist-electron",
  "target",
  "build",
  "coverage",
  ".next",
  ".vite",
]);

function textLines(value: string): string[] {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function readTextFileIfSafe(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 512 * 1024) {
      return null;
    }
    const buffer = fs.readFileSync(filePath);
    if (buffer.includes(0)) {
      return null;
    }
    return buffer.toString("utf8");
  } catch {
    return null;
  }
}

function snapshotFolder(rootPath: string): Record<string, string> {
  const root = path.resolve(rootPath);
  const snapshot: Record<string, string> = {};
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = normalizeRelativePath(path.relative(root, absolute));
      if (entry.isDirectory()) {
        if (!ignoredSnapshotDirectories.has(entry.name) && !isGeneratedRuntimePath(relative)) {
          stack.push(absolute);
        }
        continue;
      }
      if (!entry.isFile() || isGeneratedRuntimePath(relative)) {
        continue;
      }
      const text = readTextFileIfSafe(absolute);
      if (text !== null) {
        snapshot[relative] = text;
      }
    }
  }
  return snapshot;
}

function sanitizeAttachments(input: unknown, rootPath: string): ChatAttachment[] {
  if (!Array.isArray(input)) return [];
  const root = path.resolve(rootPath);
  const seen = new Set<string>();
  const files: ChatAttachment[] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    const rawPath = typeof item.path === "string" ? item.path.trim() : "";
    if (!rawPath) continue;
    const absolute = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(root, normalizeRelativePath(rawPath));
    if (!pathInside(root, absolute) || !fs.existsSync(absolute)) continue;
    const relative = normalizeRelativePath(path.relative(root, absolute));
    if (!relative || isGeneratedRuntimePath(relative) || isBlockedPath(relative) || seen.has(relative)) continue;
    const name =
      typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 120) : path.basename(relative);
    seen.add(relative);
    files.push({ path: relative, name });
    if (files.length >= 16) break;
  }
  return files;
}

function repositoryTreePreview(rootPath: string, maxEntries = 90): string[] {
  const root = path.resolve(rootPath);
  const rows: string[] = [];
  const walk = (directory: string, depth: number) => {
    if (rows.length >= maxEntries || depth > 2) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries
      .filter((entry) => {
        const relative = normalizeRelativePath(path.relative(root, path.join(directory, entry.name)));
        return !isGeneratedRuntimePath(relative) && !isBlockedPath(relative) && !ignoredSnapshotDirectories.has(entry.name);
      })
      .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name))
      .forEach((entry) => {
        if (rows.length >= maxEntries) return;
        const absolute = path.join(directory, entry.name);
        const relative = normalizeRelativePath(path.relative(root, absolute));
        rows.push(`${"  ".repeat(depth)}- ${relative}${entry.isDirectory() ? "/" : ""}`);
        if (entry.isDirectory()) walk(absolute, depth + 1);
      });
  };
  walk(root, 0);
  return rows;
}

function keyWorkspaceFiles(rootPath: string): Array<{ path: string; text: string }> {
  const candidates = ["README.md", "package.json", "desktop/package.json", "src/package.json", "pyproject.toml"];
  const snippets: Array<{ path: string; text: string }> = [];
  let remaining = 12000;
  for (const relative of candidates) {
    const absolute = path.resolve(rootPath, relative);
    if (!pathInside(rootPath, absolute) || !fs.existsSync(absolute)) continue;
    const text = readTextFileIfSafe(absolute);
    if (text === null) continue;
    const snippet = text.slice(0, Math.max(0, remaining));
    if (!snippet) break;
    snippets.push({ path: normalizeRelativePath(relative), text: snippet });
    remaining -= snippet.length;
    if (remaining <= 0) break;
  }
  return snippets;
}

function attachmentContext(rootPath: string, attachments: ChatAttachment[]): string[] {
  if (!attachments.length) return [];
  const lines = ["Attached file contents:"];
  let remaining = 30000;
  for (const file of attachments) {
    if (remaining <= 0) break;
    const absolute = path.resolve(rootPath, file.path);
    lines.push(`\n### ${file.path}`);
    if (!pathInside(rootPath, absolute) || !fs.existsSync(absolute)) {
      lines.push("(file is no longer available)");
      continue;
    }
    const text = readTextFileIfSafe(absolute);
    if (text === null) {
      lines.push("(binary, too large, or unreadable text file)");
      continue;
    }
    const snippet = text.slice(0, Math.max(0, remaining));
    remaining -= snippet.length;
    lines.push("```");
    lines.push(snippet);
    lines.push(text.length > snippet.length ? "\n...(truncated)" : "");
    lines.push("```");
  }
  return lines;
}

function openCodePromptForTask(task: TaskRecord, userPrompt: string, attachments: ChatAttachment[]): string {
  const repository = readProjects().find((project) => project.id === task.repositoryId);
  const rootPath = fs.existsSync(task.worktreePath) ? task.worktreePath : task.originalRepoPath;
  const tree = repositoryTreePreview(rootPath);
  const keyFiles = keyWorkspaceFiles(rootPath);
  const lines = [
    "Aegis workspace context:",
    `- opened folder: ${rootPath}`,
    `- repository name: ${repository?.name ?? path.basename(rootPath)}`,
    `- workspace kind: ${task.workspaceKind}`,
    `- branch/status: ${task.originalBranch} (${repository?.statusSummary ?? "unknown"})`,
    "",
    "Visible workspace files:",
    tree.length ? tree.join("\n") : "- (no readable files found)",
  ];
  if (keyFiles.length) {
    lines.push("", "Key workspace files:");
    for (const file of keyFiles) {
      lines.push(`\n### ${file.path}`, "```", file.text, "```");
    }
  }
  if (promptLooksLikePythonTask(userPrompt)) {
    lines.push(
      "",
      "Python runtime policy for this request:",
      pythonRuntimeSystemPrompt,
      "Use `uv --version`, `uv python install 3.12` when needed, `uv venv .venv --python 3.12`, and then `uv run python <script.py>` or the direct `.venv` interpreter to verify. Do not run bare `python`, `python3`, or `py` as verification.",
    );
  }
  lines.push(...attachmentContext(rootPath, attachments));
  lines.push(
    "",
    "User request:",
    userPrompt,
    "",
    "Use the opened folder above as the current project. If answering about the codebase, summarize from the provided workspace context and inspect more files with tools only when needed.",
    "If you create or modify files, do not paste the full code in your final response. Refer to the changed file paths by name so Aegis can open them in Review.",
  );
  return lines.join("\n");
}

function diffHeader(filePath: string, status: ReviewFile["status"]): string[] {
  const escaped = filePath.replace(/\\/g, "/");
  if (status === "added") {
    return [`diff --git a/${escaped} b/${escaped}`, "new file mode 100644", "--- /dev/null", `+++ b/${escaped}`];
  }
  if (status === "deleted") {
    return [`diff --git a/${escaped} b/${escaped}`, "deleted file mode 100644", `--- a/${escaped}`, "+++ /dev/null"];
  }
  return [`diff --git a/${escaped} b/${escaped}`, `--- a/${escaped}`, `+++ b/${escaped}`];
}

function lcsLineDiff(before: string[], after: string[]): string[] {
  const rows = before.length;
  const cols = after.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () => Array<number>(cols + 1).fill(0));
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let col = cols - 1; col >= 0; col -= 1) {
      table[row][col] =
        before[row] === after[col]
          ? table[row + 1][col + 1] + 1
          : Math.max(table[row + 1][col], table[row][col + 1]);
    }
  }
  const diff: string[] = [];
  let row = 0;
  let col = 0;
  while (row < rows || col < cols) {
    if (row < rows && col < cols && before[row] === after[col]) {
      diff.push(` ${before[row]}`);
      row += 1;
      col += 1;
    } else if (col < cols && (row === rows || table[row][col + 1] >= table[row + 1][col])) {
      diff.push(`+${after[col]}`);
      col += 1;
    } else if (row < rows) {
      diff.push(`-${before[row]}`);
      row += 1;
    }
  }
  return diff;
}

function buildTextDiff(filePath: string, before: string | null, after: string | null): ReviewFile | null {
  if (before === after) {
    return null;
  }
  const status: ReviewFile["status"] = before === null ? "added" : after === null ? "deleted" : "modified";
  const beforeLines = before === null ? [] : textLines(before);
  const afterLines = after === null ? [] : textLines(after);
  const body =
    status === "added"
      ? afterLines.map((line) => `+${line}`)
      : status === "deleted"
        ? beforeLines.map((line) => `-${line}`)
        : lcsLineDiff(beforeLines, afterLines);
  const hunk = `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`;
  return {
    path: filePath,
    status,
    diff: [...diffHeader(filePath, status), hunk, ...body].join("\n"),
  };
}

function worktreeRootForRepo(repoRoot: string): string {
  const resolved = path.resolve(repoRoot);
  return path.join(os.homedir(), ".aegis", "worktrees", `${slugify(path.basename(resolved))}-${shortHash(resolved.toLowerCase())}`);
}

function aegisWorktreesRoot(): string {
  return path.join(os.homedir(), ".aegis", "worktrees");
}

function directoryIsEmpty(directory: string): boolean {
  try {
    return fs.readdirSync(directory).length === 0;
  } catch {
    return false;
  }
}

function removeEmptyDirectory(directory: string): boolean {
  try {
    fs.rmdirSync(directory);
    return !fs.existsSync(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return false;
    return false;
  }
}

function cleanupEmptyAegisWorktreeDirectories(task: TaskRecord) {
  const worktreesRoot = aegisWorktreesRoot();
  const repoWorktreeRoot = worktreeRootForRepo(task.originalRepoPath);
  if (!pathInside(worktreesRoot, repoWorktreeRoot) || !pathInside(repoWorktreeRoot, task.worktreePath)) return;
  if (fs.existsSync(task.worktreePath) && directoryIsEmpty(task.worktreePath)) {
    removeEmptyDirectory(task.worktreePath);
  }
  removeEmptyDirectory(repoWorktreeRoot);
}

async function removeGitWorktree(task: TaskRecord) {
  const repoWorktreeRoot = worktreeRootForRepo(task.originalRepoPath);
  if (!pathInside(repoWorktreeRoot, task.worktreePath)) {
    throw new Error("Worktree path is outside Aegis control.");
  }
  if (fs.existsSync(task.worktreePath)) {
    const result = await gitResult(task.originalRepoPath, ["worktree", "remove", "--force", task.worktreePath]);
    if (!result.success) {
      if (!directoryIsEmpty(task.worktreePath)) {
        const message = (result.stderr || result.stdout || "Failed to remove worktree.").trim();
        throw new Error(message);
      }
      removeEmptyDirectory(task.worktreePath);
    }
  }
  cleanupEmptyAegisWorktreeDirectories(task);
}

function taskMetadataPath(task: TaskRecord): string {
  return path.join(app.getPath("userData"), "task-metadata", `${task.id}.json`);
}

function recordTaskEvent(event: BackendUiEvent) {
  if (isReviewReadyAssistantEvent(event)) return;
  const tasks = readTasks();
  const task = tasks.find((row) => row.id === event.taskId);
  if (!task) return;
  task.events = appendTaskEvent(task.events, event, 500);
  writeTasks([task, ...tasks.filter((row) => row.id !== task.id)]);
}

function emit(event: BackendUiEvent) {
  const stampedEvent = { ...event, at: event.at ?? new Date().toISOString() } as BackendUiEvent;
  recordTaskEvent(stampedEvent);
  mainWindow?.webContents.send("aegis:backend-event", stampedEvent);
}

function failTask(task: TaskRecord, message: string) {
  task.state = "failed";
  task.error = message;
  saveTask(task);
  emit({ type: "task.error", taskId: task.id, message });
}

function execFileOutput(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        timeout: options.timeout ?? 180000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}${stderr ? `\n${stderr}` : ""}`));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function execFileResult(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        timeout: options.timeout ?? 180000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const exitCode =
          error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
            ? ((error as NodeJS.ErrnoException & { code: number }).code)
            : error
              ? 1
              : 0;
        resolve({
          stdout: String(stdout),
          stderr: String(stderr) || (error ? String(error.message) : ""),
          exitCode,
          success: !error,
        });
      },
    );
  });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const output = await execFileOutput("git", args, { cwd });
  return output.stdout.trim();
}

async function gitResult(cwd: string, args: string[]): Promise<CommandResult> {
  return execFileResult("git", args, { cwd });
}

async function commandAvailable(command: string): Promise<boolean> {
  try {
    await execFileOutput(process.platform === "win32" ? "where.exe" : "which", [command], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function addSearchResult(results: Map<string, FileSearchResult>, rootPath: string, relativePath: string, match: FileSearchResult["match"]) {
  const normalized = normalizeRelativePath(relativePath.trim());
  if (!normalized || path.isAbsolute(normalized) || isGeneratedRuntimePath(normalized) || isBlockedPath(normalized)) {
    return;
  }
  const absolute = path.join(rootPath, normalized);
  if (!pathInside(rootPath, absolute) || !fs.existsSync(absolute)) {
    return;
  }
  const existing = results.get(normalized);
  if (existing?.match === "path") {
    return;
  }
  results.set(normalized, { path: normalized, name: path.basename(normalized), match });
}

function rankedSearchResults(results: Iterable<FileSearchResult>, query: string, limit: number): FileSearchResult[] {
  const queryLower = query.toLowerCase();
  const score = (file: FileSearchResult) => {
    if (!queryLower) return 0;
    const name = file.name.toLowerCase();
    const filePath = file.path.toLowerCase();
    if (name.startsWith(queryLower)) return 0;
    if (filePath.startsWith(queryLower)) return 1;
    if (name.includes(queryLower)) return 2;
    if (filePath.includes(queryLower)) return 3;
    return file.match === "content" ? 4 : 5;
  };
  return Array.from(results)
    .sort((left, right) => score(left) - score(right) || left.path.length - right.path.length || left.path.localeCompare(right.path))
    .slice(0, limit);
}

function fallbackFileSearch(rootPath: string, query: string, limit: number): FileSearchResult[] {
  const root = path.resolve(rootPath);
  const queryLower = query.toLowerCase();
  const results = new Map<string, FileSearchResult>();
  const collectionLimit = Math.max(limit * 8, 80);
  const stack = [root];
  while (stack.length && results.size < collectionLimit) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = normalizeRelativePath(path.relative(root, absolute));
      if (entry.isDirectory()) {
        if (!ignoredSnapshotDirectories.has(entry.name) && !isGeneratedRuntimePath(relative)) {
          stack.push(absolute);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (!queryLower || relative.toLowerCase().includes(queryLower)) {
        addSearchResult(results, root, relative, "path");
      }
      if (results.size >= collectionLimit) break;
    }
  }
  return rankedSearchResults(results.values(), query, limit);
}

async function searchRepositoryFiles(input: unknown): Promise<FileSearchResult[]> {
  if (!isRecord(input)) {
    throw new Error("Invalid file search input.");
  }
  const repositoryId = requiredString(input.repositoryId, "repositoryId");
  const query = typeof input.query === "string" ? input.query.trim().slice(0, 120) : "";
  const limit = Math.min(30, Math.max(4, typeof input.limit === "number" ? input.limit : 10));
  const repository = readProjects().find((project) => project.id === repositoryId);
  if (!repository) {
    throw new Error("Repository has not been selected.");
  }
  const rootPath = repository.rootPath;
  const results = new Map<string, FileSearchResult>();
  const ignoreArgs = [
    "--hidden",
    "-g",
    "!.git",
    "-g",
    "!node_modules",
    "-g",
    "!dist",
    "-g",
    "!dist-electron",
    "-g",
    "!.aegis",
    "-g",
    "!.venv",
    "-g",
    "!venv",
  ];

  if (await commandAvailable("rg")) {
    const collectionLimit = Math.max(limit * 8, 80);
    const listed = await execFileResult("rg", ["--files", ...ignoreArgs], { cwd: rootPath, timeout: 15000 });
    for (const file of listed.stdout.split(/\r?\n/)) {
      if (!query || normalizeRelativePath(file).toLowerCase().includes(query.toLowerCase())) {
        addSearchResult(results, rootPath, file, "path");
      }
      if (results.size >= collectionLimit) break;
    }
    if (query.length >= 2 && results.size < collectionLimit) {
      const contentMatches = await execFileResult("rg", ["--ignore-case", "--files-with-matches", ...ignoreArgs, escapeRegExp(query)], {
        cwd: rootPath,
        timeout: 15000,
      });
      for (const file of contentMatches.stdout.split(/\r?\n/)) {
        addSearchResult(results, rootPath, file, "content");
        if (results.size >= collectionLimit) break;
      }
    }
  }

  if (results.size === 0) {
    for (const result of fallbackFileSearch(rootPath, query, limit)) {
      results.set(result.path, result);
    }
  }

  return rankedSearchResults(results.values(), query, limit);
}

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText}${body ? `: ${body.slice(0, 240)}` : ""}`);
  }
  return response.json() as Promise<T>;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function normalizeOpenAiBaseUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  return /\/v\d+$/i.test(normalized) ? normalized : `${normalized}/v1`;
}

function modelDisplayName(providerName: string, modelId: string): string {
  return `${modelId} via ${providerName}`;
}

async function probeLocalProvider(provider: (typeof localProviderCatalog)[number]): Promise<LocalModelProvider> {
  const baseUrl = normalizeOpenAiBaseUrl(provider.baseUrl);
  try {
    const lmStudioRoot = baseUrl.replace(/\/v\d+$/i, "");
    const lmStudioModels =
      provider.providerId === "local-lmstudio"
        ? await fetchJson<{ data?: Array<{ id?: string; name?: string; type?: string; state?: string }> }>(
            `${lmStudioRoot}/api/v0/models`,
            { signal: AbortSignal.timeout(1800) },
          ).catch(() => null)
        : null;
    const response =
      lmStudioModels ??
      (await fetchJson<{ data?: Array<{ id?: string; name?: string; type?: string; state?: string }> }>(`${baseUrl}/models`, {
        signal: AbortSignal.timeout(1800),
      }));
    const seen = new Set<string>();
    const models = (response.data ?? [])
      .filter((model) => model.type !== "embeddings" && model.state !== "not-loaded")
      .map((model) => (typeof model.id === "string" && model.id.trim() ? model.id : model.name))
      .filter((modelId): modelId is string => typeof modelId === "string" && !!modelId.trim())
      .map((modelId) => modelId.trim())
      .filter((modelId) => {
        const key = modelId.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((left, right) => left.localeCompare(right))
      .map<LocalModelInfo>((modelId) => ({
        providerId: provider.providerId,
        providerName: provider.providerName,
        modelId,
        displayName: modelDisplayName(provider.providerName, modelId),
        baseUrl,
      }));
    return {
      providerId: provider.providerId,
      providerName: provider.providerName,
      baseUrl,
      status: models.length > 0 ? "ready" : "degraded",
      models,
      message: models.length > 0 ? undefined : `${provider.providerName} is reachable but did not list any models.`,
    };
  } catch {
    return {
      providerId: provider.providerId,
      providerName: provider.providerName,
      baseUrl,
      status: "unavailable",
      models: [],
      message: `${provider.providerName} is not reachable at ${baseUrl}.`,
    };
  }
}

async function probeLocalProviders(): Promise<LocalModelProvider[]> {
  return Promise.all(localProviderCatalog.map((provider) => probeLocalProvider(provider)));
}

function chooseSelectedModel(models: LocalModelInfo[]): LocalModelInfo | null {
  if (models.length === 0) {
    return null;
  }
  const selected = readSettings().selectedModel;
  if (selected) {
    const exact = models.find((model) => model.providerId === selected.providerId && model.modelId === selected.modelId);
    if (exact) return exact;
  }
  const hinted = models.find((model) => preferredModelHints.some((hint) => model.modelId.toLowerCase().includes(hint)));
  return hinted ?? models[0];
}

async function resolveSelectedModel(): Promise<{ providers: LocalModelProvider[]; models: LocalModelInfo[]; selected: LocalModelInfo | null }> {
  const providers = await probeLocalProviders();
  const models = providers.flatMap((provider) => provider.models);
  const selected = chooseSelectedModel(models);
  return { providers, models, selected };
}

async function getBackendStatus(): Promise<BackendStatus> {
  const { providers, models, selected } = await resolveSelectedModel();
  const providerMessages = providers
    .filter((provider) => provider.status !== "ready" && provider.message)
    .map((provider) => provider.message as string);
  const messages = [
    opencodeBinaryPath() ? undefined : "OpenCode is not installed in the app bundle.",
    selected ? undefined : "No LM Studio models are currently available.",
    ...providerMessages,
  ].filter((message): message is string => !!message);
  const lmstudio = providers.find((provider) => provider.providerId === "local-lmstudio")?.status ?? "unavailable";

  return {
    opencode: opencodeBinaryPath() ? "ready" : "unavailable",
    lmstudio,
    model: selected,
    models,
    providers,
    permissionMode,
    privacy: {
      share: "disabled",
      enabledProviders: providers.filter((provider) => provider.status === "ready").map((provider) => provider.providerId),
      disabledProviders: defaultDisabledProviders,
      webTools: "disabled",
    },
    message: messages.length ? messages.join(" ") : undefined,
  };
}

async function inspectRepository(selectedPath: string): Promise<RepositoryInfo> {
  const selected = path.resolve(selectedPath);
  if (!fs.existsSync(selected) || !fs.statSync(selected).isDirectory()) {
    throw new Error("Selected path is not a folder.");
  }
  let root = selected;
  let kind: WorkspaceKind = "folder";
  let branch = "folder";
  let baseCommit = crypto.createHash("sha256").update(`${selected}:${Date.now()}`).digest("hex");
  let statusSummary = "regular folder";
  let dirty = false;
  try {
    root = path.resolve(await gitOutput(selected, ["rev-parse", "--show-toplevel"]));
    kind = "git";
    branch = (await gitOutput(root, ["branch", "--show-current"]).catch(() => "")) || "HEAD";
    baseCommit = await gitOutput(root, ["rev-parse", "HEAD"]);
    const status = await gitOutput(root, ["status", "--porcelain"]).catch(() => "");
    const dirtyRows = status.split(/\r?\n/).filter(Boolean);
    dirty = dirtyRows.length > 0;
    statusSummary = dirtyRows.length === 0 ? "clean" : `${dirtyRows.length} pending change${dirtyRows.length === 1 ? "" : "s"}`;
  } catch {
    kind = "folder";
  }
  const repository: RepositoryInfo = {
    id: stableRepositoryId(root),
    name: path.basename(root) || root,
    rootPath: root,
    kind,
    originalBranch: branch,
    baseCommit,
    dirty,
    statusSummary,
  };
  writeProjects([repository, ...readProjects().filter((project) => project.id !== repository.id)]);
  return repository;
}

async function pickRepository(): Promise<{ canceled: true } | { canceled: false; repository: RepositoryInfo }> {
  const options: OpenDialogOptions = {
    title: "Select Repository",
    properties: ["openDirectory"],
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }
  return { canceled: false, repository: await inspectRepository(result.filePaths[0]) };
}

async function getRepository(input: unknown): Promise<RepositoryInfo | null> {
  if (!isRecord(input)) {
    throw new Error("Invalid repository lookup input.");
  }
  const repositoryId = typeof input.repositoryId === "string" && input.repositoryId.trim() ? input.repositoryId.trim() : "";
  const repositoryPath =
    typeof input.repositoryPath === "string" && input.repositoryPath.trim() ? path.resolve(input.repositoryPath.trim()) : "";
  const existing =
    (repositoryId ? readProjects().find((project) => project.id === repositoryId) : undefined) ??
    (repositoryPath ? readProjects().find((project) => path.resolve(project.rootPath) === repositoryPath) : undefined);
  const targetPath = existing?.rootPath ?? repositoryPath;
  if (!targetPath) {
    return null;
  }
  if (!fs.existsSync(targetPath)) {
    return existing ?? null;
  }
  return inspectRepository(targetPath);
}

async function askPermission(task: TaskRecord, request: Omit<PermissionRequest, "id">): Promise<void> {
  const id = `perm-${crypto.randomBytes(6).toString("hex")}`;
  const fullRequest: PermissionRequest = { id, ...request };
  emit({ type: "permission.requested", taskId: task.id, request: fullRequest });
  if (task.permissionMode === "bypass") {
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

async function respondToToolPermission(input: unknown) {
  if (!isRecord(input)) {
    throw new Error("Invalid permission response.");
  }
  const taskIdValue = requiredString(input.taskId, "taskId");
  const id = requiredString(input.id, "permission id");
  const decision = input.decision === "deny" ? "deny" : "allow";
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

async function runCommandForTask(
  task: TaskRecord,
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number },
): Promise<CommandResult> {
  await askPermission(task, {
    kind: "bash",
    summary: commandText(command, args),
    command: commandText(command, args),
    cwd: options.cwd,
  });
  const id = `cmd-${crypto.randomBytes(6).toString("hex")}`;
  emit({ type: "command.started", taskId: task.id, id, command: commandText(command, args), cwd: options.cwd, kind: "bash" });
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
      stdout = `${stdout}${text}`.slice(-12000);
      emit({ type: "command.output", taskId: task.id, id, stream: "stdout", text });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr = `${stderr}${text}`.slice(-12000);
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

async function getChangedFiles(worktreePath: string, baseCommit: string): Promise<string[]> {
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

function folderReviewFiles(task: TaskRecord): ReviewFile[] {
  const before = task.baselineFiles ?? {};
  const after = snapshotFolder(task.worktreePath);
  const paths = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
    .filter((file) => !isGeneratedRuntimePath(file))
    .sort((a, b) => a.localeCompare(b));
  return paths
    .map((file) => buildTextDiff(file, before[file] ?? null, after[file] ?? null))
    .filter((file): file is ReviewFile => !!file);
}

async function gitReviewFiles(task: TaskRecord): Promise<ReviewFile[]> {
  if (!task.agentBranch) {
    return [];
  }
  const changed = (await getChangedFiles(task.worktreePath, task.baseCommit))
    .filter((file) => !isGeneratedRuntimePath(file))
    .sort((a, b) => a.localeCompare(b));
  const files: ReviewFile[] = [];
  for (const file of changed) {
    const absolute = path.join(task.worktreePath, file);
    const status = await gitFileStatus(task, file);
    const diff = await gitOutput(task.worktreePath, ["diff", "--no-ext-diff", "--unified=80", task.baseCommit, "--", file]).catch(
      () => "",
    );
    if (diff.trim()) {
      files.push({ path: file, status, diff });
      continue;
    }
    const text = readTextFileIfSafe(absolute);
    if (text !== null) {
      const review = buildTextDiff(file, null, text);
      if (review) {
        files.push(review);
      }
    }
  }
  return files;
}

async function gitFileStatus(task: TaskRecord, file: string): Promise<ReviewFile["status"]> {
  const absolute = path.join(task.worktreePath, file);
  const afterExists = fs.existsSync(absolute);
  const before = await gitResult(task.worktreePath, ["cat-file", "-e", `${task.baseCommit}:${file.replace(/\\/g, "/")}`]);
  if (!before.success && afterExists) {
    return "added";
  }
  if (before.success && !afterExists) {
    return "deleted";
  }
  return "modified";
}

async function refreshReview(task: TaskRecord): Promise<ReviewFile[]> {
  const reviewFiles = task.workspaceKind === "folder" ? folderReviewFiles(task) : await gitReviewFiles(task);
  task.reviewFiles = reviewFiles;
  task.changedFiles = reviewFiles.map((file) => file.path);
  return reviewFiles;
}

async function refreshTaskReview(input: unknown): Promise<TaskInfo | null> {
  if (!isRecord(input)) {
    throw new Error("Invalid review refresh input.");
  }
  const task = getTask(requiredString(input.taskId, "taskId"));
  if (task.state === "merged" || task.state === "rejected") {
    return publicTask(task);
  }
  if (!fs.existsSync(task.worktreePath)) {
    return publicTask(task);
  }
  await refreshReview(task);
  saveTask(task);
  return publicTask(task);
}

function isBarePythonCommand(command: string): boolean {
  const normalized = command.trim().replace(/^run\s+/i, "");
  const first = normalized.split(/\s+/)[0]?.replace(/^["']|["']$/g, "").toLowerCase();
  return first === "python" || first === "python3" || first === "py";
}

async function handleOpenCodePermission(
  task: TaskRecord,
  run: OpenCodeRun,
  permission: Record<string, unknown>,
  promptForRun: string,
  intentPrompt: string,
): Promise<"pending" | "resolved" | "worktree_requested"> {
  const id = typeof permission.id === "string" ? permission.id : "";
  if (!id || pendingPermissions.has(id)) return "pending";
  const type = openCodePermissionType(permission);
  const title = openCodePermissionSummary(permission);

  if (type === "bash" && isBarePythonCommand(title)) {
    emit({ type: "permission.resolved", taskId: task.id, id, decision: "deny" });
    await replyOpenCodePermission(run, id, false);
    return "resolved";
  }

  if (task.workspaceKind === "git" && !task.agentBranch && type === "edit") {
    task.agentBranch = `aegis/${task.id}-${slugify(intentPrompt)}`;
    task.worktreePath = path.join(worktreeRootForRepo(task.originalRepoPath), task.id);
    task.openCodeSessionId = undefined;
    task.pendingPrompt = promptForRun;
    task.state = permissionMode === "bypass" ? "running" : "awaiting_worktree_approval";
    saveTask(task);
    await replyOpenCodePermission(run, id, false).catch(() => undefined);
    if (permissionMode === "bypass") {
      void createWorktreeAndRun(task, promptForRun);
    } else {
      emit({
        type: "worktree.requested",
        taskId: task.id,
        branch: task.agentBranch,
        path: task.worktreePath,
        baseCommit: task.baseCommit,
      });
    }
    return "worktree_requested";
  }

  const request: PermissionRequest = {
    id,
    kind: type.includes("edit") ? "edit" : "bash",
    summary: title,
    command: title,
    cwd: task.worktreePath,
  };
  emit({ type: "permission.requested", taskId: task.id, request });

  if (type === "webfetch" || type === "websearch") {
    emit({ type: "permission.resolved", taskId: task.id, id, decision: "deny" });
    await replyOpenCodePermission(run, id, false);
    return "resolved";
  }

  if (task.permissionMode === "bypass" && (type === "edit" || type === "bash")) {
    emit({ type: "permission.resolved", taskId: task.id, id, decision: "allow" });
    await replyOpenCodePermission(run, id, true);
    return "resolved";
  }

  pendingPermissions.set(id, {
    taskId: task.id,
    onAllow: () => replyOpenCodePermission(run, id, true),
    onDeny: () => replyOpenCodePermission(run, id, false),
  });
  return "pending";
}

async function runOpenCodeTask(taskIdValue: string, promptForRun?: string, intentPrompt?: string) {
  const task = getTask(taskIdValue);
  let run: OpenCodeRun | null = null;
  const prompt = promptForRun ?? task.prompt;
  const intent = intentPrompt ?? task.prompt;
  const expectsFileChanges = promptLooksLikeFileChange(intent);
  try {
    const { models, selected } = await resolveSelectedModel();
    if (!selected) {
      failTask(task, "No local LM Studio model is available.");
      return;
    }
    task.model = selected;
    saveTask(task);
    run = await startOpenCodeServer(task, selected, models);
    activeOpenCodeRuns.set(task.id, run);

    const toolRuns = new Map<string, { commandId: string; command: string; kind: PermissionRequest["kind"]; outputLength: number; finished: boolean }>();
    const textPartLengths = new Map<string, number>();
    const reasoningPartLengths = new Map<string, number>();
    const partKinds = new Map<string, string>();
    const partMessageIds = new Map<string, string>();
    const messageRoles = new Map<string, "user" | "assistant">();
    const pendingTextParts = new Map<string, { messageId: string; text: string }>();
    const pendingReasoningParts = new Map<string, { messageId: string; text: string }>();
    let delegatedToWorktree = false;
    let completed = false;
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const finish = () => {
      if (completed) return;
      completed = true;
      resolveCompletion();
    };

    const finishOpenToolRuns = () => {
      for (const current of toolRuns.values()) {
        if (current.finished) continue;
        current.finished = true;
        emit({ type: "command.finished", taskId: task.id, id: current.commandId, exitCode: 0 });
      }
    };

    const fail = (message: string) => {
      if (completed) return;
      completed = true;
      rejectCompletion(new Error(message));
    };

    const emitAssistantText = (text: string) => {
      if (!text || text.trim() === "Ready for review.") return;
      emit({ type: "assistant.delta", taskId: task.id, text });
    };

    const emitReasoningText = (text: string) => {
      if (!text) return;
      emit({ type: "assistant.reasoning.delta", taskId: task.id, text });
    };

    const onEvent = (event: Record<string, unknown>) => {
      const type = typeof event.type === "string" ? event.type : "";
      const sessionID = eventSessionId(event);
      if (sessionID && (!run?.sessionId || sessionID !== run.sessionId)) return;
      const properties = isRecord(event.properties) ? event.properties : {};

      if (type === "message.updated") {
        const info = isRecord(properties.info) ? properties.info : {};
        const messageId = typeof info.id === "string" ? info.id : "";
        const role = info.role === "assistant" ? "assistant" : info.role === "user" ? "user" : undefined;
        if (messageId && role) {
          messageRoles.set(messageId, role);
          if (role === "assistant") {
            for (const [partId, pending] of Array.from(pendingTextParts.entries())) {
              if (pending.messageId !== messageId) continue;
              pendingTextParts.delete(partId);
              textPartLengths.set(partId, pending.text.length);
              emitAssistantText(pending.text);
            }
            for (const [partId, pending] of Array.from(pendingReasoningParts.entries())) {
              if (pending.messageId !== messageId) continue;
              pendingReasoningParts.delete(partId);
              reasoningPartLengths.set(partId, pending.text.length);
              emitReasoningText(pending.text);
            }
          } else {
            for (const [partId, pending] of Array.from(pendingTextParts.entries())) {
              if (pending.messageId === messageId) pendingTextParts.delete(partId);
            }
            for (const [partId, pending] of Array.from(pendingReasoningParts.entries())) {
              if (pending.messageId === messageId) pendingReasoningParts.delete(partId);
            }
          }
        }
        if (info.role === "assistant" && info.error) {
          fail(openCodeErrorMessage(info.error));
        }
      }

      if (type === "message.part.updated") {
        const part = isRecord(properties.part) ? properties.part : {};
        const partType = typeof part.type === "string" ? part.type : "";
        const messageId = typeof part.messageID === "string" ? part.messageID : "";
        const role = messageId ? messageRoles.get(messageId) : undefined;
        if (typeof part.id === "string") {
          partKinds.set(part.id, partType);
          if (messageId) partMessageIds.set(part.id, messageId);
        }
        if (partType === "text" && typeof part.id === "string" && typeof part.text === "string") {
          if (!role) {
            pendingTextParts.set(part.id, { messageId, text: part.text });
            return;
          }
          if (role !== "assistant") {
            return;
          }
          const delta = part.text.slice(textPartLengths.get(part.id) ?? 0);
          textPartLengths.set(part.id, part.text.length);
          emitAssistantText(delta);
        }
        if (partType === "reasoning" && typeof part.id === "string" && typeof part.text === "string") {
          if (!role) {
            pendingReasoningParts.set(part.id, { messageId, text: part.text });
            return;
          }
          if (role !== "assistant") {
            return;
          }
          const delta = part.text.slice(reasoningPartLengths.get(part.id) ?? 0);
          reasoningPartLengths.set(part.id, part.text.length);
          emitReasoningText(delta);
        }
        if (partType === "tool" && typeof part.id === "string") {
          const state = isRecord(part.state) ? part.state : {};
          const status = typeof state.status === "string" ? state.status : "pending";
          const existing = toolRuns.get(part.id);
          const tool = openCodeToolCommand(part);
          const commandId = existing?.commandId ?? `oc-${part.id}`;
          if (!existing) {
            toolRuns.set(part.id, { commandId, command: tool.command, kind: tool.kind, outputLength: 0, finished: false });
            emit({ type: "command.started", taskId: task.id, id: commandId, command: tool.command, cwd: task.worktreePath, kind: tool.kind });
          } else if ((tool.command !== existing.command || tool.kind !== existing.kind) && tool.command !== existing.command.split(/\s+/)[0]) {
            existing.command = tool.command;
            existing.kind = tool.kind;
            emit({ type: "command.started", taskId: task.id, id: commandId, command: tool.command, cwd: task.worktreePath, kind: tool.kind });
          }
          const current = toolRuns.get(part.id);
          if (!current || current.finished) return;
          const output =
            status === "completed" && typeof state.output === "string"
              ? state.output
              : status === "error" && typeof state.error === "string"
                ? state.error
                : "";
          if (output.length > current.outputLength) {
            emit({
              type: "command.output",
              taskId: task.id,
              id: current.commandId,
              stream: status === "error" ? "stderr" : "stdout",
              text: output.slice(current.outputLength, current.outputLength + 12000),
            });
            current.outputLength = output.length;
          }
          if (status === "completed" || status === "error") {
            current.finished = true;
            emit({ type: "command.finished", taskId: task.id, id: current.commandId, exitCode: status === "completed" ? 0 : 1 });
          }
        }
      }

      if (type === "message.part.delta") {
        const partId = typeof properties.partID === "string" ? properties.partID : "";
        const field = typeof properties.field === "string" ? properties.field : "";
        const delta = typeof properties.delta === "string" ? properties.delta : "";
        const messageId =
          typeof properties.messageID === "string"
            ? properties.messageID
            : partId
              ? partMessageIds.get(partId) ?? ""
              : "";
        const role = messageId ? messageRoles.get(messageId) : undefined;
        const partType = partId ? partKinds.get(partId) : undefined;
        if (field !== "text" || !partId || !delta) {
          return;
        }
        if (role !== "assistant") {
          if (!role && messageId && partType === "reasoning") {
            const pending = pendingReasoningParts.get(partId);
            pendingReasoningParts.set(partId, { messageId, text: `${pending?.text ?? ""}${delta}` });
          } else if (!role && messageId && partType === "text") {
            const pending = pendingTextParts.get(partId);
            pendingTextParts.set(partId, { messageId, text: `${pending?.text ?? ""}${delta}` });
          }
          return;
        }
        if (partType === "reasoning") {
          reasoningPartLengths.set(partId, (reasoningPartLengths.get(partId) ?? 0) + delta.length);
          emitReasoningText(delta);
        } else if (partType === "text") {
          textPartLengths.set(partId, (textPartLengths.get(partId) ?? 0) + delta.length);
          emitAssistantText(delta);
        }
      }

      if ((type === "permission.updated" || type === "permission.asked") && isRecord(properties)) {
        void handleOpenCodePermission(task, run as OpenCodeRun, properties, prompt, intent)
          .then((result) => {
            if (result === "worktree_requested") {
              delegatedToWorktree = true;
              finish();
            }
          })
          .catch((error) => fail(String(error instanceof Error ? error.message : error)));
      }

      if (type === "session.error") {
        fail(openCodeErrorMessage(properties.error));
      }

      if (type === "session.idle") {
        finishOpenToolRuns();
        finish();
      }

      if (type === "session.status" && isRecord(properties.status) && properties.status.type === "idle") {
        finishOpenToolRuns();
        finish();
      }
    };

    const stream = beginOpenCodeEventStream(run, onEvent);
    void stream.done.catch((error) => {
      if (!run?.abortController.signal.aborted) {
        fail(String(error instanceof Error ? error.message : error));
      }
    });
    await stream.ready;
    const session = task.openCodeSessionId
      ? { id: task.openCodeSessionId }
      : await openCodeRequest<{ id: string }>(run, "/session", {
          method: "POST",
          body: { title: chatTitleFromPrompt(intent) },
        });
    run.sessionId = session.id;
    task.openCodeSessionId = session.id;
    saveTask(task);
    await openCodeRequest<void>(run, `/session/${encodeURIComponent(session.id)}/prompt_async`, {
      method: "POST",
      body: {
        model: { providerID: selected.providerId, modelID: selected.modelId },
        agent: "build",
        system: [
          "You are running under Aegis. Work only inside the current task workspace. Do not use web fetch, web search, public providers, or external directories. Use real OpenCode tools when you need repository context or file details. Do not narrate imagined tool use, and never say you ran a command or inspected a path unless a tool actually returned that result. For codebase questions, inspect the relevant files before summarizing. When you create or modify files, keep the final response concise and do not paste full file contents or code blocks for changed files. Mention changed file paths only; Aegis will link those paths to the Review panel.",
          reasoningSystemPrompt(task.reasoningMode ?? "fast"),
          pythonRuntimeSystemPrompt,
        ].join(" "),
        parts: [{ type: "text", text: prompt }],
      },
    });

    await Promise.race([
      completion,
      new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("OpenCode task timed out.")), 45 * 60 * 1000)),
    ]);

    if (delegatedToWorktree || task.state === "awaiting_worktree_approval") {
      return;
    }

    task.latestTest = {
      command: `opencode session ${session.id}`,
      output: "OpenCode session completed",
      passed: true,
      exitCode: 0,
      completedAt: new Date().toISOString(),
    };
    const reviewFiles = await refreshReview(task);
    if (reviewFiles.length === 0) {
      if (expectsFileChanges) {
        failTask(task, "OpenCode finished without file changes.");
        return;
      }
      task.state = "completed";
      saveTask(task);
      emit({ type: "assistant.done", taskId: task.id });
      return;
    }
    task.state = "review_ready";
    saveTask(task);
    emit({ type: "assistant.done", taskId: task.id });
    emit({ type: "review.ready", taskId: task.id, changedFiles: task.changedFiles, reviewFiles, latestTest: task.latestTest });
    run.abortController.abort();
    await stream.done.catch(() => undefined);
  } catch (error) {
    failTask(task, String(error instanceof Error ? error.message : error));
  } finally {
    clearPendingPermissionsForTask(task.id);
    activeOpenCodeRuns.delete(task.id);
    if (run) {
      stopOpenCodeRun(run);
    }
  }
}

async function createWorktreeAndRun(task: TaskRecord, promptForRun?: string) {
  try {
    fs.mkdirSync(path.dirname(task.worktreePath), { recursive: true });
    await execFileOutput("git", ["worktree", "add", "-b", task.agentBranch, task.worktreePath, task.baseCommit], {
      cwd: task.originalRepoPath,
      timeout: 120000,
    });
    task.state = "running";
    if (promptForRun && task.pendingPrompt === promptForRun) {
      task.pendingPrompt = undefined;
    }
    saveTask(task);
    emit({ type: "worktree.created", taskId: task.id, branch: task.agentBranch, path: task.worktreePath });
    void runOpenCodeTask(task.id, promptForRun);
  } catch (error) {
    failTask(task, String(error instanceof Error ? error.message : error));
  }
}

function closedTaskMessage(task: TaskRecord): string | undefined {
  if (task.state === "merged") {
    return "This chat was closed after its approved merge. Start a new chat for more changes.";
  }
  if (task.state === "rejected") {
    return "This chat was closed after its changes were undone. Start a new chat for more changes.";
  }
  return undefined;
}

function taskUsesHiddenChatWorkspace(task: TaskRecord, chat: ChatRecord): boolean {
  return (
    task.hiddenWorkspace === true ||
    (task.repositoryId === `hidden-${chat.id}` && path.resolve(task.originalRepoPath) === hiddenChatWorkspacePath(chat.id))
  );
}

function attachHiddenTaskToRepository(task: TaskRecord, repository: RepositoryInfo) {
  task.repositoryId = repository.id;
  task.workspaceKind = repository.kind;
  task.hiddenWorkspace = false;
  task.originalBranch = repository.originalBranch;
  task.baseCommit = repository.baseCommit;
  task.agentBranch = "";
  task.worktreePath = repository.rootPath;
  task.originalRepoPath = repository.rootPath;
  task.originalWasDirty = repository.dirty;
  task.baselineFiles = repository.kind === "folder" ? snapshotFolder(repository.rootPath) : undefined;
  task.openCodeSessionId = undefined;
  task.pendingPrompt = undefined;
  task.changedFiles = [];
  task.reviewFiles = [];
  task.latestTest = undefined;
  task.patchHash = undefined;
  task.metadataPath = undefined;
}

async function startTask(input: unknown): Promise<TaskInfo> {
  if (!isRecord(input)) {
    throw new Error("Invalid task input.");
  }
  const requestedRepositoryId =
    typeof input.repositoryId === "string" && input.repositoryId.trim() ? input.repositoryId.trim() : "";
  const prompt = requiredString(input.prompt, "prompt");
  const reasoningMode = parseReasoningMode(input.reasoningMode);
  const requestedChatId = typeof input.chatId === "string" && input.chatId.trim() ? input.chatId.trim() : undefined;
  const chat =
    (requestedChatId ? readChats().find((row) => row.id === requestedChatId) : undefined) ??
    createChat({ title: chatTitleFromPrompt(prompt) });
  const hiddenWorkspace = !requestedRepositoryId;
  const repository = hiddenWorkspace ? hiddenChatRepository(chat.id) : readProjects().find((project) => project.id === requestedRepositoryId);
  if (!repository) {
    throw new Error("Repository has not been selected.");
  }
  const refreshed = hiddenWorkspace ? repository : await inspectRepository(repository.rootPath);
  const repositoryId = refreshed.id;
  const attachments = sanitizeAttachments(input.attachedFiles, refreshed.rootPath);
  const existingTask = chat?.taskId ? readTasks().find((row) => row.id === chat.taskId) : undefined;
  const wantsFileChange = promptLooksLikeFileChange(prompt);

  if (existingTask) {
    const closedMessage = closedTaskMessage(existingTask);
    if (closedMessage) {
      throw new Error(closedMessage);
    }
    if (activeOpenCodeRuns.has(existingTask.id) || existingTask.state === "awaiting_worktree_approval" || existingTask.state === "approving") {
      throw new Error("This chat already has a task in progress.");
    }
    if (existingTask.repositoryId !== repositoryId) {
      if (!hiddenWorkspace && taskUsesHiddenChatWorkspace(existingTask, chat)) {
        attachHiddenTaskToRepository(existingTask, refreshed);
      } else {
        throw new Error("This chat belongs to a different folder. Start a new chat for this folder.");
      }
    }
    existingTask.permissionMode = permissionMode;
    existingTask.reasoningMode = reasoningMode;
    existingTask.hiddenWorkspace = existingTask.hiddenWorkspace || hiddenWorkspace;
    existingTask.error = undefined;
    if (existingTask.workspaceKind === "git" && wantsFileChange && !existingTask.agentBranch) {
      const openCodePrompt = openCodePromptForTask(existingTask, prompt, attachments);
      existingTask.originalBranch = refreshed.originalBranch;
      existingTask.baseCommit = refreshed.baseCommit;
      existingTask.agentBranch = `aegis/${existingTask.id}-${slugify(prompt)}`;
      existingTask.worktreePath = path.join(worktreeRootForRepo(refreshed.rootPath), existingTask.id);
      existingTask.originalRepoPath = refreshed.rootPath;
      existingTask.originalWasDirty = refreshed.dirty;
      existingTask.openCodeSessionId = undefined;
      existingTask.pendingPrompt = openCodePrompt;
      existingTask.state = permissionMode === "bypass" ? "running" : "awaiting_worktree_approval";
      saveTask(existingTask);
      emit({ type: "user.message", taskId: existingTask.id, text: prompt });
      if (permissionMode === "bypass") {
        existingTask.pendingPrompt = undefined;
        await createWorktreeAndRun(existingTask, openCodePrompt);
      } else {
        emit({
          type: "worktree.requested",
          taskId: existingTask.id,
          branch: existingTask.agentBranch,
          path: existingTask.worktreePath,
          baseCommit: refreshed.baseCommit,
        });
      }
      return publicTask(existingTask);
    }

    existingTask.state = "running";
    existingTask.pendingPrompt = undefined;
    existingTask.originalBranch = existingTask.agentBranch ? existingTask.originalBranch : refreshed.originalBranch;
    existingTask.baseCommit = existingTask.agentBranch ? existingTask.baseCommit : refreshed.baseCommit;
    existingTask.originalRepoPath = refreshed.rootPath;
    existingTask.originalWasDirty = refreshed.dirty;
    saveTask(existingTask);
    emit({ type: "user.message", taskId: existingTask.id, text: prompt });
    void runOpenCodeTask(existingTask.id, openCodePromptForTask(existingTask, prompt, attachments), prompt);
    return publicTask(existingTask);
  }

  const id = taskId();
  const shouldCreateWorktree = refreshed.kind === "git" && wantsFileChange;
  const branch = shouldCreateWorktree ? `aegis/${id}-${slugify(prompt)}` : "";
  const worktreePath = shouldCreateWorktree ? path.join(worktreeRootForRepo(refreshed.rootPath), id) : refreshed.rootPath;
  const task: TaskRecord = {
    id,
    chatId: chat?.id,
    repositoryId,
    prompt,
    workspaceKind: refreshed.kind,
    hiddenWorkspace,
    state: shouldCreateWorktree && permissionMode !== "bypass" ? "awaiting_worktree_approval" : "running",
    originalBranch: refreshed.originalBranch,
    baseCommit: refreshed.baseCommit,
    agentBranch: branch,
    worktreePath,
    permissionMode,
    reasoningMode,
    createdAt: new Date().toISOString(),
    changedFiles: [],
    reviewFiles: [],
    events: [],
    originalRepoPath: refreshed.rootPath,
    originalWasDirty: refreshed.dirty,
    baselineFiles: refreshed.kind === "folder" ? snapshotFolder(refreshed.rootPath) : undefined,
  };
  saveTask(task);
  emit({ type: "user.message", taskId: task.id, text: prompt });
  const openCodePrompt = openCodePromptForTask(task, prompt, attachments);
  if (!shouldCreateWorktree) {
    void runOpenCodeTask(task.id, openCodePrompt, prompt);
  } else if (permissionMode === "bypass") {
    await createWorktreeAndRun(task, openCodePrompt);
  } else {
    task.pendingPrompt = openCodePrompt;
    saveTask(task);
    emit({ type: "worktree.requested", taskId: task.id, branch, path: worktreePath, baseCommit: refreshed.baseCommit });
  }
  return publicTask(task);
}

async function approveWorktreeCreation(input: unknown): Promise<void> {
  if (!isRecord(input)) {
    throw new Error("Invalid worktree approval input.");
  }
  const task = getTask(requiredString(input.taskId, "taskId"));
  const approved = input.approved === true;
  if (task.state !== "awaiting_worktree_approval") {
    throw new Error("Task is not waiting for worktree approval.");
  }
  if (!approved) {
    task.state = "rejected";
    task.pendingPrompt = undefined;
    task.rejectedAt = new Date().toISOString();
    saveTask(task);
    emit({ type: "task.error", taskId: task.id, message: "Worktree creation was declined." });
    return;
  }
  const promptForRun = task.pendingPrompt ?? task.prompt;
  task.pendingPrompt = undefined;
  saveTask(task);
  await createWorktreeAndRun(task, promptForRun);
}

function isGeneratedRuntimePath(filePath: string): boolean {
  const normalized = normalizeRelativePath(filePath);
  return (
    normalized.startsWith(".aegis/runtime/") ||
    normalized.startsWith(".venv/") ||
    normalized.startsWith("venv/") ||
    normalized.includes("/__pycache__/") ||
    normalized.endsWith(".pyc") ||
    normalized.startsWith("node_modules/") ||
    normalized.startsWith(".git/")
  );
}

function isBlockedPath(filePath: string): boolean {
  const normalized = normalizeRelativePath(filePath);
  const basename = path.posix.basename(normalized);
  return (
    normalized === ".env" ||
    normalized.startsWith(".env.") ||
    basename.endsWith(".pem") ||
    basename.endsWith(".key") ||
    basename === "id_rsa" ||
    basename === "id_ed25519" ||
    normalized.includes("credential") ||
    normalized.includes("secret")
  );
}

function secretScanText(text: string): string | null {
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

async function approvalCheck(task: TaskRecord, name: string, run: () => Promise<string | void>): Promise<void> {
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

async function approveTaskMerge(input: unknown): Promise<ApproveResult> {
  if (!isRecord(input)) {
    throw new Error("Invalid approval input.");
  }
  const task = getTask(requiredString(input.taskId, "taskId"));
  task.state = "approving";
  saveTask(task);
  try {
    let allowedFiles: string[] = [];
    let patchHash = "";

    if (task.workspaceKind === "folder") {
      await approvalCheck(task, "agent run completed", async () => {
        if (!task.latestTest?.passed) {
          throw new Error("OpenCode has not completed successfully for this task.");
        }
        return task.latestTest.command;
      });
      await approvalCheck(task, "blocked files", async () => {
        const reviewFiles = await refreshReview(task);
        const dangerous = reviewFiles.map((file) => file.path).filter((file) => isBlockedPath(file));
        if (dangerous.length > 0) {
          throw new Error(`Blocked path changed: ${dangerous.join(", ")}`);
        }
        allowedFiles = reviewFiles.map((file) => file.path).filter((file) => !isGeneratedRuntimePath(file));
        if (allowedFiles.length === 0) {
          throw new Error("No allowed file changes to approve.");
        }
        return `${allowedFiles.length} file${allowedFiles.length === 1 ? "" : "s"}`;
      });
      await approvalCheck(task, "secret scan", async () => {
        const patch = task.reviewFiles.map((file) => file.diff).join("\n");
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
        const patch = task.reviewFiles.map((file) => file.diff).join("\n");
        patchHash = crypto.createHash("sha256").update(patch).digest("hex");
        task.state = "merged";
        task.mergedAt = new Date().toISOString();
        task.patchHash = patchHash;
        task.metadataPath = taskMetadataPath(task);
        writeJsonFile(task.metadataPath, {
          id: task.id,
          workspaceKind: task.workspaceKind,
          folderPath: task.originalRepoPath,
          changedFiles: task.changedFiles,
          latestTest: task.latestTest,
          patchHash,
          approvedAt: task.mergedAt,
        });
        saveTask(task);
        return patchHash.slice(0, 12);
      });
      emit({ type: "merge.completed", taskId: task.id, targetBranch: "folder", commit: patchHash, patchHash });
      return { ok: true, targetBranch: "folder", commit: patchHash, patchHash, metadataPath: task.metadataPath ?? "" };
    }

    await approvalCheck(task, "original branch exists", async () => {
      await execFileOutput("git", ["show-ref", "--verify", `refs/heads/${task.originalBranch}`], { cwd: task.originalRepoPath });
      return task.originalBranch;
    });
    await approvalCheck(task, "original branch clean", async () => {
      if (task.originalWasDirty) {
        throw new Error("Repository had uncommitted changes when the task started.");
      }
      const status = await gitOutput(task.originalRepoPath, ["status", "--porcelain"]);
      if (status.trim()) {
        throw new Error(status);
      }
      return "clean";
    });
    await approvalCheck(task, "original branch base", async () => {
      const current = await gitOutput(task.originalRepoPath, ["rev-parse", task.originalBranch]);
      if (current !== task.baseCommit) {
        throw new Error(`Expected ${task.baseCommit}, found ${current}.`);
      }
      return task.baseCommit.slice(0, 12);
    });
    await approvalCheck(task, "agent branch base", async () => {
      await execFileOutput("git", ["show-ref", "--verify", `refs/heads/${task.agentBranch}`], { cwd: task.originalRepoPath });
      const current = await gitOutput(task.worktreePath, ["rev-parse", task.agentBranch]);
      if (current !== task.baseCommit) {
        throw new Error("OpenCode created commits before approval.");
      }
      return task.agentBranch;
    });
    await approvalCheck(task, "controlled worktree", async () => {
      const root = worktreeRootForRepo(task.originalRepoPath);
      if (!pathInside(root, task.worktreePath) || !fs.existsSync(task.worktreePath)) {
        throw new Error("Worktree path is outside Aegis control.");
      }
      const branch = await gitOutput(task.worktreePath, ["branch", "--show-current"]);
      if (branch !== task.agentBranch) {
        throw new Error(`Expected ${task.agentBranch}, found ${branch}.`);
      }
      return task.worktreePath;
    });
    await approvalCheck(task, "agent run completed", async () => {
      if (!task.latestTest?.passed) {
        throw new Error("OpenCode has not completed successfully for this task.");
      }
      return task.latestTest.command;
    });
    await approvalCheck(task, "blocked files", async () => {
      const reviewFiles = await refreshReview(task);
      const changed = reviewFiles.map((file) => file.path);
      const dangerous = changed.filter((file) => isBlockedPath(file));
      if (dangerous.length > 0) {
        throw new Error(`Blocked path changed: ${dangerous.join(", ")}`);
      }
      allowedFiles = changed.filter((file) => !isGeneratedRuntimePath(file));
      if (allowedFiles.length === 0) {
        throw new Error("No allowed file changes to approve.");
      }
      task.changedFiles = allowedFiles;
      return `${allowedFiles.length} file${allowedFiles.length === 1 ? "" : "s"}`;
    });
    await approvalCheck(task, "secret scan", async () => {
      const diff = await gitOutput(task.worktreePath, ["diff", "--binary", task.baseCommit, "--", ...allowedFiles]);
      const diffHit = secretScanText(diff);
      if (diffHit) {
        throw new Error(`Potential ${diffHit} in patch.`);
      }
      for (const file of allowedFiles) {
        const absolute = path.join(task.worktreePath, file);
        if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
          continue;
        }
        const buffer = fs.readFileSync(absolute);
        if (buffer.includes(0) || buffer.length > 1024 * 1024) {
          continue;
        }
        const hit = secretScanText(buffer.toString("utf8"));
        if (hit) {
          throw new Error(`Potential ${hit} in ${file}.`);
        }
      }
      return "passed";
    });
    await approvalCheck(task, "stage final patch", async () => {
      const staged = await gitOutput(task.worktreePath, ["diff", "--cached", "--name-only"]);
      if (staged.trim()) {
        throw new Error(`Unexpected staged changes: ${staged}`);
      }
      await execFileOutput("git", ["add", "--", ...allowedFiles], { cwd: task.worktreePath });
      const patch = await gitOutput(task.worktreePath, ["diff", "--cached", "--binary"]);
      if (!patch.trim()) {
        throw new Error("Final patch is empty.");
      }
      patchHash = crypto.createHash("sha256").update(patch).digest("hex");
      task.patchHash = patchHash;
      saveTask(task);
      return patchHash.slice(0, 12);
    });
    await approvalCheck(task, "create task commit", async () => {
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "Aegis",
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "aegis@local",
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "Aegis",
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "aegis@local",
      };
      await execFileOutput(
        "git",
        ["commit", "-m", `Aegis task ${task.id}`, "-m", `Patch-Hash: ${patchHash}`],
        { cwd: task.worktreePath, env },
      );
      return (await gitOutput(task.worktreePath, ["rev-parse", "HEAD"])).slice(0, 12);
    });
    await approvalCheck(task, "fast-forward merge", async () => {
      await execFileOutput("git", ["checkout", task.originalBranch], { cwd: task.originalRepoPath });
      await execFileOutput("git", ["merge", "--ff-only", task.agentBranch], { cwd: task.originalRepoPath });
      return task.originalBranch;
    });
    const mergedCommit = await gitOutput(task.originalRepoPath, ["rev-parse", task.originalBranch]);
    await approvalCheck(task, "record metadata", async () => {
      task.state = "merged";
      task.mergedAt = new Date().toISOString();
      task.patchHash = patchHash;
      task.metadataPath = taskMetadataPath(task);
      writeJsonFile(task.metadataPath, {
        id: task.id,
        originalRepoPath: task.originalRepoPath,
        originalBranch: task.originalBranch,
        baseCommit: task.baseCommit,
        mergedCommit,
        agentBranch: task.agentBranch,
        changedFiles: task.changedFiles,
        latestTest: task.latestTest,
        patchHash,
        mergedAt: task.mergedAt,
      });
      saveTask(task);
      return task.metadataPath;
    });
    await approvalCheck(task, "cleanup worktree", async () => {
      await removeGitWorktree(task);
      await gitResult(task.originalRepoPath, ["branch", "-d", task.agentBranch]);
      return "removed";
    });

    emit({ type: "merge.completed", taskId: task.id, targetBranch: task.originalBranch, commit: mergedCommit, patchHash });
    return { ok: true, targetBranch: task.originalBranch, commit: mergedCommit, patchHash, metadataPath: task.metadataPath ?? "" };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    failTask(task, message);
    return { ok: false, message };
  }
}

async function rejectTask(input: unknown): Promise<void> {
  if (!isRecord(input)) {
    throw new Error("Invalid reject input.");
  }
  const task = getTask(requiredString(input.taskId, "taskId"));
  const run = activeOpenCodeRuns.get(task.id);
  if (run) {
    activeOpenCodeRuns.delete(task.id);
    stopOpenCodeRun(run);
  }
  clearPendingPermissionsForTask(task.id);
  const cleanup = input.cleanup === true;
  if (task.workspaceKind === "git" && cleanup && taskStatesThatCanOpen.has(task.state)) {
    await removeGitWorktree(task);
    await gitResult(task.originalRepoPath, ["branch", "-D", task.agentBranch]);
    task.changedFiles = [];
    task.reviewFiles = [];
  }
  if (task.workspaceKind === "folder" && cleanup) {
    const reviewFiles = await refreshReview(task);
    restoreFolderTaskChanges(task, reviewFiles);
    task.changedFiles = [];
    task.reviewFiles = [];
  }
  task.state = "rejected";
  task.rejectedAt = new Date().toISOString();
  saveTask(task);
}

function restoreFolderTaskChanges(task: TaskRecord, reviewFiles: ReviewFile[]) {
  const baseline = task.baselineFiles ?? {};
  for (const file of reviewFiles) {
    if (isGeneratedRuntimePath(file.path)) {
      continue;
    }
    const absolute = path.resolve(task.worktreePath, file.path);
    if (!pathInside(task.worktreePath, absolute)) {
      throw new Error(`Refusing to restore a path outside the task folder: ${file.path}`);
    }
    if (Object.prototype.hasOwnProperty.call(baseline, file.path)) {
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, baseline[file.path]);
      continue;
    }
    if (fs.existsSync(absolute)) {
      fs.rmSync(absolute, { force: true });
    }
  }
}

async function keepWorktree(input: unknown): Promise<void> {
  if (!isRecord(input)) {
    throw new Error("Invalid keep-worktree input.");
  }
  const task = getTask(requiredString(input.taskId, "taskId"));
  emit({ type: "task.error", taskId: task.id, message: `${task.workspaceKind === "folder" ? "Folder" : "Worktree"} retained at ${task.worktreePath}` });
}

async function cancelTask(input: unknown): Promise<void> {
  if (!isRecord(input)) {
    throw new Error("Invalid cancel input.");
  }
  const task = getTask(requiredString(input.taskId, "taskId"));
  const run = activeOpenCodeRuns.get(task.id);
  if (run) {
    activeOpenCodeRuns.delete(task.id);
    if (run.sessionId) {
      await openCodeRequest<boolean>(run, `/session/${encodeURIComponent(run.sessionId)}/abort`, { method: "POST" }).catch(
        () => undefined,
      );
    }
    stopOpenCodeRun(run);
  }
  clearPendingPermissionsForTask(task.id);
  task.state = "failed";
  task.error = "Task was cancelled.";
  saveTask(task);
  emit({ type: "task.error", taskId: task.id, message: task.error });
}

async function launchCommand(command: string, args: string[]): Promise<IdeOpenResult> {
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

const commandCandidatesByIde: Record<string, string[]> = {
  code: process.platform === "win32" ? ["code.cmd", "code"] : ["code"],
  windsurf: process.platform === "win32" ? ["windsurf.cmd", "windsurf"] : ["windsurf"],
};

function macApplicationExists(appName: string): boolean {
  if (process.platform !== "darwin") {
    return false;
  }
  const appBundle = appName.endsWith(".app") ? appName : `${appName}.app`;
  return [
    path.join("/Applications", appBundle),
    path.join(os.homedir(), "Applications", appBundle),
  ].some((appPath) => fs.existsSync(appPath));
}

function fileManagerIcon(): IdeInfo["icon"] {
  if (process.platform === "darwin") return "finder";
  if (process.platform === "win32") return "explorer";
  return "files";
}

async function firstAvailableCommand(candidates: string[]): Promise<string | null> {
  for (const command of candidates) {
    if (await commandAvailable(command)) {
      return command;
    }
  }
  return null;
}

async function visualStudioExecutable(): Promise<string | null> {
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

async function listAvailableIdes(): Promise<IdeInfo[]> {
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

async function openTaskInIde(input: unknown): Promise<IdeOpenResult> {
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
  if (task.workspaceKind === "git" && !pathInside(worktreeRootForRepo(task.originalRepoPath), task.worktreePath)) {
    return { ok: false, message: "Worktree path is outside Aegis control." };
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
  if (ideId === "explorer") {
    if (relativeFilePath) {
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
    return launchCommand(command, relativeFilePath ? [targetPath] : ["--new-window", targetPath]);
  }
  if (ideId === "code" && macApplicationExists("Visual Studio Code")) {
    return launchCommand(
      "open",
      relativeFilePath
        ? ["-a", "Visual Studio Code", targetPath]
        : ["-na", "Visual Studio Code", "--args", "--new-window", targetPath],
    );
  }
  const error = await shell.openPath(targetPath);
  return error ? { ok: false, message: error } : { ok: true };
}

function setPermissionMode(input: unknown): Promise<BackendStatus> {
  permissionMode = input === "bypass" ? "bypass" : "normal";
  return getBackendStatus();
}

async function setSelectedModel(input: unknown): Promise<BackendStatus> {
  if (!isRecord(input)) {
    throw new Error("Invalid model selection.");
  }
  const providerId = requiredString(input.providerId, "providerId");
  const modelId = requiredString(input.modelId, "modelId");
  if (providerId !== "local-lmstudio") {
    throw new Error("Unsupported local provider.");
  }
  const { models } = await resolveSelectedModel();
  const model = models.find((candidate) => candidate.providerId === providerId && candidate.modelId === modelId);
  if (!model) {
    throw new Error("That local model is not currently available.");
  }
  writeSelectedModel(model);
  return getBackendStatus();
}

function trustedSender(event: IpcMainInvokeEvent): boolean {
  const rawUrl = event.senderFrame?.url || event.sender.getURL();
  try {
    const url = new URL(rawUrl);
    if (isDev) {
      return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port === "5173";
    }
    return url.protocol === "file:";
  } catch {
    return false;
  }
}

function assertTrustedSender(event: IpcMainInvokeEvent) {
  if (!trustedSender(event)) {
    throw new Error("Blocked IPC from an untrusted renderer.");
  }
}

function handleIpc<T>(channel: string, handler: (input: unknown, event: IpcMainInvokeEvent) => Promise<T> | T) {
  ipcMain.handle(channel, async (event, input: unknown) => {
    assertTrustedSender(event);
    return handler(input, event);
  });
}

function allowedAppUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (isDev) {
      return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port === "5173";
    }
    return url.protocol === "file:";
  } catch {
    return false;
  }
}

async function createWindow() {
  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const isFrame = details.resourceType === "mainFrame" || details.resourceType === "subFrame";
    callback({ cancel: isFrame && !allowedAppUrl(details.url) });
  });

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#101112",
    title: "Aegis",
    titleBarStyle: isMac ? "hiddenInset" : isWin ? "hidden" : "default",
    titleBarOverlay: isWin
      ? {
          color: "#1b1d22",
          symbolColor: "#d7dce2",
          height: 35,
        }
      : undefined,
    webPreferences: {
      preload: path.resolve(__dirname, "../preload/preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!allowedAppUrl(url)) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.on("context-menu", (_event, params) => {
    if (!mainWindow) return;
    const template: MenuItemConstructorOptions[] = params.isEditable
      ? [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { type: "separator" },
          { role: "selectAll" },
        ]
      : [
          { role: "copy", enabled: !!params.selectionText },
          { role: "paste" },
          { type: "separator" },
          { role: "selectAll" },
        ];
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });

  if (isDev) {
    await mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    await mainWindow.loadFile(path.resolve(__dirname, "../../dist/index.html"));
  }
}

app.whenReady().then(async () => {
  finishInterruptedRunningTasks();
  handleIpc("aegis:list-chats", () => readChats());
  handleIpc("aegis:create-chat", (input) => createChat(input));
  handleIpc("aegis:update-chat-draft", (input) => updateChatDraft(input));
  handleIpc("aegis:delete-chat", (input) => deleteChat(input));
  handleIpc("aegis:get-task", (input) => publicTaskById(input));
  handleIpc("aegis:refresh-task-review", (input) => refreshTaskReview(input));
  handleIpc("aegis:search-files", (input) => searchRepositoryFiles(input));
  handleIpc("aegis:pick-repository", () => pickRepository());
  handleIpc("aegis:get-repository", (input) => getRepository(input));
  handleIpc("aegis:get-backend-status", () => getBackendStatus());
  handleIpc("aegis:set-permission-mode", (mode) => setPermissionMode(mode));
  handleIpc("aegis:set-selected-model", (input) => setSelectedModel(input));
  handleIpc("aegis:list-available-ides", () => listAvailableIdes());
  handleIpc("aegis:start-task", (input) => startTask(input));
  handleIpc("aegis:approve-worktree-creation", (input) => approveWorktreeCreation(input));
  handleIpc("aegis:respond-tool-permission", (input) => respondToToolPermission(input));
  handleIpc("aegis:open-task-in-ide", (input) => openTaskInIde(input));
  handleIpc("aegis:approve-task-merge", (input) => approveTaskMerge(input));
  handleIpc("aegis:reject-task", (input) => rejectTask(input));
  handleIpc("aegis:keep-worktree", (input) => keepWorktree(input));
  handleIpc("aegis:cancel-task", (input) => cancelTask(input));
  Menu.setApplicationMenu(null);
  await createWindow();
  void getBackendStatus();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  for (const [id, pending] of pendingPermissions) {
    pendingPermissions.delete(id);
    void pending.onDeny();
  }
  for (const [taskId, run] of activeOpenCodeRuns) {
    activeOpenCodeRuns.delete(taskId);
    stopOpenCodeRun(run);
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});
