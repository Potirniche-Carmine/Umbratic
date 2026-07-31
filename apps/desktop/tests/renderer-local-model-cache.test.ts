import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const cache = loadTypeScriptModule(
  new URL("../src/renderer/localModelCache.ts", import.meta.url),
);

test("local model discovery keeps a normalized session cache and the current selection", () => {
  cache.clearCachedLocalModelsForTest();
  cache.writeCachedLocalModels("http://127.0.0.1:11434/", ["qwen3", "qwen3", " gemma3 "]);

  assert.deepEqual(
    Array.from(cache.readCachedLocalModels("http://127.0.0.1:11434", "llama3")),
    ["llama3", "qwen3", "gemma3"],
  );
  assert.equal(cache.localModelCacheKey("http://127.0.0.1:11434///"), "http://127.0.0.1:11434");
});
