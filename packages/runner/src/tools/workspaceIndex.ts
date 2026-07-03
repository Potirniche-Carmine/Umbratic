import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { normalizeRelativePath, pathInside, shouldSkipEntry } from "./common.js";

export type IndexedFile = {
  relative: string;
  filename: string;
  directory: string;
  extension: string;
  size: number;
  modifiedMs: number;
  gitStatus?: "modified" | "untracked" | "staged" | "clean";
  searchable: boolean;
  recentReadScore: number;
};

export type WorkspaceIndex = {
  cwd: string;
  files: IndexedFile[];
  builtAtMs: number;
  recordRead(relative: string): void;
  refreshIfStale(): void;
  refresh(): void;
};

const indexTtlMs = 30_000;
const maxSearchableFileBytes = 512 * 1024;
const binaryProbeBytes = 4096;
const workspaceIndexes = new Map<string, InternalWorkspaceIndex>();

type GitStatus = NonNullable<IndexedFile["gitStatus"]>;
type DiscoveredFile = { relative: string; gitStatus?: GitStatus };

function gitPaths(cwd: string, args: string[]): string[] | undefined {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 8000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.split("\0").map((entry) => normalizeRelativePath(entry)).filter(Boolean);
}

function discoverGitFiles(cwd: string): DiscoveredFile[] | undefined {
  const files = gitPaths(cwd, ["ls-files", "-co", "--exclude-standard", "-z"]);
  if (!files) return undefined;

  const modified = new Set(gitPaths(cwd, ["ls-files", "-m", "-z"]) ?? []);
  const untracked = new Set(gitPaths(cwd, ["ls-files", "-o", "--exclude-standard", "-z"]) ?? []);
  const staged = new Set(gitPaths(cwd, ["diff", "--name-only", "--cached", "-z"]) ?? []);

  return files.map((relative) => {
    const gitStatus: GitStatus =
      staged.has(relative) ? "staged" :
      modified.has(relative) ? "modified" :
      untracked.has(relative) ? "untracked" :
      "clean";
    return { relative, gitStatus };
  });
}

function discoverFilesystemFiles(cwd: string): DiscoveredFile[] {
  const files: DiscoveredFile[] = [];
  const stack = [cwd];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = normalizeRelativePath(path.relative(cwd, absolute));
      if (shouldSkipEntry(`${relative}${entry.isDirectory() ? "/" : ""}`)) continue;
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (entry.isFile()) files.push({ relative });
    }
  }
  return files;
}

function isBinarySuspicious(filePath: string, size: number): boolean {
  if (size === 0) return false;
  const buffer = Buffer.allocUnsafe(Math.min(size, binaryProbeBytes));
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).includes(0);
  } catch {
    return true;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function toIndexedFile(cwd: string, discovered: DiscoveredFile, recentReadScores: Map<string, number>): IndexedFile | undefined {
  const relative = normalizeRelativePath(discovered.relative);
  if (!relative || shouldSkipEntry(relative)) return undefined;
  const absolute = path.resolve(cwd, relative);
  if (!pathInside(cwd, absolute)) return undefined;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  const filename = path.posix.basename(relative);
  const directory = path.posix.dirname(relative);
  const binarySuspicious = isBinarySuspicious(absolute, stat.size);
  return {
    relative,
    filename,
    directory: directory === "." ? "" : directory,
    extension: path.posix.extname(filename).toLowerCase(),
    size: stat.size,
    modifiedMs: stat.mtimeMs,
    gitStatus: discovered.gitStatus,
    searchable: stat.size <= maxSearchableFileBytes && !binarySuspicious,
    recentReadScore: recentReadScores.get(relative) ?? 0,
  };
}

function buildWorkspaceFiles(cwd: string, recentReadScores: Map<string, number>): IndexedFile[] {
  const discovered = discoverGitFiles(cwd) ?? discoverFilesystemFiles(cwd);
  const files: IndexedFile[] = [];
  const seen = new Set<string>();
  for (const entry of discovered) {
    const relative = normalizeRelativePath(entry.relative);
    if (seen.has(relative)) continue;
    seen.add(relative);
    const indexed = toIndexedFile(cwd, { ...entry, relative }, recentReadScores);
    if (indexed) files.push(indexed);
  }
  return files.sort((left, right) => left.relative.localeCompare(right.relative));
}

class InternalWorkspaceIndex implements WorkspaceIndex {
  readonly cwd: string;
  files: IndexedFile[] = [];
  builtAtMs = 0;
  private readonly recentReadScores = new Map<string, number>();

  constructor(cwd: string) {
    this.cwd = path.resolve(cwd);
    this.refresh();
  }

  refresh(): void {
    this.files = buildWorkspaceFiles(this.cwd, this.recentReadScores);
    this.builtAtMs = Date.now();
  }

  refreshIfStale(): void {
    if (Date.now() - this.builtAtMs > indexTtlMs) this.refresh();
  }

  recordRead(relative: string): void {
    const normalized = normalizeRelativePath(relative);
    if (!normalized || shouldSkipEntry(normalized)) return;
    const nextScore = (this.recentReadScores.get(normalized) ?? 0) + 1;
    this.recentReadScores.set(normalized, nextScore);
    const file = this.files.find((entry) => entry.relative === normalized);
    if (file) {
      file.recentReadScore = nextScore;
      return;
    }
    if (fs.existsSync(path.resolve(this.cwd, normalized))) this.refresh();
  }
}

export function getWorkspaceIndex(cwd: string): WorkspaceIndex {
  const resolved = path.resolve(cwd);
  let index = workspaceIndexes.get(resolved);
  if (!index) {
    index = new InternalWorkspaceIndex(resolved);
    workspaceIndexes.set(resolved, index);
  } else {
    index.refreshIfStale();
  }
  return index;
}

export function listIndexedDirectoryEntries(index: WorkspaceIndex, directoryRelative: string, depth: number): string[] {
  const directory = normalizeRelativePath(directoryRelative).replace(/\/+$/g, "");
  const prefix = directory ? `${directory}/` : "";
  const maxDepth = Math.max(1, Math.floor(depth));
  const rows = new Set<string>();

  for (const file of index.files) {
    if (prefix && !file.relative.startsWith(prefix)) continue;
    const remainder = prefix ? file.relative.slice(prefix.length) : file.relative;
    const parts = remainder.split("/").filter(Boolean);
    if (!parts.length) continue;

    for (let level = 1; level < parts.length && level <= maxDepth; level += 1) {
      rows.add(`${parts.slice(0, level).join("/")}/`);
    }
    if (parts.length <= maxDepth) rows.add(remainder);
  }

  return [...rows].sort((left, right) => left.localeCompare(right));
}
