import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { extractImageSource, imageRuntimeCmakeArgs, sourceArchiveUrl } from "../scripts/build-image-runtime.ts";

const pin = JSON.parse(await fs.readFile(new URL("../../../third_party/stable-diffusion.cpp.json", import.meta.url), "utf8"));
const source = pin.macSource.runtime;
const prefix = `stable-diffusion.cpp-${source.commit}/`;

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "umbratic-image-source-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("image sources require official repositories and full revision/checksum pins", () => {
  assert.equal(sourceArchiveUrl(source), `https://codeload.github.com/leejet/stable-diffusion.cpp/zip/${source.commit}`);
  for (const invalid of [{ repository: "attacker/source" }, { commit: "main" }, { sha256: "bad" }, { bytes: -1 }]) {
    assert.throws(() => sourceArchiveUrl({ ...source, ...invalid }), /source pin/);
  }
  for (const arch of ["arm64", "x64"]) {
    const args = imageRuntimeCmakeArgs("source", "build", pin.macSource, arch);
    assert.ok(args.includes("-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0"));
    assert.ok(args.includes("-DFETCHCONTENT_FULLY_DISCONNECTED=ON"));
    assert.ok(args.includes("-DGGML_NATIVE=OFF"));
    assert.ok(args.includes("-DSD_SERVER_BUILD_FRONTEND=OFF"));
    assert.ok(args.includes("-DSD_METAL=ON"));
  }
  assert.throws(() => imageRuntimeCmakeArgs("source", "build", pin.macSource, "wrong"), /build target/);
});

test("source extraction excludes assets and rejects traversal, root mismatches, and symlinks", async (t) => {
  const root = await directory(t);
  const safe = new JSZip();
  safe.file(`${prefix}src/main.cpp`, "source");
  safe.file(`${prefix}assets/large-model.bin`, "unused");
  await extractImageSource(await safe.generateAsync({ type: "nodebuffer" }), path.join(root, "safe"), source);
  assert.equal(await fs.readFile(path.join(root, "safe/src/main.cpp"), "utf8"), "source");
  await assert.rejects(fs.access(path.join(root, "safe/assets/large-model.bin")));
  for (const name of [`${prefix}../../escaped`, "different-root/src/main.cpp"]) {
    const unsafe = new JSZip();
    unsafe.file(name, "unexpected");
    await assert.rejects(extractImageSource(await unsafe.generateAsync({ type: "nodebuffer" }), path.join(root, "unsafe"), source), /Unsafe/);
  }
  const linked = new JSZip();
  linked.file(`${prefix}src/link`, "../../outside", { unixPermissions: 0o120777 });
  await assert.rejects(extractImageSource(await linked.generateAsync({ type: "nodebuffer", platform: "UNIX" }), path.join(root, "linked"), source), /archive link/);
});
