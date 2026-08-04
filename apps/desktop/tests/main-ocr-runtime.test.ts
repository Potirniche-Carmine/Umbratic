import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const ocrRuntime = loadTypeScriptModule(new URL("../src/main/ocrRuntime.ts", import.meta.url));
const plain = (value) => JSON.parse(JSON.stringify(value));

const sampleTsv = [
  "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
  "5\t1\t1\t1\t1\t1\t10\t15\t40\t10\t92\tHello",
  "5\t1\t1\t1\t1\t2\t56\t15\t45\t10\t88\tworld",
  "5\t1\t1\t1\t2\t1\t12\t50\t35\t10\t40\tTotal",
  "5\t1\t1\t1\t2\t2\t52\t50\t20\t10\t42\t42",
].join("\n");

function pngWithDimensions(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

test("parseTesseractTsv builds ordered OCR lines with confidence and coordinates", () => {
  const lines = ocrRuntime.parseTesseractTsv(sampleTsv, 1, 200, 100, 0.5);

  assert.deepEqual(plain(lines), [
    {
      order: 1,
      text: "Hello world",
      confidence: 0.9,
      polygon: [[10, 15], [101, 15], [101, 25], [10, 25]],
      bbox: [10, 15, 101, 25],
    },
    {
      order: 2,
      text: "Total 42",
      confidence: 0.41000000000000003,
      polygon: [[12, 50], [72, 50], [72, 60], [12, 60]],
      bbox: [12, 50, 72, 60],
      lowConfidence: true,
    },
  ]);
});

test("generateOcrDocument and writeOcrArtifacts keep OCR output local and structured", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-ocr-runtime-"));
  const imagePath = path.join(directory, "scan.png");
  fs.writeFileSync(imagePath, pngWithDimensions(200, 100));

  const document = await ocrRuntime.generateOcrDocument({
    sourcePath: imagePath,
    pathLabel: "scan.png",
    kind: "image",
    sourcePageCount: 1,
    pages: [{ pageNumber: 1, imagePath }],
    engine: { id: "tesseract", command: "tesseract", version: "tesseract 5.3.0" },
    pageLimit: 1,
    now: () => 1000,
    execFile: (_file, _args, _options, callback) => {
      queueMicrotask(() => callback(null, sampleTsv, ""));
      return { kill: () => undefined };
    },
  });

  assert.equal(document.engine.id, "tesseract");
  assert.equal(document.engine.localOnly, true);
  assert.equal(document.pages[0].text, "Hello world\nTotal 42");
  assert.equal(document.metrics.recognizedLines, 2);
  assert.equal(document.warnings.some((warning) => warning.code === "low_confidence"), true);

  const paths = ocrRuntime.writeOcrArtifacts(document, path.join(directory, ".umbratic", "artifacts", "ocr"), "scan-test");
  assert.equal(fs.existsSync(paths.jsonPath), true);
  assert.equal(fs.existsSync(paths.markdownPath), true);
  assert.match(fs.readFileSync(paths.markdownPath, "utf8"), /# OCR: scan\.png/);
  assert.match(fs.readFileSync(paths.markdownPath, "utf8"), /Low-Confidence Lines/);
});


