import type { LocalImageRuntime } from "./localImage";
import { spawn, type ChildProcess } from "node:child_process";
import { stopChild, stopRequested } from "./childShutdown";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { isLocalhostUrl } from "./utils";
import type { SamplingProfile } from "./modelCatalog";
import type { ReasoningEffort } from "../shared/desktopApi";
import type { ActiveModelEndpointSettings } from "./types";
import { DEFAULT_CONTEXT_LENGTH, normalizeContextLength } from "../shared/contextWindow";

export type LocalVeilConnection = {
  baseUrl: string;
  authToken: string;
  runtimeBaseUrl: string;
  modelId: string;
};

/**
 * The `llama-server` this Veil is put in front of.
 *
 * Both fields are minted by the desktop for one app run, and both are stable
 * across a sidecar restart, so Veil's environment stays valid when the user
 * switches models: the sidecar is replaced, Veil is not.
 */
export type LocalRuntimeConnection = {
  baseUrl: string;
  apiKey: string;
  /**
   * Whether the selected model has thinking to direct. It comes from the model
   * catalog rather than from the runtime: llama-server does not expose the
   * fact, and Veil drops a thinking directive for a model that lacks it.
   */
  reasoning: boolean;
  /** True only when the chat runtime has loaded a vision projector. */
  vision: boolean;
  /**
   * How hard to ask this model to think, or null to say nothing about it.
   * Null is the honest value for a model whose chat template does not read an
   * effort: forcing one on would be answering a question nobody asked.
   */
  reasoningEffort?: ReasoningEffort | null;
  /**
   * The sampling the model card recommends, or null to leave Veil on its own
   * local defaults. It comes from the catalog for the same reason `reasoning`
   * does: llama-server does not publish what its weights were tuned for.
   */
  sampling?: SamplingProfile | null;
  /**
   * The dictation sidecar, when a dictation model is selected and downloaded.
   * Its presence is what makes local Veil advertise `speech.transcribe`, so it
   * joins the restart key: changing the dictation model has to restart Veil,
   * which is configured with the model id.
   */
  speech?: { baseUrl: string; apiKey: string; model: string };
  image?: LocalImageRuntime;
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

function localVeilKey(
  settings: ActiveModelEndpointSettings,
  contextLength: number,
  runtime: LocalRuntimeConnection,
): string {
  return JSON.stringify({
    modelId: settings.modelId.trim(),
    contextLength,
    runtimeBaseUrl: runtime.baseUrl,
    runtimeApiKey: runtime.apiKey,
    reasoning: runtime.reasoning,
    vision: runtime.vision,
    // Both join the key: Veil reads them from its environment once at startup,
    // so a changed effort or a changed sampling set has to bring it back up.
    reasoningEffort: runtime.reasoningEffort ?? null,
    sampling: runtime.sampling ?? null,
    speech: runtime.speech ?? null,
    image: runtime.image ?? null,
  });
}

function parseListeningAddress(output: string): string | null {
  const match = output.match(/umbratic veil listening on\s+(127\.0\.0\.1:\d+)/i);
  return match?.[1] ?? null;
}

function hostRuntimeEnvironment(includeGoToolchain: boolean): NodeJS.ProcessEnv {
  const names = [
    "HOME",
    "USERPROFILE",
    "TMP",
    "TEMP",
    "TMPDIR",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "LANG",
    "LC_ALL",
  ];
  if (includeGoToolchain) {
    names.push(
      "PATH",
      "Path",
      "PATHEXT",
      "GOROOT",
      "GOPATH",
      "GOPROXY",
      "GOSUMDB",
      "GOCACHE",
      "GOTOOLCHAIN",
      "GOFLAGS",
      "LOCALAPPDATA",
    );
  }
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
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


function probeLocalVeil(
  baseUrl: string,
  authToken: string,
  onReady: () => void,
  onObservation: (observation: string) => void = () => undefined,
): () => void {
  const probe = () => {
    const request = http.get(`${baseUrl}/api/health`, {
      headers: { Authorization: `Bearer ${authToken}` },
      timeout: 1000,
    }, (response) => {
      response.resume();
      // Health requires the model runtime to answer, so a non-200 here usually
      // means the runtime, not Veil, is the problem; keep the last status for
      // the timeout message.
      onObservation(`last health response was status ${response.statusCode}`);
      // Require an authenticated healthy response. Any other status means the
      // bearer may have reached the wrong process or Veil is not ready yet.
      if (response.statusCode === 200) onReady();
    });
    request.once("timeout", () => {
      onObservation("the health probe timed out");
      request.destroy();
    });
    request.once("error", (error) => onObservation(`the health probe failed (${error.message})`));
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

export function localVeilEnvironment(input: {
  settings: ActiveModelEndpointSettings;
  address: string;
  authToken: string;
  runtime: LocalRuntimeConnection;
  contextLength?: number;
  includeGoToolchain?: boolean;
}): NodeJS.ProcessEnv {
  const { settings, address, authToken, runtime } = input;
  const contextLength = input.contextLength ?? DEFAULT_CONTEXT_LENGTH;
  // All three or none: Veil refuses a half-configured speech runtime rather
  // than advertising dictation that would fail on first press.
  // The model card's own numbers, when the catalog recorded any. Absent leaves
  // Veil on its local defaults rather than on a set this model never asked for.
  const sampling = runtime.sampling
    ? {
        VEIL_TEMPERATURE: String(runtime.sampling.temperature),
        VEIL_TOP_P: String(runtime.sampling.topP),
        VEIL_TOP_K: String(runtime.sampling.topK),
        VEIL_MIN_P: String(runtime.sampling.minP),
        VEIL_PRESENCE_PENALTY: String(runtime.sampling.presencePenalty),
        VEIL_REPETITION_PENALTY: String(runtime.sampling.repetitionPenalty),
      }
    : {};
  const reasoningEffort = runtime.reasoningEffort ? { VEIL_REASONING_EFFORT: runtime.reasoningEffort } : {};
  const speech = runtime.speech
    ? {
        VEIL_SPEECH_BASE_URL: runtime.speech.baseUrl,
        VEIL_SPEECH_MODEL: runtime.speech.model,
        VEIL_SPEECH_API_KEY: runtime.speech.apiKey,
      }
    : {};
  // Allowlisted host vars only. Never spread Electron process.env — that would
  // inherit proxies and unrelated VEIL_* overrides. Settings/SQLite own runtime.
  return {
    ...hostRuntimeEnvironment(input.includeGoToolchain === true),
    VEIL_ADDR: address,
    VEIL_AUTH_TOKEN: authToken,
    VEIL_ENV_FILE: "-",
    // Exit when this process does. before-quit only runs when Electron is asked
    // to quit; a force-kill from a dev script skips it and leaves Veil holding a
    // port forever. The inherited stdin pipe closes on every exit path, so Veil
    // watches it for EOF and drains itself.
    VEIL_PARENT_STDIN_WATCH: "1",
    VEIL_MODE: "local",
    VEIL_MODEL: settings.modelId.trim(),
    // Large local-document prompts can spend more than a minute in prompt
    // evaluation before the runtime emits the first response byte. The runner
    // still owns cancellation and its bounded turn timeout.
    VEIL_MODEL_TIMEOUT: "10m",
    VEIL_REQUEST_TIMEOUT: "12m",
    VEIL_MAX_BODY_BYTES: "67108864",
    VEIL_MAX_OUTPUT_TOKENS: "8192",
    // The llama-server sidecar this Veil owns, and the per-run secret that lets
    // only this Veil drive it.
    VEIL_PROVIDER_BASE_URL: runtime.baseUrl,
    VEIL_PROVIDER_API_KEY: runtime.apiKey,
    VEIL_MODEL_REASONING: runtime.reasoning ? "true" : "false",
    VEIL_MODEL_VISION: runtime.vision ? "true" : "false",
    VEIL_CONTEXT_LENGTH: String(normalizeContextLength(contextLength)),
    VEIL_TEMPLATE_REGISTRY_PATH: "",
    ...sampling,
    ...reasoningEffort,
    ...speech,
    ...(runtime.image ? {
      VEIL_IMAGE_BINARY: runtime.image.binary,
      VEIL_IMAGE_WEIGHTS: runtime.image.weights,
      VEIL_IMAGE_ENCODER: runtime.image.encoder,
      VEIL_IMAGE_VAE: runtime.image.vae,
    } : {}),
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
  settings: ActiveModelEndpointSettings,
  contextLength: number,
  runtime: LocalRuntimeConnection,
  key: string,
  onDiagnostic: LocalVeilDiagnosticSink,
): Promise<LocalVeilConnection> {
  const runtimeBaseUrl = runtime.baseUrl;
  const modelId = settings.modelId.trim();
  if (!modelId) throw new Error("Download a model in Settings → Connection");
  if (!isLocalhostUrl(runtimeBaseUrl)) {
    throw new Error("Local mode only connects to model runtimes on this computer. Use Server mode for remote infrastructure.");
  }

  const authToken = crypto.randomBytes(24).toString("base64url");
  const launch = localVeilCommand();
  // Bind ephemeral port inside Veil (127.0.0.1:0) and learn the real address from
  // its listen log — avoids the freeLocalPort close/rebind race.
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: localVeilEnvironment({
      settings,
      address: "127.0.0.1:0",
      authToken,
      runtime,
      contextLength,
      includeGoToolchain: launch.command === "go",
    }),
    // stdin is a pipe this process holds open and never writes to. It is the
    // liveness channel: when Electron exits for any reason, the write end
    // closes, Veil reads EOF, and it shuts itself down. `go run` forwards stdin
    // to the binary it builds, so this works from source as well as packaged.
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  launchingChild = child;
  // Never end() this stream: closing it early would tell Veil to quit.
  child.stdin?.on("error", () => {});

  let output = "";
  let baseUrl = "";
  let stopProbing: (() => void) | undefined;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let lastHealthObservation = "";
    // This first deadline covers only reaching the listen log line. When Veil
    // runs from source, `go run` compiles first and previously consumed nearly
    // the whole budget, so warmup timed out with "listening" already in the
    // output — the health probe never got a fair window.
    let timer = setTimeout(() => finish(new Error(`Timed out waiting for local Veil to report its listening address.${output.trim() ? ` ${output.trim()}` : ""}`)), 15000);
    const cleanup = () => {
      clearTimeout(timer);
      stopProbing?.();
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
    const beginProbing = (listeningAddress: string) => {
      if (baseUrl) return;
      baseUrl = `http://${listeningAddress}`;
      // Veil is up; give the health probe its own full window. Health passes
      // only once the model runtime answers, so name the runtime in the
      // failure instead of blaming Veil.
      clearTimeout(timer);
      timer = setTimeout(() => finish(new Error(
        `Local Veil is listening at ${baseUrl} but its health check did not pass within 15 seconds`
        + `${lastHealthObservation ? ` (${lastHealthObservation})` : ""}.`
        + ` Health requires the model runtime at ${runtimeBaseUrl} to answer — check that it is running.`,
      )), 15000);
      stopProbing = probeLocalVeil(baseUrl, authToken, () => finish(), (observation) => {
        lastHealthObservation = observation;
      });
    };
    const onData = (chunk: Buffer | string) => {
      output = `${output}${chunk.toString()}`.slice(-4000);
      const listening = parseListeningAddress(output);
      if (listening) beginProbing(listening);
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
    if (!stopRequested(child)) {
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

/**
 * Backoff for a local Veil that will not stay up.
 *
 * ensureLocalVeil runs on every status poll, so a Veil that crashes on start
 * used to be respawned several times a second for as long as the app was open —
 * burning CPU and filling the diagnostics log with the same failure. Each
 * consecutive failure pushes the next attempt further out; one success clears it.
 */
const veilRespawnBaseDelayMs = 1_000;
const veilRespawnMaxDelayMs = 30_000;
let respawn: { key: string; failures: number; nextAttemptAt: number } | null = null;

function veilRespawnDelayMs(failures: number): number {
  return Math.min(veilRespawnBaseDelayMs * 2 ** (failures - 1), veilRespawnMaxDelayMs);
}

function noteVeilStartFailed(key: string) {
  const failures = respawn?.key === key ? respawn.failures + 1 : 1;
  respawn = { key, failures, nextAttemptAt: Date.now() + veilRespawnDelayMs(failures) };
}

/** A person asking for a fresh attempt should not be told to wait out a backoff. */
export function resetLocalVeilBackoff(): void {
  respawn = null;
}

export async function ensureLocalVeil(
  settings: ActiveModelEndpointSettings,
  runtime: LocalRuntimeConnection,
  configuredContextLength = DEFAULT_CONTEXT_LENGTH,
  onDiagnostic: LocalVeilDiagnosticSink = () => undefined,
): Promise<LocalVeilConnection> {
  if (settings.mode !== "local") throw new Error("Local Veil can only run in Local mode.");
  const contextLength = normalizeContextLength(configuredContextLength);
  const key = localVeilKey(settings, contextLength, runtime);
  const current = currentLocalVeilConnection();
  if (current && running?.key === key) return current;
  if (starting?.key === key) return starting.promise;
  if (starting) await starting.promise.catch(() => undefined);
  if (respawn?.key === key && Date.now() < respawn.nextAttemptAt) {
    const seconds = Math.ceil((respawn.nextAttemptAt - Date.now()) / 1000);
    throw new Error(`Local Veil failed to start ${respawn.failures} times. Retrying in ${seconds}s.`);
  }
  stopLocalVeil();
  const promise = startLocalVeil(settings, contextLength, runtime, key, onDiagnostic);
  starting = { key, promise };
  try {
    const connection = await promise;
    respawn = null;
    return connection;
  } catch (cause) {
    noteVeilStartFailed(key);
    throw cause;
  } finally {
    if (starting?.promise === promise) starting = null;
  }
}
