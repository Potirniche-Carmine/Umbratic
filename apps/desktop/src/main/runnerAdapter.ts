import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { app } from "electron";

import { runnerLogsDirectory, workspaceRuntimeDirectory } from "./appPaths";
import { companyEndpoint } from "./config";
import { probeLocalCapabilities } from "./capabilities";
import { refreshWorkspaceGraph, workspaceGraphRunnerConfig } from "./indexerService";
import { currentLocalVeilConnection } from "./localVeil";
import { umbraticRunnerHardeningEnvironment, assertUmbraticRunnerConfig } from "./policy";
import { enabledPromptSkills } from "./skills";
import { readContextLengthSetting, readHarnessProfileSetting, readModelEndpointSettings } from "./storage";
import { enabledToolsFromSettings, normalizeEnabledTools } from "./toolSettings";
import type {
  CapabilityProbeReport,
  HarnessProfileId,
  LocalModelInfo,
  LspServerLaunchConfig,
  RunnerProcess,
  RunnerToolId,
  SseStream,
  TaskRecord,
} from "./types";
import { isRecord } from "./utils";

type HarnessRouteConfig = {
  chatEndpointPath: string;
};

export function runnerDiagnosticsDirectory(userDataPath: string): string {
  return runnerLogsDirectory(userDataPath);
}

export function harnessRouteConfig(profileId: HarnessProfileId): HarnessRouteConfig {
  return {
    chatEndpointPath: `/api/${profileId}/chat`,
  };
}

export function buildUmbraticRunnerConfig(
  task: TaskRecord,
  selectedModel: LocalModelInfo,
  attachmentDirectory?: string,
  capabilityReport?: CapabilityProbeReport,
): Record<string, unknown> {
  const endpointSettings = readModelEndpointSettings();
  const localVeil = endpointSettings.mode === "local" ? currentLocalVeilConnection() : null;
  const harnessProfile = readHarnessProfileSetting();
  const route = harnessRouteConfig(harnessProfile);
  const requestedTools = normalizeEnabledTools(task.enabledTools, enabledToolsFromSettings({}));
  const lspServers = approvedLspServers(capabilityReport);
  const approvedExecutables = approvedCommandExecutables(capabilityReport);
  const workspaceGraph = workspaceGraphRunnerConfig(task.worktreePath);
  const enabledTools = requestedTools.filter(
    (tool) => tool !== "lsp" && tool !== "workspace_graph",
  ) as RunnerToolId[];
  if (requestedTools.includes("lsp") && lspServers.length > 0) {
    enabledTools.splice(Math.min(4, enabledTools.length), 0, "lsp" as RunnerToolId);
  }
  // Same shape as LSP: requested plus available, never requested alone. Until
  // the artifact exists the tool simply does not admit.
  if (requestedTools.includes("workspace_graph") && workspaceGraph) {
    enabledTools.splice(Math.min(5, enabledTools.length), 0, "workspace_graph" as RunnerToolId);
  }
  return {
    taskId: task.id,
    cwd: task.worktreePath,
    contextLength: selectedModel.contextLength ?? readContextLengthSetting(),
    maxResponseTokens: 8_192,
    protectedPromptReserveTokens: 2_048,
    attachmentDirectory,
    workspaceMode: task.workspaceMode,
    skills: enabledPromptSkills().map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      source: skill.source,
      instructionPath: skill.instructionPath,
      paths: skill.paths,
    })),
    capabilities: task.capabilityProbes ?? [],
    permissionMode: "normal",
    enabledTools,
    approvedExecutables,
    lspServers,
    workspaceGraph,
    diagnostics: {
      enabled: false,
    },
    provider: {
      id: selectedModel.providerId,
      name: selectedModel.providerName,
      baseURL: selectedModel.baseUrl,
      // Trusted config, not inferred from the URL: the runner selects its orient
      // timeout from this, and a wrong guess would silently change degradation.
      mode: endpointSettings.mode,
      chatEndpointPath: route.chatEndpointPath,
      apiKey: localVeil?.authToken ?? "",
      modelId: selectedModel.modelId,
      capabilities: selectedModel.capabilities ?? {
        parallelToolCalls: endpointSettings.mode === "local",
        vision: false,
        reasoning: false,
      },
      headers: Object.fromEntries(
        (endpointSettings.mode === "local" ? [] : endpointSettings.headers)
          .filter((header) => header.name.trim().toLowerCase() !== "authorization" && header.value)
          .map((header) => [header.name.trim(), header.value]),
      ),
      mtls: endpointSettings.mode === "server" ? companyEndpoint.mtls : undefined,
    },
  };
}

export function approvedCommandExecutables(
  report?: CapabilityProbeReport,
): Array<{ id: string; command: string }> {
  if (!report) return [];
  const approved: Array<{ id: string; command: string }> = [];
  for (const probe of report.probes) {
    if (
      probe.status !== "available"
      || !probe.detectedCommand
      || !probe.executablePath
      || !path.isAbsolute(probe.executablePath)
    ) {
      continue;
    }
    try {
      const command = fs.realpathSync(probe.executablePath);
      if (!fs.statSync(command).isFile()) continue;
      approved.push({ id: probe.id, command });
    } catch {
      // A stale capability report must not approve a missing executable.
    }
  }
  return approved.slice(0, 32);
}

export function approvedLspServers(report?: CapabilityProbeReport): LspServerLaunchConfig[] {
  if (!report) return [];
  const definitions: Record<string, Omit<LspServerLaunchConfig, "command">> = {
    "typescript-language-server": {
      id: "typescript-language-server",
      args: ["--stdio"],
      languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
      extensions: ["ts", "tsx", "js", "jsx"],
    },
    "rust-analyzer": {
      id: "rust-analyzer",
      args: [],
      languageIds: ["rust"],
      extensions: ["rs"],
    },
  };
  const servers: LspServerLaunchConfig[] = [];
  for (const probe of report.probes) {
    const definition = definitions[probe.id];
    if (!definition || probe.status !== "available" || !probe.executablePath || !path.isAbsolute(probe.executablePath)) {
      continue;
    }
    try {
      const command = fs.realpathSync(probe.executablePath);
      if (!fs.statSync(command).isFile()) continue;
      servers.push({ ...definition, command });
    } catch {
      // A stale probe must not approve a missing executable.
    }
  }
  return servers.slice(0, 3);
}

export function runtimeEnv(worktreePath: string): NodeJS.ProcessEnv {
  const runtimeRoot = workspaceRuntimeDirectory(app.getPath("userData"), worktreePath);
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  // Keep UV_* install dirs for confirmed tooling, but never prepend workspace-controlled
  // .umbratic/runtime onto PATH — that lets a malicious repo win executable lookup.
  const env: NodeJS.ProcessEnv = {
    [pathKey]: process.env[pathKey] ?? "",
    UV_INSTALL_DIR: path.join(runtimeRoot, "uv"),
    UV_UNMANAGED_INSTALL: path.join(runtimeRoot, "uv"),
    UV_NO_MODIFY_PATH: "1",
    UV_PYTHON_INSTALL_DIR: path.join(runtimeRoot, "python"),
    UV_PYTHON_BIN_DIR: path.join(runtimeRoot, "python-bin"),
    UV_CACHE_DIR: path.join(runtimeRoot, "uv-cache"),
  };
  const allowedExact = new Set([
    "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "LANG", "TERM", "NO_PROXY",
    "SystemRoot", "SystemDrive", "WINDIR", "COMSPEC", "PATHEXT", "NODE_ENV",
    "CARGO_HOME", "RUSTUP_HOME",
  ].map((name) => name.toLowerCase()));
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || name.toLowerCase() === pathKey.toLowerCase()) continue;
    if (allowedExact.has(name.toLowerCase()) || name.toUpperCase().startsWith("LC_")) {
      env[name] = value;
    }
  }
  return env;
}

function existingRunnerBinary(candidate: string): string | null {
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function nativeRunnerFilename(): string {
  return process.platform === "win32" ? "umbratic-runner.exe" : "umbratic-runner";
}

function packagedRunnerBinaryPath(): string | null {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return resourcesPath ? path.join(resourcesPath, "runner", nativeRunnerFilename()) : null;
}

export function runnerBinaryPath(): string | null {
  const candidates: string[] = [];
  const packagedPath = packagedRunnerBinaryPath();
  if (packagedPath) candidates.push(packagedPath);
  candidates.push(path.resolve(__dirname, "../../../../target/release", nativeRunnerFilename()));
  for (const candidate of candidates) {
    const resolved = existingRunnerBinary(candidate);
    if (resolved) return resolved;
  }
  return null;
}

async function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate an Umbratic runner port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

export function stopRunnerProcess(run: RunnerProcess) {
  if (run.providerSessionRefresh) {
    clearInterval(run.providerSessionRefresh);
    run.providerSessionRefresh = undefined;
  }
  run.abortController.abort();
  if (run.child.killed || run.child.exitCode !== null) return;
  if (process.platform === "win32" && run.child.pid) {
    const terminator = spawn("taskkill", ["/pid", String(run.child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    terminator.unref();
    return;
  }
  run.child.kill();
}

function runnerAuthHeader(run: RunnerProcess): string {
  return `Basic ${Buffer.from(`umbratic-runner:${run.password}`).toString("base64")}`;
}

function runnerUrl(run: RunnerProcess, route: string): URL {
  return new URL(route, run.url);
}

export async function runnerRequest<T>(
  run: RunnerProcess,
  route: string,
  init: Omit<RequestInit, "body"> & { body?: unknown } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", runnerAuthHeader(run));
  if (init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(runnerUrl(run, route), {
    ...init,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal ?? run.abortController.signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Umbratic runner ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 400)}` : ""}`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export async function setRunnerProviderSession(run: RunnerProcess, session: string): Promise<void> {
  await runnerRequest<void>(run, "/provider/session", {
    method: "POST",
    body: { session },
  });
}

export async function startUmbraticRunnerServer(
  task: TaskRecord,
  model: LocalModelInfo,
  attachmentDirectory?: string,
): Promise<RunnerProcess> {
  const binaryPath = runnerBinaryPath();
  if (!binaryPath) {
    throw new Error("Umbratic runner is not built in the app bundle.");
  }
  const port = await freeLocalPort();
  const password = crypto.randomBytes(18).toString("base64url");
  const capabilityReport = await probeLocalCapabilities({ runnerPath: binaryPath });
  // The config reads the artifact's existence, so the index has to settle
  // before it is built. Opening the workspace already started this build and
  // `refreshWorkspaceGraph` coalesces onto it, so the usual cost here is the
  // incremental update. A failure resolves false and the tool stays absent.
  await refreshWorkspaceGraph(task.worktreePath);
  const config = buildUmbraticRunnerConfig(task, model, attachmentDirectory, capabilityReport);
  const diagnostics = isRecord(config.diagnostics) && typeof config.diagnostics.logPath === "string"
    ? { diagnosticLogPath: config.diagnostics.logPath }
    : {};
  assertUmbraticRunnerConfig(config, model);
  const env: NodeJS.ProcessEnv = {
    ...runtimeEnv(task.worktreePath),
    ...umbraticRunnerHardeningEnvironment(),
  };
  const child = spawn(binaryPath, ["serve", "--hostname=127.0.0.1", `--port=${port}`], {
    cwd: task.worktreePath,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  // The password travels on stdin with the rest of the configuration. Process
  // arguments are readable by any local process via `ps` or WMI.
  child.stdin?.end(JSON.stringify({ ...config, password }));

  let output = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      stopRunnerProcess({
        taskId: task.id,
        url: `http://127.0.0.1:${port}`,
        password,
        directory: task.worktreePath,
        ...diagnostics,
        child,
        abortController: new AbortController(),
      });
      reject(new Error(`Timed out waiting for Umbratic runner to start.${output.trim() ? `\n${output.trim()}` : ""}`));
    }, 15000);
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = output.match(/(?:umbratic|umbratic) runner listening on\s+(https?:\/\/[^\s]+)/i);
      if (!match || settled) return;
      settled = true;
      cleanup();
      resolve(match[1]);
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Umbratic runner exited before startup with code ${code ?? "unknown"}.${output.trim() ? `\n${output.trim()}` : ""}`));
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });

  return {
    taskId: task.id,
    url,
    password,
    directory: task.worktreePath,
    ...diagnostics,
    child,
    abortController: new AbortController(),
  };
}

function parseSseBlock(block: string): unknown | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function beginRunnerEventStream(run: RunnerProcess, onEvent: (event: Record<string, unknown>) => void): SseStream {
  let markReady!: () => void;
  let failReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  const done = (async () => {
    try {
      const headers = new Headers();
      headers.set("Authorization", runnerAuthHeader(run));
      headers.set("Accept", "text/event-stream");
      const response = await fetch(runnerUrl(run, "/event"), {
        headers,
        signal: run.abortController.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`Umbratic runner event stream failed with ${response.status} ${response.statusText}.`);
      }
      markReady();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary = buffer.search(/\r?\n\r?\n/);
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          const delimiterLength = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0].length ?? 2;
          buffer = buffer.slice(boundary + delimiterLength);
          const event = parseSseBlock(block);
          if (isRecord(event)) onEvent(event);
          boundary = buffer.search(/\r?\n\r?\n/);
        }
      }
    } catch (error) {
      if (run.abortController.signal.aborted) return;
      failReady(error);
      throw error;
    }
  })();
  return { ready, done };
}

export async function replyRunnerPermission(run: RunnerProcess, permissionId: string, allow: boolean) {
  const reply = allow ? "once" : "reject";
  await runnerRequest<boolean>(run, `/permission/${encodeURIComponent(permissionId)}/reply`, {
    method: "POST",
    body: { reply },
  });
}
