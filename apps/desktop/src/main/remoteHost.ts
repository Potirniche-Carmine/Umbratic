import { readRegularFileSync } from "./readFile";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";

import {
  capabilityCommandSpecs,
  commandCapabilityReport,
  type CapabilityCommandOutcome,
} from "./capabilities";
import {
  publicRemoteConnection,
  remoteSecret,
  remoteTarget,
  requireStoredRemoteConnection,
  type StoredRemoteConnection,
} from "./remoteConnections";
import { runRemoteCommand, runRemoteCommandOrThrow, remoteFailureMessage, shellQuote } from "./sshTransport";
import type {
  CapabilityProbeReport,
  RemoteDirectoryEntry,
  RemoteDirectoryListing,
  RemoteTarget,
} from "./types";

/**
 * Everything this module asks of a remote host is one POSIX shell script sent
 * over one connection. Round trips are the cost that shows up as latency in the
 * settings page, so a probe answers every question it can at once.
 */

const maxDirectoryEntries = 500;
const runnerInstallDirectory = ".umbratic/bin";
const runnerFileName = "umbratic-runner";

export type RemoteHostFacts = {
  home: string;
  os: string;
  arch: string;
  /** Absolute path where the runner belongs on this host. */
  runnerPath: string;
  /** Checksum of the installed runner, empty when nothing is installed. */
  runnerSha256: string;
  runnerVersion: string;
};

function scriptField(line: string, index: number, count: number): string {
  const parts = line.split("\t");
  return parts.length >= count ? (parts[index] ?? "") : "";
}

/** Reads `key<TAB>value` lines, ignoring anything the shell added around them. */
function keyedOutput(stdout: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.indexOf("\t");
    if (separator <= 0) continue;
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return values;
}

/**
 * `sha256sum` is the coreutils name and `shasum` the one macOS ships. Neither
 * is guaranteed, so a host with no checksum tool reports an empty checksum and
 * the runner reads as "not installed" rather than as verified.
 */
const checksumFunction = [
  "umbratic_sha() {",
  "  if command -v sha256sum >/dev/null 2>&1; then sha256sum \"$1\" | cut -d' ' -f1;",
  "  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 \"$1\" | cut -d' ' -f1;",
  "  else printf ''; fi",
  "}",
].join("\n");

function hostFactsScript(): string {
  return [
    "set -u",
    checksumFunction,
    `r="$HOME/${runnerInstallDirectory}/${runnerFileName}"`,
    `printf 'home\\t%s\\n' "$HOME"`,
    `printf 'os\\t%s\\n' "$(uname -s 2>/dev/null)"`,
    `printf 'arch\\t%s\\n' "$(uname -m 2>/dev/null)"`,
    `printf 'runnerPath\\t%s\\n' "$r"`,
    `if [ -x "$r" ]; then`,
    `  printf 'runnerSha\\t%s\\n' "$(umbratic_sha "$r")"`,
    `  printf 'runnerVersion\\t%s\\n' "$("$r" 2>&1 | sed -n '1p' | tr -d '\\t\\r')"`,
    "fi",
  ].join("\n");
}

export async function probeRemoteHostFacts(
  target: RemoteTarget,
  secret?: string,
): Promise<RemoteHostFacts> {
  const result = await runRemoteCommand(
    target,
    app.getPath("userData"),
    ["sh", "-c", hostFactsScript()],
    { timeoutMs: 20_000 },
    secret,
  );
  if (result.code !== 0) {
    // A default Windows sshd hands the command to cmd.exe, where `sh` does not
    // exist. That deserves a plain answer, not a shell error verbatim.
    if (/'sh' is not recognized|is not recognized as an internal or external command/i.test(`${result.stdout}\n${result.stderr}`)) {
      throw new Error("This host looks like Windows. Umbratic can run on Linux and macOS remote hosts.");
    }
    throw new Error(remoteFailureMessage(result));
  }
  const values = keyedOutput(result.stdout);
  const home = values.get("home") ?? "";
  if (!home.startsWith("/")) {
    throw new Error("The remote host did not report a usable home directory.");
  }
  return {
    home,
    os: values.get("os") ?? "",
    arch: values.get("arch") ?? "",
    runnerPath: values.get("runnerPath") ?? "",
    runnerSha256: values.get("runnerSha") ?? "",
    runnerVersion: values.get("runnerVersion") ?? "",
  };
}

/** Maps what `uname` says onto the names the packaged artifacts are filed under. */
export function remotePlatformKey(os: string, arch: string): string | null {
  const platform = os.trim().toLowerCase() === "linux"
    ? "linux"
    : os.trim().toLowerCase() === "darwin"
      ? "darwin"
      : null;
  const machine = arch.trim().toLowerCase();
  const architecture = machine === "x86_64" || machine === "amd64"
    ? "x64"
    : machine === "aarch64" || machine === "arm64"
      ? "arm64"
      : null;
  return platform && architecture ? `${platform}-${architecture}` : null;
}

/**
 * The runner binary this desktop would install on a host of the given shape.
 * Nothing is cross-compiled on demand: a host whose platform has no packaged
 * artifact is told so, rather than being handed a binary that cannot run.
 */
export function remoteRunnerArtifact(platformKey: string): { path: string; sha256: string } | null {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    ...(resourcesPath ? [path.join(resourcesPath, "runner", platformKey, runnerFileName)] : []),
    path.resolve(__dirname, "../../../../target/remote", platformKey, runnerFileName),
  ];
  for (const candidate of candidates) {
    try {
      const sha256 = crypto.createHash("sha256").update(readRegularFileSync(candidate, Number.MAX_SAFE_INTEGER)).digest("hex");
      return { path: candidate, sha256 };
    } catch {
      // Try the next location; a missing artifact is an expected state.
    }
  }
  return null;
}

/**
 * A connection as the renderer sees it, including whether the runner installed
 * over there is the one this build would install.
 */
export function publicRemoteConnectionFor(connection: StoredRemoteConnection) {
  const platformKey = remotePlatformKey(connection.platformOs, connection.platformArch);
  const artifact = platformKey ? remoteRunnerArtifact(platformKey) : null;
  return publicRemoteConnection(connection, artifact?.sha256 ?? "");
}

export type RemoteRunnerInstall = {
  runnerPath: string;
  sha256: string;
  runnerVersion: string;
};

/**
 * Copies the runner to the remote host and proves the copy arrived intact.
 *
 * The binary is written to a temporary name, checksummed there, and only then
 * moved into place, so an interrupted transfer cannot leave a half-written file
 * that later reads as installed.
 */
export async function installRemoteRunner(
  target: RemoteTarget,
  facts: RemoteHostFacts,
  secret?: string,
): Promise<RemoteRunnerInstall> {
  const platformKey = remotePlatformKey(facts.os, facts.arch);
  if (!platformKey) {
    throw new Error(`Umbratic does not ship a runner for ${facts.os || "this system"} ${facts.arch || ""}.`.trim());
  }
  const artifact = remoteRunnerArtifact(platformKey);
  if (!artifact) {
    throw new Error(`This build of Umbratic has no ${platformKey} runner to install.`);
  }
  const userDataPath = app.getPath("userData");
  const directory = `${facts.home}/${runnerInstallDirectory}`;
  const destination = `${directory}/${runnerFileName}`;
  const staging = `${destination}.incoming`;
  const upload = await runRemoteCommand(
    target,
    userDataPath,
    [
      "sh",
      "-c",
      [
        "set -eu",
        `mkdir -p ${shellQuote(directory)}`,
        `chmod 700 ${shellQuote(directory)}`,
        `rm -f ${shellQuote(staging)}`,
        // The umask keeps the window between create and chmod from ever being
        // group- or world-readable.
        "umask 077",
        `cat > ${shellQuote(staging)}`,
        `chmod 700 ${shellQuote(staging)}`,
      ].join("\n"),
    ],
    { timeoutMs: 300_000, input: fs.readFileSync(artifact.path) },
    secret,
  );
  if (upload.code !== 0) {
    throw new Error(`The runner could not be copied to the remote host. ${remoteFailureMessage(upload)}`);
  }
  const verifyScript = [
    "set -eu",
    checksumFunction,
    `s=$(umbratic_sha ${shellQuote(staging)})`,
    `printf 'sha\\t%s\\n' "$s"`,
    `if [ "$s" != ${shellQuote(artifact.sha256)} ]; then rm -f ${shellQuote(staging)}; exit 9; fi`,
    `mv -f ${shellQuote(staging)} ${shellQuote(destination)}`,
    `printf 'runnerVersion\\t%s\\n' "$(${shellQuote(destination)} 2>&1 | sed -n '1p' | tr -d '\\t\\r')"`,
  ].join("\n");
  const verify = await runRemoteCommand(target, userDataPath, ["sh", "-c", verifyScript], { timeoutMs: 60_000 }, secret);
  if (verify.code === 9) {
    throw new Error("The runner arrived on the remote host with the wrong checksum and was removed.");
  }
  if (verify.code !== 0) {
    throw new Error(`The runner could not be installed on the remote host. ${remoteFailureMessage(verify)}`);
  }
  const values = keyedOutput(verify.stdout);
  return {
    runnerPath: destination,
    sha256: values.get("sha") ?? "",
    runnerVersion: values.get("runnerVersion") ?? "",
  };
}

function capabilityScript(): string {
  const lines = ["set -u"];
  for (const [index, spec] of capabilityCommandSpecs().entries()) {
    const marker = `c${index}`;
    const versionArgs = spec.versionArgs.map(shellQuote).join(" ");
    lines.push(
      `${marker}=`,
      `for c in ${spec.commands.map(shellQuote).join(" ")}; do`,
      `  p=$(command -v "$c" 2>/dev/null) || p=`,
      `  [ -n "$p" ] || continue`,
      `  o=$("$c" ${versionArgs} 2>&1) && rc=0 || rc=$?`,
      `  v=$(printf '%s' "$o" | sed -n '1p' | tr -d '\\t\\r' | cut -c1-200)`,
      `  if [ "$rc" -eq 0 ]; then s=available; elif [ ${spec.acceptNonZeroAsAvailable ? "1" : "0"} -eq 1 ]; then s=available; else s=error; fi`,
      `  printf '${spec.id}\\t%s\\t%s\\t%s\\t%s\\n' "$s" "$c" "$p" "$v"`,
      `  ${marker}=1`,
      "  break",
      "done",
      `[ -n "$${marker}" ] || printf '${spec.id}\\tmissing\\t\\t\\t\\n'`,
    );
  }
  return lines.join("\n");
}

/**
 * Asks the remote host what tooling it has, so a run there is described by what
 * is actually reachable from the workspace rather than by what this laptop
 * happens to have installed.
 */
export async function probeRemoteCapabilities(
  target: RemoteTarget,
  runnerVersion: string,
  secret?: string,
): Promise<CapabilityProbeReport> {
  const at = new Date().toISOString();
  const stdout = await runRemoteCommandOrThrow(
    target,
    app.getPath("userData"),
    ["sh", "-c", capabilityScript()],
    { timeoutMs: 45_000 },
    secret,
  );
  const known = new Set(capabilityCommandSpecs().map((spec) => spec.id));
  const outcomes: CapabilityCommandOutcome[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const id = scriptField(line, 0, 5);
    if (!known.has(id)) continue;
    const status = scriptField(line, 1, 5);
    if (status !== "available" && status !== "missing" && status !== "error") continue;
    outcomes.push({
      id,
      status,
      detectedCommand: scriptField(line, 2, 5) || undefined,
      executablePath: scriptField(line, 3, 5) || undefined,
      version: scriptField(line, 4, 5) || undefined,
      message: status === "missing" ? "This command is not on the remote host's PATH." : undefined,
    });
  }
  return commandCapabilityReport(
    outcomes,
    [
      {
        id: "umbratic-runner",
        label: "Umbratic runner",
        category: "required",
        importance: "required",
        status: runnerVersion ? "available" : "missing",
        version: runnerVersion || undefined,
        purpose: "Executes workspace tools on the remote host.",
        installHint: "Install the runner from the remote connection's settings page.",
        workflows: ["remote execution"],
        checkedAt: at,
      },
    ],
    at,
  );
}

/** An empty directory means the connecting user's home. */
const remoteCapabilityCacheTtlMs = 30_000;
const remoteCapabilityCache = new Map<string, { expiresAt: number; report: CapabilityProbeReport }>();

/**
 * The remote host's capability report, shared by everything that needs it
 * within one run: the task record, the prompt context, and the runner
 * configuration all describe the same measurement rather than three.
 */
export async function remoteCapabilityReport(
  connectionId: string,
  options: { force?: boolean } = {},
): Promise<CapabilityProbeReport> {
  const cached = remoteCapabilityCache.get(connectionId);
  if (!options.force && cached && cached.expiresAt > Date.now()) return cached.report;
  const connection = requireStoredRemoteConnection(connectionId);
  const report = await probeRemoteCapabilities(
    remoteTarget(connection),
    connection.runnerVersion,
    remoteSecret(connection),
  );
  remoteCapabilityCache.set(connectionId, { expiresAt: Date.now() + remoteCapabilityCacheTtlMs, report });
  return report;
}

export function forgetRemoteCapabilityReport(connectionId: string): void {
  remoteCapabilityCache.delete(connectionId);
}

function directoryScript(directory: string): string {
  return [
    "set -u",
    `cd ${directory ? shellQuote(directory) : '"$HOME"'} 2>/dev/null || exit 3`,
    `printf 'path\\t%s\\n' "$(pwd -P)"`,
    "n=0",
    "for e in * .*; do",
    `  [ "$e" = "." ] || [ "$e" = ".." ] && continue`,
    `  [ -e "$e" ] || [ -L "$e" ] || continue`,
    "  n=$((n+1))",
    `  if [ "$n" -gt ${maxDirectoryEntries} ]; then printf 'truncated\\t1\\n'; break; fi`,
    `  if [ -d "$e" ]; then`,
    `    if [ -r "$e" ] && [ -x "$e" ]; then printf 'entry\\td\\t%s\\n' "$e"; else printf 'entry\\tD\\t%s\\n' "$e"; fi`,
    `  else printf 'entry\\tf\\t%s\\n' "$e"; fi`,
    "done",
  ].join("\n");
}

/**
 * Lists one remote directory so a workspace folder can be chosen the way a
 * local one is. It is deliberately not a file manager: one level, bounded
 * entry count, no reads, no writes.
 */
export async function listRemoteDirectory(
  target: RemoteTarget,
  directory: string,
  secret?: string,
): Promise<RemoteDirectoryListing> {
  const result = await runRemoteCommand(
    target,
    app.getPath("userData"),
    ["sh", "-c", directoryScript(directory)],
    { timeoutMs: 20_000 },
    secret,
  );
  if (result.code === 3) {
    throw new Error("That folder does not exist on the remote host, or you cannot open it.");
  }
  if (result.code !== 0) {
    throw new Error(remoteFailureMessage(result));
  }
  let resolved = directory;
  let truncated = false;
  const entries: RemoteDirectoryEntry[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const [kind, ...rest] = line.split("\t");
    if (kind === "path" && rest[0]?.startsWith("/")) {
      resolved = rest[0];
    } else if (kind === "truncated") {
      truncated = true;
    } else if (kind === "entry" && rest.length >= 2) {
      const marker = rest[0];
      const name = rest.slice(1).join("\t");
      if (!name) continue;
      entries.push({
        name,
        // Filled in below, once the resolved directory is known for certain.
        path: "",
        kind: marker === "f" ? "file" : "directory",
        unreadable: marker === "D",
      });
    }
  }
  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  // Entry paths are built from the resolved directory, so they are correct even
  // when the caller passed a path through a symlink.
  const corrected = entries.map((entry) => ({
    ...entry,
    path: resolved === "/" ? `/${entry.name}` : `${resolved}/${entry.name}`,
  }));
  return {
    path: resolved,
    parentPath: resolved === "/" ? "/" : resolved.slice(0, resolved.lastIndexOf("/")) || "/",
    entries: corrected,
    truncated,
  };
}
