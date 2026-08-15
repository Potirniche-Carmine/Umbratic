import * as crypto from "node:crypto";
import * as path from "node:path";

import { configuredEndpointRoute, veilManagedModelId } from "./endpointConfig";
import { isRunnerToolId } from "./toolSettings";
import type {
  CommandClass,
  LocalModelInfo,
  LocalProviderId,
  ModelEndpointMode,
  PermissionMode,
  RuntimeDiagnostics,
  TelemetryPolicyInfo,
} from "./types";
import { isRecord, normalizeRelativePath, pathInside } from "./utils";
export { isLocalhostUrl } from "./utils";

export const umbraticPolicyVersion = "umbratic-enterprise-mvp-2";
export const umbraticRunnerName = "UmbraticRunner";
export const umbraticRunnerVersion = "fork-1";
export const umbraticRunnerContractVersion = "umbratic-runner-1";
/** Veil is the only endpoint, so this is an identity check, not an allowlist. */
export const companyEndpointProviderId: LocalProviderId = "company-endpoint";
export const pythonRuntimeVersion = "python-uv-venv-1";
export const cmakeRuntimeVersion = "cmake-umbratic-build-1";

export const telemetryPolicyInfo: TelemetryPolicyInfo = {
  mode: "managed_required",
  localEnabled: false,
  syncEnabled: true,
  retentionDays: 30,
  exportFormat: "redacted-json",
  storage: "company-managed-telemetry",
};

export const localTelemetryPolicyInfo: TelemetryPolicyInfo = {
  mode: "managed_disabled",
  localEnabled: false,
  syncEnabled: false,
  retentionDays: 0,
  exportFormat: "redacted-json",
  storage: "task-event-snapshots",
};

export function telemetryPolicyForMode(mode: ModelEndpointMode): TelemetryPolicyInfo {
  return mode === "local" ? localTelemetryPolicyInfo : telemetryPolicyInfo;
}

const generatedRuntimePrefixes = [
  ".umbratic/runtime/",
  ".umbratic/build/",
  ".umbratic/tmp/",
  ".umbratic/index/",
  ".venv/",
  "venv/",
  "node_modules/",
  ".git/",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  "build/",
  "dist/",
  "dist-electron/",
  "target/",
  "coverage/",
  "%systemdrive%/programdata/microsoft/windows/caches/",
];

const generatedRuntimeNames = new Set([
  "__pycache__",
  "cmakefiles",
  ".ds_store",
  "thumbs.db",
  "desktop.ini",
  "node_modules",
  ".git",
  ".llama-cache",
  ".venv",
  "venv",
  "target",
  "dist",
  "dist-electron",
  "build",
  "coverage",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".next",
  ".vite",
  "vendor",
  ".umbratic",
]);

const generatedRuntimeExtensions = new Set([
  ".pyc",
  ".pyo",
  ".o",
  ".obj",
  ".a",
  ".lib",
  ".so",
  ".dylib",
  ".dll",
  ".exe",
  ".pdb",
]);

export function isGeneratedRuntimePath(filePath: string): boolean {
  const normalized = normalizeRelativePath(filePath).toLowerCase();
  const parts = normalized.split("/");
  const basename = path.posix.basename(normalized);
  const extension = path.posix.extname(normalized);
  return (
    generatedRuntimePrefixes.some((prefix) => normalized.startsWith(prefix)) ||
    parts.some((part) => generatedRuntimeNames.has(part)) ||
    basename === "cmakecache.txt" ||
    basename === "compile_commands.json" ||
    generatedRuntimeExtensions.has(extension)
  );
}

export function isBlockedPath(filePath: string): boolean {
  const normalized = normalizeRelativePath(filePath).toLowerCase();
  const basename = path.posix.basename(normalized);
  return (
    normalized === ".env" ||
    normalized.endsWith("/.env") ||
    normalized.startsWith(".env.") ||
    normalized.includes("/.env.") ||
    basename.endsWith(".pem") ||
    basename.endsWith(".key") ||
    basename.endsWith(".pfx") ||
    basename.endsWith(".p12") ||
    basename === "id_rsa" ||
    basename === "id_ed25519" ||
    basename === ".npmrc" ||
    normalized === ".git/config" ||
    normalized.startsWith(".git/hooks/")
  );
}

export function promptLooksLikePythonTask(prompt: string): boolean {
  return /\b(python|\.py|pyproject|requirements\.txt|uv|venv|pytest)\b/i.test(prompt);
}

export function promptLooksLikeCmakeTask(prompt: string): boolean {
  return (
    /\b(cmake|cmakelists\.txt|c code|c project|c harness|c toolchain|c\+\+|cpp|ctest|ninja|clang|gcc|msvc|makefile|asan|ubsan|segfault|buffer overflow|pointer|malloc|free)\b/i.test(prompt) ||
    /(?:^|[\s\\/])[^.\s\\/]+\.(?:c|h|cc|cpp|cxx|hpp)\b/i.test(prompt)
  );
}

export function isBarePythonCommand(command: string): boolean {
  const normalized = command.trim().replace(/^run\s+/i, "");
  const first = normalized.split(/\s+/)[0]?.replace(/^["']|["']$/g, "").toLowerCase();
  return first === "python" || first === "python3" || first === "py";
}

function commandContainsGit(command: string): boolean {
  return /\bgit(?:\.exe)?\b/i.test(command);
}

function gitCommandPattern(subcommands: string, flags = "i"): RegExp {
  return new RegExp(String.raw`\bgit(?:\.exe)?(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))*\s+(?:${subcommands})\b`, flags);
}

function gitCommandIsReadOnly(command: string): boolean {
  const readOnly = [
    "status",
    "diff",
    "show",
    "log",
    "reflog",
    "rev-parse",
    "ls-files",
    "cat-file",
    "show-ref",
    "blame",
    "grep",
    "describe",
    "merge-base",
    "name-rev",
    "for-each-ref",
    "remote\\s+(?:-v|show)",
    "worktree\\s+list",
    "stash\\s+list",
    "tag\\s+(?:--list|-l)",
    "branch\\s+(?:--show-current|--list|-a|-r|-v|-vv|--contains|--merged|--no-merged)",
    "config\\s+(?:--get|--get-regexp|--list|--show-origin)",
    "submodule\\s+status",
  ].join("|");
  return gitCommandPattern(readOnly).test(command);
}

function gitCommandLooksDestructive(command: string): boolean {
  const destructive = [
    "reset\\s+--hard",
    "clean\\s+-[^\\s]*f[^\\s]*",
    "branch\\s+--delete\\s+--force",
    "worktree\\s+(?:remove|prune)",
    "push\\s+(?:[^;&|]*\\s)?(?:--force|-f|--force-with-lease)",
  ].join("|");
  return gitCommandPattern(destructive).test(command) || gitCommandPattern("branch\\s+-D", "").test(command);
}

function commandHasNetworkIntent(command: string): boolean {
  return (
    /\b(curl|wget|aria2c|Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer)\b/i.test(command) ||
    /\bhttps?:\/\//i.test(command)
  );
}

function commandLooksDestructive(command: string): boolean {
  return (
    /\brm\b/i.test(command) ||
    /\bRemove-Item\b/i.test(command) ||
    /\b(del|erase|rmdir)\b/i.test(command) ||
    gitCommandLooksDestructive(command)
  );
}

function quotedStringPattern(): RegExp {
  return /(["'`])([\s\S]*?)\1/g;
}

function startsWithAbsolutePath(value: string): boolean {
  return process.platform === "win32" ? /^(?:[A-Za-z]:\\|\\\\)/.test(value) : value.startsWith("/");
}

function absolutePathCandidates(command: string): string[] {
  const candidates: string[] = [];
  for (const match of command.matchAll(quotedStringPattern())) {
    const candidate = match[2]?.trim();
    if (candidate && startsWithAbsolutePath(candidate)) candidates.push(candidate);
  }

  const unquoted = command.replace(quotedStringPattern(), " ");
  const unquotedPattern =
    process.platform === "win32"
      ? /(?:^|\s)((?:[A-Za-z]:\\|\\\\)[^\s"'`<>|;&]*)/g
      : /(?:^|\s)(\/[^\s"'`<>|;&]*)/g;
  for (const match of unquoted.matchAll(unquotedPattern)) {
    const candidate = match[1]?.trim();
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function commandTouchesExternalDirectory(command: string, cwd?: string): boolean {
  if (!cwd) return false;
  for (const candidate of absolutePathCandidates(command)) {
    const resolved = path.resolve(candidate);
    if (!pathInside(cwd, resolved)) return true;
  }
  return false;
}

/** Split a command into shell-ish tokens, dropping the quotes that group them. */
function commandTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: string | undefined;
  for (const character of command) {
    if (quote && character === quote) quote = undefined;
    else if (!quote && (character === '"' || character === "'")) { quote = character; started = true; }
    else if (!quote && /\s/.test(character)) { if (started) { tokens.push(current); current = ""; started = false; } }
    else { current += character; started = true; }
  }
  if (started) tokens.push(current);
  return tokens;
}

/** `find` predicates that run a program or mutate the filesystem. */
const findActionPredicates = new Set([
  "-exec", "-execdir", "-ok", "-okdir", "-delete", "-fls", "-fprint", "-fprint0", "-fprintf",
]);

/** Bare words that name no file are arguments, not paths. */
function looksLikePath(token: string): boolean {
  if (!token || token.startsWith("-")) return false;
  const normalized = token.replace(/\\/g, "/");
  const basename = path.posix.basename(normalized).toLowerCase();
  return normalized.includes("/") || normalized.includes(".") || basename === "id_rsa" || basename === "id_ed25519";
}

/** Lexically decide whether a relative path climbs above the workspace root. */
function escapesWorkspace(token: string): boolean {
  let depth = 0;
  for (const part of token.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (--depth < 0) return true; } else depth += 1;
  }
  return false;
}

function tokenIsBlockedPath(token: string): boolean {
  const normalized = token.replace(/\\/g, "/");
  return isBlockedPath(normalized) || isBlockedPath(normalized.replace(/[*?]/g, ""));
}

/**
 * The audited read-only class, which Auto-safe runs without a prompt. The whole
 * segment has to prove itself: a locator name is not enough, because `find`
 * reaches an arbitrary interpreter through `-exec` and deletes through
 * `-delete`, and any of these can redirect their output into a file.
 */
function isAuditedReadOnly(command: string, tokens: string[]): boolean {
  const first = tokens[0]?.toLowerCase() ?? "";
  if (!["cat", "type", "dir", "ls", "find", "where"].includes(first)) return false;
  if (command.includes(">") || command.includes("<")) return false;
  if (first === "find" && tokens.some((token) => findActionPredicates.has(token.toLowerCase()))) return false;
  return true;
}

export type CommandClassification = {
  commandClass: CommandClass;
  risky: boolean;
  reason?: string;
};

/// The read-only workspace tools, listed once. A new locator tool that is not
/// added here is classified as a shell command and prompts for permission.
const workspaceReadPermissionKinds = new Set(["read", "ls", "find", "search"]);

export function isWorkspaceReadPermission(permissionKind: string): boolean {
  return workspaceReadPermissionKinds.has(permissionKind);
}

export function canAutoResolvePermission(
  mode: PermissionMode,
  permissionKind: string,
  classification: CommandClassification,
  safetyAction?: string,
): boolean {
  if (mode !== "auto_safe" || classification.risky) return false;
  return isWorkspaceReadPermission(permissionKind)
    || permissionKind === "edit"
    || (permissionKind === "bash" && safetyAction === "allow");
}

export function classifyCommandText(command: string, cwd?: string): CommandClassification {
  const trimmed = command.trim();
  const lower = trimmed.toLowerCase();

  if (!trimmed) return { commandClass: "unknown", risky: false };
  if (commandHasNetworkIntent(trimmed)) return { commandClass: "network", risky: true, reason: "network command" };
  // The blocklist that guards the file tools, applied to command arguments so
  // the shell cannot read what `read` refuses.
  const tokens = commandTokens(trimmed);
  for (const token of tokens.slice(1)) {
    if (!looksLikePath(token)) continue;
    if (escapesWorkspace(token)) return { commandClass: "external-directory", risky: true, reason: "external path" };
    if (tokenIsBlockedPath(token)) {
      return { commandClass: "blocked-path", risky: true, reason: "blocked workspace path" };
    }
  }
  if (commandTouchesExternalDirectory(trimmed, cwd)) {
    return { commandClass: "external-directory", risky: true, reason: "external path" };
  }
  if (commandLooksDestructive(trimmed)) {
    return { commandClass: "destructive-file", risky: true, reason: "destructive command" };
  }
  if (isBarePythonCommand(trimmed) || /\b(uv|pytest|pip|pip3|\.venv[\\/](scripts[\\/])?python)\b/i.test(trimmed)) {
    return { commandClass: "python-runtime", risky: false };
  }
  if (commandContainsGit(trimmed)) {
    return gitCommandIsReadOnly(trimmed) ? { commandClass: "git-read", risky: false } : { commandClass: "git-write", risky: true };
  }
  if (/\b(cmake|ctest|ninja|make|msbuild)\b/i.test(trimmed)) return { commandClass: "cmake-build", risky: false };
  if (/\b(cl|clang|clang\+\+|gcc|g\+\+)\b/i.test(trimmed)) return { commandClass: "compiler", risky: false };
  if (/\b(npm|pnpm|yarn|bun|cargo|go|dotnet)\b/i.test(trimmed)) {
    return {
      commandClass: "package-manager",
      risky: /\b(install|add|update|upgrade|global|-g)\b/i.test(trimmed),
      reason: "package manager",
    };
  }
  if (/\b(markdownlint|remark|prettier)\b/i.test(trimmed) || /\.(md|markdown)\b/i.test(trimmed)) {
    return { commandClass: "markdown", risky: false };
  }
  if (isAuditedReadOnly(trimmed, tokens)) return { commandClass: "read", risky: false };
  if (lower.includes("powershell") || lower.includes("pwsh") || lower.includes("bash") || lower.includes("sh -c")) {
    return { commandClass: "shell", risky: false };
  }
  return { commandClass: "shell", risky: false };
}

export function redactText(value: string, limit = 600): string {
  const text = value
    .replace(/-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g, "[redacted-private-key]")
    .replace(/\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}/gi, "$1=[redacted]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-aws-key]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g, "[redacted-github-token]")
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}...[truncated]` : text;
}

export function redactCommandText(command: string): string {
  return redactText(command, 320);
}

export function shortHashValue(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function baseUrlHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "invalid-url";
  }
}

export function isHttpModelUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}


export function isApprovedVeilChatRoute(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      /^\/api\/(?:engineering|marketing|sales)\/chat\/?$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Umbratic runner hardening assertion failed: ${message}`);
  }
}

/**
 * `dataRoot` is passed in rather than read from Electron so this module stays
 * importable without an app instance, which is how its tests load it.
 */
export function assertUmbraticRunnerConfig(
  config: Record<string, unknown>,
  selectedModel: LocalModelInfo,
  dataRoot: string,
): void {
  assert(typeof config.taskId === "string" && config.taskId.length > 0, "task id must be set");
  assert(typeof config.cwd === "string" && config.cwd.length > 0, "cwd must be set");
  assert(config.permissionMode === "normal", "permissions must be mediated by the desktop app");
  assert(
    Array.isArray(config.enabledTools) && config.enabledTools.every((tool) => isRunnerToolId(tool)),
    "enabled tools must be explicit valid runner tool ids",
  );
  const lspServers = config.lspServers;
  assert(Array.isArray(lspServers) && lspServers.length <= 3, "LSP servers must be a bounded explicit list");
  assert(
    lspServers.every((server) => {
      if (!server || typeof server !== "object" || Array.isArray(server)) return false;
      const value = server as Record<string, unknown>;
      return (
        typeof value.id === "string"
        && typeof value.command === "string"
        && path.isAbsolute(value.command)
        && Array.isArray(value.args)
        && value.args.every((argument) => typeof argument === "string")
        && Array.isArray(value.languageIds)
        && value.languageIds.every((language) => typeof language === "string")
        && Array.isArray(value.extensions)
        && value.extensions.every((extension) => typeof extension === "string")
      );
    }),
    "LSP server commands must be approved absolute launch records",
  );
  assert(
    !config.enabledTools.includes("lsp") || lspServers.length > 0,
    "LSP must not be enabled without an approved server",
  );
  const workspaceGraph = config.workspaceGraph;
  assert(
    workspaceGraph === undefined
      || (isRecord(workspaceGraph)
        && typeof workspaceGraph.artifactPath === "string"
        && path.isAbsolute(workspaceGraph.artifactPath)),
    "workspace graph must be an absolute artifact path when configured",
  );
  // The artifact is Umbratic's own derived state, so it belongs in the app's
  // data directory and nowhere else. Asserting that positively is what stops a
  // future caller from quietly pointing the runner at a path in the user's
  // tree — or anywhere else on disk.
  assert(
    !isRecord(workspaceGraph)
      || pathInside(dataRoot, String(workspaceGraph.artifactPath)),
    "workspace graph artifact must live in the Umbratic data directory",
  );
  assert(
    !config.enabledTools.includes("workspace_graph") || workspaceGraph !== undefined,
    "the workspace graph tool must not be enabled without an artifact",
  );
  assert(selectedModel.providerId === companyEndpointProviderId, "provider must be the Umbratic private endpoint");

  const provider = config.provider as Record<string, unknown> | undefined;
  assert(provider, "provider must be configured");
  assert(isHttpModelUrl(selectedModel.baseUrl), "model base URL must be an HTTP(S) endpoint");
  assert(provider.id === selectedModel.providerId, "provider id must match the selected endpoint");
  assert(provider.modelId === selectedModel.modelId, "provider model token must match the selected endpoint");
  assert(provider.baseURL === selectedModel.baseUrl, "provider URL must match the configured endpoint");
  assert(typeof provider.chatEndpointPath === "string", "provider must use an explicit Veil chat route");
  assert(provider.mode === "server" || provider.mode === "local", "provider mode must be an explicit trusted server or local value");
  assert(
    isApprovedVeilChatRoute(configuredEndpointRoute(selectedModel.baseUrl, provider.chatEndpointPath)),
    "provider route must be an approved Veil chat API",
  );
  // A model name on the wire is a claim the server invited; the sentinel is a
  // local placeholder that must never become one.
  assert(
    provider.sendModelField === undefined || typeof provider.sendModelField === "boolean",
    "provider sendModelField must be an explicit boolean when present",
  );
  assert(
    provider.sendModelField !== true || provider.modelId !== veilManagedModelId,
    "the server-default sentinel must never be sent as a model name",
  );
  assert(
    provider.sendThinkingField === undefined || typeof provider.sendThinkingField === "boolean",
    "provider sendThinkingField must be an explicit boolean when present",
  );
  assert(
    provider.thinking === undefined || provider.thinking === "on" || provider.thinking === "off",
    "provider thinking must be on, off, or absent",
  );
  assert(!("system" in config), "protected system prompts must stay inside Veil");
}

export function umbraticRunnerHardeningEnvironment(): NodeJS.ProcessEnv {
  return {
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
  };
}

export function runtimeDiagnostics(): RuntimeDiagnostics {
  return {
    python: {
      runtimeVersion: pythonRuntimeVersion,
      barePythonVerification: "allowed_uv_preferred",
      generatedPaths: [".venv", "__pycache__", ".pyc", ".umbratic/runtime"],
    },
    markdown: {
      docsOnlyClassification: "enabled",
    },
    cmake: {
      runtimeVersion: cmakeRuntimeVersion,
      buildDir: ".umbratic/build",
    },
    toolchain: {
      bundledHelperCommands: ["rg", "fd/fdfind", "tree-sitter", "bat/batcat"],
      optionalCapabilityCommands: ["jq", "yq", "cmake", "compiler", "build backend", "tesseract"],
    },
    shell: {
      platform: process.platform,
      preferred: process.platform === "win32" ? "powershell" : "posix",
      nonInteractive: true,
    },
  };
}
