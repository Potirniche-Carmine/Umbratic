import { app, BrowserWindow, dialog, ipcMain, Menu, MenuItemConstructorOptions, OpenDialogOptions, shell } from "electron";
import { ChildProcess, execFile, spawn } from "node:child_process";
import crypto = require("node:crypto");
import fs = require("node:fs");
import net = require("node:net");
import os = require("node:os");
import path = require("node:path");

type ServiceStatus = "ready" | "degraded" | "unavailable";
type PermissionMode = "default" | "bypass";

type OpenCodeConnection =
  | {
      status: "ready";
      url: string;
      username: string;
      password: string;
      authHeader: string;
      model: {
        providerId: "aegis-lmstudio";
        modelId: string;
        displayName: string;
        lmStudioBaseUrl: string;
        lmStudio: ServiceStatus;
      };
      privacy: {
        share: "disabled";
        enabledProviders: string[];
        disabledProviders: string[];
        webTools: "disabled";
      };
    }
  | { status: "missing"; message: string }
  | { status: "error"; message: string };

type AttachedFilePayload = {
  path: string;
  name: string;
  projectPath?: string;
  content?: string;
};

type ProjectSummary = {
  id: string;
  name: string;
  root_path: string;
  preferred_ide?: string | null;
  created_at: string;
  last_opened_at?: string | null;
};

type GitResult = {
  stdout: string;
  stderr: string;
  success: boolean;
};

type NativeRequest =
  | { type: "health" }
  | { type: "project:list" }
  | { type: "project:add"; rootPath: string; name?: string }
  | { type: "store:overview" }
  | { type: "ide:detect" }
  | { type: "git:status"; projectRoot: string }
  | { type: "git:diff"; projectRoot: string }
  | { type: "git:branches"; projectRoot: string }
  | { type: "git:worktree-list"; projectRoot: string }
  | { type: "git:worktree-create"; projectRoot: string; branch: string; newBranch: string; worktreeName: string }
  | { type: "project:files"; projectRoot: string; limit?: number }
  | { type: "project:search"; projectRoot: string; query: string; limit?: number }
  | { type: "opencode:set-permission-mode"; mode: PermissionMode }
  | { type: "opencode:config" };

const isDev = !app.isPackaged;
const lmStudioBaseUrl = "http://127.0.0.1:1234/v1";
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

app.setName("Aegis");
const cleanUserData = path.join(app.getPath("appData"), "Aegis");
try {
  fs.mkdirSync(cleanUserData, { recursive: true });
  app.setPath("userData", cleanUserData);
} catch {
  /* fall back to default */
}

let mainWindow: BrowserWindow | null = null;
let opencodeProcess: ChildProcess | null = null;
let opencodeConnection: Promise<OpenCodeConnection> | null = null;
let terminalProcess: ChildProcess | null = null;
let lastGeneratedConfig: Record<string, unknown> | null = null;
let permissionMode: PermissionMode = "default";

function dataFile(name: string): string {
  return path.join(app.getPath("userData"), name);
}

function projectStorePath(): string {
  return dataFile("projects.json");
}

function readProjects(): ProjectSummary[] {
  try {
    const raw = fs.readFileSync(projectStorePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<ProjectSummary>[];
    return parsed
      .filter((row): row is ProjectSummary =>
        !!row &&
        typeof row.id === "string" &&
        typeof row.name === "string" &&
        typeof row.root_path === "string" &&
        typeof row.created_at === "string",
      )
      .filter((row) => fs.existsSync(row.root_path));
  } catch {
    return [];
  }
}

function writeProjects(projects: ProjectSummary[]) {
  fs.mkdirSync(path.dirname(projectStorePath()), { recursive: true });
  fs.writeFileSync(projectStorePath(), JSON.stringify(projects, null, 2));
}

function stableProjectId(rootPath: string): string {
  return crypto.createHash("sha256").update(path.resolve(rootPath).toLowerCase()).digest("hex").slice(0, 16);
}

function addProject(rootPath: string, name?: string): ProjectSummary {
  const resolved = path.resolve(rootPath);
  const now = new Date().toISOString();
  const project: ProjectSummary = {
    id: stableProjectId(resolved),
    name: name?.trim() || path.basename(resolved) || resolved,
    root_path: resolved,
    created_at: now,
    last_opened_at: now,
  };
  const projects = [project, ...readProjects().filter((row) => row.id !== project.id)];
  writeProjects(projects);
  return project;
}

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address?.port) {
          resolve(address.port);
        } else {
          reject(new Error("Could not allocate a local OpenCode port."));
        }
      });
    });
    server.once("error", reject);
  });
}

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }
  return response.json() as Promise<T>;
}

async function resolveLmStudioModel(): Promise<{ status: ServiceStatus; modelId: string; displayName: string }> {
  try {
    const models = await fetchJson<{ data?: Array<{ id?: string; name?: string }> }>(`${lmStudioBaseUrl}/models`, {
      signal: AbortSignal.timeout(1800),
    });
    const first = models.data?.find((model) => typeof model.id === "string" && model.id.trim());
    if (!first?.id) {
      return { status: "unavailable", modelId: "local", displayName: "LM Studio loaded model" };
    }
    return { status: "ready", modelId: first.id, displayName: first.name || first.id };
  } catch {
    return { status: "unavailable", modelId: "local", displayName: "LM Studio loaded model" };
  }
}

function generatedOpenCodeConfig(modelId: string): Record<string, unknown> {
  const permission =
    permissionMode === "bypass"
      ? {
          webfetch: "deny",
          websearch: "deny",
          edit: "allow",
          bash: "allow",
          external_directory: "allow",
        }
      : {
          webfetch: "deny",
          websearch: "deny",
          read: {
            "*": "allow",
            "*.env": "deny",
            "*.env.*": "deny",
            "*.env.example": "allow",
          },
          glob: "allow",
          grep: "allow",
          edit: "ask",
          bash: {
            "*": "ask",
            "ls *": "allow",
            "dir *": "allow",
            "pwd": "allow",
            "echo *": "allow",
            "cat *": "allow",
            "type *": "allow",
            "findstr *": "allow",
            "grep *": "allow",
            "rg *": "allow",
            "git status*": "allow",
            "git diff*": "allow",
            "git log*": "allow",
            "git branch*": "allow",
            "Get-ChildItem *": "allow",
            "Get-Content *": "allow",
            "Select-String *": "allow",
            "Remove-Item *": "ask",
            "rm *": "ask",
            "del *": "ask",
            "rmdir *": "ask",
            "mv *": "ask",
            "Move-Item *": "ask",
            "git clean*": "ask",
            "git reset*": "ask",
            "git restore*": "ask",
            "git checkout*": "ask",
            "git push*": "ask",
            "npm install*": "ask",
            "pnpm install*": "ask",
          },
          external_directory: "ask",
        };
  return {
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    autoupdate: false,
    model: `aegis-lmstudio/${modelId}`,
    small_model: `aegis-lmstudio/${modelId}`,
    enabled_providers: ["aegis-lmstudio"],
    disabled_providers: disabledProviders,
    provider: {
      "aegis-lmstudio": {
        npm: "@ai-sdk/openai-compatible",
        name: "Aegis Local Model",
        options: {
          baseURL: lmStudioBaseUrl,
        },
        models: {
          [modelId]: {
            name: modelId === "local" ? "LM Studio loaded model" : modelId,
          },
        },
      },
    },
    server: {
      hostname: "127.0.0.1",
      mdns: false,
      cors: isDev ? ["http://127.0.0.1:5173"] : [],
    },
    tools: {
      webfetch: false,
      websearch: false,
    },
    default_agent: "aegis",
    permission,
    agent: {
      aegis: {
        mode: "primary",
        model: `aegis-lmstudio/${modelId}`,
        tools: {
          webfetch: false,
          websearch: false,
        },
        permission,
        prompt:
          [
            "You are Aegis, a local-first coding agent running inside OpenCode.",
            "Use OpenCode's file and shell tools directly when the user asks for coding work.",
            "Exploratory reads and searches can run without interruption; destructive or write actions must go through OpenCode permission approval.",
            "If an operation needs host approval, OpenCode will request permission from the UI.",
            "Avoid web tools and keep user data on this machine.",
          ].join(" "),
      },
    },
  };
}

function scrubbedOpenCodeEnv(password: string, config: Record<string, unknown>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("OTEL_") ||
      key.includes("API_KEY") ||
      key.includes("ACCESS_TOKEN") ||
      key.includes("SECRET")
    ) {
      delete env[key];
    }
  }
  for (const key of [
    "OPENCODE_AUTO_SHARE",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_DIR",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
    "XAI_API_KEY",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_SERVICE_NAME",
  ]) {
    delete env[key];
  }
  env.OPENCODE_SERVER_USERNAME = "opencode";
  env.OPENCODE_SERVER_PASSWORD = password;
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  return env;
}

function opencodeBinaryPath(): string | null {
  const binary = process.platform === "win32" ? "opencode.exe" : "opencode";
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch;
  const packageNames =
    platform === "windows" && arch === "x64"
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
    } catch {
      const candidate = path.resolve(__dirname, "../../../node_modules", packageName, "bin", binary);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  try {
    return require.resolve("opencode-ai/bin/opencode");
  } catch {
    const candidate = path.resolve(__dirname, "../../../node_modules/opencode-ai/bin/opencode");
    return fs.existsSync(candidate) ? candidate : null;
  }
}

async function pollOpenCode(baseUrl: string, authHeader: string) {
  let lastError = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const health = await fetchJson<{ healthy: boolean; version: string }>(`${baseUrl}/global/health`, {
        headers: { Authorization: authHeader },
        signal: AbortSignal.timeout(1000),
      });
      if (health.healthy) {
        return health;
      }
    } catch (error) {
      lastError = String(error instanceof Error ? error.message : error);
    }
    await wait(250);
  }
  throw new Error(`Timed out waiting for OpenCode startup.${lastError ? ` Last error: ${lastError}` : ""}`);
}

async function validateProviderLockdown(baseUrl: string, authHeader: string) {
  const config = await fetchJson<Record<string, unknown>>(`${baseUrl}/config`, {
    headers: { Authorization: authHeader },
    signal: AbortSignal.timeout(3000),
  });
  const enabled = Array.isArray(config.enabled_providers) ? config.enabled_providers : [];
  const share = config.share;
  if (share !== "disabled") {
    throw new Error("OpenCode privacy validation failed: sharing is not disabled.");
  }
  if (enabled.length !== 1 || enabled[0] !== "aegis-lmstudio") {
    throw new Error(`OpenCode privacy validation failed: enabled providers are ${JSON.stringify(enabled)}.`);
  }
}

async function startOpenCode(): Promise<OpenCodeConnection> {
  if (opencodeConnection) {
    return opencodeConnection;
  }
  opencodeConnection = (async (): Promise<OpenCodeConnection> => {
    const binary = opencodeBinaryPath();
    if (!binary) {
      return {
        status: "missing",
        message: "OpenCode CLI package was not found. Run npm install from the repository root.",
      };
    }

    const resolvedModel = await resolveLmStudioModel();
    const password = crypto.randomBytes(24).toString("base64url");
    const username = "opencode";
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const authHeader = basicAuth(username, password);
    const config = generatedOpenCodeConfig(resolvedModel.modelId);
    lastGeneratedConfig = config;

    const args = [
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
      "--cors",
      "http://127.0.0.1:5173",
    ];
    opencodeProcess = spawn(binary, args, {
      cwd: app.getPath("home"),
      env: scrubbedOpenCodeEnv(password, config),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stderr = "";
    opencodeProcess.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-12000);
    });
    opencodeProcess.stdout?.on("data", (chunk: Buffer) => {
      console.log(`[opencode] ${chunk.toString("utf8").trimEnd()}`);
    });
    opencodeProcess.once("exit", (code) => {
      console.log(`[opencode] exited ${code ?? "unknown"}`);
      opencodeProcess = null;
      opencodeConnection = null;
    });

    try {
      await pollOpenCode(baseUrl, authHeader);
      await validateProviderLockdown(baseUrl, authHeader);
      return {
        status: "ready",
        url: baseUrl,
        username,
        password,
        authHeader,
        model: {
          providerId: "aegis-lmstudio",
          modelId: resolvedModel.modelId,
          displayName: resolvedModel.displayName,
          lmStudioBaseUrl,
          lmStudio: resolvedModel.status,
        },
        privacy: {
          share: "disabled",
          enabledProviders: ["aegis-lmstudio"],
          disabledProviders,
          webTools: "disabled",
        },
      };
    } catch (error) {
      opencodeProcess?.kill();
      opencodeProcess = null;
      opencodeConnection = null;
      return {
        status: "error",
        message: `${String(error instanceof Error ? error.message : error)}${stderr ? `\n\nOpenCode stderr:\n${stderr}` : ""}`,
      };
    }
  })();
  return opencodeConnection;
}

async function restartOpenCode(): Promise<OpenCodeConnection> {
  if (opencodeProcess) {
    opencodeProcess.kill();
    opencodeProcess = null;
  }
  opencodeConnection = null;
  return startOpenCode();
}

async function setPermissionMode(mode: PermissionMode): Promise<OpenCodeConnection> {
  permissionMode = mode === "bypass" ? "bypass" : "default";
  return restartOpenCode();
}

function readAttachment(filePath: string, projectRoot?: string): AttachedFilePayload {
  const payload: AttachedFilePayload = {
    path: filePath,
    name: path.basename(filePath),
  };
  if (projectRoot) {
    const relative = path.relative(projectRoot, filePath);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      payload.projectPath = relative.replace(/\\/g, "/");
    }
  }
  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile() && stat.size <= 64 * 1024) {
      const buffer = fs.readFileSync(filePath);
      if (!buffer.includes(0)) {
        payload.content = buffer.toString("utf8");
      }
    }
  } catch {
    /* best-effort attachment preview */
  }
  return payload;
}

function terminalShell(): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return { command: "powershell.exe", args: ["-NoLogo"] };
  }
  const shellName = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  return { command: shellName, args: [] };
}

function startTerminal(cwd?: string): { started: boolean; shell: string } {
  if (terminalProcess) {
    return { started: true, shell: terminalProcess.spawnfile };
  }
  const shellInfo = terminalShell();
  terminalProcess = spawn(shellInfo.command, shellInfo.args, {
    cwd: cwd && fs.existsSync(cwd) ? cwd : app.getPath("home"),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  terminalProcess.stdout?.on("data", (chunk: Buffer) => {
    mainWindow?.webContents.send("terminal:data", chunk.toString("utf8"));
  });
  terminalProcess.stderr?.on("data", (chunk: Buffer) => {
    mainWindow?.webContents.send("terminal:data", chunk.toString("utf8"));
  });
  terminalProcess.once("exit", (code) => {
    mainWindow?.webContents.send("terminal:data", `\r\n[terminal exited: ${code ?? "unknown"}]\r\n`);
    terminalProcess = null;
  });
  terminalProcess.once("error", (error) => {
    mainWindow?.webContents.send("terminal:data", `\r\n[terminal error: ${error.message}]\r\n`);
    terminalProcess = null;
  });
  return { started: true, shell: shellInfo.command };
}

function execGit(projectRoot: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: projectRoot, windowsHide: true, timeout: 20000 }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString() || (error ? String(error.message) : ""),
        success: !error,
      });
    });
  });
}

async function gitBranches(projectRoot: string) {
  const result = await execGit(projectRoot, ["branch", "--list", "--format=%(refname:short)"]);
  const current = await execGit(projectRoot, ["branch", "--show-current"]);
  return {
    current: current.stdout.trim() || null,
    branches: result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
  };
}

async function gitWorktrees(projectRoot: string) {
  const result = await execGit(projectRoot, ["worktree", "list", "--porcelain"]);
  const rows: Array<{ path: string; branch?: string | null; commit?: string | null }> = [];
  let current: { path: string; branch?: string | null; commit?: string | null } | null = null;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) rows.push(current);
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("HEAD ") && current) {
      current.commit = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  if (current) rows.push(current);
  return rows;
}

async function gitWorktreeCreate(projectRoot: string, branch: string, newBranch: string, worktreeName: string) {
  const parent = path.join(os.tmpdir(), "Aegis Worktrees");
  fs.mkdirSync(parent, { recursive: true });
  const target = path.join(parent, worktreeName);
  const result = await execGit(projectRoot, ["worktree", "add", "-b", newBranch, target, branch]);
  if (!result.success) {
    throw new Error(result.stderr || result.stdout || "git worktree add failed");
  }
  return { path: target, branch: newBranch };
}

const ignoredDirectoryNames = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "dist-electron",
  ".vite",
  ".next",
  "build",
  "coverage",
]);

function listProjectFiles(projectRoot: string, limit = 10000) {
  const root = path.resolve(projectRoot);
  const results: Array<{ path: string; name: string; directory: string; kind: "file" }> = [];
  const stack = [root];
  while (stack.length > 0 && results.length < limit) {
    const current = stack.pop();
    if (!current) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (results.length >= limit) break;
      if (entry.name.startsWith(".") && entry.name !== ".env.example") {
        continue;
      }
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (!ignoredDirectoryNames.has(entry.name)) {
          stack.push(absolute);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      results.push({
        path: relative,
        name: entry.name,
        directory: relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "",
        kind: "file",
      });
    }
  }
  return results;
}

function searchProject(projectRoot: string, query: string, limit = 200) {
  const needle = query.toLowerCase();
  if (!needle) {
    return listProjectFiles(projectRoot, limit).map((file) => ({ path: file.path, line: 1, snippet: file.path }));
  }
  const root = path.resolve(projectRoot);
  const matches: Array<{ path: string; line: number; snippet: string }> = [];
  for (const file of listProjectFiles(root, 20000)) {
    if (matches.length >= limit) break;
    const absolute = path.join(root, file.path);
    if (file.path.toLowerCase().includes(needle)) {
      matches.push({ path: file.path, line: 1, snippet: file.path });
      continue;
    }
    try {
      const stat = fs.statSync(absolute);
      if (stat.size > 512 * 1024) continue;
      const buffer = fs.readFileSync(absolute);
      if (buffer.includes(0)) continue;
      const lines = buffer.toString("utf8").split(/\r?\n/);
      const index = lines.findIndex((line) => line.toLowerCase().includes(needle));
      if (index >= 0) {
        matches.push({ path: file.path, line: index + 1, snippet: lines[index].trim().slice(0, 240) });
      }
    } catch {
      /* ignore unreadable files */
    }
  }
  return matches;
}

function detectIdes() {
  return [
    { id: "code", label: "VS Code", command: process.platform === "win32" ? "code.cmd" : "code" },
    { id: "explorer", label: process.platform === "darwin" ? "Finder" : process.platform === "win32" ? "Explorer" : "Files", command: "" },
  ];
}

async function handleNativeRequest(request: NativeRequest): Promise<unknown> {
  switch (request.type) {
    case "health": {
      const connection = await startOpenCode();
      const lm = await resolveLmStudioModel();
      return {
        opencode: connection.status === "ready" ? "ready" : "unavailable",
        sqlite_path: dataFile("opencode"),
        lm_studio: lm.status,
        model_base_url: lmStudioBaseUrl,
        semantic_index: "ready",
      };
    }
    case "project:list":
      return readProjects();
    case "project:add":
      return addProject(request.rootPath, request.name);
    case "store:overview": {
      const projects = readProjects();
      return {
        sqlite_path: dataFile("opencode"),
        projects: projects.length,
        sessions: 0,
        turns: 0,
        tool_calls: 0,
        proposals: 0,
        index_chunks: 0,
      };
    }
    case "ide:detect":
      return detectIdes();
    case "git:status":
      return execGit(request.projectRoot, ["status", "--short"]);
    case "git:diff":
      return execGit(request.projectRoot, ["diff", "--no-ext-diff"]);
    case "git:branches":
      return gitBranches(request.projectRoot);
    case "git:worktree-list":
      return gitWorktrees(request.projectRoot);
    case "git:worktree-create":
      return gitWorktreeCreate(request.projectRoot, request.branch, request.newBranch, request.worktreeName);
    case "project:files":
      return listProjectFiles(request.projectRoot, request.limit);
    case "project:search":
      return searchProject(request.projectRoot, request.query, request.limit);
    case "opencode:set-permission-mode":
      return setPermissionMode(request.mode);
    case "opencode:config":
      return { ...(lastGeneratedConfig ?? {}), aegis_permission_mode: permissionMode };
    default:
      throw new Error("Unknown native request.");
  }
}

function launchCommand(command: string, args: string[]): { ok: true } | { ok: false; message: string } {
  if (!command) {
    return { ok: false, message: "No command for the chosen editor." };
  }
  try {
    const isWindows = process.platform === "win32";
    const isBatch = isWindows && /\.(cmd|bat)$/i.test(command);
    const child = isBatch
      ? spawn("cmd.exe", ["/c", command, ...args], { detached: true, stdio: "ignore", windowsHide: true })
      : spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", (error) => {
      console.error(`[aegis] failed to launch ${command}:`, error);
    });
    child.unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error instanceof Error ? error.message : error) };
  }
}

async function createWindow() {
  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#0c0d0f",
    title: "Aegis",
    titleBarStyle: isMac ? "hiddenInset" : isWin ? "hidden" : "default",
    titleBarOverlay: isWin
      ? {
          color: "#0c0d0f",
          symbolColor: "#cdd3d9",
          height: 44,
        }
      : undefined,
    trafficLightPosition: isMac ? { x: 16, y: 14 } : undefined,
    webPreferences: {
      preload: path.resolve(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.on("context-menu", (_event, params) => {
    const template: MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      template.push(
        { role: "undo", enabled: params.editFlags.canUndo },
        { role: "redo", enabled: params.editFlags.canRedo },
        { type: "separator" },
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { role: "selectAll", enabled: params.editFlags.canSelectAll },
      );
    } else if (params.selectionText.trim()) {
      template.push({ role: "copy", enabled: params.editFlags.canCopy });
    }
    if (template.length > 0) {
      Menu.buildFromTemplate(template).popup({ window: mainWindow ?? undefined });
    }
  });

  if (isDev) {
    await mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    await mainWindow.loadFile(path.resolve(__dirname, "../../dist/index.html"));
  }
}

app.whenReady().then(async () => {
  ipcMain.handle("opencode:get-connection", () => startOpenCode());
  ipcMain.handle("opencode:restart", () => restartOpenCode());
  ipcMain.handle("opencode:set-permission-mode", (_event, mode: PermissionMode) => setPermissionMode(mode));
  ipcMain.handle("aegis:native-request", (_event, request: NativeRequest) => handleNativeRequest(request));
  ipcMain.handle("project:pick-folder", async () => {
    const options: OpenDialogOptions = {
      title: "Open Project Folder",
      properties: ["openDirectory"],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    const rootPath = result.filePaths[0];
    return {
      canceled: false,
      rootPath,
      name: path.basename(rootPath),
    };
  });
  ipcMain.handle("file:pick-attachments", async (_event, projectRoot?: string) => {
    const options: OpenDialogOptions = {
      title: "Attach Files",
      properties: ["openFile", "multiSelections"],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    return {
      canceled: false,
      files: result.filePaths.map((filePath) => readAttachment(filePath, projectRoot)),
    };
  });
  ipcMain.handle(
    "ide:open-project",
    async (_event, payload: { ideId: string; command: string; projectRoot: string }) => {
      try {
        const root = path.resolve(payload.projectRoot);
        if (!fs.existsSync(root)) {
          return { ok: false, message: `Project root does not exist: ${root}` };
        }
        if (payload.ideId === "explorer") {
          const error = await shell.openPath(root);
          return error ? { ok: false, message: error } : { ok: true };
        }
        return launchCommand(payload.command, [root]);
      } catch (error) {
        return { ok: false, message: String(error instanceof Error ? error.message : error) };
      }
    },
  );
  ipcMain.handle(
    "ide:open-file",
    async (
      _event,
      payload: { ideId: string; command: string; projectRoot: string; file: string; line?: number | null },
    ) => {
      try {
        const root = path.resolve(payload.projectRoot);
        const target = path.isAbsolute(payload.file) ? payload.file : path.join(root, payload.file);
        if (!fs.existsSync(target)) {
          return { ok: false, message: `File does not exist: ${target}` };
        }
        if (payload.ideId === "explorer") {
          shell.showItemInFolder(target);
          return { ok: true };
        }
        if (payload.ideId === "code") {
          const gotoArg = payload.line ? `${target}:${payload.line}` : target;
          const args = payload.line ? ["--reuse-window", root, "--goto", gotoArg] : ["--reuse-window", root, target];
          return launchCommand(payload.command, args);
        }
        return launchCommand(payload.command, [target]);
      } catch (error) {
        return { ok: false, message: String(error instanceof Error ? error.message : error) };
      }
    },
  );
  ipcMain.handle("terminal:start", (_event, cwd?: string) => startTerminal(cwd));
  ipcMain.handle("terminal:write", (_event, data: string) => {
    if (!terminalProcess) {
      startTerminal();
    }
    terminalProcess?.stdin?.write(data);
    return { written: true };
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [
          {
            label: "Open Folder...",
            accelerator: "CmdOrCtrl+O",
            click: () => mainWindow?.webContents.send("menu:open-project"),
          },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          {
            label: "Back to Chat",
            accelerator: "Alt+Left",
            click: () => mainWindow?.webContents.send("menu:back-to-chat"),
          },
          {
            label: "Toggle Sidebar",
            accelerator: "CmdOrCtrl+B",
            click: () => mainWindow?.webContents.send("menu:toggle-sidebar"),
          },
          { type: "separator" },
          { role: "reload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
        ],
      },
      {
        label: "Window",
        submenu: [{ role: "minimize" }, { role: "close" }],
      },
      {
        label: "Help",
        submenu: [
          {
            label: "About Aegis",
            click: () => mainWindow?.webContents.send("menu:show-about"),
          },
        ],
      },
    ]),
  );
  await createWindow();
  void startOpenCode();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (opencodeProcess) {
    opencodeProcess.kill();
  }
  if (terminalProcess) {
    terminalProcess.kill();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});
