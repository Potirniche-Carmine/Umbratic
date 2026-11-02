import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as artifacts from "../../../scripts/ci/release-artifacts.ts";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const version = JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version;
const commit = "a".repeat(40);
const identity = { repository: "owner/Umbratic", commit, sourceRef: "refs/heads/main", workflow: "release.yml" };

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-attestation-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const prefix = `Umbratic-${version}`;
  fs.writeFileSync(path.join(directory, `${prefix}.dmg`), "disk-image");
  for (const [channel, name] of [["latest-mac.yml", `${prefix}.zip`], ["latest.yml", `${prefix}-x64.exe`], ["latest-arm64.yml", `${prefix}-arm64.exe`]]) {
    const file = path.join(directory, name);
    fs.writeFileSync(file, `installer ${name}`);
    fs.writeFileSync(path.join(directory, channel), JSON.stringify({ version, files: [{ url: name,
      size: fs.statSync(file).size, sha512: artifacts.hashFile(file, "sha512", "base64") }] }));
  }
  for (const architecture of ["x64", "arm64"]) {
    const name = `${prefix}-${architecture}.exe`;
    fs.writeFileSync(path.join(directory, `${prefix}-${architecture}-windows-provenance.json`), JSON.stringify({
      version, sourceCommit: commit, architecture, files: [{ path: "Umbratic.exe", role: "project" }],
      installer: { name, sha256: artifacts.hashFile(path.join(directory, name), "sha256", "hex") },
    }));
  }
  return directory;
}

function helper(run = () => "", filesystem = fs) {
  return loadTypeScriptModule(new URL("../../../scripts/ci/release-attestations.ts", import.meta.url), {
    mocks: { "node:fs": filesystem, "node:child_process": { execFileSync: run }, "./release-artifacts.ts": artifacts },
  });
}

function prepared(t, run = () => "") {
  const directory = fixture(t), module = helper(run);
  const files = module.prepareAttestation(directory, version, "release", commit);
  const statement = { _type: "https://in-toto.io/Statement/v1", predicateType: "https://slsa.dev/provenance/v1",
    subject: files.map((name) => ({ name, digest: { sha256: artifacts.hashFile(path.join(directory, name), "sha256", "hex") } })) };
  fs.writeFileSync(path.join(directory, module.provenanceName), JSON.stringify({ dsseEnvelope: {
    payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
  } }));
  return { directory, module };
}

test("every final installer, updater file, provenance inventory and checksum is verified with exact certificate identity", (t) => {
  const calls = [];
  const { directory, module } = prepared(t, (command, args, options) => calls.push({ command, args, options }));
  const files = module.verifyReleaseAttestations(directory, version, identity.repository, commit);
  assert.equal(files.length, 11);
  assert.equal(calls.length, 10);
  assert.deepEqual(calls.map(({ args }) => path.basename(args[2])).sort(), JSON.parse(JSON.stringify(files.filter((name) => name !== module.provenanceName).sort())));
  for (const { command, args, options } of calls) {
    assert.equal(command, "gh");
    for (const [flag, expected] of [
      ["--repo", identity.repository], ["--source-digest", commit], ["--signer-digest", commit],
      ["--source-ref", identity.sourceRef], ["--signer-workflow", "owner/Umbratic/.github/workflows/release.yml"],
      ["--cert-identity", "https://github.com/owner/Umbratic/.github/workflows/release.yml@refs/heads/main"],
      ["--cert-oidc-issuer", "https://token.actions.githubusercontent.com"],
      ["--predicate-type", "https://slsa.dev/provenance/v1"], ["--bundle", path.join(directory, module.provenanceName)],
    ]) assert.equal(args[args.indexOf(flag) + 1], expected);
    assert.ok(args.includes("--deny-self-hosted-runners"));
    assert.equal(options.timeout, 60_000);
    assert.equal(options.maxBuffer, 1024 * 1024);
  }
});

test("signed release preparation requires both Windows provenance records bound to the actual installer and commit", (t) => {
  for (const field of ["sourceCommit", "architecture", "version", "sha256"]) {
    const directory = fixture(t), module = helper();
    const file = path.join(directory, `Umbratic-${version}-x64-windows-provenance.json`);
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (field === "sha256") record.installer.sha256 = "b".repeat(64); else record[field] = "different";
    fs.writeFileSync(file, JSON.stringify(record));
    assert.throws(() => module.prepareAttestation(directory, version, "release", commit), /provenance does not match/);
    assert.equal(fs.existsSync(path.join(directory, module.checksumName)), false);
  }
});

test("altered disk images, checksum omissions and extra assets fail before cryptographic verification", (t) => {
  for (const change of ["image", "checksum", "extra"]) {
    let called = false;
    const { directory, module } = prepared(t, () => { called = true; });
    if (change === "image") fs.appendFileSync(path.join(directory, `Umbratic-${version}.dmg`), "changed");
    if (change === "checksum") fs.writeFileSync(path.join(directory, module.checksumName), "");
    if (change === "extra") fs.writeFileSync(path.join(directory, "old-installer.exe"), "old");
    assert.throws(() => module.verifyReleaseAttestations(directory, version, identity.repository, commit), /SHA256SUMS|Unexpected release asset/);
    assert.equal(called, false);
  }
});

test("missing or empty bundles and failed identity verification cannot be accepted", (t) => {
  const { directory, module } = prepared(t);
  fs.writeFileSync(path.join(directory, module.provenanceName), "");
  assert.throws(() => module.verifyReleaseAttestations(directory, version, identity.repository, commit), /Invalid bounded release evidence/);
  fs.rmSync(path.join(directory, module.provenanceName));
  assert.throws(() => module.verifyReleaseAttestations(directory, version, identity.repository, commit), /ENOENT/);
  const failure = new Error("certificate workflow or digest rejected");
  const other = prepared(t, () => { throw failure; });
  assert.throws(() => other.module.verifyReleaseAttestations(other.directory, version, identity.repository, commit), /certificate workflow or digest rejected/);
});

test("extra, duplicate, omitted or renamed attestation subjects cannot be published", (t) => {
  for (const mutation of ["extra", "duplicate", "omit", "rename"]) {
    const { directory, module } = prepared(t);
    const file = path.join(directory, module.provenanceName);
    const bundle = JSON.parse(fs.readFileSync(file, "utf8"));
    const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString("utf8"));
    if (mutation === "extra") statement.subject.push({ name: "unexpected.exe", digest: { sha256: "b".repeat(64) } });
    if (mutation === "duplicate") statement.subject[0] = statement.subject[1];
    if (mutation === "omit") statement.subject.pop();
    if (mutation === "rename") statement.subject[0].name = "renamed.exe";
    bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
    fs.writeFileSync(file, JSON.stringify(bundle));
    assert.throws(() => module.verifyReleaseAttestations(directory, version, identity.repository, commit), /subject set does not match/);
  }
});

test("unsigned CI requires the same complete platform payload and never claims the release workflow identity", (t) => {
  const directory = fixture(t), calls = [];
  for (const architecture of ["x64", "arm64"]) fs.rmSync(path.join(directory, `Umbratic-${version}-${architecture}-windows-provenance.json`));
  const module = helper((command, args) => { calls.push(args); });
  const files = module.prepareAttestation(directory, version, "ci", commit);
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-ci-evidence-"));
  t.after(() => fs.rmSync(evidence, { recursive: true, force: true }));
  const bundle = path.join(evidence, "bundle.jsonl");
  fs.writeFileSync(bundle, "mock verifier input");
  module.verifyAttestations(files.map((name) => path.join(directory, name)), bundle, { ...identity, workflow: "verify.yml" });
  assert.equal(calls.length, 8);
  assert.ok(calls.every((args) => args[args.indexOf("--cert-identity") + 1].endsWith("/verify.yml@refs/heads/main")));
});

test("evidence reads reject an oversized or replaced opened file without leaking its descriptor", (t) => {
  const { directory, module } = prepared(t);
  const bundle = path.join(directory, module.provenanceName);
  fs.truncateSync(bundle, 16 * 1024 * 1024 + 1);
  assert.throws(() => module.verifyAttestationSubjects([], bundle), /Invalid bounded release evidence/);
  fs.writeFileSync(bundle, "original evidence");
  let opened, closed = false;
  const raced = helper(() => "", { ...fs,
    openSync(file, ...options) {
      const descriptor = fs.openSync(file, ...options);
      if (file === bundle) {
        opened = descriptor;
        fs.renameSync(bundle, `${bundle}.old`);
        fs.writeFileSync(bundle, "replaced evidence");
      }
      return descriptor;
    },
    closeSync(descriptor) { if (descriptor === opened) closed = true; return fs.closeSync(descriptor); },
  });
  assert.throws(() => raced.verifyAttestationSubjects([], bundle), /Invalid bounded release evidence/);
  assert.equal(closed, true);
  assert.throws(() => fs.fstatSync(opened), /EBADF/);
  const growing = helper(() => "", { ...fs,
    fstatSync(descriptor) {
      const stat = fs.fstatSync(descriptor);
      fs.appendFileSync(bundle, "growth");
      return stat;
    },
  });
  assert.throws(() => growing.verifyAttestationSubjects([], bundle), /changed while reading/);
});

test("tamper negative control requires cryptographic rejection, preserves original bytes and cleans temporary files", (t) => {
  let temporary;
  const { directory, module } = prepared(t, (command, args) => {
    temporary = args[2];
    assert.notEqual(artifacts.hashFile(temporary, "sha256", "hex"), artifacts.hashFile(path.join(directory, `Umbratic-${version}-x64.exe`), "sha256", "hex"));
    throw Object.assign(new Error("verification rejected"), { status: 1, stderr: 'Error: verifying with issuer "GitHub, Inc."\n' });
  });
  const original = path.join(directory, `Umbratic-${version}-x64.exe`), before = fs.readFileSync(original);
  module.verifyTamperedAttestationRejection(original, path.join(directory, module.provenanceName), identity);
  assert.deepEqual(fs.readFileSync(original), before);
  assert.equal(fs.existsSync(temporary), false);
});

test("network errors, tool failures and timeouts do not count as tamper rejection", (t) => {
  for (const failure of [Object.assign(new Error("timeout"), { status: 1, signal: "SIGTERM", stderr: 'Error: verifying with issuer "GitHub, Inc."' }),
    Object.assign(new Error("network"), { status: 1, stderr: "Loading trusted roots failed" })]) {
    const { directory, module } = prepared(t, () => { throw failure; });
    assert.throws(() => module.verifyTamperedAttestationRejection(path.join(directory, `Umbratic-${version}-x64.exe`), path.join(directory, module.provenanceName), identity), /timeout|network/);
  }
  const { directory, module } = prepared(t);
  assert.throws(() => module.verifyTamperedAttestationRejection(path.join(directory, `Umbratic-${version}-x64.exe`), path.join(directory, module.provenanceName), identity), /accepted tampered/);
});

test("the CI entrypoint verifies the actual full set and rejects PR, non-main and wrong-checkout identities", (t) => {
  const directory = fixture(t);
  for (const architecture of ["x64", "arm64"]) fs.rmSync(path.join(directory, `Umbratic-${version}-${architecture}-windows-provenance.json`));
  let calls = 0;
  const module = helper((command, args) => {
    calls++;
    if (args[2].includes("umbratic-attestation-negative-")) throw Object.assign(new Error("digest rejected"), {
      status: 1, stderr: 'Error: verifying with issuer "GitHub, Inc."\n',
    });
    return "";
  });
  const files = module.prepareAttestation(directory, version, "ci", commit);
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-ci-bundle-"));
  t.after(() => fs.rmSync(evidence, { recursive: true, force: true }));
  const bundle = path.join(evidence, "bundle.jsonl");
  fs.writeFileSync(bundle, JSON.stringify({ dsseEnvelope: { payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify({
    _type: "https://in-toto.io/Statement/v1", predicateType: "https://slsa.dev/provenance/v1",
    subject: files.map((name) => ({ name, digest: { sha256: artifacts.hashFile(path.join(directory, name), "sha256", "hex") } })),
  })).toString("base64") } }));
  const execute = (patch = {}, checkout = commit) => loadTypeScriptModule(new URL("../../../scripts/ci/verify-ci-attestation.ts", import.meta.url), {
    globals: { process: { env: { GITHUB_SHA: commit, GITHUB_REPOSITORY: identity.repository, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", ATTESTATION_BUNDLE: bundle, ...patch } }, console: { log() {} } },
    mocks: { "./release-attestations.ts": module, "./release-artifacts.ts": artifacts,
      "node:path": { ...path, resolve: (...parts) => parts[0] === "target/release/upload" ? directory : path.resolve(...parts) },
      "node:child_process": { execFileSync: () => checkout } },
  });
  execute();
  assert.equal(calls, 9);
  assert.throws(() => execute({ GITHUB_EVENT_NAME: "pull_request" }), /trusted main push/);
  assert.throws(() => execute({ GITHUB_REF: "refs/heads/untrusted" }), /trusted main push/);
  assert.throws(() => execute({}, "b".repeat(40)), /checkout identity/);
  assert.equal(calls, 9);
});
