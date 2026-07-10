import * as crypto from "node:crypto";
import * as path from "node:path";

import { isRunnerToolId } from "./toolSettings";
import type {
  CommandClass,
  LocalModelInfo,
  LocalProviderId,
  ModelEndpointMode,
  RuntimeDiagnostics,
  TelemetryPolicyInfo,
} from "./types";
import { normalizeRelativePath, pathInside } from "./utils";

export const umbraticPolicyVersion = "umbratic-enterprise-mvp-2";
export const umbraticRunnerName = "UmbraticRunner";
export const umbraticRunnerVersion = "fork-1";
export const umbraticRunnerContractVersion = "umbratic-runner-1";
export const allowedLocalProviderIds: LocalProviderId[] = ["company-endpoint"];
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
];

const generatedRuntimeNames = new Set(["__pycache__", "cmakefiles", ".ds_store", "thumbs.db", "desktop.ini"]);

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
    normalized.startsWith(".env.") ||
    normalized.includes("/.env.") ||
    basename.endsWith(".pem") ||
    basename.endsWith(".key") ||
    basename.endsWith(".pfx") ||
    basename.endsWith(".p12") ||
    basename === "id_rsa" ||
    basename === "id_ed25519" ||
    normalized.includes("credential") ||
    normalized.includes("secret") ||
    normalized.includes("token")
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

function firstCommandToken(command: string): string {
  const normalized = command.trim().replace(/^run\s+/i, "");
  const match = normalized.match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").toLowerCase();
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
    /\brm\s+(-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\b/i.test(command) ||
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

export type CommandClassification = {
  commandClass: CommandClass;
  risky: boolean;
  reason?: string;
};

export function classifyCommandText(command: string, cwd?: string): CommandClassification {
  const trimmed = command.trim();
  const lower = trimmed.toLowerCase();
  const first = firstCommandToken(trimmed);

  if (!trimmed) return { commandClass: "unknown", risky: false };
  if (commandHasNetworkIntent(trimmed)) return { commandClass: "network", risky: true, reason: "network command" };
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
  if (first === "cat" || first === "type" || first === "dir" || first === "ls" || first === "find" || first === "where") {
    return { commandClass: "read", risky: false };
  }
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

export function isLocalhostUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (hostname === "localhost" || hostname === "::1" || hostname.startsWith("127."))
    );
  } catch {
    return false;
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

export function configuredEndpointUrl(baseUrl: string, endpointPath?: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const defaultPath = base.endsWith("/v1") ? "chat/completions" : "v1/chat/completions";
  const rawPath = endpointPath?.trim() ? endpointPath.trim() : defaultPath;
  if (/^https?:\/\//i.test(rawPath)) return rawPath;
  let normalizedPath = rawPath.replace(/^\/+/, "");
  if (/\/v\d+$/i.test(new URL(base).pathname) && /^v\d+\//i.test(normalizedPath)) {
    normalizedPath = normalizedPath.replace(/^v\d+\//i, "");
  }
  const baseSegment = new URL(base).pathname.replace(/\/+$/, "").split("/").filter(Boolean).at(-1);
  const routeSegment = normalizedPath.split("/").filter(Boolean)[0];
  if (baseSegment && baseSegment === routeSegment) {
    normalizedPath = normalizedPath.split("/").filter(Boolean).slice(1).join("/");
  }
  return new URL(normalizedPath, `${base}/`).toString();
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

export function assertUmbraticRunnerConfig(config: Record<string, unknown>, selectedModel: LocalModelInfo): void {
  assert(typeof config.taskId === "string" && config.taskId.length > 0, "task id must be set");
  assert(typeof config.cwd === "string" && config.cwd.length > 0, "cwd must be set");
  assert(config.permissionMode === "normal", "permissions must be mediated by the desktop app");
  assert(
    Array.isArray(config.enabledTools) && config.enabledTools.every((tool) => isRunnerToolId(tool)),
    "enabled tools must be explicit valid runner tool ids",
  );
  assert(allowedLocalProviderIds.includes(selectedModel.providerId), "provider must be on the Umbratic private endpoint allowlist");

  const provider = config.provider as Record<string, unknown> | undefined;
  assert(provider, "provider must be configured");
  assert(isHttpModelUrl(selectedModel.baseUrl), "model base URL must be an HTTP(S) endpoint");
  assert(provider.id === selectedModel.providerId, "provider id must match the selected endpoint");
  assert(provider.modelId === selectedModel.modelId, "provider model token must match the selected endpoint");
  assert(provider.baseURL === selectedModel.baseUrl, "provider URL must match the configured endpoint");
  assert(config.modelBoundary === "managed", "runner model boundary must be managed");
  assert(typeof provider.chatEndpointPath === "string", "provider must use an explicit Veil chat route");
  assert(
    isApprovedVeilChatRoute(configuredEndpointUrl(selectedModel.baseUrl, provider.chatEndpointPath)),
    "provider route must be an approved Veil chat API",
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
