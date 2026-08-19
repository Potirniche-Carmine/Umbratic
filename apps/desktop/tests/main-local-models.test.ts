import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const catalog = loadTypeScriptModule(new URL("../src/main/modelCatalog.ts", import.meta.url));
const hardware = loadTypeScriptModule(new URL("../src/main/hardware.ts", import.meta.url));
const downloads = loadTypeScriptModule(new URL("../src/main/modelDownloads.ts", import.meta.url), {
  mocks: { electron: { app: { getPath: () => os.tmpdir() } } },
});

test("every catalog quantization pins a revision and a checksum per file", () => {
  assert.ok(catalog.modelCatalog.length > 0);
  for (const model of catalog.modelCatalog) {
    assert.match(model.hfRevision, /^[0-9a-f]{40}$/, `${model.id} must pin an immutable commit`);
    assert.ok(model.quants.length > 0, `${model.id} must offer at least one quantization`);
    assert.ok(model.minRamGB > 0);
    for (const quant of model.quants) {
      assert.ok(quant.files.length > 0, `${model.id}@${quant.quant} must name at least one file`);
      for (const file of quant.files) {
        assert.match(file.sha256, /^[0-9a-f]{64}$/, `${model.id}/${file.name} must record a SHA-256`);
        assert.ok(file.bytes > 0);
        // The URL must be revision-pinned, never a branch: a branch can be
        // moved under the recorded digest.
        const url = catalog.catalogFileUrl(model, file);
        assert.ok(url.startsWith(`https://huggingface.co/${model.hfRepo}/resolve/${model.hfRevision}/`), url);
      }
    }
  }
});

test("dictation models ship their projector alongside the weights", () => {
  for (const model of catalog.catalogModels("dictation")) {
    // ASR accuracy falls off sharply below Q8_0, so the catalog offers exactly
    // one quantization of a dictation model.
    assert.equal(model.quants.length, 1, `${model.id} offers only Q8_0`);
    const [quant] = model.quants;
    assert.equal(quant.quant, "Q8_0");
    assert.equal(quant.files.length, 2, `${model.id} needs weights and an mmproj`);
    assert.ok(quant.files.some((file) => file.name.startsWith("mmproj-")));
    assert.ok(quant.files.every((file) => file.name.includes("Q8_0")));
  }
});

test("every catalog id is unique and every chat quantization is one weights file, plus at most an MTP head", () => {
  const ids = catalog.modelCatalog.map((model) => model.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate catalog id");
  for (const model of catalog.catalogModels("chat")) {
    const labels = model.quants.map((quant) => quant.quant);
    assert.equal(new Set(labels).size, labels.length, `${model.id} repeats a quant label`);
    for (const quant of model.quants) {
      const weights = quant.files.filter((file) => !/^mtp-/i.test(file.name));
      assert.equal(weights.length, 1, `${model.id}@${quant.quant} should be a single weights GGUF`);
      assert.equal(catalog.quantWeightsFile(quant), weights[0]);
      assert.ok(
        weights[0].name.toUpperCase().includes(quant.quant.toUpperCase()),
        `${model.id}@${quant.quant} label should match its file name`,
      );
      // A separate head only travels with a dense model that we draft from.
      const head = catalog.quantMtpFile(quant);
      if (head) assert.equal(model.mtp, true, `${model.id} ships an MTP head it does not claim`);
    }
  }
});

test("MTP is for dense models; mixture-of-experts do not draft", () => {
  for (const id of ["gemma4-e2b", "gemma4-e4b", "gemma4-e4b-uncensored", "ornith-1.5-35b-a3b"]) {
    const model = catalog.catalogModel(id);
    assert.notEqual(model.mtp, true, `${id} is mixture-of-experts and should not draft`);
    for (const quant of model.quants) {
      assert.equal(catalog.quantMtpFile(quant), null, `${id} should not download a drafting head`);
    }
  }
  for (const id of ["gemma4-12b", "qwen38-27b", "qwen38-27b-abliterated"]) {
    assert.equal(catalog.catalogModel(id).mtp, true, `${id} is dense and should draft`);
  }
});

test("the recommendation follows installed memory", () => {
  assert.equal(hardware.recommendedModelId("chat", 8), "gemma4-e2b");
  assert.equal(hardware.recommendedModelId("chat", 11.9), "gemma4-e2b");
  assert.equal(hardware.recommendedModelId("chat", 12), "gemma4-e4b");
  assert.equal(hardware.recommendedModelId("chat", 15.9), "gemma4-e4b");
  assert.equal(hardware.recommendedModelId("chat", 16), "gemma4-12b");
  assert.equal(hardware.recommendedModelId("chat", 31.9), "gemma4-12b");
  // 32 GB is enough for the 27B's ~17 GB of weights plus a long context's KV
  // cache, and the 27B is the only model here whose tool calling holds up over
  // a long agentic run — so it is what a 48 GB machine is offered.
  assert.equal(hardware.recommendedModelId("chat", 32), "qwen38-27b");
  assert.equal(hardware.recommendedModelId("chat", 48), "qwen38-27b");
  assert.equal(hardware.recommendedModelId("chat", 128), "qwen38-27b");

  assert.equal(hardware.recommendedModelId("dictation", 8), "qwen3-asr-0.6b");
  assert.equal(hardware.recommendedModelId("dictation", 16), "qwen3-asr-1.7b");
});

// The suggestion is read off the catalog's order, so the catalog has to keep
// that order meaningful: the most capable safety-trained model a machine runs
// comfortably is what it is offered, and the uncensored builds trail.
test("the recommendation is the most capable safety-trained model the machine runs comfortably", () => {
  for (const ram of [4, 8, 12, 16, 24, 32, 64]) {
    const suggested = catalog.catalogModel(hardware.recommendedModelId("chat", ram));
    const fitting = catalog.catalogModels("chat").filter((model) => !model.uncensored && model.minRamGB <= ram);
    const expected = fitting[fitting.length - 1] ?? catalog.catalogModels("chat")[0];
    assert.equal(suggested.id, expected.id, `at ${ram} GB`);
  }
  // Ornith is offered at the same memory as the 27B and listed ahead of it, so
  // the 27B — the one this app has run long agentic sessions on — stays the
  // suggestion at 32 GB while Ornith sits one row away.
  assert.equal(hardware.recommendedModelId("chat", 32), "qwen38-27b");
  assert.equal(catalog.catalogModel("ornith-1.5-35b-a3b").minRamGB, 32);
});

test("memory fit is quant-aware and never hides a row", () => {
  const qwen = catalog.catalogModel("qwen38-27b");
  const q4 = catalog.modelQuant(qwen, "Q4_K_M");
  const q8 = catalog.modelQuant(qwen, "Q8_0");
  const q3 = catalog.modelQuant(qwen, "Q3_K_M");
  // The default quantization wants exactly what the catalog says.
  assert.equal(hardware.neededRamGB(qwen, q4), 32);
  // The others scale with their bytes: a Q8_0 that is 1.7x the size wants
  // 1.7x the room, and the Q3_K_M wants less.
  assert.equal(hardware.neededRamGB(qwen, q8), Math.ceil(32 * (q8.files[0].bytes / q4.files[0].bytes)));
  assert.ok(hardware.neededRamGB(qwen, q3) < 32);

  assert.equal(hardware.memoryFit(qwen, q4, 32), "comfortable");
  assert.equal(hardware.memoryFit(qwen, q4, 64), "comfortable");
  // Three quarters of the comfortable figure is about where the weights
  // themselves still fit: 24 GB holds 17 GB of weights, tightly.
  assert.equal(hardware.memoryFit(qwen, q4, 24), "tight");
  assert.equal(hardware.memoryFit(qwen, q4, 16), "exceeds");
  // Picking a heavier quantization moves the verdict on the same machine.
  assert.equal(hardware.memoryFit(qwen, q8, 32), "exceeds");
  assert.equal(hardware.memoryFit(qwen, q3, hardware.neededRamGB(qwen, q3)), "comfortable");
});

test("every chat model says what it is for, not just how big it is", () => {
  // Size answers "will this run". It does not answer "should I pick this",
  // and the difference between these rows is whether their tool calling holds
  // up — which no number in the list has ever said.
  for (const model of catalog.catalogModels("chat")) {
    assert.ok(model.role, `${model.id} should carry a role`);
    assert.ok(model.role.label.length > 0 && model.role.label.length <= 20, `${model.id} role tag stays short`);
    assert.ok(model.role.detail.length > 40, `${model.id} role should explain itself`);
  }
  const byId = (id: string) => catalog.catalogModels("chat").find((model) => model.id === id);
  // The small ones say plainly that agentic work is not what they are for.
  for (const id of ["gemma4-e2b", "gemma4-e4b", "gemma4-e4b-uncensored"]) {
    assert.match(byId(id).role.detail, /[Tt]ool calling is inconsistent|inconsistent/);
  }
  // And the one that is says so.
  assert.equal(byId("qwen38-27b").role.label, "Agentic");
  // Dictation weights are chosen by size alone, so they carry nothing to say.
  for (const model of catalog.catalogModels("dictation")) {
    assert.equal(model.role, undefined);
  }
});

// A recommendation is what someone gets without choosing, so it never lands on
// a build with the safety training removed.
test("uncensored models are offered but never recommended", () => {
  const uncensored = catalog.catalogModels("chat").filter((model) => model.uncensored);
  assert.ok(uncensored.length >= 2, "the catalog carries uncensored options");
  for (const ram of [4, 8, 12, 16, 24, 32, 64, 128]) {
    const suggested = catalog.catalogModel(hardware.recommendedModelId("chat", ram));
    assert.notEqual(suggested.uncensored, true, `recommended at ${ram} GB must not be uncensored`);
  }
});

test("totalRamGB reads installed memory in binary gigabytes", () => {
  assert.equal(hardware.totalRamGB(16 * 2 ** 30), 16);
});

// The runtime's own device list is the honest answer: a machine whose Vulkan
// loader is missing reports nothing here for the same reason inference would
// fall back to the processor.
test("the accelerator is read from the runtime's device list", () => {
  // Verbatim from `llama-server --list-devices` on the packaged b10419 build.
  const vulkan = hardware.parseAcceleratorDevices(
    "Available devices:\n  Vulkan0: AMD Radeon RX 9070 XT (16304 MiB, 15416 MiB free)",
  );
  assert.equal(vulkan.accelerator, "Vulkan");
  assert.equal(vulkan.device, "AMD Radeon RX 9070 XT");
  // The heading is not a device row.
  assert.equal(hardware.parseAcceleratorDevices("Available devices:").accelerator, null);

  const metal = hardware.parseAcceleratorDevices("  Metal0: Apple M2 Pro (21845 MiB, 21845 MiB free)");
  assert.equal(metal.accelerator, "Metal");
  assert.equal(metal.device, "Apple M2 Pro");

  // The CPU is always listed and is not an accelerator.
  const cpuOnly = hardware.parseAcceleratorDevices([
    "Available devices:",
    "  CPU: 13th Gen Intel Core i7-13700H (32000 MiB)",
  ].join("\n"));
  assert.equal(cpuOnly.accelerator, null);
  assert.equal(hardware.parseAcceleratorDevices("").accelerator, null);
});

test("system quality reflects the machine, not the chosen model", () => {
  assert.equal(hardware.systemQuality(32, "Vulkan"), "optimal");
  assert.equal(hardware.systemQuality(16, "Metal"), "optimal");
  assert.equal(hardware.systemQuality(8, "Vulkan"), "good");
  // No accelerator is the case worth naming: it is invisible otherwise.
  assert.equal(hardware.systemQuality(128, null), "cpu");
});

test("a quantization counts as downloaded only when every file is present at its exact size", () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-models-"));
  const model = catalog.catalogModel("qwen3-asr-0.6b");
  const quant = catalog.defaultQuant(model);
  assert.equal(downloads.modelDownloaded(dataRoot, model, quant), false);

  const directory = downloads.modelDirectory(dataRoot, model);
  fs.mkdirSync(directory, { recursive: true });
  for (const file of quant.files) {
    fs.writeFileSync(downloads.modelFilePath(dataRoot, model, file), "");
  }
  // Present but truncated is not downloaded.
  assert.equal(downloads.modelDownloaded(dataRoot, model, quant), false);

  assert.ok(directory.split(path.sep).includes("cache"));
  assert.ok(directory.endsWith(path.join("models", model.id)));
});

test("a download writes through a .partial file and verifies before renaming", () => {
  const source = fs.readFileSync(new URL("../src/main/modelDownloads.ts", import.meta.url), "utf8");
  assert.match(source, /const partialPath = `\$\{finalPath\}\.partial`/);
  assert.match(source, /crypto\.createHash\("sha256"\)/);
  assert.match(source, /digest !== file\.sha256/);
  assert.match(source, /fs\.rmSync\(partialPath, \{ force: true \}\)/);
  assert.match(source, /fs\.renameSync\(partialPath, finalPath\)/);
  // Parallel ranged transfer with a resume ledger, and only over HTTPS.
  assert.match(source, /const rangeConnections = \d/);
  assert.match(source, /Range: `bytes=\$\{start\}-\$\{end\}`/);
  assert.match(source, /statusCode !== 206/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /redirected to an insecure address/);
  assert.doesNotMatch(source, /require\("node:http"\)|from "node:http"/);
});
