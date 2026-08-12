import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { RemoteAuthMethod, RemoteTarget } from "./types";

/**
 * Every remote capability in the desktop is the system OpenSSH client driven as
 * a child process. Nothing here speaks the SSH protocol itself: key exchange,
 * host-key verification, agent handling, jump hosts, and the user's own
 * `ssh_config` all stay with the implementation the operating system already
 * ships and keeps patched.
 *
 * The options below are set on the command line, which OpenSSH resolves before
 * any config file, so a user's `ssh_config` can add to the connection but never
 * weaken the guarantees this module depends on.
 */

const connectTimeoutSeconds = 10;
const defaultCommandTimeoutMs = 15_000;
const maxCapturedOutputBytes = 256 * 1024;

export type SshExecOptions = {
  timeoutMs?: number;
  /** Written to the remote command's stdin, then stdin is closed. */
  input?: string | Buffer;
  signal?: AbortSignal;
};

export type SshExecResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export class SshError extends Error {
  readonly stderr: string;
  readonly code: number | null;
  constructor(message: string, code: number | null, stderr: string) {
    super(message);
    this.name = "SshError";
    this.code = code;
    this.stderr = stderr;
  }
}

/** Quotes one argument for a POSIX shell on the remote host. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function shellCommand(parts: readonly string[]): string {
  return parts.map(shellQuote).join(" ");
}

function opensshDirectory(): string | null {
  if (process.platform !== "win32") return null;
  const root = process.env.SystemRoot || process.env.WINDIR;
  return root ? path.join(root, "System32", "OpenSSH") : null;
}

/**
 * Resolves an OpenSSH tool. On Windows the copy under `System32\OpenSSH` is
 * preferred over anything on PATH: a PATH lookup there can land on a client
 * shipped inside an unrelated toolchain, and the connection the user configured
 * would then read a different `known_hosts` than the one this app verified.
 */
function opensshTool(tool: "ssh" | "ssh-keyscan" | "ssh-keygen"): string {
  const directory = opensshDirectory();
  if (directory) {
    const candidate = path.join(directory, `${tool}.exe`);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Fall through to PATH; a trimmed Windows install can lack the directory.
    }
  }
  return tool;
}

/**
 * The password never reaches the filesystem and never reaches a command line.
 * OpenSSH reads it from a helper program, and the helper reads it from an
 * environment variable that only this ssh process inherits.
 */
function askpassHelper(userDataPath: string): { path: string; variable: string } {
  const variable = "UMBRATIC_SSH_PASSWORD";
  const directory = path.join(userDataPath, "remote");
  fs.mkdirSync(directory, { recursive: true });
  const windows = process.platform === "win32";
  const file = path.join(directory, windows ? "askpass.cmd" : "askpass.sh");
  const script = windows
    ? `@echo off\r\nsetlocal EnableDelayedExpansion\r\n<nul set /p "=!${variable}!"\r\n`
    : `#!/bin/sh\nprintf '%s\\n' "$${variable}"\n`;
  fs.writeFileSync(file, script, { encoding: "utf8", mode: 0o700 });
  if (!windows) fs.chmodSync(file, 0o700);
  return { path: file, variable };
}

export function knownHostsPath(userDataPath: string): string {
  const directory = path.join(userDataPath, "remote");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "known_hosts");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, "", { encoding: "utf8", mode: 0o600 });
  }
  return file;
}

function authenticationOptions(target: RemoteTarget): string[] {
  const options: string[] = [];
  switch (target.authMethod satisfies RemoteAuthMethod) {
    case "identity_file":
      options.push(
        "-o", "PreferredAuthentications=publickey",
        "-o", "IdentitiesOnly=yes",
        "-o", "BatchMode=yes",
        "-i", target.identityFilePath ?? "",
      );
      break;
    case "agent":
      options.push(
        "-o", "PreferredAuthentications=publickey",
        "-o", "BatchMode=yes",
      );
      break;
    case "password":
      // BatchMode would disable the very prompt the askpass helper answers, so
      // password targets bound the prompt count instead: one attempt, then fail
      // rather than sit on an open connection retrying a stored secret.
      options.push(
        "-o", "PreferredAuthentications=password,keyboard-interactive",
        "-o", "PubkeyAuthentication=no",
        "-o", "NumberOfPasswordPrompts=1",
      );
      break;
  }
  return options;
}

export function sshArguments(
  target: RemoteTarget,
  userDataPath: string,
  extra: readonly string[],
  remoteCommand?: string,
): string[] {
  const args = [
    "-T",
    "-p", String(target.port),
    "-o", `ConnectTimeout=${connectTimeoutSeconds}`,
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${knownHostsPath(userDataPath)}`,
    // A user's own multiplexing configuration would outlive this process and
    // leave the remote runner running with nothing attached to it.
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no",
    "-o", "RequestTTY=no",
    ...authenticationOptions(target),
    ...extra,
    `${target.username}@${target.host}`,
  ];
  if (remoteCommand !== undefined) args.push("--", remoteCommand);
  return args;
}

export function sshEnvironment(target: RemoteTarget, userDataPath: string, secret?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env[askpassHelper(userDataPath).variable];
  if (target.authMethod !== "password") return env;
  if (!secret) {
    throw new Error("This remote is configured for password sign-in but no password is stored.");
  }
  const helper = askpassHelper(userDataPath);
  env[helper.variable] = secret;
  env.SSH_ASKPASS = helper.path;
  env.SSH_ASKPASS_REQUIRE = "force";
  // Some OpenSSH builds still consult DISPLAY before using the helper.
  env.DISPLAY = env.DISPLAY || "umbratic";
  return env;
}

export function spawnSsh(
  target: RemoteTarget,
  userDataPath: string,
  extra: readonly string[],
  remoteCommand: string | undefined,
  secret?: string,
): ChildProcess {
  return spawn(opensshTool("ssh"), sshArguments(target, userDataPath, extra, remoteCommand), {
    env: sshEnvironment(target, userDataPath, secret),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function collect(child: ChildProcess, options: SshExecOptions): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new SshError("The remote host did not answer in time.", null, stderr));
    }, options.timeoutMs ?? defaultCommandTimeoutMs);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(new SshError("The remote request was cancelled.", null, stderr));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const append = (target: "out" | "err") => (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (target === "out") {
        if (stdout.length < maxCapturedOutputBytes) stdout += text;
      } else if (stderr.length < maxCapturedOutputBytes) {
        stderr += text;
      }
    };
    child.stdout?.on("data", append("out"));
    child.stderr?.on("data", append("err"));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr });
    });
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
  });
}

/**
 * Runs one command on the remote host and waits for it.
 *
 * `command` is a list of program and arguments, quoted here for the remote
 * shell. Callers never build the remote command line by string concatenation,
 * so a directory name with a space or a quote in it cannot become an argument
 * boundary.
 */
export async function runRemoteCommand(
  target: RemoteTarget,
  userDataPath: string,
  command: readonly string[],
  options: SshExecOptions = {},
  secret?: string,
): Promise<SshExecResult> {
  const child = spawnSsh(target, userDataPath, [], shellCommand(command), secret);
  return collect(child, options);
}

/** Runs a command and fails unless it exits zero. */
export async function runRemoteCommandOrThrow(
  target: RemoteTarget,
  userDataPath: string,
  command: readonly string[],
  options: SshExecOptions = {},
  secret?: string,
): Promise<string> {
  const result = await runRemoteCommand(target, userDataPath, command, options, secret);
  if (result.code !== 0) {
    throw new SshError(remoteFailureMessage(result), result.code, result.stderr);
  }
  return result.stdout;
}

/**
 * Turns an ssh failure into something a person can act on. OpenSSH writes the
 * useful part on the last non-empty stderr line; the rest is banner noise.
 */
export function remoteFailureMessage(result: SshExecResult): string {
  const lines = result.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("Warning: Permanently added"));
  const detail = lines.at(-1) ?? "";
  if (/permission denied/i.test(detail)) {
    return "The remote host refused the credentials for this connection.";
  }
  if (/host key verification failed/i.test(detail)) {
    return "The remote host key no longer matches the one this connection trusted.";
  }
  if (/could not resolve hostname|name or service not known/i.test(detail)) {
    return "The remote host name could not be resolved.";
  }
  if (/connection refused|connection timed out|no route to host/i.test(detail)) {
    return "The remote host did not accept the connection.";
  }
  return detail || `The remote command exited with code ${result.code ?? "unknown"}.`;
}

export type RemoteHostKey = {
  /** The `known_hosts` line, stored verbatim once the user trusts it. */
  line: string;
  keyType: string;
  fingerprint: string;
};

/**
 * Reads the host's key without authenticating, so a fingerprint can be shown
 * for approval before any credential is offered to the host.
 *
 * This uses `ssh` rather than `ssh-keyscan`, for two reasons. The key exchange
 * is then negotiated exactly as the real connection will negotiate it, so the
 * key pinned here is the key that connection verifies against — `ssh-keyscan`
 * negotiates differently and fails outright against servers whose preferred
 * algorithm it does not implement. And it is the same binary, reading the same
 * configuration, so a host reached through a jump host is reached the same way
 * for its key as for its work.
 *
 * `PreferredAuthentications=none` is what keeps this a read. SSH records the
 * host key during key exchange, which happens before authentication, so the
 * connection is refused with nothing offered and the key already known.
 */
export async function scanRemoteHostKey(target: RemoteTarget): Promise<RemoteHostKey> {
  const probeFile = path.join(os.tmpdir(), `umbratic-hostscan-${process.pid}-${Date.now()}`);
  fs.writeFileSync(probeFile, "", { encoding: "utf8", mode: 0o600 });
  try {
    await new Promise<void>((resolve) => {
      const child = spawn(
        opensshTool("ssh"),
        [
          "-T",
          "-p", String(target.port),
          "-o", `ConnectTimeout=${connectTimeoutSeconds}`,
          "-o", "StrictHostKeyChecking=accept-new",
          "-o", `UserKnownHostsFile=${probeFile}`,
          "-o", "BatchMode=yes",
          "-o", "PreferredAuthentications=none",
          "-o", "PubkeyAuthentication=no",
          "-o", "ControlMaster=no",
          "-o", "ControlPath=none",
          `${target.username}@${target.host}`,
          "--",
          "true",
        ],
        { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
      );
      const timer = setTimeout(() => child.kill(), 15_000);
      // The refusal is expected: the key is on disk by the time it happens.
      child.stderr.resume();
      child.once("error", () => { clearTimeout(timer); resolve(); });
      child.once("close", () => { clearTimeout(timer); resolve(); });
    });
    const chosen = fs
      .readFileSync(probeFile, "utf8")
      .split(/\r?\n/)
      .find((line) => line.trim() && !line.startsWith("#"));
    if (!chosen) {
      throw new Error("The remote host did not present a host key. Check the address and port.");
    }
    return { ...(await hostKeyFingerprint(chosen)), line: chosen.trim() };
  } finally {
    fs.rmSync(probeFile, { force: true });
  }
}

async function hostKeyFingerprint(knownHostsLine: string): Promise<{ keyType: string; fingerprint: string }> {
  const file = path.join(os.tmpdir(), `umbratic-hostkey-${process.pid}-${Date.now()}`);
  fs.writeFileSync(file, `${knownHostsLine}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(opensshTool("ssh-keygen"), ["-l", "-f", file], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.once("error", reject);
      child.once("close", () => resolve(stdout));
    });
    // "256 SHA256:abc… host (ED25519)"
    const match = output.trim().split(/\r?\n/)[0]?.match(/\s(SHA256:\S+)\s.*\(([A-Za-z0-9-]+)\)/);
    return { fingerprint: match?.[1] ?? "unknown", keyType: match?.[2] ?? "unknown" };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Records a host key the user approved, replacing any earlier key for the host. */
export function trustHostKey(userDataPath: string, hostKeyLine: string): void {
  const file = knownHostsPath(userDataPath);
  const marker = hostKeyLine.trim().split(" ")[0];
  const kept = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() && line.split(" ")[0] !== marker);
  fs.writeFileSync(file, `${[...kept, hostKeyLine.trim()].join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}

export function forgetHostKey(userDataPath: string, host: string, port: number): void {
  const file = knownHostsPath(userDataPath);
  // OpenSSH writes port-22 hosts bare and everything else bracketed.
  const marker = port === 22 ? host : `[${host}]:${port}`;
  const kept = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() && line.split(" ")[0] !== marker);
  fs.writeFileSync(file, kept.length ? `${kept.join("\n")}\n` : "", { encoding: "utf8", mode: 0o600 });
}
