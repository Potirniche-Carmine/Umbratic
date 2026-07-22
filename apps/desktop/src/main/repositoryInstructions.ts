import * as fs from "node:fs";
import * as path from "node:path";

import { normalizeRelativePath, pathInside } from "./utils";

export type AgentInstructionFile = {
  path: string;
  text: string;
};

type AgentInstructionDiscoveryOptions = {
  readTextFile(filePath: string): string | null;
  shouldSkipDirectory(input: { name: string; path: string }): boolean;
};

export function findAgentInstructionFiles(
  rootPath: string,
  options: AgentInstructionDiscoveryOptions,
): AgentInstructionFile[] {
  const root = path.resolve(rootPath);
  const files: AgentInstructionFile[] = [];
  const seen = new Set<string>();

  const addFile = (absolute: string) => {
    const resolved = path.resolve(absolute);
    if (!pathInside(root, resolved) || seen.has(resolved) || !fs.existsSync(resolved)) return;
    const text = options.readTextFile(resolved);
    if (text === null) return;
    files.push({
      path: normalizeRelativePath(path.relative(root, resolved)) || "AGENTS.md",
      text,
    });
    seen.add(resolved);
  };

  addFile(path.join(root, "AGENTS.md"));

  const walk = (directory: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = normalizeRelativePath(path.relative(root, absolute));
      if (entry.isFile() && entry.name === "AGENTS.md") {
        addFile(absolute);
        continue;
      }
      if (entry.isDirectory() && !options.shouldSkipDirectory({ name: entry.name, path: relative })) {
        walk(absolute);
      }
    }
  };

  walk(root);
  return files.sort((left, right) => {
    const depthDifference = left.path.split("/").length - right.path.split("/").length;
    return depthDifference || left.path.localeCompare(right.path);
  });
}
