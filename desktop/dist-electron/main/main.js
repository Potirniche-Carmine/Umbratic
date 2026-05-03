"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const node_child_process_1 = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const isDev = !electron_1.app.isPackaged;
const ollamaBaseUrl = "http://127.0.0.1:11434/v1";
const defaultModelId = "gemma4:e4b";
const defaultModelName = "Gemma 4 E4B via Ollama";
const disabledProviders = [
    "opencode",
    "openai",
    "anthropic",
    "google",
    "gemini",
    "openrouter",
    "xai",
    "azure",
    "amazon-bedrock",
    "groq",
    "mistral",
    "cohere",
    "together",
    "perplexity",
];
const taskStatesThatCanOpen = new Set(["running", "review_ready", "approving", "failed"]);
electron_1.app.enableSandbox();
electron_1.app.setName("Aegis");
const cleanUserData = path.join(electron_1.app.getPath("appData"), "Aegis");
try {
    fs.mkdirSync(cleanUserData, { recursive: true });
    electron_1.app.setPath("userData", cleanUserData);
}
catch {
    /* Electron will use the default userData path. */
}
let mainWindow = null;
let permissionMode = "normal";
const pendingPermissions = new Map();
function dataFile(name) {
    return path.join(electron_1.app.getPath("userData"), name);
}
function projectsPath() {
    return dataFile("projects.json");
}
function tasksPath() {
    return dataFile("tasks.json");
}
function chatsPath() {
    return dataFile("chats.json");
}
function readJsonFile(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
    catch {
        return fallback;
    }
}
function writeJsonFile(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
function readProjects() {
    return readJsonFile(projectsPath(), []).filter((project) => project &&
        typeof project.id === "string" &&
        typeof project.rootPath === "string" &&
        (project.kind === "git" || project.kind === "folder" || project.kind === undefined) &&
        fs.existsSync(project.rootPath)).map((project) => ({ ...project, kind: project.kind ?? "git" }));
}
function writeProjects(projects) {
    writeJsonFile(projectsPath(), projects);
}
function readTasks() {
    return readJsonFile(tasksPath(), []).filter((task) => task &&
        typeof task.id === "string" &&
        typeof task.originalRepoPath === "string" &&
        typeof task.worktreePath === "string").map((task) => ({
        ...task,
        workspaceKind: task.workspaceKind ?? "git",
        reviewFiles: Array.isArray(task.reviewFiles) ? task.reviewFiles : [],
        events: Array.isArray(task.events) ? task.events : [],
    }));
}
function writeTasks(tasks) {
    writeJsonFile(tasksPath(), tasks);
}
function readChats() {
    return readJsonFile(chatsPath(), [])
        .filter((chat) => chat &&
        typeof chat.id === "string" &&
        typeof chat.title === "string" &&
        typeof chat.createdAt === "string" &&
        typeof chat.updatedAt === "string")
        .map((chat) => ({
        ...chat,
        draftPrompt: typeof chat.draftPrompt === "string" ? chat.draftPrompt : "",
        attachedFiles: Array.isArray(chat.attachedFiles)
            ? chat.attachedFiles.filter((file) => file && typeof file.path === "string" && typeof file.name === "string")
            : [],
    }))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
function writeChats(chats) {
    writeJsonFile(chatsPath(), chats);
}
function saveChat(chat) {
    const chats = [chat, ...readChats().filter((row) => row.id !== chat.id)];
    writeChats(chats);
}
function saveTask(task) {
    const existingTasks = readTasks();
    const existing = existingTasks.find((row) => row.id === task.id);
    const taskEvents = Array.isArray(task.events) ? task.events : [];
    const existingEvents = Array.isArray(existing?.events) ? existing.events : [];
    const nextTask = {
        ...task,
        events: existingEvents.length >= taskEvents.length ? existingEvents : taskEvents,
    };
    const tasks = [nextTask, ...existingTasks.filter((row) => row.id !== task.id)];
    writeTasks(tasks);
    updateChatFromTask(nextTask);
}
function publicTask(task) {
    const { id, chatId, repositoryId, prompt, workspaceKind, state, originalBranch, baseCommit, agentBranch, worktreePath, permissionMode: mode, createdAt, changedFiles, reviewFiles, events, latestTest, patchHash, error, } = task;
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
        createdAt,
        changedFiles,
        reviewFiles,
        events,
        latestTest,
        patchHash,
        error,
    };
}
function getTask(taskId) {
    const task = readTasks().find((row) => row.id === taskId);
    if (!task) {
        throw new Error("Task was not found.");
    }
    return task;
}
function publicTaskById(input) {
    if (!isRecord(input) || typeof input.taskId !== "string" || !input.taskId.trim()) {
        return null;
    }
    const taskIdValue = input.taskId.trim();
    const task = readTasks().find((row) => row.id === taskIdValue);
    return task ? publicTask(task) : null;
}
function stableRepositoryId(rootPath) {
    return crypto.createHash("sha256").update(path.resolve(rootPath).toLowerCase()).digest("hex").slice(0, 16);
}
function taskId() {
    return `task-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}
function chatId() {
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
function titleWord(word) {
    if (!word)
        return word;
    if (word === word.toUpperCase() || word.includes("_") || word.includes("-"))
        return word;
    return `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}`;
}
function chatTitleFromPrompt(prompt) {
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
function createChat(input) {
    const title = isRecord(input) && typeof input.title === "string" && input.title.trim()
        ? input.title.trim().slice(0, 72)
        : "New chat";
    const repositoryName = isRecord(input) && typeof input.repositoryName === "string" && input.repositoryName.trim()
        ? input.repositoryName.trim().slice(0, 120)
        : undefined;
    const repositoryPath = isRecord(input) && typeof input.repositoryPath === "string" && input.repositoryPath.trim()
        ? path.resolve(input.repositoryPath.trim())
        : undefined;
    const now = new Date().toISOString();
    const chat = {
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
function updateChatDraft(input) {
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
            .filter((file) => isRecord(file))
            .map((file) => ({
            path: typeof file.path === "string" ? normalizeRelativePath(file.path).slice(0, 260) : "",
            name: typeof file.name === "string" ? file.name.slice(0, 120) : "",
        }))
            .filter((file) => file.path && file.name)
            .slice(0, 16)
        : existing.attachedFiles ?? [];
    const draftPrompt = typeof input.draftPrompt === "string" ? input.draftPrompt.slice(0, 12000) : existing.draftPrompt ?? "";
    const next = {
        ...existing,
        draftPrompt,
        attachedFiles,
        updatedAt: new Date().toISOString(),
    };
    writeChats([next, ...chats.filter((chat) => chat.id !== id)]);
    return next;
}
function deleteChat(input) {
    if (!isRecord(input)) {
        throw new Error("Invalid chat delete input.");
    }
    const id = requiredString(input.chatId, "chatId");
    writeChats(readChats().filter((chat) => chat.id !== id));
    return { ok: true };
}
function updateChatFromTask(task) {
    if (!task.chatId) {
        return;
    }
    const chats = readChats();
    const existing = chats.find((chat) => chat.id === task.chatId);
    const repository = readProjects().find((project) => project.id === task.repositoryId);
    const next = {
        id: task.chatId,
        title: chatTitleFromPrompt(task.prompt),
        createdAt: existing?.createdAt ?? task.createdAt,
        updatedAt: new Date().toISOString(),
        taskId: task.id,
        taskState: task.state,
        repositoryName: repository?.name,
        repositoryPath: repository?.rootPath,
        changedFiles: task.changedFiles.length,
        draftPrompt: existing?.draftPrompt ?? "",
        attachedFiles: existing?.attachedFiles ?? [],
    };
    writeChats([next, ...chats.filter((chat) => chat.id !== task.chatId)]);
}
function slugify(value) {
    const slug = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32);
    return slug || "change";
}
function normalizeRelativePath(value) {
    return value.replace(/\\/g, "/").replace(/^\.\/+/, "");
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
function textLines(value) {
    const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") {
        lines.pop();
    }
    return lines;
}
function readTextFileIfSafe(filePath) {
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
    }
    catch {
        return null;
    }
}
function snapshotFolder(rootPath) {
    const root = path.resolve(rootPath);
    const snapshot = {};
    const stack = [root];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {
            continue;
        }
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        }
        catch {
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
function diffHeader(filePath, status) {
    const escaped = filePath.replace(/\\/g, "/");
    if (status === "added") {
        return [`diff --git a/${escaped} b/${escaped}`, "new file mode 100644", "--- /dev/null", `+++ b/${escaped}`];
    }
    if (status === "deleted") {
        return [`diff --git a/${escaped} b/${escaped}`, "deleted file mode 100644", `--- a/${escaped}`, "+++ /dev/null"];
    }
    return [`diff --git a/${escaped} b/${escaped}`, `--- a/${escaped}`, `+++ b/${escaped}`];
}
function lcsLineDiff(before, after) {
    const rows = before.length;
    const cols = after.length;
    const table = Array.from({ length: rows + 1 }, () => Array(cols + 1).fill(0));
    for (let row = rows - 1; row >= 0; row -= 1) {
        for (let col = cols - 1; col >= 0; col -= 1) {
            table[row][col] =
                before[row] === after[col]
                    ? table[row + 1][col + 1] + 1
                    : Math.max(table[row + 1][col], table[row][col + 1]);
        }
    }
    const diff = [];
    let row = 0;
    let col = 0;
    while (row < rows || col < cols) {
        if (row < rows && col < cols && before[row] === after[col]) {
            diff.push(` ${before[row]}`);
            row += 1;
            col += 1;
        }
        else if (col < cols && (row === rows || table[row][col + 1] >= table[row + 1][col])) {
            diff.push(`+${after[col]}`);
            col += 1;
        }
        else if (row < rows) {
            diff.push(`-${before[row]}`);
            row += 1;
        }
    }
    return diff;
}
function buildTextDiff(filePath, before, after) {
    if (before === after) {
        return null;
    }
    const status = before === null ? "added" : after === null ? "deleted" : "modified";
    const beforeLines = before === null ? [] : textLines(before);
    const afterLines = after === null ? [] : textLines(after);
    const body = status === "added"
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
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function requiredString(value, field) {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`Invalid ${field}.`);
    }
    return value.trim();
}
function quoteCommandArg(arg) {
    return /\s|"/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}
function commandText(command, args) {
    return [command, ...args].map(quoteCommandArg).join(" ");
}
function pathInside(parent, child) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}
function worktreeRootForRepo(repoRoot) {
    return path.join(path.dirname(repoRoot), ".aegis-worktrees", path.basename(repoRoot));
}
function taskMetadataPath(task) {
    return path.join(electron_1.app.getPath("userData"), "task-metadata", `${task.id}.json`);
}
function recordTaskEvent(event) {
    const tasks = readTasks();
    const task = tasks.find((row) => row.id === event.taskId);
    if (!task)
        return;
    task.events = [...task.events, event].slice(-500);
    writeTasks([task, ...tasks.filter((row) => row.id !== task.id)]);
}
function emit(event) {
    recordTaskEvent(event);
    mainWindow?.webContents.send("aegis:backend-event", event);
}
function failTask(task, message) {
    task.state = "failed";
    task.error = message;
    saveTask(task);
    emit({ type: "task.error", taskId: task.id, message });
}
function execFileOutput(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        (0, node_child_process_1.execFile)(command, args, {
            cwd: options.cwd,
            env: options.env,
            windowsHide: true,
            timeout: options.timeout ?? 180000,
            maxBuffer: 8 * 1024 * 1024,
        }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`${error.message}${stderr ? `\n${stderr}` : ""}`));
                return;
            }
            resolve({ stdout: String(stdout), stderr: String(stderr) });
        });
    });
}
function execFileResult(command, args, options = {}) {
    return new Promise((resolve) => {
        (0, node_child_process_1.execFile)(command, args, {
            cwd: options.cwd,
            env: options.env,
            windowsHide: true,
            timeout: options.timeout ?? 180000,
            maxBuffer: 8 * 1024 * 1024,
        }, (error, stdout, stderr) => {
            const exitCode = error && typeof error.code === "number"
                ? (error.code)
                : error
                    ? 1
                    : 0;
            resolve({
                stdout: String(stdout),
                stderr: String(stderr) || (error ? String(error.message) : ""),
                exitCode,
                success: !error,
            });
        });
    });
}
async function gitOutput(cwd, args) {
    const output = await execFileOutput("git", args, { cwd });
    return output.stdout.trim();
}
async function gitResult(cwd, args) {
    return execFileResult("git", args, { cwd });
}
async function commandAvailable(command) {
    try {
        await execFileOutput(process.platform === "win32" ? "where.exe" : "which", [command], { timeout: 5000 });
        return true;
    }
    catch {
        return false;
    }
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function addSearchResult(results, rootPath, relativePath, match) {
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
function fallbackFileSearch(rootPath, query, limit) {
    const root = path.resolve(rootPath);
    const queryLower = query.toLowerCase();
    const results = new Map();
    const stack = [root];
    while (stack.length && results.size < limit) {
        const current = stack.pop();
        if (!current)
            continue;
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        }
        catch {
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
            if (!entry.isFile())
                continue;
            if (!queryLower || relative.toLowerCase().includes(queryLower)) {
                addSearchResult(results, root, relative, "path");
            }
            if (results.size >= limit)
                break;
        }
    }
    return Array.from(results.values()).slice(0, limit);
}
async function searchRepositoryFiles(input) {
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
    const results = new Map();
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
        const listed = await execFileResult("rg", ["--files", ...ignoreArgs], { cwd: rootPath, timeout: 15000 });
        for (const file of listed.stdout.split(/\r?\n/)) {
            if (!query || normalizeRelativePath(file).toLowerCase().includes(query.toLowerCase())) {
                addSearchResult(results, rootPath, file, "path");
            }
            if (results.size >= limit)
                break;
        }
        if (query.length >= 2 && results.size < limit) {
            const contentMatches = await execFileResult("rg", ["--ignore-case", "--files-with-matches", ...ignoreArgs, escapeRegExp(query)], {
                cwd: rootPath,
                timeout: 15000,
            });
            for (const file of contentMatches.stdout.split(/\r?\n/)) {
                addSearchResult(results, rootPath, file, "content");
                if (results.size >= limit)
                    break;
            }
        }
    }
    if (results.size === 0) {
        for (const result of fallbackFileSearch(rootPath, query, limit)) {
            results.set(result.path, result);
        }
    }
    return Array.from(results.values()).slice(0, limit);
}
async function fetchJson(url, init = {}) {
    const response = await fetch(url, init);
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`${response.status} ${response.statusText}${body ? `: ${body.slice(0, 240)}` : ""}`);
    }
    return response.json();
}
function opencodeBinaryPath() {
    const binary = process.platform === "win32" ? "opencode.exe" : "opencode";
    const platform = process.platform === "win32" ? "windows" : process.platform;
    const arch = process.arch;
    const packageNames = platform === "windows" && arch === "x64"
        ? ["opencode-windows-x64", "opencode-windows-x64-baseline"]
        : platform === "windows" && arch === "arm64"
            ? ["opencode-windows-arm64"]
            : platform === "darwin" && arch === "arm64"
                ? ["opencode-darwin-arm64"]
                : platform === "darwin" && arch === "x64"
                    ? ["opencode-darwin-x64", "opencode-darwin-x64-baseline"]
                    : platform === "linux" && arch === "arm64"
                        ? ["opencode-linux-arm64", "opencode-linux-arm64-musl"]
                        : platform === "linux" && arch === "x64"
                            ? [
                                "opencode-linux-x64",
                                "opencode-linux-x64-baseline",
                                "opencode-linux-x64-musl",
                                "opencode-linux-x64-baseline-musl",
                            ]
                            : [];
    for (const packageName of packageNames) {
        try {
            return require.resolve(`${packageName}/bin/${binary}`);
        }
        catch {
            const candidate = path.resolve(__dirname, "../../../node_modules", packageName, "bin", binary);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }
    try {
        return require.resolve("opencode-ai/bin/opencode");
    }
    catch {
        const candidate = path.resolve(__dirname, "../../../node_modules/opencode-ai/bin/opencode");
        return fs.existsSync(candidate) ? candidate : null;
    }
}
async function getBackendStatus() {
    let ollama = "unavailable";
    let message;
    try {
        const models = await fetchJson(`${ollamaBaseUrl}/models`, {
            signal: AbortSignal.timeout(1800),
        });
        const hasDefault = models.data?.some((model) => model.id === defaultModelId);
        ollama = hasDefault ? "ready" : "degraded";
        if (!hasDefault) {
            message = `${defaultModelId} is not listed by Ollama. Pull it before running a real model task.`;
        }
    }
    catch {
        message = `Ollama is not reachable at ${ollamaBaseUrl}.`;
    }
    return {
        opencode: opencodeBinaryPath() ? "ready" : "unavailable",
        ollama,
        model: {
            providerId: "local-ollama",
            modelId: defaultModelId,
            displayName: defaultModelName,
            baseUrl: ollamaBaseUrl,
        },
        permissionMode,
        privacy: {
            share: "disabled",
            enabledProviders: ["local-ollama"],
            disabledProviders,
            webTools: "disabled",
        },
        message,
    };
}
async function inspectRepository(selectedPath) {
    const selected = path.resolve(selectedPath);
    if (!fs.existsSync(selected) || !fs.statSync(selected).isDirectory()) {
        throw new Error("Selected path is not a folder.");
    }
    let root = selected;
    let kind = "folder";
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
    }
    catch {
        kind = "folder";
    }
    const repository = {
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
async function pickRepository() {
    const options = {
        title: "Select Repository",
        properties: ["openDirectory"],
    };
    const result = mainWindow ? await electron_1.dialog.showOpenDialog(mainWindow, options) : await electron_1.dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
    }
    return { canceled: false, repository: await inspectRepository(result.filePaths[0]) };
}
function buildOpenCodeConfig(mode) {
    const toolPermission = mode === "bypass"
        ? { webfetch: "deny", websearch: "deny", external_directory: "ask", edit: "allow", bash: "allow" }
        : { webfetch: "deny", websearch: "deny", external_directory: "ask", edit: "ask", bash: "ask" };
    return {
        $schema: "https://opencode.ai/config.json",
        share: "disabled",
        autoupdate: false,
        model: `local-ollama/${defaultModelId}`,
        small_model: `local-ollama/${defaultModelId}`,
        enabled_providers: ["local-ollama"],
        disabled_providers: disabledProviders,
        provider: {
            "local-ollama": {
                npm: "@ai-sdk/openai-compatible",
                name: "Local Ollama",
                options: { baseURL: ollamaBaseUrl },
                models: {
                    [defaultModelId]: { name: defaultModelName },
                },
            },
        },
        server: {
            hostname: "127.0.0.1",
            mdns: false,
            cors: [],
        },
        mcp: {},
        plugin: [],
        instructions: [],
        permission: toolPermission,
    };
}
function runtimeEnv(worktreePath) {
    const runtimeRoot = path.join(worktreePath, ".aegis", "runtime");
    return {
        ...process.env,
        UV_INSTALL_DIR: path.join(runtimeRoot, "uv"),
        UV_UNMANAGED_INSTALL: path.join(runtimeRoot, "uv"),
        UV_NO_MODIFY_PATH: "1",
        UV_PYTHON_INSTALL_DIR: path.join(runtimeRoot, "python"),
        UV_PYTHON_BIN_DIR: path.join(runtimeRoot, "python-bin"),
        UV_CACHE_DIR: path.join(runtimeRoot, "uv-cache"),
    };
}
async function askPermission(task, request) {
    const id = `perm-${crypto.randomBytes(6).toString("hex")}`;
    const fullRequest = { id, ...request };
    emit({ type: "permission.requested", taskId: task.id, request: fullRequest });
    if (task.permissionMode === "bypass") {
        emit({ type: "permission.resolved", taskId: task.id, id, decision: "allow" });
        return;
    }
    return new Promise((resolve, reject) => {
        pendingPermissions.set(id, { taskId: task.id, resolve, reject });
    });
}
function respondToToolPermission(input) {
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
        pending.resolve();
    }
    else {
        pending.reject(new Error("The user denied the requested tool action."));
    }
}
async function runCommandForTask(task, command, args, options) {
    await askPermission(task, {
        kind: "bash",
        summary: commandText(command, args),
        command: commandText(command, args),
        cwd: options.cwd,
    });
    const id = `cmd-${crypto.randomBytes(6).toString("hex")}`;
    emit({ type: "command.started", taskId: task.id, id, command: commandText(command, args), cwd: options.cwd });
    return new Promise((resolve) => {
        const child = (0, node_child_process_1.spawn)(command, args, {
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
        child.stdout?.on("data", (chunk) => {
            const text = chunk.toString("utf8");
            stdout = `${stdout}${text}`.slice(-12000);
            emit({ type: "command.output", taskId: task.id, id, stream: "stdout", text });
        });
        child.stderr?.on("data", (chunk) => {
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
async function getChangedFiles(worktreePath, baseCommit) {
    const tracked = await gitOutput(worktreePath, ["diff", "--name-only", "--diff-filter=ACMRTD", baseCommit]);
    const untracked = await gitOutput(worktreePath, ["ls-files", "--others", "--exclude-standard"]);
    return Array.from(new Set([...tracked.split(/\r?\n/), ...untracked.split(/\r?\n/)]
        .map((row) => normalizeRelativePath(row.trim()))
        .filter(Boolean))).sort((a, b) => a.localeCompare(b));
}
function folderReviewFiles(task) {
    const before = task.baselineFiles ?? {};
    const after = snapshotFolder(task.worktreePath);
    const paths = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
        .filter((file) => !isGeneratedRuntimePath(file))
        .sort((a, b) => a.localeCompare(b));
    return paths
        .map((file) => buildTextDiff(file, before[file] ?? null, after[file] ?? null))
        .filter((file) => !!file);
}
async function gitReviewFiles(task) {
    const changed = (await getChangedFiles(task.worktreePath, task.baseCommit))
        .filter((file) => !isGeneratedRuntimePath(file))
        .sort((a, b) => a.localeCompare(b));
    const files = [];
    for (const file of changed) {
        const absolute = path.join(task.worktreePath, file);
        const status = await gitFileStatus(task, file);
        const diff = await gitOutput(task.worktreePath, ["diff", "--no-ext-diff", "--unified=80", task.baseCommit, "--", file]).catch(() => "");
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
async function gitFileStatus(task, file) {
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
async function refreshReview(task) {
    const reviewFiles = task.workspaceKind === "folder" ? folderReviewFiles(task) : await gitReviewFiles(task);
    task.reviewFiles = reviewFiles;
    task.changedFiles = reviewFiles.map((file) => file.path);
    return reviewFiles;
}
async function refreshTaskReview(input) {
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
async function writeHelloWorld(task) {
    await askPermission(task, {
        kind: "edit",
        summary: "write hello_world.py",
        command: "write hello_world.py",
        cwd: task.worktreePath,
    });
    const id = `cmd-${crypto.randomBytes(6).toString("hex")}`;
    emit({ type: "command.started", taskId: task.id, id, command: "write hello_world.py", cwd: task.worktreePath });
    fs.writeFileSync(path.join(task.worktreePath, "hello_world.py"), 'print("hello world")\n');
    emit({ type: "command.output", taskId: task.id, id, stream: "stdout", text: "created hello_world.py\n" });
    emit({ type: "command.finished", taskId: task.id, id, exitCode: 0 });
}
async function verifyHelloWorld(task) {
    const env = runtimeEnv(task.worktreePath);
    const candidates = process.platform === "win32"
        ? [
            { command: "py", args: ["-3", "hello_world.py"] },
            { command: "python", args: ["hello_world.py"] },
        ]
        : [
            { command: "python3", args: ["hello_world.py"] },
            { command: "python", args: ["hello_world.py"] },
        ];
    for (const candidate of candidates) {
        const result = await runCommandForTask(task, candidate.command, candidate.args, {
            cwd: task.worktreePath,
            env,
            timeout: 120000,
        });
        if (result.success && result.stdout.trim() === "hello world") {
            return {
                command: commandText(candidate.command, candidate.args),
                output: result.stdout.trim(),
                passed: true,
                exitCode: result.exitCode,
                completedAt: new Date().toISOString(),
            };
        }
    }
    if (await commandAvailable("uv")) {
        await runCommandForTask(task, "uv", ["python", "install", "3.12"], {
            cwd: task.worktreePath,
            env,
            timeout: 10 * 60 * 1000,
        });
        const result = await runCommandForTask(task, "uv", ["run", "--python", "3.12", "python", "hello_world.py"], {
            cwd: task.worktreePath,
            env,
            timeout: 10 * 60 * 1000,
        });
        return {
            command: "uv run --python 3.12 python hello_world.py",
            output: result.stdout.trim() || result.stderr.trim(),
            passed: result.success && result.stdout.trim() === "hello world",
            exitCode: result.exitCode,
            completedAt: new Date().toISOString(),
        };
    }
    return {
        command: "python hello_world.py",
        output: "Python was not found and uv is not available.",
        passed: false,
        exitCode: null,
        completedAt: new Date().toISOString(),
    };
}
async function runHelloWorldTask(taskIdValue) {
    const task = getTask(taskIdValue);
    try {
        emit({ type: "assistant.delta", taskId: task.id, text: "Starting the isolated hello-world task in the worktree.\n" });
        await writeHelloWorld(task);
        const test = await verifyHelloWorld(task);
        task.latestTest = test;
        const reviewFiles = await refreshReview(task);
        if (!test.passed) {
            failTask(task, test.output || "Verification failed.");
            return;
        }
        task.state = "review_ready";
        saveTask(task);
        emit({ type: "assistant.delta", taskId: task.id, text: "hello_world.py is verified and ready for review.\n" });
        emit({ type: "assistant.done", taskId: task.id });
        emit({ type: "review.ready", taskId: task.id, changedFiles: task.changedFiles, reviewFiles, latestTest: task.latestTest });
    }
    catch (error) {
        failTask(task, String(error instanceof Error ? error.message : error));
    }
}
async function createWorktreeAndRun(task) {
    try {
        fs.mkdirSync(path.dirname(task.worktreePath), { recursive: true });
        await execFileOutput("git", ["worktree", "add", "-b", task.agentBranch, task.worktreePath, task.baseCommit], {
            cwd: task.originalRepoPath,
            timeout: 120000,
        });
        task.state = "running";
        saveTask(task);
        emit({ type: "worktree.created", taskId: task.id, branch: task.agentBranch, path: task.worktreePath });
        void runHelloWorldTask(task.id);
    }
    catch (error) {
        failTask(task, String(error instanceof Error ? error.message : error));
    }
}
async function startTask(input) {
    if (!isRecord(input)) {
        throw new Error("Invalid task input.");
    }
    const repositoryId = requiredString(input.repositoryId, "repositoryId");
    const prompt = requiredString(input.prompt, "prompt");
    const requestedChatId = typeof input.chatId === "string" && input.chatId.trim() ? input.chatId.trim() : undefined;
    const chat = (requestedChatId ? readChats().find((row) => row.id === requestedChatId) : undefined) ??
        createChat({ title: chatTitleFromPrompt(prompt) });
    const repository = readProjects().find((project) => project.id === repositoryId);
    if (!repository) {
        throw new Error("Repository has not been selected.");
    }
    const refreshed = await inspectRepository(repository.rootPath);
    const id = taskId();
    const branch = refreshed.kind === "git" ? `aegis/${id}-${slugify(prompt)}` : "";
    const worktreePath = refreshed.kind === "git" ? path.join(worktreeRootForRepo(refreshed.rootPath), id) : refreshed.rootPath;
    const task = {
        id,
        chatId: chat?.id,
        repositoryId,
        prompt,
        workspaceKind: refreshed.kind,
        state: refreshed.kind === "folder" || permissionMode === "bypass" ? "running" : "awaiting_worktree_approval",
        originalBranch: refreshed.originalBranch,
        baseCommit: refreshed.baseCommit,
        agentBranch: branch,
        worktreePath,
        permissionMode,
        createdAt: new Date().toISOString(),
        changedFiles: [],
        reviewFiles: [],
        events: [],
        originalRepoPath: refreshed.rootPath,
        originalWasDirty: refreshed.dirty,
        baselineFiles: refreshed.kind === "folder" ? snapshotFolder(refreshed.rootPath) : undefined,
    };
    saveTask(task);
    if (refreshed.kind === "folder") {
        void runHelloWorldTask(task.id);
    }
    else if (permissionMode === "bypass") {
        await createWorktreeAndRun(task);
    }
    else {
        emit({ type: "worktree.requested", taskId: task.id, branch, path: worktreePath, baseCommit: refreshed.baseCommit });
    }
    return publicTask(task);
}
async function approveWorktreeCreation(input) {
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
        task.rejectedAt = new Date().toISOString();
        saveTask(task);
        emit({ type: "task.error", taskId: task.id, message: "Worktree creation was declined." });
        return;
    }
    await createWorktreeAndRun(task);
}
function isGeneratedRuntimePath(filePath) {
    const normalized = normalizeRelativePath(filePath);
    return (normalized.startsWith(".aegis/runtime/") ||
        normalized.startsWith(".venv/") ||
        normalized.startsWith("venv/") ||
        normalized.includes("/__pycache__/") ||
        normalized.endsWith(".pyc") ||
        normalized.startsWith("node_modules/") ||
        normalized.startsWith(".git/"));
}
function isBlockedPath(filePath) {
    const normalized = normalizeRelativePath(filePath);
    const basename = path.posix.basename(normalized);
    return (normalized === ".env" ||
        normalized.startsWith(".env.") ||
        basename.endsWith(".pem") ||
        basename.endsWith(".key") ||
        basename === "id_rsa" ||
        basename === "id_ed25519" ||
        normalized.includes("credential") ||
        normalized.includes("secret"));
}
function secretScanText(text) {
    const patterns = [
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
async function approvalCheck(task, name, run) {
    emit({ type: "approval.check", taskId: task.id, name, status: "running" });
    try {
        const result = await run();
        const detail = typeof result === "string" ? result : undefined;
        emit({ type: "approval.check", taskId: task.id, name, status: "passed", detail });
    }
    catch (error) {
        const detail = String(error instanceof Error ? error.message : error);
        emit({ type: "approval.check", taskId: task.id, name, status: "failed", detail });
        throw error;
    }
}
async function approveTaskMerge(input) {
    if (!isRecord(input)) {
        throw new Error("Invalid approval input.");
    }
    const task = getTask(requiredString(input.taskId, "taskId"));
    task.state = "approving";
    saveTask(task);
    try {
        let allowedFiles = [];
        let patchHash = "";
        if (task.workspaceKind === "folder") {
            await approvalCheck(task, "latest verification", async () => {
                if (!task.latestTest?.passed || task.latestTest.output.trim() !== "hello world") {
                    throw new Error("Latest passing verification did not print hello world.");
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
        await approvalCheck(task, "latest verification", async () => {
            if (!task.latestTest?.passed || task.latestTest.output.trim() !== "hello world") {
                throw new Error("Latest passing verification did not print hello world.");
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
            await execFileOutput("git", ["commit", "-m", `Aegis task ${task.id}`, "-m", `Patch-Hash: ${patchHash}`], { cwd: task.worktreePath, env });
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
            await execFileOutput("git", ["worktree", "remove", "--force", task.worktreePath], { cwd: task.originalRepoPath });
            await gitResult(task.originalRepoPath, ["branch", "-d", task.agentBranch]);
            return "removed";
        });
        emit({ type: "merge.completed", taskId: task.id, targetBranch: task.originalBranch, commit: mergedCommit, patchHash });
        return { ok: true, targetBranch: task.originalBranch, commit: mergedCommit, patchHash, metadataPath: task.metadataPath ?? "" };
    }
    catch (error) {
        const message = String(error instanceof Error ? error.message : error);
        failTask(task, message);
        return { ok: false, message };
    }
}
async function rejectTask(input) {
    if (!isRecord(input)) {
        throw new Error("Invalid reject input.");
    }
    const task = getTask(requiredString(input.taskId, "taskId"));
    const cleanup = input.cleanup === true;
    if (task.workspaceKind === "git" && cleanup && taskStatesThatCanOpen.has(task.state) && fs.existsSync(task.worktreePath)) {
        await execFileOutput("git", ["worktree", "remove", "--force", task.worktreePath], { cwd: task.originalRepoPath });
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
function restoreFolderTaskChanges(task, reviewFiles) {
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
async function keepWorktree(input) {
    if (!isRecord(input)) {
        throw new Error("Invalid keep-worktree input.");
    }
    const task = getTask(requiredString(input.taskId, "taskId"));
    emit({ type: "task.error", taskId: task.id, message: `${task.workspaceKind === "folder" ? "Folder" : "Worktree"} retained at ${task.worktreePath}` });
}
async function cancelTask(input) {
    if (!isRecord(input)) {
        throw new Error("Invalid cancel input.");
    }
    const task = getTask(requiredString(input.taskId, "taskId"));
    task.state = "failed";
    task.error = "Task was cancelled.";
    saveTask(task);
    emit({ type: "task.error", taskId: task.id, message: task.error });
}
async function launchCommand(command, args) {
    try {
        const isWindows = process.platform === "win32";
        const isBatch = isWindows && /\.(cmd|bat)$/i.test(command);
        const child = isBatch
            ? (0, node_child_process_1.spawn)("cmd.exe", ["/c", command, ...args], { detached: true, stdio: "ignore", windowsHide: true })
            : (0, node_child_process_1.spawn)(command, args, { detached: true, stdio: "ignore", windowsHide: true });
        child.unref();
        return { ok: true };
    }
    catch (error) {
        return { ok: false, message: String(error instanceof Error ? error.message : error) };
    }
}
const commandCandidatesByIde = {
    code: process.platform === "win32" ? ["code.cmd", "code"] : ["code"],
    windsurf: process.platform === "win32" ? ["windsurf.cmd", "windsurf"] : ["windsurf"],
};
function macApplicationExists(appName) {
    if (process.platform !== "darwin") {
        return false;
    }
    const appBundle = appName.endsWith(".app") ? appName : `${appName}.app`;
    return [
        path.join("/Applications", appBundle),
        path.join(os.homedir(), "Applications", appBundle),
    ].some((appPath) => fs.existsSync(appPath));
}
function fileManagerIcon() {
    if (process.platform === "darwin")
        return "finder";
    if (process.platform === "win32")
        return "explorer";
    return "files";
}
async function firstAvailableCommand(candidates) {
    for (const command of candidates) {
        if (await commandAvailable(command)) {
            return command;
        }
    }
    return null;
}
async function visualStudioExecutable() {
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
        const output = await execFileOutput(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.Component.MSBuild", "-property", "productPath"], { timeout: 5000 });
        const executable = output.stdout.trim().split(/\r?\n/).find(Boolean);
        return executable && fs.existsSync(executable) ? executable : null;
    }
    catch {
        return null;
    }
}
async function listAvailableIdes() {
    const ides = [];
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
async function openTaskInIde(input) {
    if (!isRecord(input)) {
        throw new Error("Invalid IDE input.");
    }
    const task = getTask(requiredString(input.taskId, "taskId"));
    const ideId = requiredString(input.ideId, "ideId");
    const relativeFilePath = typeof input.filePath === "string" && input.filePath.trim()
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
            electron_1.shell.showItemInFolder(targetPath);
            return { ok: true };
        }
        const error = await electron_1.shell.openPath(targetPath);
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
        return launchCommand("open", relativeFilePath
            ? ["-a", "Visual Studio Code", targetPath]
            : ["-na", "Visual Studio Code", "--args", "--new-window", targetPath]);
    }
    const error = await electron_1.shell.openPath(targetPath);
    return error ? { ok: false, message: error } : { ok: true };
}
function setPermissionMode(input) {
    permissionMode = input === "bypass" ? "bypass" : "normal";
    buildOpenCodeConfig(permissionMode);
    return getBackendStatus();
}
function trustedSender(event) {
    const rawUrl = event.senderFrame?.url || event.sender.getURL();
    try {
        const url = new URL(rawUrl);
        if (isDev) {
            return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port === "5173";
        }
        return url.protocol === "file:";
    }
    catch {
        return false;
    }
}
function assertTrustedSender(event) {
    if (!trustedSender(event)) {
        throw new Error("Blocked IPC from an untrusted renderer.");
    }
}
function handleIpc(channel, handler) {
    electron_1.ipcMain.handle(channel, async (event, input) => {
        assertTrustedSender(event);
        return handler(input, event);
    });
}
function allowedAppUrl(rawUrl) {
    try {
        const url = new URL(rawUrl);
        if (isDev) {
            return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port === "5173";
        }
        return url.protocol === "file:";
    }
    catch {
        return false;
    }
}
async function createWindow() {
    const isMac = process.platform === "darwin";
    const isWin = process.platform === "win32";
    electron_1.session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
        callback(false);
    });
    electron_1.session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const isFrame = details.resourceType === "mainFrame" || details.resourceType === "subFrame";
        callback({ cancel: isFrame && !allowedAppUrl(details.url) });
    });
    mainWindow = new electron_1.BrowserWindow({
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
    if (isDev) {
        await mainWindow.loadURL("http://127.0.0.1:5173");
    }
    else {
        await mainWindow.loadFile(path.resolve(__dirname, "../../dist/index.html"));
    }
}
electron_1.app.whenReady().then(async () => {
    handleIpc("aegis:list-chats", () => readChats());
    handleIpc("aegis:create-chat", (input) => createChat(input));
    handleIpc("aegis:update-chat-draft", (input) => updateChatDraft(input));
    handleIpc("aegis:delete-chat", (input) => deleteChat(input));
    handleIpc("aegis:get-task", (input) => publicTaskById(input));
    handleIpc("aegis:refresh-task-review", (input) => refreshTaskReview(input));
    handleIpc("aegis:search-files", (input) => searchRepositoryFiles(input));
    handleIpc("aegis:pick-repository", () => pickRepository());
    handleIpc("aegis:get-backend-status", () => getBackendStatus());
    handleIpc("aegis:set-permission-mode", (mode) => setPermissionMode(mode));
    handleIpc("aegis:list-available-ides", () => listAvailableIdes());
    handleIpc("aegis:start-task", (input) => startTask(input));
    handleIpc("aegis:approve-worktree-creation", (input) => approveWorktreeCreation(input));
    handleIpc("aegis:respond-tool-permission", (input) => respondToToolPermission(input));
    handleIpc("aegis:open-task-in-ide", (input) => openTaskInIde(input));
    handleIpc("aegis:approve-task-merge", (input) => approveTaskMerge(input));
    handleIpc("aegis:reject-task", (input) => rejectTask(input));
    handleIpc("aegis:keep-worktree", (input) => keepWorktree(input));
    handleIpc("aegis:cancel-task", (input) => cancelTask(input));
    electron_1.Menu.setApplicationMenu(null);
    await createWindow();
    void getBackendStatus();
});
electron_1.app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        electron_1.app.quit();
    }
});
electron_1.app.on("before-quit", () => {
    for (const [id, pending] of pendingPermissions) {
        pendingPermissions.delete(id);
        pending.reject(new Error("Aegis is quitting."));
    }
});
electron_1.app.on("activate", () => {
    if (electron_1.BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
    }
});
