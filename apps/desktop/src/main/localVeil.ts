import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { isLocalhostUrl } from "./policy";
import type { ModelEndpointSettings } from "./types";
import { DEFAULT_CONTEXT_LENGTH, normalizeContextLength } from "../shared/contextWindow";

export type LocalVeilConnection = {
  baseUrl: string;
  authToken: string;
  runtimeBaseUrl: string;
  modelId: string;
};

export type LocalVeilDiagnostic = {
  level: "warn" | "error";
  event: string;
  message?: string;
  data?: Record<string, unknown>;
};

type LocalVeilDiagnosticSink = (diagnostic: LocalVeilDiagnostic) => void;

type RunningLocalVeil = LocalVeilConnection & {
  key: string;
  child: ChildProcess;
};

let running: RunningLocalVeil | null = null;
let launchingChild: ChildProcess | null = null;
let starting: { key: string; promise: Promise<LocalVeilConnection> } | null = null;
const stoppingChildren = new WeakSet<ChildProcess>();
const veilDiagnosticMarker = "VEIL_DIAGNOSTIC ";

export function parseLocalVeilDiagnosticLine(line: string): LocalVeilDiagnostic | null {
  const markerIndex = line.indexOf(veilDiagnosticMarker);
  if (markerIndex < 0) return null;
  try {
    const value = JSON.parse(line.slice(markerIndex + veilDiagnosticMarker.length)) as Record<string, unknown>;
    if (value.level !== "warn" && value.level !== "error") return null;
    const event = typeof value.event === "string" && /^[a-z0-9._-]{1,100}$/i.test(value.event)
      ? `veil.${value.event}`
      : "veil.failure";
    const { level, event: _event, message, ...data } = value;
    return {
      level,
      event,
      ...(typeof message === "string" ? { message: message.slice(0, 1000) } : {}),
      data,
    };
  } catch {
    return null;
  }
}

function localVeilKey(settings: ModelEndpointSettings, contextLength: number): string {
  return JSON.stringify({
    software: "ollama",
    runtimeBaseUrl: settings.baseUrl.trim().replace(/\/+$/, ""),
    modelId: settings.modelId.trim(),
    contextLength,
  });
}

async function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate a local Veil port.")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function packagedVeilBinaryPath(): string | null {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!resourcesPath) return null;
  const binary = path.join(resourcesPath, "veil", process.platform === "win32" ? "veil.exe" : "veil");
  return fs.existsSync(binary) ? binary : null;
}

function sourceVeilRoot(): string | null {
  const root = path.resolve(__dirname, "../../../../infrastructure/veil");
  return fs.existsSync(path.join(root, "go.mod")) ? root : null;
}

function localVeilCommand(): { command: string; args: string[]; cwd?: string } {
  const override = process.env.UMBRATIC_VEIL_BINARY?.trim();
  if (override) return { command: override, args: [] };
  const packaged = packagedVeilBinaryPath();
  if (packaged) return { command: packaged, args: [] };
  const sourceRoot = sourceVeilRoot();
  if (sourceRoot) return { command: "go", args: ["run", "./cmd/veil"], cwd: sourceRoot };
  throw new Error("The bundled local Veil runtime is missing. Reinstall Umbratic or switch to Server mode.");
}

function stopChild(child: ChildProcess | null) {
  if (!child || child.exitCode !== null || child.killed) return;
  stoppingChildren.add(child);
  if (process.platform === "win32" && child.pid) {
    const terminator = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    terminator.unref();
    return;
  }
  child.kill();
}

function probeLocalVeil(baseUrl: string, authToken: string, onReady: () => void): () => void {
  const probe = () => {
    const request = http.get(`${baseUrl}/api/health`, {
      headers: { Authorization: `Bearer ${authToken}` },
      timeout: 1000,
    }, (response) => {
      response.resume();
      onReady();
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => undefined);
  };
  probe();
  const interval = setInterval(probe, 150);
  return () => clearInterval(interval);
}

function activateLocalVeil(baseUrl: string, authToken: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = http.request(`${baseUrl}/api/model/connect`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}`, "Content-Length": "0" },
      timeout: 75000,
    }, (response) => {
      response.resume();
      response.once("end", () => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode >= 200 && statusCode < 300) {
          resolve();
          return;
        }
        reject(new Error(`Local Veil could not load the selected model (status ${statusCode}).`));
      });
    });
    request.once("timeout", () => request.destroy(new Error("Timed out loading the selected local model.")));
    request.once("error", reject);
    request.end();
  });
}

export function localVeilEnvironment(
  settings: ModelEndpointSettings,
  address: string,
  authToken: string,
  contextLength = DEFAULT_CONTEXT_LENGTH,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    VEIL_ADDR: address,
    VEIL_AUTH_TOKEN: authToken,
    VEIL_ENV_FILE: path.join(os.tmpdir(), "umbratic-managed-veil-no-env"),
    VEIL_MODEL: settings.modelId.trim(),
    // Large local-document prompts can spend more than a minute in prompt
    // evaluation before Ollama emits the first response byte. The runner still
    // owns cancellation and its bounded turn timeout.
    VEIL_MODEL_TIMEOUT: "10m",
    VEIL_REQUEST_TIMEOUT: "12m",
    VEIL_MAX_BODY_BYTES: "67108864",
    VEIL_MAX_OUTPUT_TOKENS: "8192",
    VEIL_PROVIDER_API_KEY: "",
    VEIL_PROVIDER_BASE_URL: settings.baseUrl.trim().replace(/\/+$/, ""),
    VEIL_PROVIDER_CHAT_PATH: "",
    VEIL_PROVIDER_ENDPOINT_PATH: "",
    VEIL_PROVIDER_MODELS_PATH: "",
    VEIL_PROVIDER_MODELS_ENDPOINT_PATH: "",
    VEIL_PROVIDER_PROTOCOL: "ollama",
    VEIL_CONTEXT_LENGTH: String(normalizeContextLength(contextLength)),
    VEIL_TEMPLATE_REGISTRY_PATH: "",
    VEIL_TELEMETRY_ENABLED: "false",
    VEIL_TELEMETRY_RETENTION_DAYS: "30",
    VEIL_TELEMETRY_STORE_PATH: "",
  };
}

export function stopLocalVeil(): void {
  const child = running?.child ?? launchingChild;
  running = null;
  launchingChild = null;
  starting = null;
  stopChild(child);
}

export function currentLocalVeilConnection(): LocalVeilConnection | null {
  if (!running || running.child.exitCode !== null) return null;
  const { baseUrl, authToken, runtimeBaseUrl, modelId } = running;
  return { baseUrl, authToken, runtimeBaseUrl, modelId };
}

async function startLocalVeil(
  settings: ModelEndpointSettings,
  contextLength: number,
  key: string,
  onDiagnostic: LocalVeilDiagnosticSink,
): Promise<LocalVeilConnection> {
  const runtimeBaseUrl = settings.baseUrl.trim().replace(/\/+$/, "");
  const modelId = settings.modelId.trim();
  if (!runtimeBaseUrl) throw new Error("Enter the local model runtime URL.");
  if (!modelId) throw new Error("Enter the local model name before connecting.");
  const runtimeUrl = new URL(runtimeBaseUrl);
  if (runtimeUrl.protocol !== "http:" && runtimeUrl.protocol !== "https:") {
    throw new Error("The local model runtime URL must use HTTP or HTTPS.");
  }
  if (!isLocalhostUrl(runtimeBaseUrl)) {
    throw new Error("Local mode only connects to model runtimes on this computer. Use Server mode for remote infrastructure.");
  }

  const port = await freeLocalPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const authToken = crypto.randomBytes(24).toString("base64url");
  const launch = localVeilCommand();
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: localVeilEnvironment(settings, `127.0.0.1:${port}`, authToken, contextLength),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  launchingChild = child;

  let output = "";
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for local Veil to start.${output.trim() ? ` ${output.trim()}` : ""}`)), 15000);
    const stopProbing = probeLocalVeil(baseUrl, authToken, () => finish());
    const cleanup = () => {
      clearTimeout(timer);
      stopProbing();
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk: Buffer | string) => {
      output = `${output}${chunk.toString()}`.slice(-4000);
      if (/umbratic veil listening on\s+127\.0\.0\.1:/i.test(output)) finish();
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null) =>
      finish(new Error(`Local Veil exited before it was ready${code === null ? "" : ` (code ${code})`}.${output.trim() ? ` ${output.trim()}` : ""}`));
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  }).catch((error) => {
    stopChild(child);
    throw error;
  });

  await activateLocalVeil(baseUrl, authToken).catch((error) => {
    stopChild(child);
    throw error;
  });

  child.stdout?.resume();
  let diagnosticBuffer = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    diagnosticBuffer += chunk.toString();
    const lines = diagnosticBuffer.split(/\r?\n/);
    diagnosticBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const diagnostic = parseLocalVeilDiagnosticLine(line);
      if (diagnostic) onDiagnostic(diagnostic);
    }
    if (diagnosticBuffer.length > 16000) diagnosticBuffer = diagnosticBuffer.slice(-16000);
  });

  launchingChild = null;
  const connection: RunningLocalVeil = { key, child, baseUrl, authToken, runtimeBaseUrl, modelId };
  running = connection;
  child.once("exit", (code, signal) => {
    if (running?.child === child) running = null;
    if (!stoppingChildren.has(child)) {
      onDiagnostic({
        level: "warn",
        event: "veil.process_exited",
        message: "Local Veil exited unexpectedly.",
        data: { code, signal },
      });
    }
  });
  return { baseUrl, authToken, runtimeBaseUrl, modelId };
}

export async function ensureLocalVeil(
  settings: ModelEndpointSettings,
  configuredContextLength = DEFAULT_CONTEXT_LENGTH,
  onDiagnostic: LocalVeilDiagnosticSink = () => undefined,
): Promise<LocalVeilConnection> {
  if (settings.mode !== "local") throw new Error("Local Veil can only run in Local mode.");
  if (settings.software !== "ollama") throw new Error("Local mode supports Ollama. Use Server mode for vLLM.");
  const contextLength = normalizeContextLength(configuredContextLength);
  const key = localVeilKey(settings, contextLength);
  const current = currentLocalVeilConnection();
  if (current && running?.key === key) return current;
  if (starting?.key === key) return starting.promise;
  if (starting) await starting.promise.catch(() => undefined);
  stopLocalVeil();
  const promise = startLocalVeil(settings, contextLength, key, onDiagnostic);
  starting = { key, promise };
  try {
    return await promise;
  } finally {
    if (starting?.promise === promise) starting = null;
  }
}
