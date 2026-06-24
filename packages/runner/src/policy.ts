import * as crypto from "node:crypto";
import * as path from "node:path";

export const umbraticPolicyVersion = "umbratic-enterprise-mvp-2";
export const umbraticRunnerName = "UmbraticRunner";
export const umbraticRunnerVersion = "fork-1";
export const umbraticRunnerContractVersion = "umbratic-runner-1";

export type CommandClass =
  | "read"
  | "edit"
  | "shell"
  | "python-runtime"
  | "markdown"
  | "cmake-build"
  | "compiler"
  | "debugger"
  | "package-manager"
  | "git-read"
  | "git-write"
  | "destructive-file"
  | "network"
  | "external-directory"
  | "unknown";

export type CommandClassification = {
  commandClass: CommandClass;
  risky: boolean;
  reason?: string;
};

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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

const generatedRuntimeNames = new Set(["__pycache__", "cmakefiles"]);
const generatedRuntimeExtensions = new Set([".pyc", ".pyo", ".o", ".obj", ".a", ".lib", ".so", ".dylib", ".dll", ".exe", ".pdb"]);

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

function firstCommandToken(command: string): string {
  const normalized = command.trim().replace(/^run\s+/i, "");
  const match = normalized.match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").toLowerCase();
}

function isBarePythonCommand(command: string): boolean {
  const first = firstCommandToken(command).replace(/^["']|["']$/g, "");
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
    "clean\\s+-[^\\s]*f",
    "branch\\s+--delete\\s+--force",
    "worktree\\s+(?:remove|prune)",
    "push\\s+(?:[^;&|]*\\s)?(?:--force|-f|--force-with-lease)",
  ].join("|");
  return gitCommandPattern(destructive).test(command) || gitCommandPattern("branch\\s+-D", "").test(command);
}

function commandHasNetworkIntent(command: string): boolean {
  return /\b(curl|wget|aria2c|Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer)\b/i.test(command) || /\bhttps?:[/][/]/i.test(command);
}

function commandLooksDestructive(command: string): boolean {
  return (
    /\brm\s+(-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\b/i.test(command) ||
    /\bRemove-Item\b/i.test(command) ||
    /\b(del|erase|rmdir)\b/i.test(command) ||
    gitCommandLooksDestructive(command)
  );
}

function commandTouchesExternalDirectory(command: string, cwd?: string): boolean {
  if (!cwd) return false;
  const absolutePathPattern =
    process.platform === "win32" ? /(?:^|\s)([A-Za-z]:\\[^\s"'`<>|]+|\\\\[^\s"'`<>|]+)/g : /(?:^|\s)(\/[^\s"'`<>|]+)/g;
  for (const match of command.matchAll(absolutePathPattern)) {
    const candidate = match[1];
    if (candidate && !pathInside(cwd, path.resolve(candidate))) return true;
  }
  return false;
}

export function classifyCommandText(command: string, cwd?: string): CommandClassification {
  const trimmed = command.trim();
  const lower = trimmed.toLowerCase();
  const first = firstCommandToken(trimmed);

  if (!trimmed) return { commandClass: "unknown", risky: false };
  if (commandHasNetworkIntent(trimmed)) return { commandClass: "network", risky: true, reason: "network command" };
  if (commandTouchesExternalDirectory(trimmed, cwd)) return { commandClass: "external-directory", risky: true, reason: "external path" };
  if (commandLooksDestructive(trimmed)) return { commandClass: "destructive-file", risky: true, reason: "destructive command" };
  if (isBarePythonCommand(trimmed) || /\b(uv|pytest|pip|pip3|\.venv[\\/](scripts[\\/])?python)\b/i.test(trimmed)) {
    return { commandClass: "python-runtime", risky: isBarePythonCommand(trimmed), reason: isBarePythonCommand(trimmed) ? "bare python" : undefined };
  }
  if (commandContainsGit(trimmed)) return gitCommandIsReadOnly(trimmed) ? { commandClass: "git-read", risky: false } : { commandClass: "git-write", risky: true };
  if (/\b(gdb|lldb|cdb|windbg|vsdbg|valgrind|drmemory)\b/i.test(trimmed)) return { commandClass: "debugger", risky: false };
  if (/\b(cmake|ctest|ninja|make|msbuild)\b/i.test(trimmed)) return { commandClass: "cmake-build", risky: false };
  if (/\b(cl|clang|clang\+\+|gcc|g\+\+)\b/i.test(trimmed)) return { commandClass: "compiler", risky: false };
  if (/\b(npm|pnpm|yarn|bun|cargo|go|dotnet)\b/i.test(trimmed)) {
    return { commandClass: "package-manager", risky: /\b(install|add|update|upgrade|global|-g)\b/i.test(trimmed), reason: "package manager" };
  }
  if (/\b(markdownlint|remark|prettier)\b/i.test(trimmed) || /\.(md|markdown)\b/i.test(trimmed)) return { commandClass: "markdown", risky: false };
  if (first === "cat" || first === "type" || first === "dir" || first === "ls" || first === "find" || first === "where") return { commandClass: "read", risky: false };
  if (lower.includes("powershell") || lower.includes("pwsh") || lower.includes("bash") || lower.includes("sh -c")) return { commandClass: "shell", risky: false };
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
