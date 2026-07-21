import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

test("native desktop file search falls back from development resources and preserves ranking", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-native-search-"));
  const originalResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  Object.defineProperty(process, "resourcesPath", { configurable: true, value: root });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "hidden"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "runner.ts"), "export const runner = 'native';\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "other.ts"), "// runner appears in content\n", "utf8");
  fs.writeFileSync(path.join(root, "node_modules", "hidden", "runner.ts"), "runner\n", "utf8");
  try {
    const search = loadTypeScriptModule(new URL("../src/main/fileSearch.ts", import.meta.url).pathname, { cache: new Map() });
    const results = await search.searchRootFiles(root, "runner", 10);
    assert.deepEqual(JSON.parse(JSON.stringify(results.map((result: { path: string; match: string }) => [result.path, result.match]))), [
      ["src/runner.ts", "path"],
      ["src/other.ts", "content"],
    ]);
  } finally {
    if (originalResourcesPath) {
      Object.defineProperty(process, "resourcesPath", originalResourcesPath);
    } else {
      delete process.resourcesPath;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
