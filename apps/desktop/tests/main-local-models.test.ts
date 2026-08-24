import assert from "node:assert/strict";
import crypto from "node:crypto";
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
  for (const id of ["gemma4-12b", "qwen38-27b", "qwen38-27b-obliterated"]) {
    assert.equal(catalog.catalogModel(id).mtp, true, `${id} is dense and should draft`);
  }
});

test("the recommendation follows the memory a model would run in", () => {
  assert.equal(hardware.recommendedModelId("chat", { ramGB: 8, vramGB: null }), "gemma4-e2b");
  assert.equal(hardware.recommendedModelId("chat", { ramGB: 11.9, vramGB: null }), "gemma4-e2b");
  assert.equal(hardware.recommendedModelId("chat", { ramGB: 12, vramGB: null }), "gemma4-e4b");
  assert.equal(hardware.recommendedModelId("chat", { ramGB: 15.9, vramGB: null }), "gemma4-e4b");
  assert.equal(hardware.recommendedModelId("chat", { ramGB: 16, vramGB: null }), "gemma4-12b");
  assert.equal(hardware.recommendedModelId("chat", { ramGB: 31.9, vramGB: null }), "gemma4-12b");
  // 32 GB is enough for the 27B's ~17 GB of weights plus a long context's KV
  // cache, and the 27B is the only model here whose tool calling holds up over
  // a long agentic run — so it is what a 48 GB machine is offered.
  assert.equal(hardware.recommendedModelId("chat", { ramGB: 32, vramGB: null }), "qwen38-27b");
  assert.equal(hardware.recommendedModelId("chat", { ramGB: 48, vramGB: null }), "qwen38-27b");
  assert.equal(hardware.recommendedModelId("chat", { ramGB: 128, vramGB: null }), "qwen38-27b");

  assert.equal(hardware.recommendedModelId("dictation", { ramGB: 8, vramGB: null }), "qwen3-asr-0.6b");
  assert.equal(hardware.recommendedModelId("dictation", { ramGB: 16, vramGB: null }), "qwen3-asr-1.7b");
});

// The suggestion is read off the catalog's order, so the catalog has to keep
// that order meaningful: the most capable safety-trained model a machine runs
// comfortably is what it is offered, and the uncensored builds trail.
test("the recommendation is the most capable safety-trained model the machine runs comfortably", () => {
  for (const ram of [4, 8, 12, 16, 24, 32, 64]) {
    const suggested = catalog.catalogModel(hardware.recommendedModelId("chat", { ramGB: ram, vramGB: null }));
    const fitting = catalog.catalogModels("chat").filter((model) => !model.uncensored && model.minRamGB <= ram);
    const expected = fitting[fitting.length - 1] ?? catalog.catalogModels("chat")[0];
    assert.equal(suggested.id, expected.id, `at ${ram} GB`);
  }
  // Ornith is offered at the same memory as the 27B and listed ahead of it, so
  // the 27B — the one this app has run long agentic sessions on — stays the
  // suggestion at 32 GB while Ornith sits one row away.
  assert.equal(hardware.recommendedModelId("chat", { ramGB: 32, vramGB: null }), "qwen38-27b");
  assert.equal(catalog.catalogModel("ornith-1.5-35b-a3b").minRamGB, 32);
});

test("memory fit is quant-aware and never hides a row", () => {
  const qwen = catalog.catalogModel("qwen38-27b");
  const q4 = catalog.modelQuant(qwen, "Q4_K_M");
  const q8 = catalog.modelQuant(qwen, "Q8_0");
  // Nothing below four bits is offered any more, so the rung that wants less
  // room than the default is the obliterated build's importance-weighted one.
  const obliterated = catalog.catalogModel("qwen38-27b-obliterated");
  const smaller = catalog.modelQuant(obliterated, "IQ4_XS");
  // The default quantization wants exactly what the catalog says.
  assert.equal(hardware.neededRamGB(qwen, q4), 32);
  // The others scale with their bytes: a Q8_0 that is 1.7x the size wants
  // 1.7x the room, and a rung below the default wants less.
  assert.equal(hardware.neededRamGB(qwen, q8), Math.ceil(32 * (q8.files[0].bytes / q4.files[0].bytes)));
  assert.ok(hardware.neededRamGB(obliterated, smaller) < obliterated.minRamGB);

  assert.equal(hardware.memoryFit(qwen, q4, { ramGB: 32, vramGB: null }), "comfortable");
  assert.equal(hardware.memoryFit(qwen, q4, { ramGB: 64, vramGB: null }), "comfortable");
  // Three quarters of the comfortable figure is about where the weights
  // themselves still fit: 24 GB holds 17 GB of weights, tightly.
  assert.equal(hardware.memoryFit(qwen, q4, { ramGB: 24, vramGB: null }), "tight");
  assert.equal(hardware.memoryFit(qwen, q4, { ramGB: 16, vramGB: null }), "exceeds");
  // Picking a heavier quantization moves the verdict on the same machine.
  assert.equal(hardware.memoryFit(qwen, q8, { ramGB: 32, vramGB: null }), "exceeds");
  assert.equal(
    hardware.memoryFit(obliterated, smaller, { ramGB: hardware.neededRamGB(obliterated, smaller), vramGB: null }),
    "comfortable",
  );
});

// The case this could not see before: a large machine behind a small card.
// Installed memory alone called the 27B comfortable on a box that would run
// most of it on the processor.
test("a dedicated card is what the model is weighed against, with RAM behind it", () => {
  const qwen = catalog.catalogModel("qwen38-27b");
  const q4 = catalog.modelQuant(qwen, "Q4_K_M");
  assert.equal(hardware.neededRamGB(qwen, q4), 32);

  // 64 GB of RAM behind an 8 GB card: it runs, spilling onto the processor,
  // and saying "comfortable" here would be a promise about speed the machine
  // cannot keep.
  assert.equal(hardware.memoryFit(qwen, q4, { ramGB: 64, vramGB: 8 }), "tight");
  // The same card in a machine with no memory to fall back on cannot.
  assert.equal(hardware.memoryFit(qwen, q4, { ramGB: 8, vramGB: 8 }), "exceeds");
  // A card that holds the whole model is the comfortable case.
  assert.equal(hardware.memoryFit(qwen, q4, { ramGB: 64, vramGB: 32 }), "comfortable");

  // And the suggestion follows the card, not the box around it.
  assert.equal(
    hardware.recommendedModelId("chat", { ramGB: 64, vramGB: 8 }),
    hardware.recommendedModelId("chat", { ramGB: 8, vramGB: null }),
  );
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
    const suggested = catalog.catalogModel(hardware.recommendedModelId("chat", { ramGB: ram, vramGB: null }));
    assert.notEqual(suggested.uncensored, true, `recommended at ${ram} GB must not be uncensored`);
  }
});

test("totalRamGB reads installed memory in binary gigabytes", () => {
  assert.equal(hardware.totalRamGB(16 * 2 ** 30), 16);
});

// The runtime's own device list is the honest answer: a machine whose Vulkan
// loader is missing reports nothing here for the same reason inference would
// fall back to the processor.
test("the accelerator and its memory are read from the runtime's device list", () => {
  // Verbatim from `llama-server --list-devices` on the packaged b10419 build.
  const vulkan = hardware.parseAcceleratorDevices(
    "Available devices:\n  Vulkan0: AMD Radeon RX 9070 XT (16304 MiB, 15416 MiB free)",
  );
  assert.equal(vulkan.length, 1);
  assert.equal(vulkan[0].backend, "Vulkan");
  assert.equal(vulkan[0].name, "AMD Radeon RX 9070 XT");
  assert.equal(vulkan[0].unified, false);
  assert.equal(Math.round(vulkan[0].memoryGB ?? 0), 16);
  // The heading is not a device row.
  assert.equal(hardware.parseAcceleratorDevices("Available devices:").length, 0);

  // Metal's figure is a window onto installed RAM, not memory of its own, so
  // it must never be added to it.
  const metal = hardware.parseAcceleratorDevices("  Metal0: Apple M2 Pro (21845 MiB, 21845 MiB free)");
  assert.equal(metal[0].backend, "Metal");
  assert.equal(metal[0].name, "Apple M2 Pro");
  assert.equal(metal[0].unified, true);
  assert.equal(hardware.acceleratorMemoryGB(metal), null);

  // The CPU is always listed and is not an accelerator.
  const cpuOnly = hardware.parseAcceleratorDevices([
    "Available devices:",
    "  CPU: 13th Gen Intel Core i7-13700H (32000 MiB)",
  ].join("\n"));
  assert.equal(cpuOnly.length, 0);
  assert.equal(hardware.parseAcceleratorDevices("").length, 0);
  assert.equal(hardware.acceleratorMemoryGB([]), null);
});

test("dedicated cards add up and a device that reported nothing is unknown, not zero", () => {
  const pair = hardware.parseAcceleratorDevices([
    "Available devices:",
    "  Vulkan0: NVIDIA GeForce RTX 4070 (12282 MiB, 11000 MiB free)",
    "  Vulkan1: NVIDIA GeForce RTX 4070 (12282 MiB, 12000 MiB free)",
    "  CPU: 13th Gen Intel Core i7-13700H (32000 MiB)",
  ].join("\n"));
  assert.equal(pair.length, 2);
  assert.equal(Math.round(hardware.acceleratorMemoryGB(pair) ?? 0), 24);

  // A row with no figure says nothing about memory. Reading that as zero is
  // how a capable machine gets told it can run nothing.
  const silent = hardware.parseAcceleratorDevices("  Vulkan0: Some Accelerator");
  assert.equal(silent[0].memoryGB, null);
  assert.equal(hardware.acceleratorMemoryGB(silent), null);
});

// Verbatim from `llama-server --list-devices` on a laptop pairing a discrete
// RTX 4060 with the APU's integrated Radeon, built with the device-type patch
// from third_party. The integrated figure is roughly half of installed RAM
// because that is what it is: a window onto memory already counted once.
test("an integrated GPU beside a discrete card is not memory of its own", () => {
  const laptop = hardware.parseAcceleratorDevices([
    "Available devices:",
    "  Vulkan0: NVIDIA GeForce RTX 4060 (discrete, 7956 MiB, 7188 MiB free)",
    "  Vulkan1: AMD Radeon(TM) Graphics (integrated, 16209 MiB, 15399 MiB free)",
  ].join("\n"));

  assert.equal(laptop.length, 2);
  assert.equal(laptop[0].unified, false);
  assert.equal(laptop[1].unified, true);
  // The name keeps the brackets it came with rather than being cut at "(TM)".
  assert.equal(laptop[1].name, "AMD Radeon(TM) Graphics");

  // The card's own memory, not the card plus a second view of installed RAM,
  // which is what summing the two rows gives and what this machine reported.
  assert.equal(Math.round(hardware.acceleratorMemoryGB(laptop) ?? 0), 8);
  const budget = { ramGB: 31, vramGB: hardware.acceleratorMemoryGB(laptop) };
  assert.equal(hardware.systemQuality(budget, "Vulkan"), "good");

  // With no discrete card the integrated one contributes nothing of its own,
  // and installed RAM becomes the whole budget — which is the honest answer,
  // since that is the memory it was borrowing all along.
  const handheld = hardware.parseAcceleratorDevices(
    "  Vulkan0: AMD Radeon(TM) Graphics (integrated, 16209 MiB, 15399 MiB free)",
  );
  assert.equal(hardware.acceleratorMemoryGB(handheld), null);
  assert.equal(hardware.fastMemoryGB({ ramGB: 31, vramGB: null }), 31);
});

// Verbatim from `llama-server --list-devices` on an Apple M5 Max with 48 GB.
// Two things here are not what they look like: Apple's backend is spelled MTL
// by this build rather than Metal, and BLAS is Accelerate running on the very
// processor this is trying to find an alternative to.
test("Apple's backend is unified under either spelling, and BLAS is not a device", () => {
  const mac = hardware.parseAcceleratorDevices([
    "Available devices:",
    "  MTL0: Apple M5 Max (38338 MiB, 38337 MiB free)",
    "  BLAS: Accelerate (0 MiB, 0 MiB free)",
  ].join("\n"));

  // BLAS is the processor with a maths library on it, not something to offload
  // to. Listing it as the accelerator claims an acceleration that is not there.
  assert.equal(mac.length, 1);
  // Reported under the name the rest of this uses, not the build's spelling.
  assert.equal(mac[0].backend, "Metal");
  assert.equal(mac[0].name, "Apple M5 Max");
  assert.equal(mac[0].unified, true);

  // The 37 GB it reports is a window onto the 48 GB already counted as RAM.
  // Counting it again would show "48 GB RAM · 37 GB VRAM" for one pool of
  // memory, and would weigh models against the smaller of the two figures.
  assert.equal(hardware.acceleratorMemoryGB(mac), null);
  const budget = { ramGB: 48, vramGB: hardware.acceleratorMemoryGB(mac) };
  assert.equal(hardware.fastMemoryGB(budget), 48);
  assert.equal(hardware.backingMemoryGB(budget), 48);

  // A machine listing only BLAS has no accelerator at all.
  assert.equal(hardware.parseAcceleratorDevices("  BLAS: Accelerate (0 MiB, 0 MiB free)").length, 0);
});

// Apple is the exception, not the rule: every other backend has memory of its
// own, and that memory is what a model is weighed against there.
test("off a Mac the card's memory is what the suggestion comes from", () => {
  for (const line of [
    "  Vulkan0: NVIDIA GeForce RTX 4070 (12282 MiB, 11000 MiB free)",
    "  CUDA0: NVIDIA GeForce RTX 4070 (12282 MiB, 11000 MiB free)",
    "  ROCm0: AMD Radeon RX 9070 XT (12282 MiB, 11000 MiB free)",
  ]) {
    const devices = hardware.parseAcceleratorDevices(line);
    assert.equal(devices[0].unified, false, line);
    // A card sold as 12 GB reports 12282 MiB, which is 11.99 GB. The profile
    // rounds to whole gigabytes before anything is weighed against it, so the
    // figure shown and the figure judged against are the same one — a card
    // displayed as "12 GB VRAM" but judged as 11.99 would quietly offer the
    // smaller model for a reason nothing on screen explains.
    const vramGB = Math.round(hardware.acceleratorMemoryGB(devices) ?? 0);
    assert.equal(vramGB, 12, line);

    // 96 GB of RAM behind the card changes nothing about what is suggested:
    // the suggestion is what runs on the card.
    const budget = { ramGB: 96, vramGB };
    assert.equal(hardware.fastMemoryGB(budget), vramGB, line);
    assert.equal(
      hardware.recommendedModelId("chat", budget),
      hardware.recommendedModelId("chat", { ramGB: 12, vramGB: null }),
      line,
    );
  }
});

test("the memory budget is the card's when it has its own, and the machine's otherwise", () => {
  // A dedicated card: the model runs at the card's speed only while it fits
  // there, and installed RAM is what the overflow falls back to.
  const discrete = { ramGB: 64, vramGB: 8 };
  assert.equal(hardware.fastMemoryGB(discrete), 8);
  assert.equal(hardware.backingMemoryGB(discrete), 72);

  // Unified or absent: RAM is the whole answer, both figures alike.
  const unified = { ramGB: 32, vramGB: null };
  assert.equal(hardware.fastMemoryGB(unified), 32);
  assert.equal(hardware.backingMemoryGB(unified), 32);
});

test("system quality reflects the machine, not the chosen model", () => {
  assert.equal(hardware.systemQuality({ ramGB: 32, vramGB: 24 }, "Vulkan"), "optimal");
  assert.equal(hardware.systemQuality({ ramGB: 16, vramGB: null }, "Metal"), "optimal");
  assert.equal(hardware.systemQuality({ ramGB: 8, vramGB: null }, "Vulkan"), "good");
  // Plenty of RAM behind a small card is a good machine, not an optimal one:
  // what the card cannot hold runs at the processor's speed.
  assert.equal(hardware.systemQuality({ ramGB: 64, vramGB: 8 }, "Vulkan"), "good");
  // No accelerator is the case worth naming: it is invisible otherwise.
  assert.equal(hardware.systemQuality({ ramGB: 128, vramGB: null }, null), "cpu");
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

test("a download verifies the checksum before renaming into place", async () => {
  const payload = Buffer.from("gguf-fixture-bytes");
  const sha256 = crypto.createHash("sha256").update(payload).digest("hex");
  const file = { name: "probe.gguf", bytes: payload.length, sha256 };
  const model = probeCatalogModel(file);
  const downloads = loadDownloads(servingHttps(payload));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-download-"));
  try {
    await downloads.downloadLocalModel(dataRoot, model, model.quants[0]);
    const dest = downloads.modelFilePath(dataRoot, model, file);
    assert.equal(fs.readFileSync(dest, "utf8"), payload.toString("utf8"));
    assert.equal(fs.existsSync(`${dest}.partial`), false);
    assert.equal(fs.existsSync(`${dest}.partial.chunks`), false);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("a checksum mismatch deletes the partial file and keeps nothing", async () => {
  const payload = Buffer.from("gguf-fixture-bytes");
  const file = { name: "probe.gguf", bytes: payload.length, sha256: "0".repeat(64) };
  const model = probeCatalogModel(file);
  const downloads = loadDownloads(servingHttps(payload));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-download-"));
  try {
    await assert.rejects(
      () => downloads.downloadLocalModel(dataRoot, model, model.quants[0]),
      /did not match its published checksum/,
    );
    const dest = downloads.modelFilePath(dataRoot, model, file);
    assert.equal(fs.existsSync(dest), false);
    assert.equal(fs.existsSync(`${dest}.partial`), false);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("a download refuses a redirect onto HTTP", async () => {
  const payload = Buffer.from("gguf-fixture-bytes");
  const sha256 = crypto.createHash("sha256").update(payload).digest("hex");
  const file = { name: "probe.gguf", bytes: payload.length, sha256 };
  const model = probeCatalogModel(file);
  const downloads = loadDownloads(httpsMock((_url, _options, callback) => {
    callback(streamResponse(Buffer.alloc(0), 302, { location: "http://example.com/probe.gguf" }));
  }));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-download-"));
  try {
    await assert.rejects(
      () => downloads.downloadLocalModel(dataRoot, model, model.quants[0]),
      /redirected to an insecure address/,
    );
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

function probeCatalogModel(file) {
  return {
    id: "probe-model",
    kind: "chat",
    displayName: "Probe",
    hfRepo: "Example/Probe",
    hfRevision: "a".repeat(40),
    quants: [{ quant: "Q4_K_M", files: [file] }],
    minRamGB: 4,
    reasoning: false,
  };
}

function streamResponse(body, statusCode, headers = {}) {
  return {
    statusCode,
    headers,
    destroy() {},
    resume() {},
    async *[Symbol.asyncIterator]() {
      if (body.length > 0) yield body;
    },
  };
}

function httpsMock(handler) {
  return {
    get(url, options, callback) {
      const request = { once() {} };
      handler(url, options, callback);
      return request;
    },
  };
}

function loadDownloads(https) {
  return loadTypeScriptModule(new URL("../src/main/modelDownloads.ts", import.meta.url), {
    cache: new Map(),
    realm: "host",
    mocks: {
      electron: { app: { getPath: () => os.tmpdir() } },
      "node:https": https,
      https,
    },
  });
}

function servingHttps(payload) {
  return httpsMock((_url, options, callback) => {
    const range = options?.headers?.Range;
    let body = payload;
    let statusCode = 200;
    const match = typeof range === "string" ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
    if (match) {
      body = payload.subarray(Number(match[1]), Number(match[2]) + 1);
      statusCode = 206;
    }
    callback(streamResponse(body, statusCode));
  });
}
