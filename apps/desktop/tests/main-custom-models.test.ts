import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

/**
 * A file that reports the catalog's declared size without occupying it.
 *
 * `modelDownloaded` only compares `stat.size` against the catalog, so the bytes
 * are never read. Truncating alone would be enough on a filesystem that leaves
 * the hole unallocated, but NTFS allocates every one of them unless the file is
 * marked sparse first — several gigabytes per run, for weights nothing opens.
 */
function writeSizedPlaceholder(filePath: string, bytes: number) {
  fs.writeFileSync(filePath, "");
  if (process.platform === "win32") {
    try {
      execFileSync("fsutil", ["sparse", "setflag", filePath], { stdio: "ignore" });
    } catch {
      // Not every volume supports sparse files. The truncate still produces a
      // correctly sized file; it just costs the disk what it says it does.
    }
  }
  fs.truncateSync(filePath, bytes);
}

/** An in-memory stand-in for the settings blob custom models persist into. */
function memoryStorage() {
  let customModels: unknown;
  let localQuants: Record<string, string> = {};
  return {
    readStoredCustomModels: () => customModels,
    writeStoredCustomModels: (value: unknown) => { customModels = value; },
    readLocalQuantSelections: () => localQuants,
    writeLocalQuantSelection: (id: string, quant: string | null) => {
      if (quant === null) delete localQuants[id];
      else localQuants[id] = quant;
      return localQuants;
    },
  };
}

function loadCustomModels(storage = memoryStorage()) {
  const module = loadTypeScriptModule(new URL("../src/main/customModels.ts", import.meta.url), {
    mocks: { "./settingsStorage": storage },
  });
  return { module, storage };
}

const sha = (fill: string) => fill.repeat(64).slice(0, 64);
const revision = "a".repeat(40);

/** A fetchJson that answers the two Hugging Face API calls addCustomModel makes. */
function fakeHub(files: Array<{ path: string; size: number; oid: string }>) {
  return async (url: string) => {
    if (url.endsWith(`/tree/${revision}`)) {
      return files.map((file) => ({ type: "file", path: file.path, lfs: { size: file.size, oid: file.oid } }));
    }
    return { sha: revision };
  };
}

test("a pasted reference resolves whether it is bare, a URL, or a deep link", () => {
  const { module } = loadCustomModels();
  assert.equal(module.parseHuggingFaceReference("TheBloke/Mistral-7B-GGUF"), "TheBloke/Mistral-7B-GGUF");
  assert.equal(module.parseHuggingFaceReference("https://huggingface.co/TheBloke/Mistral-7B-GGUF"), "TheBloke/Mistral-7B-GGUF");
  assert.equal(module.parseHuggingFaceReference("https://huggingface.co/TheBloke/Mistral-7B-GGUF/tree/main"), "TheBloke/Mistral-7B-GGUF");
  assert.equal(module.parseHuggingFaceReference("hf.co/TheBloke/Mistral-7B-GGUF"), "TheBloke/Mistral-7B-GGUF");
  // Only Hugging Face hosts are references; anything else is not.
  assert.equal(module.parseHuggingFaceReference("https://example.com/TheBloke/Mistral-7B-GGUF"), null);
  assert.equal(module.parseHuggingFaceReference("not a reference"), null);
  assert.equal(module.parseHuggingFaceReference(""), null);
});

test("quant labels are read from GGUF file names", () => {
  const { module } = loadCustomModels();
  assert.equal(module.quantLabelFromFileName("model-Q4_K_M.gguf"), "Q4_K_M");
  assert.equal(module.quantLabelFromFileName("model-IQ4_XS.gguf"), "IQ4_XS");
  assert.equal(module.quantLabelFromFileName("Model-UD-Q2_K_XL.gguf"), "UD-Q2_K_XL");
  assert.equal(module.quantLabelFromFileName("model-BF16.gguf"), "BF16");
  assert.equal(module.quantLabelFromFileName("model.bin"), null);
});

test("adding a model pins the current revision and records every digest", async () => {
  const { module } = loadCustomModels();
  const added = await module.addCustomModel("https://huggingface.co/Example/Tiny-GGUF", fakeHub([
    { path: "tiny-Q8_0.gguf", size: 900, oid: sha("b") },
    { path: "tiny-Q4_K_M.gguf", size: 500, oid: sha("c") },
    { path: "tiny-Q2_K.gguf", size: 300, oid: sha("d") },
    // Not weights: projector, split parts, and non-GGUF files stay out.
    { path: "mmproj-tiny.gguf", size: 100, oid: sha("e") },
    { path: "big-Q4_K_M-00001-of-00002.gguf", size: 100, oid: sha("f") },
    { path: "README.md", size: 10, oid: sha("9") },
  ]));

  assert.equal(added.id, "custom-example-tiny-gguf");
  assert.equal(added.kind, "chat");
  assert.equal(added.hfRevision, revision);
  // The 4-bit build leads; the rest keep their size order.
  assert.equal(added.quants.map((quant) => quant.quant).join(","), "Q4_K_M,Q2_K,Q8_0");
  assert.equal(added.quants[0].files[0].sha256, sha("c"));
  // Unreviewed weights never claim a thinking directive.
  assert.equal(added.reasoning, false);

  const { module: reread } = loadCustomModels();
  assert.equal(reread.listCustomModels().length, 0, "storage is per-instance in this test");
  assert.equal(module.listCustomModels().length, 1);
  assert.equal(module.customModel("custom-example-tiny-gguf")?.hfRepo, "Example/Tiny-GGUF");

  await assert.rejects(
    () => module.addCustomModel("Example/Tiny-GGUF", fakeHub([])),
    /already been added/,
  );
});

test("a repository with nothing runnable is refused with a reason", async () => {
  const { module } = loadCustomModels();
  await assert.rejects(
    () => module.addCustomModel("Example/Split-GGUF", fakeHub([
      { path: "big-Q4_K_M-00001-of-00002.gguf", size: 100, oid: sha("a") },
      { path: "big-Q4_K_M-00002-of-00002.gguf", size: 100, oid: sha("b") },
    ])),
    /split GGUF/,
  );
  await assert.rejects(
    () => module.addCustomModel("Example/No-GGUF", fakeHub([{ path: "weights.safetensors", size: 100, oid: sha("a") }])),
    /does not publish GGUF/,
  );
  // A catalog repo re-added by reference is already in the collection.
  await assert.rejects(
    () => module.addCustomModel("ornith-ai/Ornith-1.5-9B-GGUF", fakeHub([])),
    /already in the collection/,
  );
});

test("malformed stored entries are dropped rather than trusted", () => {
  const storage = memoryStorage();
  storage.writeStoredCustomModels([
    { id: "custom-good", hfRepo: "a/b", hfRevision: revision, quants: [{ quant: "Q4_K_M", files: [{ name: "x-Q4_K_M.gguf", bytes: 5, sha256: sha("a") }] }] },
    { id: "custom-bad-sha", hfRepo: "a/c", hfRevision: revision, quants: [{ quant: "Q4_K_M", files: [{ name: "x.gguf", bytes: 5, sha256: "nope" }] }] },
    { id: "custom-bad-rev", hfRepo: "a/d", hfRevision: "main", quants: [{ quant: "Q4_K_M", files: [{ name: "x.gguf", bytes: 5, sha256: sha("a") }] }] },
    { id: "custom-traversal", hfRepo: "a/e", hfRevision: revision, quants: [{ quant: "Q4_K_M", files: [{ name: "../x.gguf", bytes: 5, sha256: sha("a") }] }] },
    "garbage",
  ]);
  const { module } = loadCustomModels(storage);
  assert.equal(module.listCustomModels().map((model: { id: string }) => model.id).join(","), "custom-good");
});

test("removing a custom model forgets the entry", async () => {
  const { module } = loadCustomModels();
  await module.addCustomModel("Example/Tiny-GGUF", fakeHub([
    { path: "tiny-Q4_K_M.gguf", size: 500, oid: sha("c") },
  ]));
  assert.equal(module.removeCustomModel("custom-example-tiny-gguf")?.hfRepo, "Example/Tiny-GGUF");
  assert.equal(module.listCustomModels().length, 0);
  assert.equal(module.removeCustomModel("custom-example-tiny-gguf"), null);
});

test("the active quantization follows the choice only once it is on disk", async (t) => {
  const storage = memoryStorage();
  const localModels = loadTypeScriptModule(new URL("../src/main/localModels.ts", import.meta.url), {
    mocks: {
      "./settingsStorage": storage,
      "./localLlama": {},
      "./localSpeech": {},
      "./localVeil": {},
    },
  });
  const catalog = loadTypeScriptModule(new URL("../src/main/modelCatalog.ts", import.meta.url));
  const downloads = loadTypeScriptModule(new URL("../src/main/modelDownloads.ts", import.meta.url));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-quants-"));
  // `modelDownloaded` compares the file's size against the catalog's, so this
  // test writes weights at their real declared size — several gigabytes of
  // them. Registered before the first byte is written, and unconditional, so a
  // failing assertion leaves nothing behind either: without it every run of
  // the suite abandoned another few gigabytes in the system temp directory.
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const model = catalog.catalogModel("gemma4-e2b");
  const q4 = catalog.defaultQuant(model);
  const q6 = model.quants.find((quant: { quant: string }) => quant.quant === "Q6_K");

  // Nothing on disk: nothing to run, and the selection is the default.
  assert.equal(localModels.selectedQuant(model).quant, "Q4_K_M");
  assert.equal(localModels.activeQuant(dataRoot, model), null);
  assert.equal(localModels.selectedLocalChatModel(dataRoot, model.id), null);

  fs.mkdirSync(downloads.modelDirectory(dataRoot, model), { recursive: true });
  const q4Path = downloads.modelFilePath(dataRoot, model, q4.files[0]);
  writeSizedPlaceholder(q4Path, q4.files[0].bytes);
  assert.equal(localModels.activeQuant(dataRoot, model).quant, "Q4_K_M");
  assert.equal(localModels.selectedLocalChatModel(dataRoot, model.id)?.id, model.id);

  // Choosing Q6_K before downloading it keeps the working Q4_K_M running.
  storage.writeLocalQuantSelection(model.id, "Q6_K");
  assert.equal(localModels.selectedQuant(model).quant, "Q6_K");
  assert.equal(localModels.activeQuant(dataRoot, model).quant, "Q4_K_M");

  // Once Q6_K is on disk the choice takes over, including the weights path.
  const q6Path = downloads.modelFilePath(dataRoot, model, q6.files[0]);
  writeSizedPlaceholder(q6Path, q6.files[0].bytes);
  assert.equal(localModels.activeQuant(dataRoot, model).quant, "Q6_K");
  assert.equal(localModels.localModelWeightsPath(dataRoot, model), q6Path);

  const rows = await localModels.listLocalModels(dataRoot, "chat");
  const row = rows.find((entry: { id: string }) => entry.id === model.id);
  assert.equal(row.selectedQuant, "Q6_K");
  assert.equal(row.downloaded, true);
  assert.equal(
    row.quants.filter((quant: { downloaded: boolean }) => quant.downloaded).map((quant: { quant: string }) => quant.quant).sort().join(","),
    "Q4_K_M,Q6_K",
  );

  // A quantization counts as here only when every file it lists is. The
  // dictation weights are the multi-file case in the catalog: llama-server
  // will not load the audio encoder without its projector beside it.
  const asr = catalog.catalogModel("qwen3-asr-0.6b");
  const asrQuant = catalog.defaultQuant(asr);
  fs.mkdirSync(downloads.modelDirectory(dataRoot, asr), { recursive: true });
  const [asrWeights, asrProjector] = asrQuant.files;
  writeSizedPlaceholder(downloads.modelFilePath(dataRoot, asr, asrWeights), asrWeights.bytes);
  assert.equal(localModels.activeQuant(dataRoot, asr), null);
  writeSizedPlaceholder(downloads.modelFilePath(dataRoot, asr, asrProjector), asrProjector.bytes);
  assert.equal(localModels.activeQuant(dataRoot, asr).quant, asrQuant.quant);

  // Dense models draft from a head inside their own weights, so there is no
  // separate file to name; drafting off says nothing at all.
  const dense = catalog.catalogModel("qwen38-27b");
  assert.equal(localModels.localModelMtp(dataRoot, dense, true)?.draftFile, null);
  assert.equal(localModels.localModelMtp(dataRoot, dense, false), null);
  // Mixture-of-experts keep their nextn tensors; we still do not draft from them.
  assert.equal(localModels.localModelMtp(dataRoot, catalog.catalogModel("ornith-1.5-35b-a3b"), true), null);
  assert.equal(localModels.localModelMtp(dataRoot, model, true), null);
});
