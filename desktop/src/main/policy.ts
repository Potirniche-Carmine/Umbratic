import * as crypto from "node:crypto";
import * as path from "node:path";

import type { CommandClass, LocalModelInfo, LocalProviderId, RuntimeDiagnostics, RuntimeProfileId, TelemetryPolicyInfo } from "./types";
import { normalizeRelativePath, pathInside } from "./utils";

export const aegisPolicyVersion = "aegis-local-mvp-1";
export const aegisRunnerName = "AegisRunner";
export const aegisRunnerVersion = "package-adapter-1";
export const aegisRunnerContractVersion = "aegis-runner-1";
export const allowedLocalProviderIds: LocalProviderId[] = ["local-lmstudio", "local-vllm"];
export const pythonRuntimeProfileVersion = "python-uv-venv-1";
export const cmakeRuntimeProfileVersion = "cmake-aegis-build-1";

export const telemetryPolicyInfo: TelemetryPolicyInfo = {
  mode: "developer_toggle",
  localEnabled: true,
  syncEnabled: false,
  retentionDays: 30,
  exportFormat: "redacted-json",
  storage: "task-event-snapshots",
};

const generatedRuntimePrefixes = [
  ".aegis/runtime/",
  ".aegis/build/",
  ".aegis/tmp/",
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

const generatedRuntimeNames = new Set(["__pycache__", "cmakefiles"]);

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

export function promptLooksLikeMarkdownTask(prompt: string): boolean {
  return /\b(markdown|readme|docs?|\.md|\.markdown)\b/i.test(prompt);
}

export function promptLooksLikeCmakeTask(prompt: string): boolean {
  return /\b(cmake|c\+\+|cpp|\.cc|\.cpp|\.cxx|\.h|\.hpp|ctest|ninja|clang|gcc|msvc)\b/i.test(prompt);
}

export function runtimeProfileForPrompt(prompt: string): RuntimeProfileId {
  if (promptLooksLikePythonTask(prompt)) return "python";
  if (promptLooksLikeCmakeTask(prompt)) return "cmake";
  if (promptLooksLikeMarkdownTask(prompt)) return "markdown";
  return "none";
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

function gitCommandIsReadOnly(command: string): boolean {
  return /\bgit\s+(status|diff|show|log|rev-parse|branch\s+--show-current|ls-files|cat-file|show-ref)\b/i.test(command);
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
    /\bgit\s+reset\s+--hard\b/i.test(command) ||
    /\bgit\s+clean\s+-[^\s]*f/i.test(command)
  );
}

function commandTouchesExternalDirectory(command: string, cwd?: string): boolean {
  if (!cwd) return false;
  const absolutePathPattern =
    process.platform === "win32"
      ? /(?:^|\s)([A-Za-z]:\\[^\s"'`<>|]+|\\\\[^\s"'`<>|]+)/g
      : /(?:^|\s)(\/[^\s"'`<>|]+)/g;
  for (const match of command.matchAll(absolutePathPattern)) {
    const candidate = match[1];
    if (!candidate) continue;
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
  if (commandLooksDestructive(trimmed)) {
    return { commandClass: "destructive-file", risky: true, reason: "destructive command" };
  }
  if (commandTouchesExternalDirectory(trimmed, cwd)) {
    return { commandClass: "external-directory", risky: true, reason: "external path" };
  }
  if (isBarePythonCommand(trimmed) || /\b(uv|pytest|pip|pip3|\.venv[\\/](scripts[\\/])?python)\b/i.test(trimmed)) {
    return { commandClass: "python-runtime", risky: isBarePythonCommand(trimmed), reason: isBarePythonCommand(trimmed) ? "bare python" : undefined };
  }
  if (/\bgit\b/i.test(trimmed)) {
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Aegis runner hardening assertion failed: ${message}`);
  }
}

function keysOfRecord(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
}

export function assertPackageRunnerConfig(config: Record<string, unknown>, selectedModel: LocalModelInfo): void {
  assert(config.share === "disabled", "sharing must stay disabled");
  assert(config.autoupdate === false, "auto-update must stay disabled");
  assert(config.model === `${selectedModel.providerId}/${selectedModel.modelId}`, "model must match selected local provider");
  assert(config.small_model === `${selectedModel.providerId}/${selectedModel.modelId}`, "small model must match selected local provider");
  assert(Array.isArray(config.enabled_providers), "enabled providers must be explicit");
  assert(config.enabled_providers.length === 1 && config.enabled_providers[0] === selectedModel.providerId, "only the selected local provider may be enabled");
  assert(allowedLocalProviderIds.includes(selectedModel.providerId), "provider must be on the Aegis local allowlist");
  assert(isLocalhostUrl(selectedModel.baseUrl), "model base URL must be localhost");

  const providerKeys = keysOfRecord(config.provider);
  assert(providerKeys.length === 1 && providerKeys[0] === selectedModel.providerId, "provider config must contain only the selected provider");

  const server = config.server as Record<string, unknown> | undefined;
  assert(server?.hostname === "127.0.0.1", "server must bind to 127.0.0.1");
  assert(server?.mdns === false, "mDNS must stay disabled");
  assert(Array.isArray(server?.cors) && server.cors.length === 0, "CORS must stay empty");
  assert(keysOfRecord(config.mcp).length === 0, "MCP must stay empty");
  assert(Array.isArray(config.plugin) && config.plugin.length === 0, "plugins must stay empty");
  assert(Array.isArray(config.instructions) && config.instructions.length === 0, "extra instructions must stay empty");

  const permissions = config.permission as Record<string, unknown> | undefined;
  assert(permissions?.webfetch === "deny", "web fetch must be denied");
  assert(permissions?.websearch === "deny", "web search must be denied");
}

export function packageRunnerHardeningEnvironment(): NodeJS.ProcessEnv {
  return {
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_SHARE: "1",
    OPENCODE_DISABLE_TELEMETRY: "1",
    OPENCODE_DISABLE_WEB: "1",
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
  };
}

export function runtimeDiagnostics(): RuntimeDiagnostics {
  return {
    python: {
      profileVersion: pythonRuntimeProfileVersion,
      barePythonVerification: "denied",
      generatedPaths: [".venv", "__pycache__", ".pyc", ".aegis/runtime"],
    },
    markdown: {
      docsOnlyClassification: "enabled",
    },
    cmake: {
      profileVersion: cmakeRuntimeProfileVersion,
      buildDir: ".aegis/build",
    },
    shell: {
      platform: process.platform,
      preferred: process.platform === "win32" ? "powershell" : "posix",
      nonInteractive: true,
    },
  };
}
