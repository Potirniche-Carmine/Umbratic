import { app, dialog } from "electron";

import { getMainWindow } from "./mainRuntime";
import {
  deleteRemoteConnection as removeStoredConnection,
  listStoredRemoteConnections,
  patchRemoteConnection,
  remoteSecret,
  remoteTarget,
  requireStoredRemoteConnection,
  saveRemoteConnection as saveStoredConnection,
  validatedRemoteDirectory,
} from "./remoteConnections";
import {
  forgetRemoteCapabilityReport,
  installRemoteRunner,
  listRemoteDirectory,
  probeRemoteHostFacts,
  publicRemoteConnectionFor,
  remotePlatformKey,
  remoteRunnerArtifact,
} from "./remoteHost";
import { hostKeyIsTrusted, scanRemoteHostKey, trustHostKey } from "./sshTransport";
import type {
  RemoteConnectionCheck,
  RemoteConnectionInfo,
  RemoteDirectoryListing,
  RemoteHostKeyOffer,
} from "./types";
import { isRecord, requiredString } from "./utils";

/**
 * The remote-connection operations the settings page drives. Each one is a
 * single user-visible action, and each returns the connection as the renderer
 * should now show it, so the page never has to re-derive state from a partial
 * result.
 */

function connectionIdFrom(input: unknown): string {
  if (!isRecord(input)) throw new Error("Invalid remote connection request.");
  return requiredString(input.connectionId, "connectionId");
}

export function listRemoteConnections(): RemoteConnectionInfo[] {
  return listStoredRemoteConnections().map(publicRemoteConnectionFor);
}

export function saveRemoteConnection(input: unknown): RemoteConnectionInfo {
  const saved = saveStoredConnection(input);
  return publicRemoteConnectionFor(requireStoredRemoteConnection(saved.id));
}

export function deleteRemoteConnection(input: unknown): { ok: true } {
  const connectionId = connectionIdFrom(input);
  removeStoredConnection(connectionId);
  forgetRemoteCapabilityReport(connectionId);
  return { ok: true };
}

/**
 * Reads the host's key without offering any credential to it, so the user can
 * compare the fingerprint before this app ever tries to sign in.
 */
export async function offerRemoteHostKey(input: unknown): Promise<RemoteHostKeyOffer> {
  const connection = requireStoredRemoteConnection(connectionIdFrom(input));
  const key = await scanRemoteHostKey(remoteTarget(connection));
  return {
    fingerprint: key.fingerprint,
    keyType: key.keyType,
    alreadyTrusted:
      hostKeyIsTrusted(app.getPath("userData"), connection.host, connection.port)
      && connection.hostKeyFingerprint === key.fingerprint,
  };
}

/**
 * Records the key the user approved.
 *
 * The fingerprint the user saw is sent back and re-checked against a fresh
 * scan. If the host answered with a different key in between, this refuses
 * rather than trusting something nobody looked at.
 */
export async function trustRemoteHostKey(input: unknown): Promise<RemoteConnectionInfo> {
  if (!isRecord(input)) throw new Error("Invalid host key approval.");
  const connection = requireStoredRemoteConnection(connectionIdFrom(input));
  const approved = requiredString(input.fingerprint, "fingerprint");
  const key = await scanRemoteHostKey(remoteTarget(connection));
  if (key.fingerprint !== approved) {
    throw new Error("The remote host answered with a different key than the one shown. Nothing was trusted.");
  }
  trustHostKey(app.getPath("userData"), key.line);
  return publicRemoteConnectionFor(
    patchRemoteConnection(connection.id, { hostKeyFingerprint: key.fingerprint, hostKeyType: key.keyType }),
  );
}

/** Signs in, records what the host is, and reports whether it can host a run. */
export async function checkRemoteConnection(input: unknown): Promise<RemoteConnectionCheck> {
  const connection = requireStoredRemoteConnection(connectionIdFrom(input));
  if (!connection.hostKeyFingerprint) {
    return {
      ok: false,
      message: "Review and trust this host's key first.",
      connection: publicRemoteConnectionFor(connection),
    };
  }
  const facts = await probeRemoteHostFacts(remoteTarget(connection), remoteSecret(connection));
  const platformKey = remotePlatformKey(facts.os, facts.arch);
  const artifact = platformKey ? remoteRunnerArtifact(platformKey) : null;
  const updated = patchRemoteConnection(connection.id, {
    platformOs: facts.os,
    platformArch: facts.arch,
    runnerPath: facts.runnerSha256 ? facts.runnerPath : "",
    runnerSha256: facts.runnerSha256,
    runnerVersion: facts.runnerVersion,
    lastConnectedAt: new Date().toISOString(),
    defaultDirectory: connection.defaultDirectory || facts.home,
  });
  const info = publicRemoteConnectionFor(updated);
  if (!platformKey) {
    return { ok: false, message: `Umbratic has no runner build for ${facts.os} ${facts.arch}.`, connection: info };
  }
  if (!artifact) {
    return { ok: false, message: `This build of Umbratic ships no ${platformKey} runner to install.`, connection: info };
  }
  if (info.runnerState === "ready") {
    return { ok: true, message: `Connected. The runner is installed and current.`, connection: info };
  }
  return {
    ok: false,
    message: info.runnerState === "outdated"
      ? "Connected. The installed runner is from a different build and needs reinstalling."
      : "Connected. The runner is not installed on this host yet.",
    connection: info,
  };
}

/**
 * Copies the runner to the host. The renderer asks the user first; this is the
 * step that actually writes to another machine.
 */
export async function installRunnerOnRemote(input: unknown): Promise<RemoteConnectionCheck> {
  const connection = requireStoredRemoteConnection(connectionIdFrom(input));
  if (!connection.hostKeyFingerprint) {
    throw new Error("Review and trust this host's key before installing anything on it.");
  }
  const secret = remoteSecret(connection);
  const facts = await probeRemoteHostFacts(remoteTarget(connection), secret);
  const installed = await installRemoteRunner(remoteTarget(connection), facts, secret);
  // The report names the runner and its version, so it stops describing the
  // host the moment a new binary lands there.
  forgetRemoteCapabilityReport(connection.id);
  const updated = patchRemoteConnection(connection.id, {
    platformOs: facts.os,
    platformArch: facts.arch,
    runnerPath: installed.runnerPath,
    runnerSha256: installed.sha256,
    runnerVersion: installed.runnerVersion,
    lastConnectedAt: new Date().toISOString(),
    defaultDirectory: connection.defaultDirectory || facts.home,
  });
  const info = publicRemoteConnectionFor(updated);
  return {
    ok: info.runnerState === "ready",
    message: info.runnerState === "ready"
      ? `The runner is installed at ${installed.runnerPath}.`
      : "The runner was copied but does not match this build.",
    connection: info,
  };
}

export async function browseRemoteDirectory(input: unknown): Promise<RemoteDirectoryListing> {
  if (!isRecord(input)) throw new Error("Invalid remote folder request.");
  const connection = requireStoredRemoteConnection(connectionIdFrom(input));
  if (!connection.hostKeyFingerprint) {
    throw new Error("Review and trust this host's key before browsing it.");
  }
  // An empty path asks the remote host for the connecting user's home, which is
  // the only starting folder this side can name without having looked yet.
  const requested = typeof input.path === "string" && input.path.trim()
    ? validatedRemoteDirectory(input.path)
    : connection.defaultDirectory;
  return listRemoteDirectory(remoteTarget(connection), requested, remoteSecret(connection));
}

/** Records the folder a connection starts in when a chat does not pick one. */
export function setRemoteDefaultDirectory(input: unknown): RemoteConnectionInfo {
  if (!isRecord(input)) throw new Error("Invalid remote folder.");
  const connection = requireStoredRemoteConnection(connectionIdFrom(input));
  return publicRemoteConnectionFor(
    patchRemoteConnection(connection.id, { defaultDirectory: validatedRemoteDirectory(input.path) }),
  );
}

export async function pickRemoteIdentityFile(): Promise<{ path: string }> {
  const window = getMainWindow();
  const result = await dialog.showOpenDialog(window ?? undefined!, {
    title: "Choose a private key",
    properties: ["openFile", "showHiddenFiles", "dontAddToRecent"],
    buttonLabel: "Use key",
  });
  return { path: result.canceled ? "" : result.filePaths[0] ?? "" };
}
