import * as path from "node:path";
import * as fs from "node:fs";
import { ensureReadableText, throwIfToolAborted, toolError, type ToolContext, type ToolResult } from "./common.js";
import { parseSearchQuery, type SearchQuery } from "./searchQuery.js";
import { getWorkspaceIndex, type IndexedFile, type WorkspaceIndex } from "./workspaceIndex.js";

type ContentLineClass = "definition" | "import" | "usage";

type ContentHit = {
  relative: string;
  lineNumber: number;
  lineClass: ContentLineClass;
  fileScore: number;
};

const entryPointFilenames = new Set(["index.ts", "index.tsx", "index.js", "main.ts", "main.tsx", "main.js", "lib.rs", "__init__.py"]);
const contentCacheTtlMs = 30_000;
const contentCache = new Map<string, { modifiedMs: number; size: number; cachedAtMs: number; text: string }>();
const globCache = new Map<string, RegExp>();

function caseValue(value: string, caseSensitive: boolean): string {
  return caseSensitive ? value : value.toLowerCase();
}

function queryPathTerms(query: SearchQuery): string[] {
  if (query.terms.length) return query.terms;
  return query.location ? [query.location.pathQuery] : [];
}

function normalizeDirectoryConstraint(value: string, caseSensitive: boolean): string {
  const normalized = value.replace(/\/+$/g, "");
  return caseValue(normalized ? `${normalized}/` : "", caseSensitive);
}

function matchesIncludeDirectory(relative: string, directory: string, caseSensitive: boolean): boolean {
  return caseValue(relative, caseSensitive).startsWith(normalizeDirectoryConstraint(directory, caseSensitive));
}

function matchesExcludeDirectory(relative: string, directory: string, caseSensitive: boolean): boolean {
  const candidate = caseValue(relative, caseSensitive);
  const constraint = normalizeDirectoryConstraint(directory, caseSensitive);
  return candidate.startsWith(constraint) || candidate.includes(`/${constraint}`);
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$+?.()|{}]/g, "\\$&");
}

function globToRegExp(glob: string, caseSensitive: boolean): RegExp {
  const cacheKey = `${caseSensitive ? "case" : "nocase"}:${glob}`;
  const cached = globCache.get(cacheKey);
  if (cached) return cached;

  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        if (glob[index + 2] === "/") {
          pattern += "(?:.*/)?";
          index += 2;
        } else {
          pattern += ".*";
          index += 1;
        }
      } else {
        pattern += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      pattern += "[^/]";
      continue;
    }
    pattern += escapeRegex(char ?? "");
  }

  const regexp = new RegExp(`^${pattern}$`, caseSensitive ? "" : "i");
  globCache.set(cacheKey, regexp);
  return regexp;
}

function matchesGlob(file: IndexedFile, glob: string, caseSensitive: boolean): boolean {
  const normalized = glob.replace(/^\.\/+/, "");
  const target = normalized.includes("/") ? file.relative : file.filename;
  return globToRegExp(normalized, caseSensitive).test(target);
}

function filePassesConstraints(file: IndexedFile, query: SearchQuery): boolean {
  const caseSensitive = query.smartCase;
  return (
    query.includeDirs.every((directory) => matchesIncludeDirectory(file.relative, directory, caseSensitive)) &&
    query.includeGlobs.every((glob) => matchesGlob(file, glob, caseSensitive)) &&
    !query.excludeDirs.some((directory) => matchesExcludeDirectory(file.relative, directory, caseSensitive)) &&
    !query.excludeGlobs.some((glob) => matchesGlob(file, glob, caseSensitive))
  );
}

function fuzzyScore(candidate: string, query: string, filenameRegion: boolean): number {
  if (!query) return 0;
  let lastIndex = -1;
  let firstIndex = -1;
  let runLength = 0;
  let score = filenameRegion ? 120 : 70;

  for (const char of query) {
    const nextIndex = candidate.indexOf(char, lastIndex + 1);
    if (nextIndex === -1) return 0;
    if (firstIndex === -1) firstIndex = nextIndex;
    if (nextIndex === lastIndex + 1) {
      runLength += 1;
      score += 12 + Math.min(runLength, 5) * 3;
    } else {
      runLength = 1;
      score += 5;
    }
    if (nextIndex === 0 || "/._-".includes(candidate[nextIndex - 1] ?? "")) {
      score += filenameRegion ? 12 : 6;
    }
    lastIndex = nextIndex;
  }

  const span = lastIndex - firstIndex + 1;
  score += query.length * (filenameRegion ? 10 : 6);
  score -= Math.max(0, span - query.length) * 2;
  score -= firstIndex * 0.5;
  return Math.max(1, score);
}

function scoreTerm(file: IndexedFile, term: string, caseSensitive: boolean): number {
  const query = caseValue(term, caseSensitive);
  const filename = caseValue(file.filename, caseSensitive);
  const relative = caseValue(file.relative, caseSensitive);
  if (!query) return 0;

  let score = 0;
  if (filename === query) score = Math.max(score, 600);
  if (relative === query) score = Math.max(score, 580);
  if (relative.endsWith(query)) score = Math.max(score, 360);

  const filenameIndex = filename.indexOf(query);
  if (filenameIndex !== -1) score = Math.max(score, 320 - Math.min(filenameIndex, 80));
  const pathIndex = relative.indexOf(query);
  if (pathIndex !== -1) score = Math.max(score, 180 - Math.min(pathIndex, 80));

  score = Math.max(score, fuzzyScore(filename, query, true), fuzzyScore(relative, query, false));
  return score;
}

function fileBoost(file: IndexedFile): number {
  let boost = file.recentReadScore * 35;
  if (file.gitStatus === "staged") boost += 25;
  if (file.gitStatus === "modified" || file.gitStatus === "untracked") boost += 20;
  if (entryPointFilenames.has(file.filename.toLowerCase())) boost += 8;
  return boost;
}

function pathMatchesWithIndex(index: WorkspaceIndex, query: SearchQuery, limit: number): string[] {
  const terms = queryPathTerms(query);
  const hasPathIntent = terms.length > 0 || query.includeDirs.length > 0 || query.includeGlobs.length > 0 || !!query.location;
  if (!hasPathIntent) return [];

  const caseSensitive = query.smartCase;
  const hits = index.files
    .filter((file) => filePassesConstraints(file, query))
    .map((file) => {
      const baseScore = terms.length ? terms.reduce((total, term) => {
        const termScore = scoreTerm(file, term, caseSensitive);
        return termScore > 0 && total >= 0 ? total + termScore : -1;
      }, 0) : 10;
      return { relative: file.relative, score: baseScore < 0 ? 0 : baseScore + fileBoost(file) };
    })
    .filter((hit) => hit.score > 0)
    .sort((left, right) => right.score - left.score || left.relative.length - right.relative.length || left.relative.localeCompare(right.relative))
    .slice(0, limit);

  return hits.map((hit) => `${hit.relative}: path`);
}

export function classifyLine(line: string): ContentLineClass {
  const trimmed = line.trimStart();
  if (/^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|struct|fn|def|impl|trait)\b/.test(trimmed)) {
    return "definition";
  }
  if (/^(?:import\b|from\b|require\s*\(|use\b|#include\b)/.test(trimmed)) return "import";
  return "usage";
}

function readCachedText(cwd: string, file: IndexedFile): string {
  const absolute = path.resolve(cwd, file.relative);
  const stat = fs.statSync(absolute);
  const cached = contentCache.get(absolute);
  if (
    cached &&
    cached.modifiedMs === stat.mtimeMs &&
    cached.size === stat.size &&
    Date.now() - cached.cachedAtMs <= contentCacheTtlMs
  ) {
    return cached.text;
  }
  const text = ensureReadableText(absolute);
  contentCache.set(absolute, { modifiedMs: stat.mtimeMs, size: stat.size, cachedAtMs: Date.now(), text });
  return text;
}

function lineMatchesTerms(line: string, terms: string[], caseSensitive: boolean): boolean {
  const candidate = caseValue(line, caseSensitive);
  return terms.every((term) => candidate.includes(caseValue(term, caseSensitive)));
}

function lineClassRank(lineClass: ContentLineClass): number {
  if (lineClass === "definition") return 0;
  if (lineClass === "usage") return 1;
  return 2;
}

function contentMatchesWithIndex(ctx: ToolContext, index: WorkspaceIndex, query: SearchQuery, limit: number): string[] {
  const cwd = ctx.cwd;
  if (!query.terms.length) return [];
  const caseSensitive = query.smartCase;
  const matches: ContentHit[] = [];

  for (const file of index.files) {
    throwIfToolAborted(ctx);
    if (!file.searchable || !filePassesConstraints(file, query)) continue;
    let text: string;
    try {
      text = readCachedText(cwd, file);
    } catch {
      continue;
    }
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    for (const [indexInFile, line] of lines.entries()) {
      if (!lineMatchesTerms(line, query.terms, caseSensitive)) continue;
      matches.push({
        relative: file.relative,
        lineNumber: indexInFile + 1,
        lineClass: classifyLine(line),
        fileScore: fileBoost(file),
      });
    }
  }

  return matches
    .sort(
      (left, right) =>
        lineClassRank(left.lineClass) - lineClassRank(right.lineClass) ||
        right.fileScore - left.fileScore ||
        left.relative.localeCompare(right.relative) ||
        left.lineNumber - right.lineNumber,
    )
    .slice(0, limit)
    .map((hit) => `${hit.relative}:${hit.lineNumber}: content`);
}

export async function searchTool(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  throwIfToolAborted(ctx);
  const rawQuery = typeof input.query === "string" ? input.query.trim() : "";
  const limit = typeof input.limit === "number" ? Math.min(Math.max(Math.floor(input.limit), 1), 100) : 50;
  if (!rawQuery) throw toolError("validation_error", "invalid_arguments", "search requires query");
  const query = parseSearchQuery(rawQuery);
  const index = getWorkspaceIndex(ctx.cwd);
  const pathResults = pathMatchesWithIndex(index, query, limit);
  const contentResults = pathResults.length >= limit ? [] : contentMatchesWithIndex(ctx, index, query, limit);
  const results = [...pathResults, ...contentResults].slice(0, limit);
  return { title: "search", output: results.join("\n") || "No matches.", status: "success" };
}
