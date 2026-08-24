/**
 * Supervisor for a bundled `llama-server` sidecar.
 *
 * Two sidecars run under this: the chat model and, when dictation is on, the
 * ASR model. They differ only in their argv and their lifecycle trigger, so the
 * process handling — binary resolution, the reserved loopback port, the per-run
 * bearer, readiness, restart-on-change, backoff, and the Windows tree kill —
 * lives here once and each caller supplies the rest.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { stopChild, stopRequested } from "./childShutdown";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";

export type LlamaConnection = {
  baseUrl: string;
  apiKey: string;
};

export type LlamaDiagnostic = {
  level: "warn" | "error";
  event: string;
  message?: string;
  data?: Record<string, unknown>;
};

export type LlamaDiagnosticSink = (diagnostic: LlamaDiagnostic) => void;

export type LlamaSupervisor = {
  /**
   * Starts the sidecar if it is not already running for this key, and resolves
   * once it answers /health. `key` is the whole of the restart decision: a
   * different key means different weights or a different context size, and the
   * old process is replaced rather than reused.
   */
  ensure(input: { key: string; args: string[]; onDiagnostic?: LlamaDiagnosticSink }): Promise<LlamaConnection>;
  stop(): void;
  current(): LlamaConnection | null;
  /** The key the live sidecar was started with, or null when none is running. */
  currentKey(): string | null;
  /** Clears the failure backoff so an explicit user retry attempts immediately. */
  resetBackoff(): void;
  /**
   * The address this sidecar will always be reachable at. Reserved once per app
   * run so a restart does not invalidate configuration that named it — Veil is
   * started with these values in its environment and cannot be told new ones
   * without restarting too.
   */
  endpoint(): Promise<LlamaConnection>;
};

const readinessTimeoutMs = 120_000;
const respawnBaseDelayMs = 1_000;
const respawnMaxDelayMs = 30_000;

/**
 * Resolves the packaged binary, then an explicit override.
 *
 * There is no fallback to a runtime found on PATH: an Umbratic that quietly
 * used whatever `llama-server` happened to be installed would be running
 * unreviewed code against the user's documents.
 */
export function llamaServerBinaryPath(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const executable = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  const packaged = resourcesPath ? path.join(resourcesPath, "llama-server", executable) : "";
  if (packaged && fs.existsSync(packaged)) return packaged;
  const override = process.env.UMBRATIC_LLAMA_SERVER?.trim();
  if (override && fs.existsSync(override)) return override;
  throw new Error("llama-server binary is missing — run the packaging build or set UMBRATIC_LLAMA_SERVER");
}

/**
 * Takes a free loopback port from the operating system and gives it straight
 * back. There is a window between the two in which something else could claim
 * it, which is why this runs once per sidecar per app run rather than on every
 * restart: a stable port is what lets the sidecar restart under a Veil that was
 * configured with its address.
 */
function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "string" || address === null) {
        probe.close();
        reject(new Error("Could not reserve a local port for the model runtime."));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * The sidecar inherits only what a process needs to run. Never spread
 * process.env: that would hand the model runtime the app's proxy settings and
 * every unrelated override on the machine.
 */
function sidecarEnvironment(apiKey: string): NodeJS.ProcessEnv {
  const names = ["HOME", "USERPROFILE", "TMP", "TEMP", "TMPDIR", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "Path", "LANG", "LC_ALL"];
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  // llama-server reads LLAMA_API_KEY. Putting the bearer on argv would expose
  // it to every other user on the box via ps / Activity Monitor / WMI.
  env.LLAMA_API_KEY = apiKey;
  return env;
}


/**
 * Polls /health until the runtime reports ready.
 *
 * llama-server leaves /health unauthenticated by design and answers 503 while
 * it is still mapping weights — which on a 9 GB model is tens of seconds, so
 * this deliberately waits rather than treating a slow load as a failure.
 */
function probeHealth(baseUrl: string, onReady: () => void, onObservation: (observation: string) => void): () => void {
  const probe = () => {
    const request = http.get(`${baseUrl}/health`, { timeout: 1000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        if (body.length < 512) body += chunk;
      });
      response.once("end", () => {
        onObservation(`last health response was status ${response.statusCode}`);
        if (response.statusCode === 200 && body.includes(`"ok"`)) onReady();
      });
    });
    request.once("timeout", () => {
      onObservation("the health probe timed out");
      request.destroy();
    });
    request.once("error", (error) => onObservation(`the health probe failed (${error.message})`));
  };
  probe();
  const interval = setInterval(probe, 250);
  return () => clearInterval(interval);
}

export function createLlamaSupervisor(options: { label: string }): LlamaSupervisor {
  const apiKey = crypto.randomBytes(32).toString("hex");
  let reservedPort: number | null = null;
  let reserving: Promise<number> | null = null;
  let running: { key: string; child: ChildProcess } | null = null;
  let launchingChild: ChildProcess | null = null;
  let starting: { key: string; promise: Promise<LlamaConnection> } | null = null;
  let respawn: { key: string; failures: number; nextAttemptAt: number } | null = null;

  const baseUrlFor = (port: number) => `http://127.0.0.1:${port}`;

  async function port(): Promise<number> {
    if (reservedPort !== null) return reservedPort;
    if (!reserving) reserving = reserveLoopbackPort();
    reservedPort = await reserving;
    return reservedPort;
  }

  function current(): LlamaConnection | null {
    if (!running || running.child.exitCode !== null || reservedPort === null) return null;
    return { baseUrl: baseUrlFor(reservedPort), apiKey };
  }

  function currentKey(): string | null {
    return current() === null ? null : running?.key ?? null;
  }

  function stop(): void {
    const child = running?.child ?? launchingChild;
    running = null;
    launchingChild = null;
    starting = null;
    stopChild(child);
  }

  async function start(key: string, args: string[], onDiagnostic: LlamaDiagnosticSink): Promise<LlamaConnection> {
    const binary = llamaServerBinaryPath();
    const listenPort = await port();
    const baseUrl = baseUrlFor(listenPort);
    const child = spawn(
      binary,
      // Bound to loopback. The per-run bearer is in the child environment, not
      // on this argv: another user on the box can read the command line.
      ["--host", "127.0.0.1", "--port", String(listenPort), ...args],
      { env: sidecarEnvironment(apiKey), stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    launchingChild = child;

    let output = "";
    let exitDetail: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let stopProbing: (() => void) | undefined;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let lastObservation = "";
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stopProbing?.();
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        child.off("error", onError);
        child.off("exit", onExit);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => finish(new Error(
        `The local model runtime did not become ready within ${readinessTimeoutMs / 1000} seconds`
        + `${lastObservation ? ` (${lastObservation})` : ""}.`,
      )), readinessTimeoutMs);
      const onData = (chunk: Buffer | string) => {
        output = `${output}${chunk.toString()}`.slice(-4000);
      };
      const onError = (error: Error) => finish(error);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        exitDetail = { code, signal };
        finish(new Error(
          `The local model runtime exited before it was ready${code === null ? "" : ` (code ${code})`}.`,
        ));
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.once("error", onError);
      child.once("exit", onExit);
      stopProbing = probeHealth(baseUrl, () => finish(), (observation) => {
        lastObservation = observation;
      });
    }).catch((error) => {
      const superseded = stopRequested(child);
      stopChild(child);
      // A start that lost to a newer settings change was killed on purpose and
      // is not a failure worth alarming anyone with. The runtime's own output
      // can name file paths and arguments, so it goes to the diagnostics log
      // rather than into a renderer-visible message.
      if (!superseded) {
        onDiagnostic({
          level: "error",
          event: `${options.label}.start_failed`,
          message: "The local model runtime failed to start.",
          data: {
            output: output.trim().slice(-2000),
            ...(exitDetail ? { exitCode: exitDetail.code, exitSignal: exitDetail.signal } : {}),
          },
        });
      }
      throw error;
    });

    child.stdout?.resume();
    child.stderr?.resume();
    launchingChild = null;
    running = { key, child };
    child.once("exit", (code, signal) => {
      if (running?.child === child) running = null;
      if (!stopRequested(child)) {
        onDiagnostic({
          level: "warn",
          event: `${options.label}.process_exited`,
          message: "The local model runtime exited unexpectedly.",
          data: { code, signal },
        });
      }
    });
    return { baseUrl, apiKey };
  }

  return {
    current,
    currentKey,
    stop,
    resetBackoff() {
      respawn = null;
    },
    async endpoint() {
      return { baseUrl: baseUrlFor(await port()), apiKey };
    },
    async ensure({ key, args, onDiagnostic = () => undefined }) {
      const live = current();
      if (live && running?.key === key) return live;
      if (starting?.key === key) return starting.promise;
      if (starting) await starting.promise.catch(() => undefined);
      // ensure runs on every status poll, so a runtime that crashes on start
      // would otherwise be respawned several times a second for as long as the
      // app is open. One success clears the backoff.
      if (respawn?.key === key && Date.now() < respawn.nextAttemptAt) {
        const seconds = Math.ceil((respawn.nextAttemptAt - Date.now()) / 1000);
        throw new Error(`The local model runtime failed to start ${respawn.failures} times. Retrying in ${seconds}s.`);
      }
      stop();
      const promise = start(key, args, onDiagnostic);
      starting = { key, promise };
      try {
        const connection = await promise;
        respawn = null;
        return connection;
      } catch (cause) {
        const failures = respawn?.key === key ? respawn.failures + 1 : 1;
        respawn = {
          key,
          failures,
          nextAttemptAt: Date.now() + Math.min(respawnBaseDelayMs * 2 ** (failures - 1), respawnMaxDelayMs),
        };
        throw cause;
      } finally {
        if (starting?.promise === promise) starting = null;
      }
    },
  } satisfies LlamaSupervisor;
}
