import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

/** A settings blob with no custom models in it, unless a test puts one there. */
function memoryStorage(customModels: unknown = []) {
  return {
    readStoredCustomModels: () => customModels,
    writeStoredCustomModels: () => undefined,
    readLocalQuantSelections: () => ({}),
    writeLocalQuantSelection: () => ({}),
  };
}

function loadDiscovered(storage = memoryStorage()) {
  return loadTypeScriptModule(new URL("../src/main/discoveredModels.ts", import.meta.url), {
    mocks: {
      electron: { app: { getPath: () => os.tmpdir() } },
      "./settingsStorage": storage,
    },
  });
}

/** A data root with the given files laid out under cache/models. */
function dataRootWith(files: Record<string, number>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-models-"));
  for (const [relative, bytes] of Object.entries(files)) {
    const target = path.join(root, "cache", "models", relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.alloc(bytes));
  }
  return root;
}

test("a GGUF dropped into the models folder becomes a model", () => {
  const module = loadDiscovered();
  const root = dataRootWith({ "Qwen3-Coder-30B-Q4_K_M.gguf": 2048 });
  const [model] = module.listDiscoveredModels(root);
  assert.ok(model, "the loose file should be listed");
  assert.equal(model.displayName, "Qwen3 Coder 30B");
  assert.equal(model.discovered, true);
  assert.equal(model.quants.map((quant: { quant: string }) => quant.quant).join(","), "Q4_K_M");
  assert.equal(model.quants[0].files[0].bytes, 2048);
  // Nothing published these bytes, so there is nothing to verify them against.
  assert.equal(model.quants[0].files[0].sha256, "");
  assert.equal(module.discoveredModel(root, model.id)?.id, model.id);
});

test("files that differ only by quantization collapse into one model, smallest first after the 4-bit lead", () => {
  const module = loadDiscovered();
  const root = dataRootWith({
    "Mistral-Small-Q8_0.gguf": 4096,
    "Mistral-Small-Q4_K_M.gguf": 2048,
    "Mistral-Small-Q6_K.gguf": 3072,
  });
  const models = module.listDiscoveredModels(root);
  assert.equal(models.length, 1);
  assert.equal(models[0].displayName, "Mistral Small");
  assert.equal(models[0].quants.map((quant: { quant: string }) => quant.quant).join(","), "Q4_K_M,Q6_K,Q8_0");
});

test("a folder somebody made is read, and the folders this app downloaded into are not", () => {
  const module = loadDiscovered(memoryStorage([{ id: "custom-someone-model" }]));
  const root = dataRootWith({
    "my-models/Ministral-8B-Q4_K_M.gguf": 1024,
    // A catalog id and a pinned custom id: both are ours, and both are already
    // in the list from their own source.
    "qwen38-27b/Qwen3.8-27B-Q4_K_M.gguf": 1024,
    "custom-someone-model/whatever-Q4_K_M.gguf": 1024,
  });
  const models = module.listDiscoveredModels(root);
  assert.equal(models.map((model: { displayName: string }) => model.displayName).join(","), "Ministral 8B");
  // The files stay where they were put, so the model must point at that folder.
  assert.equal(models[0].localDirectory, path.join(root, "cache", "models", "my-models"));
});

test("projectors, drafting heads, split parts, and half-finished downloads are not models", () => {
  const module = loadDiscovered();
  const root = dataRootWith({
    "mmproj-something-Q8_0.gguf": 512,
    "mtp-something-Q4_K_M.gguf": 512,
    "Huge-Model-Q4_K_M-00001-of-00003.gguf": 512,
    "Half-Done-Q4_K_M.gguf.partial": 512,
    "notes.txt": 32,
  });
  assert.equal(module.listDiscoveredModels(root).length, 0);
});

test("a models folder that is not there yet reads as empty rather than throwing", () => {
  const module = loadDiscovered();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-empty-"));
  assert.equal(module.listDiscoveredModels(root).length, 0);
  assert.equal(module.discoveredModel(root, "local-anything"), null);
});
