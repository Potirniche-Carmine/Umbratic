import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const mocks = { electron: { app: { getPath: () => os.tmpdir() } } };
const catalog = loadTypeScriptModule(new URL("../src/main/modelCatalog.ts", import.meta.url), { mocks });
const downloads = loadTypeScriptModule(new URL("../src/main/modelDownloads.ts", import.meta.url), { mocks });

test("image catalog contains all five pinned quants and the required components", () => {
  const rows = catalog.catalogModels("image");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hfRepo, "abenzerps/Qwen-Image-2.1-GGUF");
  assert.deepEqual(JSON.parse(JSON.stringify(rows[0].quants.map((q) => q.quant))), ["Q4_K_M", "Q4_0", "Q5_K_M", "Q6_K", "Q8_0"]);
  for (const quant of rows[0].quants) {
    assert.equal(quant.files.length, 3);
    assert.match(quant.files[1].name, /^text_encoders\//);
    assert.match(quant.files[2].name, /^vae\//);
    for (const file of quant.files) assert.match(file.sha256, /^[a-f0-9]{64}$/);
  }
});

test("existing chat weights are detected without vision; image and dictation still need their companions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-model-detection-"));
  try {
    for (const kind of ["chat", "image", "dictation"]) {
      const model = { id: kind, kind };
      const quant = { files: [{ name: "model.gguf", bytes: 4 }, { name: "mmproj-model.gguf", bytes: 4 }] };
      fs.mkdirSync(downloads.modelDirectory(root, model), { recursive: true });
      fs.writeFileSync(downloads.modelFilePath(root, model, quant.files[0]), "GGUF");
      assert.equal(downloads.modelDownloaded(root, model, quant), kind === "chat");
      assert.equal(downloads.modelFileDownloaded(root, model, quant.files[1]), false);
      fs.writeFileSync(downloads.modelFilePath(root, model, quant.files[1]), "GGUF");
      assert.equal(downloads.modelDownloaded(root, model, quant), true);
      assert.equal(downloads.modelFileDownloaded(root, model, quant.files[1]), true);
      fs.writeFileSync(downloads.modelFilePath(root, model, quant.files[0]), "bad");
      assert.equal(downloads.modelDownloaded(root, model, quant), false);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("generated image previews require a successful tool result and a confined regular PNG", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-image-preview-"));
  const { readGeneratedImage } = loadTypeScriptModule(new URL("../src/main/generatedImage.ts", import.meta.url), { mocks });
  const bytes = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(32)]);
  const task = { worktreePath: root, originalRepoPath: root, events: [] };
  const success = (file) => ({ type: "command.finished", exitCode: 0, details: { image: true, path: file } });
  try {
    fs.writeFileSync(path.join(root, "sphere.png"), bytes);
    assert.equal(readGeneratedImage(task, "sphere.png").dataUrl, null);
    task.events = [success("sphere.png")];
    assert.equal(readGeneratedImage(task, "sphere.png").dataUrl, `data:image/png;base64,${bytes.toString("base64")}`);
    for (const requested of ["../sphere.png", path.join(root,"sphere.png"), ".env", null]) assert.equal(readGeneratedImage(task, requested).dataUrl, null);
    task.events = [{ ...success("sphere.png"), exitCode: 1 }];
    assert.equal(readGeneratedImage(task, "sphere.png").dataUrl, null);
    task.events = [success("sphere.png")];
    fs.writeFileSync(path.join(root, "sphere.png"), "not a png");
    assert.equal(readGeneratedImage(task, "sphere.png").dataUrl, null);
    fs.symlinkSync(path.join(root,"sphere.png"),path.join(root,"link.png"));
    task.events = [success("link.png")];
    assert.equal(readGeneratedImage(task,"link.png").dataUrl,null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
