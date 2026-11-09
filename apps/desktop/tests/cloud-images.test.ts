import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

test("cloud images accept only bounded decodable images and resolve app-owned IDs", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-images-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const image = { isEmpty: () => false, getSize: () => ({ width: 10, height: 10 }), toPNG: () => Buffer.from("normalized PNG"), resize: () => ({ toDataURL: () => "data:image/png;base64,cHJldmlldw==" }) };
  const api = loadTypeScriptModule(new URL("../src/main/cloudImages.ts", import.meta.url), { realm: "host", mocks: {
    electron: { app: { getPath: () => root }, nativeImage: { createFromBuffer: bytes => bytes.toString() === "image bytes" ? image : { isEmpty: () => true } } },
  } });
  const valid = { name: "../../test.png", dataUrl: "data:image/png;base64,aW1hZ2UgYnl0ZXM=" };
  for (const files of [[], Array(21).fill(valid), [{ name: "unsafe.exe", dataUrl: "data:application/octet-stream;base64,aW1hZ2U=" }], [{ dataUrl: "data:image/png;base64,YmFk" }], [{ dataUrl: "x".repeat(30_000_000) }]]) assert.throws(() => api.saveCloudImages({ files }));
  assert.throws(() => api.resolveCloudImages(["../outside.png"]));
  const saved = api.saveCloudImages({ files: [valid] });
  assert.equal(saved[0].mimeType, "image/png");
  const resolved = api.resolveCloudImages([saved[0].id, saved[0].id]);
  assert.equal(resolved.length, 1); assert.ok(resolved[0].path.startsWith(path.join(root, "cloud", "images")));
  assert.equal(fs.readFileSync(resolved[0].path, "utf8"), "normalized PNG");
  fs.unlinkSync(resolved[0].path); fs.symlinkSync(path.join(root, "outside.png"), resolved[0].path);
  assert.throws(() => api.resolveCloudImages([saved[0].id]), /Attach this file again/);
  const documents = api.saveCloudImages({ files: [
    { name: "brief.txt", dataUrl: "data:text/plain;base64,aGVsbG8=" },
    { name: "brief.pdf", dataUrl: `data:application/pdf;base64,${Buffer.from("%PDF-1.4\nfixture").toString("base64")}` },
  ] });
  assert.deepEqual(documents.map(file => file.mimeType), ["text/plain", "application/pdf"]);
  assert.equal(fs.readFileSync(api.resolveCloudImages([documents[0].id])[0].path, "utf8"), "hello");
  assert.throws(() => api.saveCloudImages({ files: [{ name: "not.pdf", dataUrl: "data:application/pdf;base64,aGVsbG8=" }] }));
});
