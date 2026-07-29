import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const cache = loadTypeScriptModule(
  new URL("../src/main/cacheMaintenance.ts", import.meta.url),
  { cache: new Map() },
);

test("cache maintenance clears the Electron cache above its limit", async () => {
  let clears = 0;
  const result = await cache.enforceElectronCacheLimit({
    getCacheSize: async () => 101,
    clearCache: async () => { clears += 1; },
  }, 100);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    cleared: true,
    bytesBefore: 101,
    limitBytes: 100,
  });
  assert.equal(clears, 1);
});

test("cache maintenance keeps a cache at or below its limit", async () => {
  let clears = 0;
  const result = await cache.enforceElectronCacheLimit({
    getCacheSize: async () => 100,
    clearCache: async () => { clears += 1; },
  }, 100);
  assert.equal(result.cleared, false);
  assert.equal(clears, 0);
});

test("runtime cache maintenance removes the oldest files above its limit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runtime-cache-"));
  const first = path.join(root, "workspace-a", "uv-cache", "first.bin");
  const second = path.join(root, "workspace-b", "uv-cache", "second.bin");
  fs.mkdirSync(path.dirname(first), { recursive: true });
  fs.mkdirSync(path.dirname(second), { recursive: true });
  fs.writeFileSync(first, "123456");
  fs.writeFileSync(second, "abcdef");
  const old = new Date("2026-01-01T00:00:00.000Z");
  const recent = new Date("2026-01-02T00:00:00.000Z");
  fs.utimesSync(first, old, old);
  fs.utimesSync(second, recent, recent);

  try {
    const result = await cache.enforceRuntimeCacheLimit(root, 6);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
      bytesBefore: 12,
      bytesAfter: 6,
      removedFiles: 1,
    });
    assert.equal(fs.existsSync(first), false);
    assert.equal(fs.existsSync(second), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
