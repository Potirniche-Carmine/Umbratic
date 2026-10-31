import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-version-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["scripts", "apps/desktop", "packages", "src"]) fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.copyFileSync(new URL("../../../scripts/check-release-version.ts", import.meta.url), path.join(root, "scripts/check-release-version.ts"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module", version: "0.0.3" }));
  fs.writeFileSync(path.join(root, "apps/desktop/package.json"), JSON.stringify({ version: "0.0.3" }));
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ version: "0.0.3", packages: { "": { version: "0.0.3" }, "apps/desktop": { version: "0.0.3" } } }));
  fs.writeFileSync(path.join(root, "Cargo.toml"), '[package]\nname = "version-fixture"\nversion = "0.0.3"\nedition = "2024"\n');
  fs.writeFileSync(path.join(root, "src/lib.rs"), "pub fn fixture() {}\n");
  fs.writeFileSync(path.join(root, "Cargo.lock"), 'version = 4\n\n[[package]]\nname = "version-fixture"\nversion = "0.0.3"\n');
  return root;
}
function check(root) {
  return spawnSync(process.execPath, [path.join(root, "scripts/check-release-version.ts")], { cwd: root, encoding: "utf8" });
}

test("release versions verify offline and reject a stale Cargo lock even when no-deps metadata succeeds", (t) => {
  const root = fixture(t);
  assert.equal(check(root).status, 0);
  const lock = path.join(root, "Cargo.lock");
  fs.writeFileSync(lock, fs.readFileSync(lock, "utf8").replace('version = "0.0.3"', 'version = "0.0.2"'));
  const result = check(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cargo.lock version.*out of sync/);
});

test("release version checks reject mismatched npm workspace versions", (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "apps/desktop/package.json"), JSON.stringify({ version: "0.0.2" }));
  assert.match(check(root).stderr, /apps\/desktop\/package.json does not match release/);
});
