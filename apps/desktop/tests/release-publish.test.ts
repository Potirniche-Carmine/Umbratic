import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as artifacts from "../../../scripts/ci/release-artifacts.ts";
import { prepareAttestation } from "../../../scripts/ci/release-attestations.ts";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

function publication(t, mainMoves, attestationFails = false, alterUploaded = (assets) => assets) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-publish-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [channel, name] of [["latest-mac.yml", "Umbratic-0.0.3.zip"], ["latest.yml", "Umbratic-0.0.3-x64.exe"], ["latest-arm64.yml", "Umbratic-0.0.3-arm64.exe"]]) {
    const file = path.join(directory, name);
    fs.writeFileSync(file, name);
    fs.writeFileSync(path.join(directory, channel), JSON.stringify({ version: "0.0.3", files: [{ url: name,
      size: fs.statSync(file).size, sha512: artifacts.hashFile(file, "sha512", "base64") }] }));
  }
  fs.writeFileSync(path.join(directory, "Umbratic-0.0.3.dmg"), "disk-image");
  const commit = "a".repeat(40), calls = [];
  for (const architecture of ["x64", "arm64"]) {
    const name = `Umbratic-0.0.3-${architecture}.exe`;
    fs.writeFileSync(path.join(directory, `Umbratic-0.0.3-${architecture}-windows-provenance.json`), JSON.stringify({
      version: "0.0.3", sourceCommit: commit, architecture, signing: "unsigned", ciRunId: 123,
      files: [name, architecture === "x64" ? "latest.yml" : "latest-arm64.yml"].map((asset) => ({
        path: asset, sha256: artifacts.hashFile(path.join(directory, asset), "sha256", "hex"),
      })),
      installer: { name, sha256: artifacts.hashFile(path.join(directory, name), "sha256", "hex") },
    }));
  }
  const subjects = prepareAttestation(directory, "0.0.3", "release", commit).map((name) => ({
    name, digest: { sha256: artifacts.hashFile(path.join(directory, name), "sha256", "hex") },
  }));
  const statement = { _type: "https://in-toto.io/Statement/v1", predicateType: "https://slsa.dev/provenance/v1", subject: subjects };
  fs.writeFileSync(path.join(directory, "release-provenance.jsonl"), JSON.stringify({ dsseEnvelope: {
    payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
  } }));
  let uploaded = false;
  const execute = () => loadTypeScriptModule(new URL("../../../scripts/ci/publish-release.ts", import.meta.url), {
    globals: { process: { env: { GITHUB_REPOSITORY: "owner/Umbratic", RELEASE_COMMIT: commit, RELEASE_TAG: "v0.0.3" } }, console: { log() {} } },
    mocks: {
      "./release-artifacts.ts": artifacts,
      "node:path": { ...path, resolve: (...parts) => parts[0] === "target/release/upload" ? directory : path.resolve(...parts) },
      "node:fs": { ...fs, readFileSync: (file, ...options) => file === "package.json" ? JSON.stringify({ version: "0.0.3" }) : fs.readFileSync(file, ...options) },
      "node:child_process": { execFileSync(command, args, options) {
        assert.equal(options.encoding, "utf8");
        if (command === "git") return commit;
        assert.equal(command, "gh");
        calls.push([...args]);
        if (args[0] === "attestation") {
          if (attestationFails) throw new Error("attestation identity rejected");
          return "";
        }
        assert.equal(Object.hasOwn(options, "maxBuffer"), false);
        if (args[0] !== "api") { if (args[1] === "upload") uploaded = true; return ""; }
        if (args[1].endsWith("/git/ref/heads/main")) return JSON.stringify({ object: {
          sha: mainMoves === "before" || (mainMoves && uploaded) ? "b".repeat(40) : commit,
        } });
        if (args[1].includes("matching-refs")) return "[]";
        if (args[1].includes("/assets")) return !uploaded ? "[]" : JSON.stringify(alterUploaded(
          artifacts.publicReleaseArtifactNames("0.0.3").map((name) => ({ name, state: "uploaded",
            size: fs.statSync(path.join(directory, name)).size,
            digest: `sha256:${artifacts.hashFile(path.join(directory, name), "sha256", "hex")}`,
          })),
        ));
        if (args[1].endsWith("/releases?per_page=100")) return JSON.stringify([{ id: 1, tag_name: "v0.0.3", draft: true, target_commitish: "stale-branch" }]);
        throw new Error("Unexpected release API call");
      } },
    },
  });
  return { execute, calls, commit };
}

test("retrying an untagged stale draft pins its target to the verified commit before publication", (t) => {
  const { execute, calls, commit } = publication(t, false);
  execute();
  const reset = calls.findIndex((args) => args[0] === "release" && args[1] === "edit" && args.includes("--draft"));
  const upload = calls.findIndex((args) => args[1] === "upload");
  assert.ok(reset >= 0 && reset < upload);
  assert.deepEqual(calls[upload].slice(calls[upload].indexOf("--clobber") + 1).map((file) => path.basename(file)),
    ["Umbratic-0.0.3-arm64.exe", "Umbratic-0.0.3-x64.exe", "Umbratic-0.0.3.dmg", "Umbratic-0.0.3.zip"]);
  assert.equal(calls[reset][calls[reset].indexOf("--target") + 1], commit);
  const notes = calls[reset][calls[reset].indexOf("--notes") + 1];
  assert.match(notes, /Windows x64 and ARM64 installers are unsigned/);
  assert.match(notes, /macOS builds are Developer ID signed and notarized/);
  assert.ok(notes.includes(`[Code signing policy](https://github.com/owner/Umbratic/blob/${commit}/CODE_SIGNING_POLICY.md)`));
  const publish = calls.find((args) => args.includes("--draft=false"));
  assert.equal(publish[publish.indexOf("--target") + 1], commit);
  assert.equal(calls.filter((args) => args[1].endsWith("/git/ref/heads/main")).length, 2);
});

test("main advancing before upload rejects publication without changing a draft", (t) => {
  const { execute, calls } = publication(t, "before");
  assert.throws(execute, /Main changed while packaging/);
  assert.ok(!calls.some((args) => args[0] === "release"));
});

test("main advancing during asset upload leaves the existing release unpublished", (t) => {
  const { execute, calls } = publication(t, true);
  assert.throws(execute, /Main changed during upload/);
  assert.ok(calls.some((args) => args[1] === "upload"));
  assert.ok(!calls.some((args) => args.includes("--draft=false")));
});

test("attestation rejection blocks every release mutation", (t) => {
  const { execute, calls } = publication(t, false, true);
  assert.throws(execute, /attestation identity rejected/);
  assert.ok(!calls.some((args) => args[0] === "release"));
});

test("missing, unexpected, duplicated or corrupted GitHub assets block publication", (t) => {
  for (const alter of [
    (assets) => assets.slice(1),
    (assets) => [...assets, { name: "latest.yml" }],
    (assets) => [assets[0], assets[0], ...assets.slice(2)],
    (assets) => assets.map((asset) => ({ ...asset, digest: `sha256:${"0".repeat(64)}` })),
    (assets) => assets.map((asset) => ({ ...asset, size: asset.size + 1 })),
    (assets) => assets.map((asset) => ({ ...asset, state: "starter" })),
  ]) {
    const { execute, calls } = publication(t, false, false, alter);
    assert.throws(execute, /Uploaded release assets do not match/);
    assert.ok(!calls.some((args) => args.includes("--draft=false")));
  }
});
