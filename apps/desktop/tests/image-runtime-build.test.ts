import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { extractImageSource, imageRuntimeCmakeArgs, sourceArchiveUrl, verifyImageRuntimeGgufBounds } from "../scripts/build-image-runtime.ts";

const pin = JSON.parse(await fs.readFile(new URL("../../../third_party/stable-diffusion.cpp.json", import.meta.url), "utf8"));
const source = pin.source.runtime;
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
    const args = imageRuntimeCmakeArgs("source", "build", pin.source, arch, "darwin");
    assert.ok(args.includes("-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0"));
    assert.ok(args.includes("-DFETCHCONTENT_FULLY_DISCONNECTED=ON"));
    assert.ok(args.includes("-DGGML_NATIVE=OFF"));
    assert.ok(args.includes("-DSD_SERVER_BUILD_FRONTEND=OFF"));
    assert.ok(args.includes("-DSD_METAL=ON"));
  }
  for (const platform of ["win32", "linux"]) {
    const args = imageRuntimeCmakeArgs("source", "build", pin.source, "x64", platform);
    for (const flag of ["-DGGML_NATIVE=OFF", "-DGGML_CPU_ALL_VARIANTS=ON", "-DGGML_BACKEND_DL=ON", "-DSD_METAL=OFF", "-DSD_VULKAN=OFF"]) {
      assert.ok(args.includes(flag));
    }
  }
  assert.throws(() => imageRuntimeCmakeArgs("source", "build", pin.source, "wrong", "darwin"), /build target/);
  assert.throws(() => imageRuntimeCmakeArgs("source", "build", pin.source, "arm64", "win32"), /build target/);
  assert.deepEqual(pin.targets, ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"]);
  assert.equal(pin.assets, undefined);
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

test("GGUF probes retain malicious dimensions and isolate parsing from GPU initialization", async (t) => {
  const fixtures = [];
  t.mock.method(childProcess, "spawnSync", (_binary, args, options) => {
    assert.deepEqual(args.slice(0, 4), ["--mode", "convert", "--backend", "cpu"]);
    assert.equal(options.env.GGML_METAL_DEVICES, "0");
    assert.equal(options.timeout, 15_000);
    assert.equal(options.killSignal, "SIGKILL");
    assert.equal(options.maxBuffer, 64 * 1024);
    const file = args[args.indexOf("-m") + 1];
    const bytes = readFileSync(file);
    assert.equal(bytes.subarray(0, 4).toString(), "GGUF");
    assert.equal(bytes.readBigUInt64LE(8), 1n);
    const elements = [0, 1, 2, 3].reduce((count, index) => count * bytes.readBigUInt64LE(37 + index * 8), 1n);
    if (file.endsWith("shape.gguf")) assert.ok(elements > 2n ** 63n - 1n);
    else assert.ok(elements * 2n > 2n ** 64n - 1n - 31n);
    fixtures.push(file);
    return { status: 1, signal: null, stdout: "", stderr: file.endsWith("shape.gguf")
      ? "may cause overflow errors" : "overflows after padding" };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await verifyImageRuntimeGgufBounds("image-runtime");
  assert.equal(fixtures.length, 2);
  for (const file of fixtures) await assert.rejects(fs.access(file));
});

test("GGUF probes fail on timeout, crash, unexpected status, or a missing guard marker with bounded diagnostics", async (t) => {
  let response;
  t.mock.method(childProcess, "spawnSync", () => response);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const failure of [
    { status: null, signal: "SIGKILL", error: Object.assign(new Error("spawn timed out"), { code: "ETIMEDOUT" }) },
    { status: null, signal: "SIGABRT" },
    { status: 0, signal: null },
    { status: 1, signal: null, stderr: "unrelated rejection" },
  ]) {
    response = { stdout: "x".repeat(100_000), stderr: "may cause overflow errors", ...failure };
    await assert.rejects(verifyImageRuntimeGgufBounds("image-runtime"), (error) => {
      assert.match(error.message, /GGUF shape overflow fixture/);
      assert.ok(error.message.length < 5000);
      assert.ok(error.message.includes(JSON.stringify(failure.signal)));
      if (failure.error) assert.match(error.message, /ETIMEDOUT/);
      if (failure.stderr) assert.match(error.message, /unrelated rejection/);
      return true;
    });
  }
});
