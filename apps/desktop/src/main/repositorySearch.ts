import * as path from "node:path";

import { attachmentContextTokens } from "./attachmentContext";
import { searchRootFiles } from "./fileSearch";
import { readProjects } from "./storage";
import type { FileSearchResult } from "./types";
import { isRecord, requiredString } from "./utils";

export async function searchRepositoryFiles(input: unknown): Promise<FileSearchResult[]> {
  if (!isRecord(input)) throw new Error("Invalid file search input.");
  const repositoryId = requiredString(input.repositoryId, "repositoryId");
  const query = typeof input.query === "string" ? input.query.trim().slice(0, 120) : "";
  const limit = Math.min(30, Math.max(4, typeof input.limit === "number" ? input.limit : 10));
  const repository = readProjects().find((project) => project.id === repositoryId);
  if (!repository) throw new Error("Repository has not been selected.");
  const results = await searchRootFiles(repository.rootPath, query, limit);
  return results.map((result) => ({
    ...result,
    contextTokens: attachmentContextTokens(path.resolve(repository.rootPath, result.path)),
  }));
}
