import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hashFile, verifyReleaseArtifacts, verifyUpdateChannel } from "../../../scripts/ci/release-artifacts.ts";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-release-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const prefix = "Umbratic-0.0.2";
  const channels = [["latest-mac.yml", `${prefix}.zip`], ["latest.yml", `${prefix}-x64.exe`], ["latest-arm64.yml", `${prefix}-arm64.exe`]];
  fs.writeFileSync(path.join(directory, `${prefix}.dmg`), "disk-image");
  for (const [channel, name] of channels) {
    const file = path.join(directory, name);
    fs.writeFileSync(file, `signed installer ${name}`);
    fs.writeFileSync(path.join(directory, channel), JSON.stringify({ version: "0.0.2", files: [{
      url: name, size: fs.statSync(file).size, sha512: hashFile(file, "sha512", "base64"),
    }] }));
  }
  return directory;
}

test("a release requires installers and valid updater metadata for every supported architecture", (t) => {
  const directory = fixture(t);
  assert.equal(verifyReleaseArtifacts(directory, "0.0.2").length, 7);
  fs.rmSync(path.join(directory, "latest-arm64.yml"));
  assert.throws(() => verifyReleaseArtifacts(directory, "0.0.2"), /ENOENT/);
});

test("tampered installers and unexpected or traversing assets cannot publish", (t) => {
  const directory = fixture(t);
  const installer = path.join(directory, "Umbratic-0.0.2-x64.exe");
  fs.appendFileSync(installer, "tamper");
  assert.throws(() => verifyReleaseArtifacts(directory, "0.0.2"), /checksum or size mismatch/);
  const channel = path.join(directory, "latest.yml");
  const metadata = JSON.parse(fs.readFileSync(channel, "utf8"));
  metadata.files[0].url = "Umbratic-0.0.2/../../secret";
  fs.writeFileSync(channel, JSON.stringify(metadata));
  assert.throws(() => verifyReleaseArtifacts(directory, "0.0.2"), /Unsafe release asset/);
});

test("cross-architecture channel metadata cannot ship a different installer", (t) => {
  const directory = fixture(t);
  fs.copyFileSync(path.join(directory, "latest.yml"), path.join(directory, "latest-arm64.yml"));
  assert.throws(() => verifyReleaseArtifacts(directory, "0.0.2"), /Wrong platform asset|does not reference.*arm64/);
});

test("stale versions and extra assets cannot be included in an otherwise valid release", (t) => {
  const directory = fixture(t);
  fs.writeFileSync(path.join(directory, "stale-installer.exe"), "unexpected");
  assert.throws(() => verifyReleaseArtifacts(directory, "0.0.2"), /Unexpected release asset/);
  fs.rmSync(path.join(directory, "stale-installer.exe"));
  const file = path.join(directory, "latest.yml");
  const metadata = JSON.parse(fs.readFileSync(file, "utf8"));
  metadata.version = "0.0.1";
  fs.writeFileSync(file, JSON.stringify(metadata));
  assert.throws(() => verifyReleaseArtifacts(directory, "0.0.2"), /Invalid release metadata/);
});

test("native CI validates each architecture's actual updater metadata before publication staging", (t) => {
  const directory = fixture(t);
  assert.deepEqual(verifyUpdateChannel(directory, "0.0.2", "latest.yml", "Umbratic-0.0.2-x64.exe"), [
    "latest.yml", "Umbratic-0.0.2-x64.exe",
  ]);
  fs.copyFileSync(path.join(directory, "latest-arm64.yml"), path.join(directory, "latest.yml"));
  assert.deepEqual(verifyUpdateChannel(directory, "0.0.2", "latest.yml", "Umbratic-0.0.2-arm64.exe"), [
    "latest.yml", "Umbratic-0.0.2-arm64.exe",
  ]);
  assert.throws(() => verifyUpdateChannel(directory, "0.0.2", "latest.yml", "Umbratic-0.0.2-x64.exe"), /Wrong platform asset/);
});
