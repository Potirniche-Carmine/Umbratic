import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";

import { readProtectedString, writeProtectedString, type StoredProtectedString } from "./companyCredentialStorage";
import { readStoredRemoteConnections, writeStoredRemoteConnections } from "./settingsStorage";
import { forgetHostKey } from "./sshTransport";
import type {
  RemoteAuthMethod,
  RemoteConnectionDraft,
  RemoteConnectionInfo,
  RemoteRunnerState,
  RemoteTarget,
} from "./types";
import { isRecord } from "./utils";

const maxConnections = 20;
const defaultSshPort = 22;

/**
 * A saved host, as it sits in settings. The password is an OS-encrypted
 * envelope; everything else is plain because everything else is already visible
 * to anyone who can read the settings file anyway.
 */
export type StoredRemoteConnection = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: RemoteAuthMethod;
  identityFilePath: string;
  password: "" | StoredProtectedString;
  defaultDirectory: string;
  hostKeyFingerprint: string;
  hostKeyType: string;
  runnerPath: string;
  /** Checksum of the binary this desktop installed, used to detect drift. */
  runnerSha256: string;
  runnerVersion: string;
  platformOs: string;
  platformArch: string;
};

export type RemoteConnectionPatch = Partial<
  Pick<
    StoredRemoteConnection,
    | "hostKeyFingerprint"
    | "hostKeyType"
    | "runnerPath"
    | "runnerSha256"
    | "runnerVersion"
    | "platformOs"
    | "platformArch"
    | "defaultDirectory"
  >
>;

function isAuthMethod(value: unknown): value is RemoteAuthMethod {
  return value === "agent" || value === "identity_file" || value === "password";
}

function decodeConnection(value: unknown): StoredRemoteConnection | null {
  if (!isRecord(value)) return null;
  const text = (name: string): string => (typeof value[name] === "string" ? (value[name] as string) : "");
  const id = text("id");
  const host = text("host");
  const username = text("username");
  if (!id || !host || !username) return null;
  const port = typeof value.port === "number" && Number.isInteger(value.port) ? value.port : defaultSshPort;
  const password = isRecord(value.password) ? (value.password as StoredProtectedString) : "";
  return {
    id,
    name: text("name") || host,
    host,
    port,
    username,
    authMethod: isAuthMethod(value.authMethod) ? value.authMethod : "agent",
    identityFilePath: text("identityFilePath"),
    password,
    defaultDirectory: text("defaultDirectory"),
    hostKeyFingerprint: text("hostKeyFingerprint"),
    hostKeyType: text("hostKeyType"),
    runnerPath: text("runnerPath"),
    runnerSha256: text("runnerSha256"),
    runnerVersion: text("runnerVersion"),
    platformOs: text("platformOs"),
    platformArch: text("platformArch"),
  };
}

function readStored(): StoredRemoteConnection[] {
  const value = readStoredRemoteConnections();
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const connection = decodeConnection(entry);
    return connection ? [connection] : [];
  }).slice(0, maxConnections);
}

function writeStored(connections: readonly StoredRemoteConnection[]): void {
  writeStoredRemoteConnections(connections.slice(0, maxConnections));
}

/**
 * The runner is "ready" only when the remote copy is byte-identical to the
 * artifact this desktop would install. A version string cannot carry that:
 * the runner reports one build identifier for every build, so a stale binary
 * left by an older desktop would claim to be current.
 */
function runnerState(connection: StoredRemoteConnection, expectedSha256: string): RemoteRunnerState {
  if (!connection.runnerPath || !connection.runnerSha256) return "missing";
  if (!expectedSha256) return "unknown";
  return connection.runnerSha256 === expectedSha256 ? "ready" : "outdated";
}

export function publicRemoteConnection(
  connection: StoredRemoteConnection,
  expectedSha256 = "",
): RemoteConnectionInfo {
  return {
    id: connection.id,
    name: connection.name,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    authMethod: connection.authMethod,
    identityFilePath: connection.identityFilePath,
    passwordConfigured: connection.password !== "",
    defaultDirectory: connection.defaultDirectory,
    hostKeyFingerprint: connection.hostKeyFingerprint,
    hostKeyType: connection.hostKeyType,
    runnerState: runnerState(connection, expectedSha256),
    runnerVersion: connection.runnerVersion,
    runnerPath: connection.runnerPath,
    platform: { os: connection.platformOs, arch: connection.platformArch },
  };
}

export function remoteTarget(connection: StoredRemoteConnection): RemoteTarget {
  return {
    host: connection.host,
    port: connection.port,
    username: connection.username,
    authMethod: connection.authMethod,
    identityFilePath: connection.identityFilePath || undefined,
  };
}

/** The stored password, decrypted only at the moment ssh is about to run. */
export function remoteSecret(connection: StoredRemoteConnection): string | undefined {
  if (connection.authMethod !== "password") return undefined;
  return readProtectedString(connection.password);
}

export function listStoredRemoteConnections(): StoredRemoteConnection[] {
  return readStored();
}

export function readStoredRemoteConnection(id: string): StoredRemoteConnection | null {
  return readStored().find((connection) => connection.id === id) ?? null;
}

/** Throws with a message the user can act on, rather than a validation code. */
export function requireStoredRemoteConnection(id: string): StoredRemoteConnection {
  const connection = readStoredRemoteConnection(id);
  if (!connection) throw new Error("That remote connection no longer exists.");
  return connection;
}

// A hostname or literal address only. Anything a shell or an ssh option could
// reinterpret — spaces, quotes, an embedded `-o`, a second `@` — is refused
// here rather than escaped later.
const hostPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,252}[A-Za-z0-9])?$/;
const usernamePattern = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

function validatedName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new Error("Give this remote a name.");
  if (name.length > 64) throw new Error("Remote names are limited to 64 characters.");
  return name;
}

function validatedHost(value: unknown): string {
  const host = typeof value === "string" ? value.trim() : "";
  if (!host) throw new Error("Enter the remote host.");
  if (!hostPattern.test(host)) throw new Error("That host name contains characters SSH cannot use.");
  return host;
}

function validatedPort(value: unknown): number {
  if (value === undefined || value === null || value === "") return defaultSshPort;
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Enter a port between 1 and 65535.");
  return port;
}

function validatedUsername(value: unknown): string {
  const username = typeof value === "string" ? value.trim() : "";
  if (!username) throw new Error("Enter the user name to sign in with.");
  if (!usernamePattern.test(username)) throw new Error("That user name contains characters SSH cannot use.");
  return username;
}

function validatedIdentityFile(value: unknown, authMethod: RemoteAuthMethod): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (authMethod !== "identity_file") return candidate;
  if (!candidate) throw new Error("Choose the private key file to sign in with.");
  const resolved = path.resolve(candidate);
  try {
    if (!fs.statSync(resolved).isFile()) throw new Error("not a file");
  } catch {
    throw new Error("That private key file could not be read.");
  }
  return resolved;
}

/**
 * A remote workspace directory is an absolute POSIX path. Relative paths would
 * resolve against whatever the login shell happened to choose, which is not a
 * location the user picked.
 */
export function validatedRemoteDirectory(value: unknown, { allowEmpty = false } = {}): string {
  const directory = typeof value === "string" ? value.trim() : "";
  if (!directory) {
    if (allowEmpty) return "";
    throw new Error("Choose a folder on the remote host.");
  }
  if (!directory.startsWith("/")) throw new Error("The remote folder must be an absolute path.");
  if (directory.includes("\0") || directory.length > 1_024) throw new Error("That remote folder path is not usable.");
  const normalized = directory.replace(/\/+$/, "") || "/";
  if (normalized.split("/").includes("..")) throw new Error("The remote folder path cannot contain \"..\".");
  return normalized;
}

function connectionId(): string {
  return `remote_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function saveRemoteConnection(input: unknown): RemoteConnectionInfo {
  if (!isRecord(input)) throw new Error("Invalid remote connection.");
  const draft = input as RemoteConnectionDraft;
  const authMethod = isAuthMethod(draft.authMethod) ? draft.authMethod : "agent";
  const connections = readStored();
  const existing = draft.id ? connections.find((connection) => connection.id === draft.id) : undefined;
  if (draft.id && !existing) throw new Error("That remote connection no longer exists.");
  if (!existing && connections.length >= maxConnections) {
    throw new Error(`Umbratic keeps up to ${maxConnections} remote connections.`);
  }
  const host = validatedHost(draft.host);
  const port = validatedPort(draft.port);
  const password = typeof draft.password === "string" ? draft.password : "";
  if (authMethod === "password" && !password && !existing?.password) {
    throw new Error("Enter the password for this remote, or sign in with a key instead.");
  }
  const identityChanged = existing
    && (existing.host !== host || existing.port !== port);
  const next: StoredRemoteConnection = {
    ...(existing ?? {
      id: connectionId(),
      password: "" as const,
      hostKeyFingerprint: "",
      hostKeyType: "",
      runnerPath: "",
      runnerSha256: "",
      runnerVersion: "",
      platformOs: "",
      platformArch: "",
    }),
    name: validatedName(draft.name),
    host,
    port,
    username: validatedUsername(draft.username),
    authMethod,
    identityFilePath: validatedIdentityFile(draft.identityFilePath, authMethod),
    defaultDirectory: validatedRemoteDirectory(draft.defaultDirectory, { allowEmpty: true }),
    // Only the chosen method's secret is kept. Switching to a key sign-in has
    // to drop the stored password, or it would sit in the keychain unused and
    // unmentioned by the settings page that no longer shows it.
    password: authMethod !== "password"
      ? ""
      : password
        ? writeProtectedString(password, "Secure storage is not available, so the remote password was not saved.")
        : existing?.password ?? "",
  };
  // Moving a connection to a different host or port invalidates the key that
  // was trusted for the old one; the next connection has to ask again.
  if (identityChanged) {
    forgetHostKey(app.getPath("userData"), existing.host, existing.port);
    next.hostKeyFingerprint = "";
    next.hostKeyType = "";
    next.runnerPath = "";
    next.runnerSha256 = "";
    next.runnerVersion = "";
    next.platformOs = "";
    next.platformArch = "";
  }
  writeStored(existing
    ? connections.map((connection) => (connection.id === next.id ? next : connection))
    : [...connections, next]);
  return publicRemoteConnection(next);
}

export function patchRemoteConnection(id: string, patch: RemoteConnectionPatch): StoredRemoteConnection {
  const connections = readStored();
  const existing = connections.find((connection) => connection.id === id);
  if (!existing) throw new Error("That remote connection no longer exists.");
  const next = { ...existing, ...patch };
  writeStored(connections.map((connection) => (connection.id === id ? next : connection)));
  return next;
}

export function deleteRemoteConnection(id: string): void {
  const connections = readStored();
  const existing = connections.find((connection) => connection.id === id);
  if (!existing) return;
  forgetHostKey(app.getPath("userData"), existing.host, existing.port);
  writeStored(connections.filter((connection) => connection.id !== id));
}
