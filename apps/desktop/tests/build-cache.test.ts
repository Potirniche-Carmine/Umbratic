import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { nativeCacheInputs, nativeCacheKey } from "../../../scripts/ci/build-cache.ts";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-native-key-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const input of nativeCacheInputs) {
    fs.mkdirSync(path.dirname(path.join(root, input)), { recursive: true });
    fs.writeFileSync(path.join(root, input), input);
  }
  return root;
}

test("every reviewed native source pin, patch and build control invalidates the exact cache", (t) => {
  const root = fixture(t);
  const identity = { platform: "win32", architecture: "x64", image: "20261101.1", compiler: "MSVC 19.51", sdk: "10.0.26100" };
  const original = nativeCacheKey(root, identity);
  assert.match(original, /^umbratic-native-v1-[0-9a-f]{64}$/);
  for (const input of nativeCacheInputs) {
    const file = path.join(root, input);
    fs.appendFileSync(file, "changed");
    assert.notEqual(nativeCacheKey(root, identity), original, input);
    fs.writeFileSync(file, input);
  }
  fs.rmSync(path.join(root, "third_party/llama.cpp-disable-remote-downloads.patch"));
  assert.throws(() => nativeCacheKey(root, identity), /ENOENT/);
});

test("native cache identity binds compiler, SDK, image, architecture, flags and absolute checkout location", (t) => {
  const root = fixture(t);
  const identity = { platform: "darwin", architecture: "arm64", image: "20261101.1", compiler: "AppleClang17",
    sdk: "macOS26", cmake: "4.1", generator: "Unix Makefiles", CXXFLAGS: "", UMBRATIC_LLAMA_CPU_ONLY: "" };
  const original = nativeCacheKey(root, identity);
  assert.equal(nativeCacheKey(root, Object.fromEntries(Object.entries(identity).reverse())), original);
  for (const field of Object.keys(identity)) assert.notEqual(nativeCacheKey(root, { ...identity, [field]: "changed" }), original, field);
  assert.notEqual(nativeCacheKey(fixture(t), identity), original);
  // Final packages and local signing state never participate in, or ship via,
  // the native cache. Only reviewed source/build inputs determine its key.
  fs.mkdirSync(path.join(root, ".package"));
  fs.writeFileSync(path.join(root, ".package/signed.exe"), "must not influence the key");
  assert.equal(nativeCacheKey(root, identity), original);
});
