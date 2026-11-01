import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { applySigningResponse, requireProjectIdentity, requestSignature, unsignedPeDigest } from "../../../scripts/ci/windows-signing.ts";
import { cleanupWindowsFixture } from "../../../scripts/ci/windows-fixture-cleanup.ts";

const releaseVersion = JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version;
function pe(): Buffer {
  const bytes = Buffer.alloc(513);
  bytes.write("MZ");
  bytes.writeUInt32LE(64, 60);
  bytes.writeUInt32LE(0x4550, 64);
  bytes.writeUInt16LE(0x8664, 68);
  bytes.writeUInt16LE(0x20b, 88);
  bytes[400] = 123;
  return bytes;
}
function signed(original: Buffer): Buffer {
  const offset = Math.ceil(original.length / 8) * 8;
  const bytes = Buffer.alloc(offset + 24);
  original.copy(bytes);
  bytes.writeUInt32LE(offset, 88 + 112 + 32);
  bytes.writeUInt32LE(24, 88 + 112 + 36);
  bytes.writeUInt32LE(9876, 88 + 64);
  bytes.fill(77, offset);
  return bytes;
}
function identity() {
  return { status: "Valid", publisher: "Fixture publisher", subject: "CN=Fixture publisher", thumbprint: "ABCD", timestamp: true, sha256Signature: true,
    productName: "Umbratic", productVersion: releaseVersion };
}

test("signed PE binding excludes only signature data, checksum and required alignment", () => {
  const original = pe();
  const valid = signed(original);
  assert.equal(unsignedPeDigest(valid), unsignedPeDigest(original));
  for (const offset of [68, 400, 512]) {
    const changed = Buffer.from(valid);
    changed[offset] ^= 1;
    assert.notEqual(unsignedPeDigest(changed), unsignedPeDigest(original));
  }
  const extra = Buffer.concat([valid, Buffer.from("hidden unsigned data")]);
  assert.throws(() => unsignedPeDigest(extra), /certificate table/);
  const malformed = Buffer.from(valid);
  malformed.writeUInt32LE(1, 88 + 112 + 32);
  assert.throws(() => unsignedPeDigest(malformed), /certificate table/);
  assert.throws(() => unsignedPeDigest(Buffer.from("not a PE")), /Invalid PE/);
});

test("every project binary requires the exact trusted publisher, timestamp, product and release", () => {
  const valid = identity();
  requireProjectIdentity(valid, valid.publisher, releaseVersion);
  for (const changed of [{ status: "NotSigned" }, { publisher: "Another legitimate publisher" }, { timestamp: false }, { sha256Signature: false },
    { productName: "Another product" }, { productVersion: "0.0.0" }]) {
    assert.throws(() => requireProjectIdentity({ ...valid, ...changed }, valid.publisher, releaseVersion), /required publisher/);
  }
});

test("handoff rejects wrong-stage, missing, extra, changed, stale and invalidly signed responses", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-signpath-unit-"));
  const previous = { root: process.env.UMBRATIC_SIGNPATH_STAGING, publisher: process.env.SIGNPATH_PUBLISHER };
  process.env.UMBRATIC_SIGNPATH_STAGING = root;
  process.env.SIGNPATH_PUBLISHER = identity().publisher;
  let inspected = identity();
  let pending: Promise<void> | undefined;
  t.mock.method(childProcess, "execFileSync", (command) => {
    assert.equal(command, "pwsh");
    return JSON.stringify([inspected]);
  });
  syncBuiltinESMExports();
  t.after(async () => {
    if (pending) {
      fs.writeFileSync(path.join(root, "installer/resume"), "resume\n");
      await pending.catch(() => {});
    }
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (previous.root === undefined) delete process.env.UMBRATIC_SIGNPATH_STAGING; else process.env.UMBRATIC_SIGNPATH_STAGING = previous.root;
    if (previous.publisher === undefined) delete process.env.SIGNPATH_PUBLISHER; else process.env.SIGNPATH_PUBLISHER = previous.publisher;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(root, "Umbratic-0.0.3-x64.exe");
  fs.writeFileSync(file, pe());
  pending = requestSignature("installer", [file]);
  const output = path.join(root, "installer/signed");
  fs.mkdirSync(output);
  assert.throws(() => applySigningResponse("uninstaller"), /not awaiting/);
  assert.throws(() => applySigningResponse("installer"), /artifact set/);
  fs.writeFileSync(path.join(output, path.basename(file)), signed(pe()));
  fs.writeFileSync(path.join(output, "extra.exe"), signed(pe()));
  assert.throws(() => applySigningResponse("installer"), /artifact set/);
  fs.unlinkSync(path.join(output, "extra.exe"));
  const changed = signed(pe());
  changed[400] ^= 1;
  fs.writeFileSync(path.join(output, path.basename(file)), changed);
  assert.throws(() => applySigningResponse("installer"), /changed PE contents/);
  fs.writeFileSync(path.join(output, path.basename(file)), signed(pe()));
  inspected = { ...identity(), publisher: "Other publisher" };
  assert.throws(() => applySigningResponse("installer"), /required publisher/);
  inspected = identity();
  fs.writeFileSync(file, changed);
  assert.throws(() => applySigningResponse("installer"), /pending input changed/);
  fs.writeFileSync(file, pe());
  applySigningResponse("installer");
  await pending;
  assert.equal(unsignedPeDigest(fs.readFileSync(file)), unsignedPeDigest(pe()));
  assert.throws(() => applySigningResponse("installer"), /not awaiting/);
  await assert.rejects(requestSignature("installer", [file]), /stale requests/);
});

test("fixture stop and certificate failures preserve retry state and never restore beneath a writer", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-fixture-cleanup-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "state");
  const desktop = path.join(temporary, "desktop");
  const upload = path.join(temporary, "upload");
  for (const directory of [root, path.join(root, "handoff"), path.join(root, "unsigned-desktop"), path.join(root, "unsigned-upload"), desktop, upload]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(root, "identity.json"), "{}");
  fs.writeFileSync(path.join(root, "handoff/pid"), "1234");
  fs.writeFileSync(path.join(root, "unsigned-desktop/normal"), "original installer");
  fs.writeFileSync(path.join(root, "unsigned-upload/normal"), "original upload");
  fs.writeFileSync(path.join(desktop, "fixture"), "fixture installer");
  fs.writeFileSync(path.join(upload, "fixture"), "fixture upload");
  const failure = new Error("worker still running");
  let removed = 0;
  assert.throws(() => cleanupWindowsFixture(root, desktop, upload, () => { throw failure; }, () => { removed++; }), (error) => error === failure);
  assert.equal(removed, 1);
  assert.equal(fs.readFileSync(path.join(root, "handoff/pid"), "utf8"), "1234");
  assert.ok(fs.existsSync(path.join(root, "unsigned-desktop/normal")));
  assert.ok(fs.existsSync(path.join(desktop, "fixture")));
  assert.ok(fs.existsSync(path.join(upload, "fixture")));
  assert.throws(() => cleanupWindowsFixture(root, desktop, upload, () => {}, () => { throw new Error("certificate cleanup failed"); }), /certificate cleanup failed/);
  assert.ok(fs.existsSync(path.join(root, "handoff/pid")));
  assert.ok(fs.existsSync(path.join(desktop, "fixture")));
  cleanupWindowsFixture(root, desktop, upload, () => {}, () => { removed++; });
  assert.equal(fs.existsSync(root), false);
  assert.equal(fs.readFileSync(path.join(desktop, "normal"), "utf8"), "original installer");
  assert.equal(fs.readFileSync(path.join(upload, "normal"), "utf8"), "original upload");
  assert.equal(fs.existsSync(path.join(desktop, "fixture")), false);
});

test("worker startup atomically refuses existing signing state without changing its response", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-signpath-stale-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const response = path.join(root, "old-response");
  fs.writeFileSync(response, "previous approval");
  const result = childProcess.spawnSync(process.execPath, [fileURLToPath(new URL("../../../scripts/ci/windows-signpath-build.ts", import.meta.url)), "start"], {
    env: { ...process.env, UMBRATIC_SIGNPATH_STAGING: root }, encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already exists; refuse stale responses/);
  assert.equal(fs.readFileSync(response, "utf8"), "previous approval");
  assert.deepEqual(fs.readdirSync(root), ["old-response"]);
});
