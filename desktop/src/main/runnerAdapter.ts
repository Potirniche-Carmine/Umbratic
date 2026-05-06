import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { defaultDisabledProviders, localProviderCatalog, permissionRulesForMode, pythonRuntimeSystemPrompt } from "./config";
import { assertPackageRunnerConfig, packageRunnerHardeningEnvironment } from "./policy";
import type { LocalModelInfo, RunnerProcess, PermissionMode, PermissionRequest, ReasoningMode, SseStream, TaskRecord } from "./types";
import { isRecord } from "./utils";

const nodeRequire = createRequire(__filename);

export function buildPackageRunnerConfig(
  mode: PermissionMode,
  selectedModel: LocalModelInfo,
  availableModels: LocalModelInfo[],
  reasoningMode: ReasoningMode,
): Record<string, unknown> {
  const providerCatalog = new Map(localProviderCatalog.map((provider) => [provider.providerId, provider]));
  const modelsForSelectedProvider = availableModels.filter((model) => model.providerId === selectedModel.providerId);
  const modelBehavior =
    reasoningMode === "reasoning"
      ? { reasoning: true, interleaved: { field: "reasoning_content" as const } }
      : { reasoning: false };
  const modelEntries = Object.fromEntries(
    (modelsForSelectedProvider.length ? modelsForSelectedProvider : [selectedModel]).map((model) => [
      model.modelId,
      { name: model.displayName, ...modelBehavior },
    ]),
  );
  const catalogProvider = providerCatalog.get(selectedModel.providerId);
  const enabledProviderIds = Array.from(new Set([selectedModel.providerId]));
  return {
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    autoupdate: false,
    model: `${selectedModel.providerId}/${selectedModel.modelId}`,
    small_model: `${selectedModel.providerId}/${selectedModel.modelId}`,
    enabled_providers: enabledProviderIds,
    disabled_providers: defaultDisabledProviders,
    provider: {
      [selectedModel.providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: `Local ${selectedModel.providerName}`,
        options: {
          baseURL: selectedModel.baseUrl,
          apiKey: catalogProvider?.apiKey ?? "local",
        },
        models: modelEntries,
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
    permission: permissionRulesForMode(mode),
  };
}

export function runtimeEnv(worktreePath: string): NodeJS.ProcessEnv {
  const runtimeRoot = path.join(worktreePath, ".aegis", "runtime");
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const pathEntries = [
    path.join(os.homedir(), ".local", "bin"),
    path.join(runtimeRoot, "uv"),
    path.join(runtimeRoot, "uv", "bin"),
    path.join(runtimeRoot, "uv", "Scripts"),
    process.env[pathKey] ?? "",
  ].filter(Boolean);
  return {
    ...process.env,
    [pathKey]: pathEntries.join(path.delimiter),
    AEGIS_PYTHON_RUNTIME_GUIDE: pythonRuntimeSystemPrompt,
    UV_INSTALL_DIR: path.join(runtimeRoot, "uv"),
    UV_UNMANAGED_INSTALL: path.join(runtimeRoot, "uv"),
    UV_NO_MODIFY_PATH: "1",
    UV_PYTHON_INSTALL_DIR: path.join(runtimeRoot, "python"),
    UV_PYTHON_BIN_DIR: path.join(runtimeRoot, "python-bin"),
    UV_CACHE_DIR: path.join(runtimeRoot, "uv-cache"),
  };
}

export function runnerBinaryPath(): string | null {
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
      return nodeRequire.resolve(`${packageName}/bin/${binary}`);
    } catch {
      const candidate = path.resolve(__dirname, "../../../node_modules", packageName, "bin", binary);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  try {
    return nodeRequire.resolve("opencode-ai/bin/opencode");
  } catch {
    const candidate = path.resolve(__dirname, "../../../node_modules/opencode-ai/bin/opencode");
    return fs.existsSync(candidate) ? candidate : null;
  }
}

async function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate an Aegis runner port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

export function stopRunnerProcess(run: RunnerProcess) {
  run.abortController.abort();
  if (!run.child.killed) {
    run.child.kill();
  }
}

function packageRunnerAuthHeader(run: RunnerProcess): string {
  return `Basic ${Buffer.from(`opencode:${run.password}`).toString("base64")}`;
}

function packageRunnerUrl(run: RunnerProcess, route: string): URL {
  const url = new URL(route, run.url);
  url.searchParams.set("directory", run.directory);
  return url;
}

export async function runnerRequest<T>(
  run: RunnerProcess,
  route: string,
  init: Omit<RequestInit, "body"> & { body?: unknown } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", packageRunnerAuthHeader(run));
  if (init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(packageRunnerUrl(run, route), {
    ...init,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal ?? run.abortController.signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Aegis runner ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 400)}` : ""}`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export async function startPackageRunnerServer(
  task: TaskRecord,
  model: LocalModelInfo,
  models: LocalModelInfo[],
): Promise<RunnerProcess> {
  const binary = runnerBinaryPath();
  if (!binary) {
    throw new Error("Aegis runner is not installed in the app bundle.");
  }
  const port = await freeLocalPort();
  const password = crypto.randomBytes(18).toString("base64url");
  const config = buildPackageRunnerConfig(task.permissionMode, model, models, task.reasoningMode ?? "fast");
  assertPackageRunnerConfig(config, model);
  const child = spawn(binary, ["serve", "--pure", "--hostname=127.0.0.1", `--port=${port}`], {
    cwd: task.worktreePath,
    env: {
      ...runtimeEnv(task.worktreePath),
      ...packageRunnerHardeningEnvironment(),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_SERVER_PASSWORD: password,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let output = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      stopRunnerProcess({
        taskId: task.id,
        url: `http://127.0.0.1:${port}`,
        password,
        directory: task.worktreePath,
        child,
        abortController: new AbortController(),
      });
      reject(new Error(`Timed out waiting for Aegis runner to start.${output.trim() ? `\n${output.trim()}` : ""}`));
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
      const match = output.match(/opencode server listening on\s+(https?:\/\/[^\s]+)/);
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
      reject(new Error(`Aegis runner exited before startup with code ${code ?? "unknown"}.${output.trim() ? `\n${output.trim()}` : ""}`));
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
    child,
    abortController: new AbortController(),
  };
}

export function eventSessionId(event: Record<string, unknown>): string | undefined {
  const properties = isRecord(event.properties) ? event.properties : {};
  const direct = typeof properties.sessionID === "string" ? properties.sessionID : undefined;
  if (direct) return direct;
  const info = isRecord(properties.info) ? properties.info : undefined;
  if (typeof info?.sessionID === "string") return info.sessionID;
  const part = isRecord(properties.part) ? properties.part : undefined;
  if (typeof part?.sessionID === "string") return part.sessionID;
  return undefined;
}

export function runnerErrorMessage(error: unknown): string {
  if (!isRecord(error)) return String(error || "Aegis runner failed.");
  const data = isRecord(error.data) ? error.data : {};
  if (typeof data.message === "string") return data.message;
  if (typeof error.name === "string") return error.name;
  return "Aegis runner failed.";
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
      headers.set("Authorization", packageRunnerAuthHeader(run));
      headers.set("Accept", "text/event-stream");
      const response = await fetch(packageRunnerUrl(run, "/event"), {
        headers,
        signal: run.abortController.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`Aegis runner event stream failed with ${response.status} ${response.statusText}.`);
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

function findStringByKey(value: unknown, keys: Set<string>, depth = 0): string {
  if (depth > 8 || !value) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return "";
    try {
      return findStringByKey(JSON.parse(trimmed) as unknown, keys, depth + 1);
    } catch {
      return "";
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByKey(item, keys, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (!isRecord(value)) return "";
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key.toLowerCase()) && typeof child === "string" && child.trim()) {
      return child.trim();
    }
  }
  for (const child of Object.values(value)) {
    const found = findStringByKey(child, keys, depth + 1);
    if (found) return found;
  }
  return "";
}

function asInputRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toolDisplayName(value: string): string {
  return value.split(".").pop()?.toLowerCase() || value.toLowerCase() || "tool";
}

export function runnerToolCommand(part: Record<string, unknown>): { kind: PermissionRequest["kind"]; command: string } {
  const tool = typeof part.tool === "string" ? part.tool : "tool";
  const state = isRecord(part.state) ? part.state : {};
  const inputCandidates = [state.input, part.input, state.args, part.args, state.params, part.params]
    .map(asInputRecord)
    .filter((input): input is Record<string, unknown> => !!input);
  const commandInput = inputCandidates.find(
    (input) => typeof input.command === "string" || typeof input.cmd === "string",
  );
  const pathInput = inputCandidates.find(
    (input) => typeof input.filePath === "string" || typeof input.path === "string",
  );
  const title = typeof state.title === "string" && state.title.trim() ? state.title.trim() : tool;
  const commandValue =
    (commandInput
      ? (typeof commandInput.command === "string" && commandInput.command.trim()) ||
        (typeof commandInput.cmd === "string" && commandInput.cmd.trim())
      : "") ||
    findStringByKey(part, new Set(["command", "cmd", "shell", "script"]));
  const pathValue =
    (pathInput
      ? (typeof pathInput.filePath === "string" && pathInput.filePath.trim()) ||
        (typeof pathInput.path === "string" && pathInput.path.trim())
      : "") ||
    findStringByKey(part, new Set(["filepath", "file_path", "path", "filename"]));
  const toolName = toolDisplayName(tool);
  const command =
    commandValue ||
    (pathValue ? `${toolName} ${pathValue}` : "") ||
    title;
  return {
    kind: tool.toLowerCase().includes("bash") || !!commandValue ? "bash" : "edit",
    command,
  };
}

export async function replyRunnerPermission(run: RunnerProcess, permissionId: string, allow: boolean) {
  if (!run.sessionId) return;
  const reply = allow ? "once" : "reject";
  try {
    await runnerRequest<boolean>(run, `/permission/${encodeURIComponent(permissionId)}/reply`, {
      method: "POST",
      body: { reply },
    });
    return;
  } catch {
    await runnerRequest<boolean>(run, `/session/${encodeURIComponent(run.sessionId)}/permissions/${encodeURIComponent(permissionId)}`, {
      method: "POST",
      body: { response: reply },
    });
  }
}

export function runnerPermissionType(permission: Record<string, unknown>): string {
  const direct = typeof permission.type === "string" ? permission.type : "";
  const named = typeof permission.permission === "string" ? permission.permission : "";
  return direct || named || "tool";
}

export function runnerPermissionSummary(permission: Record<string, unknown>): string {
  const title = typeof permission.title === "string" && permission.title.trim() ? permission.title.trim() : "";
  const type = runnerPermissionType(permission);
  const patterns = Array.isArray(permission.patterns)
    ? permission.patterns.filter((pattern): pattern is string => typeof pattern === "string" && !!pattern.trim())
    : Array.isArray(permission.pattern)
      ? permission.pattern.filter((pattern): pattern is string => typeof pattern === "string" && !!pattern.trim())
      : typeof permission.pattern === "string" && permission.pattern.trim()
        ? [permission.pattern.trim()]
        : [];
  return title || patterns.join(", ") || type;
}
