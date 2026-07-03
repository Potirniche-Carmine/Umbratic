import { normalizeRelativePath } from "./common.js";

export type SearchQuery = {
  raw: string;
  terms: string[];
  includeDirs: string[];
  includeGlobs: string[];
  excludeDirs: string[];
  excludeGlobs: string[];
  location?: { pathQuery: string; line: number; column?: number };
  smartCase: boolean;
};

const globSyntax = /[*?[\]]/;

function normalizeQueryPath(value: string): string {
  return normalizeRelativePath(value.trim().replace(/^\.\//, ""));
}

function normalizeQueryDirectory(value: string): string {
  const normalized = normalizeQueryPath(value).replace(/\/+$/g, "");
  return normalized ? `${normalized}/` : "";
}

export function parseLocationSuffix(value: string): SearchQuery["location"] | undefined {
  const match = value.trim().match(/^(.+?):([1-9]\d*)(?::([1-9]\d*))?$/);
  if (!match) return undefined;
  const pathQuery = normalizeQueryPath(match[1] ?? "").replace(/\/+$/g, "");
  const line = Number(match[2]);
  const column = match[3] === undefined ? undefined : Number(match[3]);
  if (!pathQuery || !Number.isSafeInteger(line) || line < 1) return undefined;
  if (column !== undefined && (!Number.isSafeInteger(column) || column < 1)) return undefined;
  return { pathQuery, line, ...(column === undefined ? {} : { column }) };
}

export function parseSearchQuery(raw: string): SearchQuery {
  const trimmed = raw.trim();
  const query: SearchQuery = {
    raw: trimmed,
    terms: [],
    includeDirs: [],
    includeGlobs: [],
    excludeDirs: [],
    excludeGlobs: [],
    smartCase: /[A-Z]/.test(trimmed),
  };

  for (const token of trimmed.split(/\s+/).filter(Boolean)) {
    const excluded = token.startsWith("!") && token.length > 1;
    const tokenValue = excluded ? token.slice(1) : token;
    const location = excluded ? undefined : parseLocationSuffix(tokenValue);
    if (location) {
      query.location = location;
      continue;
    }

    const value = normalizeQueryPath(tokenValue);
    if (!value) continue;
    if (value.endsWith("/")) {
      const directory = normalizeQueryDirectory(value);
      if (!directory) continue;
      if (excluded) query.excludeDirs.push(directory);
      else query.includeDirs.push(directory);
      continue;
    }
    if (globSyntax.test(value)) {
      if (excluded) query.excludeGlobs.push(value);
      else query.includeGlobs.push(value);
      continue;
    }
    if (excluded) {
      query.excludeGlobs.push(value);
      continue;
    }
    query.terms.push(value);
  }

  return query;
}
