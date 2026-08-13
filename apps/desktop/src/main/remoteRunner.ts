import * as crypto from "node:crypto";
import { app } from "electron";

import { currentLocalVeilConnection } from "./localVeil";
import { assertUmbraticRunnerConfig } from "./policy";
import {
  remoteSecret,
  remoteTarget,
  requireStoredRemoteConnection,
  type StoredRemoteConnection,
} from "./remoteConnections";
import {
  remoteCapabilityReport,
  remotePlatformKey,
  remoteRunnerArtifact,
} from "./remoteHost";
import { buildUmbraticRunnerConfig, freeLocalPort } from "./runnerAdapter";
import { shellCommand, spawnSsh } from "./sshTransport";
import { readModelEndpointSettings } from "./storage";
import type { LocalModelInfo, RunnerProcess, TaskRecord } from "./types";

/**
 * Runs the workspace runner on another machine.
 *
 * One ssh process carries the whole session: it starts the runner over there,
 * forwards a local port to the runner's loopback listener, and forwards a
 * remote port back to the local Veil. Everything above this module — the HTTP
 * requests, the event stream, permission replies, teardown — is unchanged,
 * because from its side a remote run is still an authenticated loopback URL.
 *
 * Nothing about the runner's own guarantees is relaxed to make that work. It
 * still binds 127.0.0.1 on the host it runs on, and it still refuses to be
 * reached from anywhere except that host's loopback interface. The tunnel is
 * what crosses the network, and SSH is what protects it.
 */

const startupTimeoutMs = 45_000;
const portAttempts = 3;

/** Ports the remote runner and the reverse Veil forward are drawn from. */
function candidateRemotePort(): number {
  return 20_000 + crypto.randomInt(0, 30_000);
}

export type RemoteRunnerReadiness =
  | { ok: true; connection: StoredRemoteConnection }
  | { ok: false; message: string };

/**
 * Confirms a connection can host a run before a task is created, so a chat
 * fails with something the user can fix rather than mid-run.
 */
export async function checkRemoteRunnerReady(connectionId: string): Promise<RemoteRunnerReadiness> {
  const connection = requireStoredRemoteConnection(connectionId);
  const platformKey = remotePlatformKey(connection.platformOs, connection.platformArch);
  const artifact = platformKey ? remoteRunnerArtifact(platformKey) : null;
  if (!artifact) {
    return { ok: false, message: `Umbratic has no runner build for ${connection.name}.` };
  }
  if (connection.runnerSha256 !== artifact.sha256) {
    return {
      ok: false,
      message: `Install the Umbratic runner on ${connection.name} from settings before running there.`,
    };
  }
  return { ok: true, connection };
}

/**
 * The local Veil, as the remote host will reach it.
 *
 * The reverse forward deliberately reuses the same port number on both sides,
 * so `http://127.0.0.1:<port>` names the same service from either machine and
 * the runner's configuration is byte-identical to a local run's. Model traffic
 * then travels inside the SSH channel and is never exposed on the network.
 */
function veilReverseForward(): string {
  const connection = currentLocalVeilConnection();
  if (!connection) {
    throw new Error("The local model service is not running, so a remote run has nothing to call.");
  }
  const port = Number(new URL(connection.baseUrl).port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("The local model service is not reachable on a port that can be forwarded.");
  }
  return `127.0.0.1:${port}:127.0.0.1:${port}`;
}

function startAttempt(
  connection: StoredRemoteConnection,
  localPort: number,
  remotePort: number,
  veilForward: string,
  directory: string,
): ReturnType<typeof spawnSsh> {
  return spawnSsh(
    remoteTarget(connection),
    app.getPath("userData"),
    [
      "-o", "ExitOnForwardFailure=yes",
      // A dropped network should end the run rather than leave the desktop
      // waiting on a stream that will never produce another event.
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
      "-R", veilForward,
    ],
    [
      `cd ${shellCommand([directory])} || exit 4`,
      // `exec` replaces the login shell, so the runner is the process the SSH
      // channel owns and there is no shell left behind if it exits.
      `exec ${shellCommand([connection.runnerPath, "serve", "--hostname=127.0.0.1", `--port=${remotePort}`])}`,
    ].join("\n"),
    remoteSecret(connection),
  );
}

function awaitRemoteListener(child: ReturnType<typeof spawnSsh>): Promise<{ ok: true } | { ok: false; output: string; portInUse: boolean }> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const timer = setTimeout(() => finish({ ok: false, output, portInUse: false }), startupTimeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const finish = (result: { ok: true } | { ok: false; output: string; portInUse: boolean }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (/umbratic runner listening on\s+https?:\/\//i.test(output)) finish({ ok: true });
    };
    const onError = () => finish({ ok: false, output, portInUse: false });
    const onExit = () =>
      finish({
        ok: false,
        output,
        portInUse: /address (already )?in use|cannot listen to port|bind: /i.test(output),
      });
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function startupFailure(output: string): string {
  const trimmed = output.trim();
  if (/permission denied/i.test(trimmed)) return "The remote host refused the credentials for this connection.";
  if (/host key verification failed/i.test(trimmed)) {
    return "This host answered with a different key than the one Umbratic first saw. Remove the connection and add it again if that was expected.";
  }
  if (/exit 4|no such file or directory/i.test(trimmed)) {
    return "The remote folder for this chat no longer exists.";
  }
  return `The remote runner did not start.${trimmed ? `\n${trimmed.slice(-600)}` : ""}`;
}

/**
 * Starts a runner on the task's remote host and returns it in the same shape a
 * local run produces, so callers do not branch on where the work happens.
 */
export async function startRemoteRunnerServer(
  task: TaskRecord,
  model: LocalModelInfo,
): Promise<RunnerProcess> {
  const remote = task.remote;
  if (!remote) throw new Error("This task is not attached to a remote host.");
  if (readModelEndpointSettings().mode === "server") {
    throw new Error(
      "Remote hosts run against the local model service. Switch this connection to Local mode to run on a remote host.",
    );
  }
  const readiness = await checkRemoteRunnerReady(remote.connectionId);
  if (!readiness.ok) throw new Error(readiness.message);
  const connection = readiness.connection;
  const capabilityReport = await remoteCapabilityReport(connection.id);
  const veilForward = veilReverseForward();
  const password = crypto.randomBytes(18).toString("base64url");
  // Attachments live in this app's data directory; the remote runner cannot
  // read them, so a remote run carries no attachment directory at all rather
  // than one that silently resolves to nothing over there.
  const config = buildUmbraticRunnerConfig(task, model, undefined, capabilityReport);
  assertUmbraticRunnerConfig(config, model, app.getPath("userData"));

  let lastOutput = "";
  for (let attemptIndex = 0; attemptIndex < portAttempts; attemptIndex += 1) {
    const localPort = await freeLocalPort();
    const child = startAttempt(connection, localPort, candidateRemotePort(), veilForward, remote.directory);
    // Stdin carries the configuration and then stays open for the life of the
    // run. Its close is how the remote runner learns the session ended.
    child.stdin?.write(`${JSON.stringify({ ...config, password })}\n`);
    const started = await awaitRemoteListener(child);
    if (started.ok) {
      return {
        taskId: task.id,
        url: `http://127.0.0.1:${localPort}`,
        password,
        directory: remote.directory,
        remote,
        child,
        abortController: new AbortController(),
      };
    }
    lastOutput = started.output;
    child.stdin?.end();
    child.kill();
    // A port collision on the remote host is the one failure worth retrying:
    // the port was chosen here without being able to see what is already bound
    // over there.
    if (!started.portInUse) break;
  }
  throw new Error(startupFailure(lastOutput));
}
