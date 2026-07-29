import type { Session } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

export const maximumElectronCacheBytes = 512 * 1024 * 1024;
export const maximumRuntimeCacheBytes = 1024 * 1024 * 1024;
const cacheMaintenanceIntervalMs = 30 * 60 * 1000;
let cacheMaintenanceTimer: NodeJS.Timeout | null = null;

export type CacheLimitResult = {
  cleared: boolean;
  bytesBefore: number;
  limitBytes: number;
};

export async function enforceElectronCacheLimit(
  targetSession: Pick<Session, "clearCache" | "getCacheSize">,
  limitBytes = maximumElectronCacheBytes,
): Promise<CacheLimitResult> {
  const bytesBefore = await targetSession.getCacheSize();
  if (bytesBefore <= limitBytes) {
    return { cleared: false, bytesBefore, limitBytes };
  }
  await targetSession.clearCache();
  return { cleared: true, bytesBefore, limitBytes };
}

type CacheFile = {
  filePath: string;
  bytes: number;
  modifiedAt: number;
};

async function cacheFilesBelow(root: string): Promise<CacheFile[]> {
  const files: CacheFile[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.promises.lstat(entryPath);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        files.push({ filePath: entryPath, bytes: stat.size, modifiedAt: stat.mtimeMs });
      } catch {
        // Files can disappear while a runtime updates its cache.
      }
    }
  }
  return files;
}

export async function enforceRuntimeCacheLimit(
  runtimesRoot: string,
  limitBytes = maximumRuntimeCacheBytes,
): Promise<{ bytesBefore: number; bytesAfter: number; removedFiles: number }> {
  let runtimeEntries: fs.Dirent[];
  try {
    runtimeEntries = await fs.promises.readdir(runtimesRoot, { withFileTypes: true });
  } catch {
    return { bytesBefore: 0, bytesAfter: 0, removedFiles: 0 };
  }
  const cacheRoots = runtimeEntries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => path.join(runtimesRoot, entry.name, "uv-cache"));
  const files = (await Promise.all(cacheRoots.map(cacheFilesBelow))).flat();
  const bytesBefore = files.reduce((total, file) => total + file.bytes, 0);
  let bytesAfter = bytesBefore;
  let removedFiles = 0;
  if (bytesAfter <= limitBytes) return { bytesBefore, bytesAfter, removedFiles };

  files.sort((left, right) => left.modifiedAt - right.modifiedAt || left.filePath.localeCompare(right.filePath));
  for (const file of files) {
    if (bytesAfter <= limitBytes) break;
    try {
      await fs.promises.unlink(file.filePath);
      bytesAfter -= file.bytes;
      removedFiles += 1;
    } catch {
      // A running tool can hold or replace a cache file.
    }
  }
  return { bytesBefore, bytesAfter, removedFiles };
}

export async function startLocalCacheMaintenance(
  targetSession: Pick<Session, "clearCache" | "getCacheSize">,
  runtimesRoot: string,
  canPruneRuntimeCache: () => boolean,
  reportError: (error: unknown) => void,
): Promise<void> {
  const maintain = async () => {
    try {
      await enforceElectronCacheLimit(targetSession);
      if (canPruneRuntimeCache()) await enforceRuntimeCacheLimit(runtimesRoot);
    } catch (error) {
      reportError(error);
    }
  };
  await maintain();
  cacheMaintenanceTimer = setInterval(() => void maintain(), cacheMaintenanceIntervalMs);
  cacheMaintenanceTimer.unref();
}

export function stopLocalCacheMaintenance(): void {
  if (!cacheMaintenanceTimer) return;
  clearInterval(cacheMaintenanceTimer);
  cacheMaintenanceTimer = null;
}
