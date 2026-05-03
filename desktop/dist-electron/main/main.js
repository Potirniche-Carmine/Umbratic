"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const node_child_process_1 = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const isDev = !electron_1.app.isPackaged;
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
electron_1.app.setName("Aegis");
const cleanUserData = path.join(electron_1.app.getPath("appData"), "Aegis");
try {
    fs.mkdirSync(cleanUserData, { recursive: true });
    electron_1.app.setPath("userData", cleanUserData);
}
catch {
    /* fall back to default */
}
let mainWindow = null;
let opencodeProcess = null;
let opencodeConnection = null;
let terminalProcess = null;
let lastGeneratedConfig = null;
let permissionMode = "default";
function dataFile(name) {
    return path.join(electron_1.app.getPath("userData"), name);
}
function projectStorePath() {
    return dataFile("projects.json");
}
function readProjects() {
    try {
        const raw = fs.readFileSync(projectStorePath(), "utf8");
        const parsed = JSON.parse(raw);
        return parsed
            .filter((row) => !!row &&
            typeof row.id === "string" &&
            typeof row.name === "string" &&
            typeof row.root_path === "string" &&
            typeof row.created_at === "string")
            .filter((row) => fs.existsSync(row.root_path));
    }
    catch {
        return [];
    }
}
function writeProjects(projects) {
    fs.mkdirSync(path.dirname(projectStorePath()), { recursive: true });
    fs.writeFileSync(projectStorePath(), JSON.stringify(projects, null, 2));
}
function stableProjectId(rootPath) {
    return crypto.createHash("sha256").update(path.resolve(rootPath).toLowerCase()).digest("hex").slice(0, 16);
}
function addProject(rootPath, name) {
    const resolved = path.resolve(rootPath);
    const now = new Date().toISOString();
    const project = {
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
function basicAuth(username, password) {
    return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}
function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            server.close(() => {
                if (typeof address === "object" && address?.port) {
                    resolve(address.port);
                }
                else {
                    reject(new Error("Could not allocate a local OpenCode port."));
                }
            });
        });
        server.once("error", reject);
    });
}
async function fetchJson(url, init = {}) {
    const response = await fetch(url, init);
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`${response.status} ${response.statusText}${body ? `: ${body.slice(0, 300)}` : ""}`);
    }
    return response.json();
}
async function resolveLmStudioModel() {
    try {
        const models = await fetchJson(`${lmStudioBaseUrl}/models`, {
            signal: AbortSignal.timeout(1800),
        });
        const first = models.data?.find((model) => typeof model.id === "string" && model.id.trim());
        if (!first?.id) {
            return { status: "unavailable", modelId: "local", displayName: "LM Studio loaded model" };
        }
        return { status: "ready", modelId: first.id, displayName: first.name || first.id };
    }
    catch {
        return { status: "unavailable", modelId: "local", displayName: "LM Studio loaded model" };
    }
}
function generatedOpenCodeConfig(modelId, runtime) {
    const sandboxed = runtime === "docker-sandbox";
    const modelBaseUrl = sandboxed ? "http://host.docker.internal:1234/v1" : lmStudioBaseUrl;
    const permission = permissionMode === "bypass"
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
                "ls": "allow",
                "ls *": "allow",
                "dir": "allow",
                "dir *": "allow",
                "pwd": "allow",
                "echo": "allow",
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
                "Get-ChildItem": "allow",
                "Get-ChildItem *": "allow",
                "Get-Content *": "allow",
                "Select-String *": "allow",
                "Remove-Item *": "ask",
                "rm *": "ask",
                "del *": "ask",
                "erase *": "ask",
                "rmdir *": "ask",
                "rd *": "ask",
                "mv *": "ask",
                "move *": "ask",
                "Move-Item *": "ask",
                "cp *": "ask",
                "copy *": "ask",
                "Copy-Item *": "ask",
                "chmod *": "ask",
                "chown *": "ask",
                "sed -i *": "ask",
                "git clean*": "ask",
                "git reset*": "ask",
                "git restore*": "ask",
                "git checkout*": "ask",
                "git push*": "ask",
                "npm install*": "ask",
                "pnpm install*": "ask",
                "yarn install*": "ask",
                "yarn add*": "ask",
                "bun install*": "ask",
                "pip install*": "ask",
                "python -m pip install*": "ask",
                "env": "ask",
                "env *": "ask",
                "printenv*": "ask",
                "set": "ask",
                "set *": "ask",
                "Get-ChildItem env:*": "ask",
                "Get-Item env:*": "ask",
                "gci env:*": "ask",
                "ls env:*": "ask",
                "cat *.env*": "ask",
                "cat *secret*": "ask",
                "cat *token*": "ask",
                "cat *credential*": "ask",
                "cat *id_rsa*": "ask",
                "type *.env*": "ask",
                "type *secret*": "ask",
                "type *token*": "ask",
                "type *credential*": "ask",
                "type *id_rsa*": "ask",
                "Get-Content *.env*": "ask",
                "Get-Content *secret*": "ask",
                "Get-Content *token*": "ask",
                "Get-Content *credential*": "ask",
                "Get-Content *id_rsa*": "ask",
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
                    baseURL: modelBaseUrl,
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
                prompt: [
                    "You are Aegis, a local-first coding agent running inside OpenCode.",
                    sandboxed
                        ? "You are running inside a Docker Sandbox microVM; the project workspace is mounted from the host, but host files outside mounted workspaces are outside your boundary."
                        : "You are running directly on the user's host device; be conservative with file and shell access.",
                    "Use OpenCode's file and shell tools directly when the user asks for coding work.",
                    "Exploratory reads and searches can run without interruption; only sensitive information-gathering commands and destructive or write actions must go through OpenCode permission approval.",
                    "If an operation needs host approval, OpenCode will request permission from the UI.",
                    "Avoid web tools and keep user data on this machine.",
                ].join(" "),
            },
        },
    };
}
function scrubbedOpenCodeEnv(password, config) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (key.startsWith("OTEL_") ||
            key.includes("API_KEY") ||
            key.includes("ACCESS_TOKEN") ||
            key.includes("SECRET")) {
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
function execFileOutput(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        (0, node_child_process_1.execFile)(command, args, { ...options, windowsHide: true, timeout: 180000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`${error.message}${stderr ? `\n${stderr}` : ""}`));
                return;
            }
            resolve({ stdout: String(stdout), stderr: String(stderr) });
        });
    });
}
async function commandAvailable(command) {
    try {
        await execFileOutput(process.platform === "win32" ? "where.exe" : "which", [command]);
        return true;
    }
    catch {
        return false;
    }
}
function sandboxNameFor(workspace) {
    const basename = path.basename(workspace).toLowerCase().replace(/[^a-z0-9.+-]+/g, "-").replace(/^-+|-+$/g, "");
    const hash = crypto.createHash("sha256").update(path.resolve(workspace).toLowerCase()).digest("hex").slice(0, 8);
    return `aegis-opencode-${basename || "workspace"}-${hash}`;
}
async function detectSandboxDriver() {
    if (await commandAvailable("sbx")) {
        return "sbx";
    }
    if (await commandAvailable("docker")) {
        try {
            await execFileOutput("docker", ["sandbox", "version"]);
            return "docker-sandbox";
        }
        catch {
            return null;
        }
    }
    return null;
}
async function sandboxExists(driver, name) {
    try {
        const output = driver === "sbx"
            ? await execFileOutput("sbx", ["ls", "-q"])
            : await execFileOutput("docker", ["sandbox", "ls", "-q"]);
        return output.stdout.split(/\r?\n/).map((row) => row.trim()).includes(name);
    }
    catch {
        return false;
    }
}
async function ensureOpenCodeSandbox(driver, name, workspace) {
    if (await sandboxExists(driver, name)) {
        return;
    }
    if (driver === "sbx") {
        await execFileOutput("sbx", ["create", "--name", name, "opencode", workspace]);
    }
    else {
        await execFileOutput("docker", ["sandbox", "create", "--name", name, "opencode", workspace]);
    }
}
async function startSandboxIfNeeded(driver, name) {
    if (driver === "sbx") {
        await execFileOutput("sbx", ["exec", name, "true"]);
    }
    else {
        await execFileOutput("docker", ["sandbox", "exec", name, "true"]);
    }
}
async function allowLmStudioFromSandbox(driver, name) {
    if (driver === "sbx") {
        await execFileOutput("sbx", ["policy", "allow", "network", "localhost:1234"]);
    }
    else {
        await execFileOutput("docker", ["sandbox", "network", "proxy", name, "--allow-host", "localhost:1234"]);
    }
}
async function publishSandboxPort(driver, name, hostPort, sandboxPort) {
    const spec = `127.0.0.1:${hostPort}:${sandboxPort}`;
    if (driver === "sbx") {
        await execFileOutput("sbx", ["ports", name, "--publish", spec]);
    }
    else {
        await execFileOutput("docker", ["sandbox", "ports", name, "--publish", spec]);
    }
}
function spawnSandboxOpenCode(driver, name, workspace, password, config, port) {
    const envArgs = [
        "--env",
        "OPENCODE_SERVER_USERNAME=opencode",
        "--env",
        `OPENCODE_SERVER_PASSWORD=${password}`,
        "--env",
        `OPENCODE_CONFIG_CONTENT=${JSON.stringify(config)}`,
    ];
    const opencodeArgs = [
        "opencode",
        "serve",
        "--hostname",
        "0.0.0.0",
        "--port",
        String(port),
        "--cors",
        "http://127.0.0.1:5173",
    ];
    if (driver === "sbx") {
        return (0, node_child_process_1.spawn)("sbx", ["exec", ...envArgs, "--workdir", workspace, name, ...opencodeArgs], {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
    }
    return (0, node_child_process_1.spawn)("docker", ["sandbox", "exec", ...envArgs, "--workdir", workspace, name, ...opencodeArgs], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
}
async function launchSandboxOpenCode(password, config, port) {
    const driver = await detectSandboxDriver();
    if (!driver) {
        return null;
    }
    const workspace = electron_1.app.getPath("home");
    const name = sandboxNameFor(workspace);
    await ensureOpenCodeSandbox(driver, name, workspace);
    await allowLmStudioFromSandbox(driver, name);
    await startSandboxIfNeeded(driver, name);
    await publishSandboxPort(driver, name, port, port);
    const child = spawnSandboxOpenCode(driver, name, workspace, password, config, port);
    return {
        driver,
        name,
        workspace,
        process: child,
    };
}
async function pollOpenCode(baseUrl, authHeader) {
    let lastError = "";
    for (let attempt = 0; attempt < 60; attempt += 1) {
        try {
            const health = await fetchJson(`${baseUrl}/global/health`, {
                headers: { Authorization: authHeader },
                signal: AbortSignal.timeout(1000),
            });
            if (health.healthy) {
                return health;
            }
        }
        catch (error) {
            lastError = String(error instanceof Error ? error.message : error);
        }
        await wait(250);
    }
    throw new Error(`Timed out waiting for OpenCode startup.${lastError ? ` Last error: ${lastError}` : ""}`);
}
async function validateProviderLockdown(baseUrl, authHeader) {
    const config = await fetchJson(`${baseUrl}/config`, {
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
async function startOpenCode() {
    if (opencodeConnection) {
        return opencodeConnection;
    }
    opencodeConnection = (async () => {
        const resolvedModel = await resolveLmStudioModel();
        const password = crypto.randomBytes(24).toString("base64url");
        const username = "opencode";
        const port = await getFreePort();
        const baseUrl = `http://127.0.0.1:${port}`;
        const authHeader = basicAuth(username, password);
        let runtime = "docker-sandbox";
        let sandbox = null;
        let config = generatedOpenCodeConfig(resolvedModel.modelId, runtime);
        try {
            sandbox = await launchSandboxOpenCode(password, config, port);
        }
        catch (error) {
            console.warn("[aegis] Docker Sandbox launch failed; falling back to host OpenCode.", error);
        }
        if (sandbox) {
            opencodeProcess = sandbox.process;
        }
        else {
            runtime = "host";
            const binary = opencodeBinaryPath();
            if (!binary) {
                return {
                    status: "missing",
                    message: "OpenCode CLI package was not found, and Docker Sandboxes were not available. Install Docker Sandboxes (`sbx`) or run npm install from the repository root.",
                };
            }
            config = generatedOpenCodeConfig(resolvedModel.modelId, runtime);
            const args = [
                "serve",
                "--hostname",
                "127.0.0.1",
                "--port",
                String(port),
                "--cors",
                "http://127.0.0.1:5173",
            ];
            opencodeProcess = (0, node_child_process_1.spawn)(binary, args, {
                cwd: electron_1.app.getPath("home"),
                env: scrubbedOpenCodeEnv(password, config),
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            });
        }
        lastGeneratedConfig = {
            ...config,
            aegis_runtime: runtime,
            aegis_sandbox: sandbox ? { driver: sandbox.driver, name: sandbox.name, workspace: sandbox.workspace } : null,
        };
        let stderr = "";
        opencodeProcess.stderr?.on("data", (chunk) => {
            stderr = `${stderr}${chunk.toString("utf8")}`.slice(-12000);
        });
        opencodeProcess.stdout?.on("data", (chunk) => {
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
                runtime,
                sandbox: sandbox ? { driver: sandbox.driver, name: sandbox.name, workspace: sandbox.workspace } : undefined,
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
        }
        catch (error) {
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
async function restartOpenCode() {
    if (opencodeProcess) {
        opencodeProcess.kill();
        opencodeProcess = null;
    }
    opencodeConnection = null;
    return startOpenCode();
}
async function setPermissionMode(mode) {
    permissionMode = mode === "bypass" ? "bypass" : "default";
    return restartOpenCode();
}
function readAttachment(filePath, projectRoot) {
    const payload = {
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
    }
    catch {
        /* best-effort attachment preview */
    }
    return payload;
}
function terminalShell() {
    if (process.platform === "win32") {
        return { command: "powershell.exe", args: ["-NoLogo"] };
    }
    const shellName = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
    return { command: shellName, args: [] };
}
function startTerminal(cwd) {
    if (terminalProcess) {
        return { started: true, shell: terminalProcess.spawnfile };
    }
    const shellInfo = terminalShell();
    terminalProcess = (0, node_child_process_1.spawn)(shellInfo.command, shellInfo.args, {
        cwd: cwd && fs.existsSync(cwd) ? cwd : electron_1.app.getPath("home"),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });
    terminalProcess.stdout?.on("data", (chunk) => {
        mainWindow?.webContents.send("terminal:data", chunk.toString("utf8"));
    });
    terminalProcess.stderr?.on("data", (chunk) => {
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
function execGit(projectRoot, args) {
    return new Promise((resolve) => {
        (0, node_child_process_1.execFile)("git", args, { cwd: projectRoot, windowsHide: true, timeout: 20000 }, (error, stdout, stderr) => {
            resolve({
                stdout: stdout.toString(),
                stderr: stderr.toString() || (error ? String(error.message) : ""),
                success: !error,
            });
        });
    });
}
async function gitBranches(projectRoot) {
    const result = await execGit(projectRoot, ["branch", "--list", "--format=%(refname:short)"]);
    const current = await execGit(projectRoot, ["branch", "--show-current"]);
    return {
        current: current.stdout.trim() || null,
        branches: result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    };
}
async function gitWorktrees(projectRoot) {
    const result = await execGit(projectRoot, ["worktree", "list", "--porcelain"]);
    const rows = [];
    let current = null;
    for (const line of result.stdout.split(/\r?\n/)) {
        if (line.startsWith("worktree ")) {
            if (current)
                rows.push(current);
            current = { path: line.slice("worktree ".length) };
        }
        else if (line.startsWith("HEAD ") && current) {
            current.commit = line.slice("HEAD ".length);
        }
        else if (line.startsWith("branch ") && current) {
            current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
        }
    }
    if (current)
        rows.push(current);
    return rows;
}
async function gitWorktreeCreate(projectRoot, branch, newBranch, worktreeName) {
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
function listProjectFiles(projectRoot, limit = 10000) {
    const root = path.resolve(projectRoot);
    const results = [];
    const stack = [root];
    while (stack.length > 0 && results.length < limit) {
        const current = stack.pop();
        if (!current)
            break;
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (results.length >= limit)
                break;
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
function searchProject(projectRoot, query, limit = 200) {
    const needle = query.toLowerCase();
    if (!needle) {
        return listProjectFiles(projectRoot, limit).map((file) => ({ path: file.path, line: 1, snippet: file.path }));
    }
    const root = path.resolve(projectRoot);
    const matches = [];
    for (const file of listProjectFiles(root, 20000)) {
        if (matches.length >= limit)
            break;
        const absolute = path.join(root, file.path);
        if (file.path.toLowerCase().includes(needle)) {
            matches.push({ path: file.path, line: 1, snippet: file.path });
            continue;
        }
        try {
            const stat = fs.statSync(absolute);
            if (stat.size > 512 * 1024)
                continue;
            const buffer = fs.readFileSync(absolute);
            if (buffer.includes(0))
                continue;
            const lines = buffer.toString("utf8").split(/\r?\n/);
            const index = lines.findIndex((line) => line.toLowerCase().includes(needle));
            if (index >= 0) {
                matches.push({ path: file.path, line: index + 1, snippet: lines[index].trim().slice(0, 240) });
            }
        }
        catch {
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
async function handleNativeRequest(request) {
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
function launchCommand(command, args) {
    if (!command) {
        return { ok: false, message: "No command for the chosen editor." };
    }
    try {
        const isWindows = process.platform === "win32";
        const isBatch = isWindows && /\.(cmd|bat)$/i.test(command);
        const child = isBatch
            ? (0, node_child_process_1.spawn)("cmd.exe", ["/c", command, ...args], { detached: true, stdio: "ignore", windowsHide: true })
            : (0, node_child_process_1.spawn)(command, args, { detached: true, stdio: "ignore", windowsHide: true });
        child.once("error", (error) => {
            console.error(`[aegis] failed to launch ${command}:`, error);
        });
        child.unref();
        return { ok: true };
    }
    catch (error) {
        return { ok: false, message: String(error instanceof Error ? error.message : error) };
    }
}
async function createWindow() {
    const isMac = process.platform === "darwin";
    const isWin = process.platform === "win32";
    mainWindow = new electron_1.BrowserWindow({
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
        const template = [];
        const inputFieldType = params.inputFieldType;
        const isEditable = params.isEditable || (typeof inputFieldType === "string" && inputFieldType !== "none");
        if (isEditable) {
            template.push({ role: "undo", enabled: params.editFlags.canUndo }, { role: "redo", enabled: params.editFlags.canRedo }, { type: "separator" }, { role: "cut", enabled: params.editFlags.canCut }, { role: "copy", enabled: params.editFlags.canCopy }, { role: "paste" }, { type: "separator" }, { role: "selectAll" });
        }
        else {
            template.push({ role: "copy", enabled: params.selectionText.trim().length > 0 }, { role: "selectAll" });
        }
        if (template.length > 0) {
            electron_1.Menu.buildFromTemplate(template).popup({ window: mainWindow ?? undefined });
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
    electron_1.ipcMain.handle("opencode:get-connection", () => startOpenCode());
    electron_1.ipcMain.handle("opencode:restart", () => restartOpenCode());
    electron_1.ipcMain.handle("opencode:set-permission-mode", (_event, mode) => setPermissionMode(mode));
    electron_1.ipcMain.handle("aegis:native-request", (_event, request) => handleNativeRequest(request));
    electron_1.ipcMain.handle("project:pick-folder", async () => {
        const options = {
            title: "Open Project Folder",
            properties: ["openDirectory"],
        };
        const result = mainWindow
            ? await electron_1.dialog.showOpenDialog(mainWindow, options)
            : await electron_1.dialog.showOpenDialog(options);
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
    electron_1.ipcMain.handle("file:pick-attachments", async (_event, projectRoot) => {
        const options = {
            title: "Attach Files",
            properties: ["openFile", "multiSelections"],
        };
        const result = mainWindow
            ? await electron_1.dialog.showOpenDialog(mainWindow, options)
            : await electron_1.dialog.showOpenDialog(options);
        if (result.canceled || result.filePaths.length === 0) {
            return { canceled: true };
        }
        return {
            canceled: false,
            files: result.filePaths.map((filePath) => readAttachment(filePath, projectRoot)),
        };
    });
    electron_1.ipcMain.handle("ide:open-project", async (_event, payload) => {
        try {
            const root = path.resolve(payload.projectRoot);
            if (!fs.existsSync(root)) {
                return { ok: false, message: `Project root does not exist: ${root}` };
            }
            if (payload.ideId === "explorer") {
                const error = await electron_1.shell.openPath(root);
                return error ? { ok: false, message: error } : { ok: true };
            }
            return launchCommand(payload.command, [root]);
        }
        catch (error) {
            return { ok: false, message: String(error instanceof Error ? error.message : error) };
        }
    });
    electron_1.ipcMain.handle("ide:open-file", async (_event, payload) => {
        try {
            const root = path.resolve(payload.projectRoot);
            const target = path.isAbsolute(payload.file) ? payload.file : path.join(root, payload.file);
            if (!fs.existsSync(target)) {
                return { ok: false, message: `File does not exist: ${target}` };
            }
            if (payload.ideId === "explorer") {
                electron_1.shell.showItemInFolder(target);
                return { ok: true };
            }
            if (payload.ideId === "code") {
                const gotoArg = payload.line ? `${target}:${payload.line}` : target;
                const args = payload.line ? ["--reuse-window", root, "--goto", gotoArg] : ["--reuse-window", root, target];
                return launchCommand(payload.command, args);
            }
            return launchCommand(payload.command, [target]);
        }
        catch (error) {
            return { ok: false, message: String(error instanceof Error ? error.message : error) };
        }
    });
    electron_1.ipcMain.handle("terminal:start", (_event, cwd) => startTerminal(cwd));
    electron_1.ipcMain.handle("terminal:write", (_event, data) => {
        if (!terminalProcess) {
            startTerminal();
        }
        terminalProcess?.stdin?.write(data);
        return { written: true };
    });
    electron_1.Menu.setApplicationMenu(electron_1.Menu.buildFromTemplate([
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
    ]));
    await createWindow();
    void startOpenCode();
});
electron_1.app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        electron_1.app.quit();
    }
});
electron_1.app.on("before-quit", () => {
    if (opencodeProcess) {
        opencodeProcess.kill();
    }
    if (terminalProcess) {
        terminalProcess.kill();
    }
});
electron_1.app.on("activate", () => {
    if (electron_1.BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
    }
});
