import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const { OoxmlPackage } = loadTypeScriptModule(new URL("../src/main/artifacts/worker/package.ts", import.meta.url), { realm: "host" });

test("OOXML rejects original traversal names even after JSZip normalizes them", async () => {
  for (const name of ["../escaped.xml", "word/../../escaped.xml"]) {
    const zip = new JSZip();
    zip.file(name, "payload");
    await assert.rejects(OoxmlPackage.read(await zip.generateAsync({ type: "nodebuffer" })), /unsafe entry name/);
  }
});

test("OOXML refuses a highly compressed part and cumulative inflation beyond their limits", async () => {
  for (const [count, size] of [[1, 32 * 1024 * 1024 + 1], [3, 22 * 1024 * 1024]]) {
    const zip = new JSZip();
    const payload = Buffer.alloc(size, 97);
    for (let index = 0; index < count; index++) zip.file(`word/part${index}.xml`, payload);
    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    assert.ok(bytes.length < 128 * 1024, "the input exercises a compressed expansion, not an oversized upload");
    await assert.rejects(OoxmlPackage.read(bytes), (error) => error.kind === "too-large");
  }
});

test("bounded OOXML reads preserve bytes of untouched package parts", async () => {
  const zip = new JSZip();
  const content = Buffer.from("<document>雪 &amp; café</document>");
  zip.file("word/document.xml", content);
  const pack = await OoxmlPackage.read(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  assert.equal(pack.text("word/document.xml"), content.toString());
});
