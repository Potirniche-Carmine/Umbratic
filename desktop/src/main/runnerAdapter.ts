import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { localProviderCatalog, pythonRuntimeSystemPrompt } from "./config";
import { aegisRunnerHardeningEnvironment, assertAegisRunnerConfig } from "./policy";
import type { LocalModelInfo, RunnerProcess, SseStream, TaskRecord } from "./types";
import { isRecord } from "./utils";

const nodeRequire = createRequire(__filename);

export function buildAegisRunnerConfig(task: TaskRecord, selectedModel: LocalModelInfo): Record<string, unknown> {
  const catalogProvider = localProviderCatalog.find((provider) => provider.providerId === selectedModel.providerId);
  return {
    taskId: task.id,
    cwd: task.worktreePath,
    workspaceMode: task.workspaceMode,
    permissionMode: "normal",
    provider: {
      id: selectedModel.providerId,
      name: selectedModel.providerName,
      baseURL: selectedModel.baseUrl,
      apiKey: catalogProvider?.apiKey ?? "local",
      modelId: selectedModel.modelId,
    },
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

function existingRunnerCliPath(candidate: string): string | null {
  return fs.existsSync(candidate) ? candidate : null;
}

export function runnerBinaryPath(): string | null {
  const candidates: string[] = [];
  try {
    candidates.push(nodeRequire.resolve("@aegis/runner/bin/aegis-runner.cjs"));
  } catch {
    /* The direct workspace fallback below covers source-tree runs. */
  }
  candidates.push(path.resolve(__dirname, "../../runner/bin/aegis-runner.cjs"));
  for (const candidate of candidates) {
    const resolved = existingRunnerCliPath(candidate);
    if (resolved && fs.existsSync(path.resolve(path.dirname(resolved), "../dist/cli.js"))) {
      return resolved;
    }
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

function runnerAuthHeader(run: RunnerProcess): string {
  return `Basic ${Buffer.from(`aegis-runner:${run.password}`).toString("base64")}`;
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
    throw new Error(`Aegis runner ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 400)}` : ""}`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export async function startAegisRunnerServer(
  task: TaskRecord,
  model: LocalModelInfo,
): Promise<RunnerProcess> {
  const cliPath = runnerBinaryPath();
  if (!cliPath) {
    throw new Error("Aegis runner is not built in the app bundle.");
  }
  const port = await freeLocalPort();
  const password = crypto.randomBytes(18).toString("base64url");
  const config = buildAegisRunnerConfig(task, model);
  assertAegisRunnerConfig(config, model);
  const env: NodeJS.ProcessEnv = {
    ...runtimeEnv(task.worktreePath),
    ...aegisRunnerHardeningEnvironment(),
    AEGIS_RUNNER_CONFIG: JSON.stringify(config),
  };
  if ((process.versions as NodeJS.ProcessVersions & { electron?: string }).electron) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  const child = spawn(process.execPath, [cliPath, "serve", "--hostname=127.0.0.1", `--port=${port}`, `--password=${password}`], {
    cwd: task.worktreePath,
    env,
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
      const match = output.match(/aegis runner listening on\s+(https?:\/\/[^\s]+)/);
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

export async function replyRunnerPermission(run: RunnerProcess, permissionId: string, allow: boolean) {
  const reply = allow ? "once" : "reject";
  await runnerRequest<boolean>(run, `/permission/${encodeURIComponent(permissionId)}/reply`, {
    method: "POST",
    body: { reply },
  });
}
