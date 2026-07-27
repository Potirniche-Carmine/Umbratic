import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { FileSearchResult } from "./types";
import { isRecord } from "./utils";

function desktopCoreBinaryPath(): string {
  const filename = process.platform === "win32" ? "umbratic-desktop-core.exe" : "umbratic-desktop-core";
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const packagedBinary = path.join(resourcesPath, "desktop-core", filename);
    try {
      if (fs.statSync(packagedBinary).isFile()) return packagedBinary;
    } catch {
      // Electron also defines resourcesPath in development, where this packaged binary is absent.
    }
  }
  return path.resolve(__dirname, "../../../../target/release", filename);
}

function isFileSearchResult(value: unknown): value is FileSearchResult {
  return isRecord(value)
    && typeof value.path === "string"
    && typeof value.name === "string"
    && (value.match === "path" || value.match === "content");
}

const activeSearches = new Map<string, ChildProcessWithoutNullStreams>();

export function cancelRootSearch(rootPath: string): void {
  const key = path.resolve(rootPath);
  const child = activeSearches.get(key);
  if (!child) return;
  activeSearches.delete(key);
  try {
    child.kill();
  } catch {
    /* already exited */
  }
}

export async function searchRootFiles(rootPath: string, query: string, limit: number): Promise<FileSearchResult[]> {
  const key = path.resolve(rootPath);
  cancelRootSearch(key);
  return new Promise((resolve, reject) => {
    const child = spawn(
      desktopCoreBinaryPath(),
      ["search-files", `--root=${rootPath}`, `--query=${query}`, `--limit=${limit}`],
      { windowsHide: true },
    );
    activeSearches.set(key, child);
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let settled = false;
    const timeout = setTimeout(() => {
      cancelRootSearch(key);
      finish(new Error("Native file search timed out."));
    }, 15_000);

    const finish = (error?: Error, results?: FileSearchResult[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (activeSearches.get(key) === child) activeSearches.delete(key);
      if (error) reject(error);
      else resolve(results ?? []);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const total = chunks.reduce((sum, part) => sum + part.length, 0);
      if (total > 4 * 1024 * 1024) {
        cancelRootSearch(key);
        finish(new Error("Native file search exceeded the output budget."));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors.push(chunk);
    });
    child.on("error", (error) => {
      finish(new Error(`Native file search failed: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(`Native file search failed: ${Buffer.concat(errors).toString("utf8").trim() || `exit ${code ?? "unknown"}`}`));
        return;
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!Array.isArray(parsed) || !parsed.every(isFileSearchResult)) throw new Error("invalid native result shape");
        finish(undefined, parsed);
      } catch (cause) {
        finish(new Error(`Native file search returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`));
      }
    });
  });
}
