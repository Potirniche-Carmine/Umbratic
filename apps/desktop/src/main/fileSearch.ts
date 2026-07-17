import { execFile } from "node:child_process";
import * as path from "node:path";

import type { FileSearchResult } from "./types";
import { isRecord } from "./utils";

function desktopCoreBinaryPath(): string {
  const filename = process.platform === "win32" ? "umbratic-desktop-core.exe" : "umbratic-desktop-core";
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return resourcesPath
    ? path.join(resourcesPath, "desktop-core", filename)
    : path.resolve(__dirname, "../../../../target/release", filename);
}

function isFileSearchResult(value: unknown): value is FileSearchResult {
  return isRecord(value)
    && typeof value.path === "string"
    && typeof value.name === "string"
    && (value.match === "path" || value.match === "content");
}

export async function searchRootFiles(rootPath: string, query: string, limit: number): Promise<FileSearchResult[]> {
  return new Promise((resolve, reject) => {
    execFile(
      desktopCoreBinaryPath(),
      ["search-files", `--root=${rootPath}`, `--query=${query}`, `--limit=${limit}`],
      { windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Native file search failed: ${String(stderr).trim() || error.message}`));
          return;
        }
        try {
          const parsed: unknown = JSON.parse(String(stdout));
          if (!Array.isArray(parsed) || !parsed.every(isFileSearchResult)) throw new Error("invalid native result shape");
          resolve(parsed);
        } catch (cause) {
          reject(new Error(`Native file search returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`));
        }
      },
    );
  });
}
