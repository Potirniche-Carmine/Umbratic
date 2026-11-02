import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as artifacts from "../../../scripts/ci/release-artifacts.ts";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const version = "0.0.1", commit = "a".repeat(40), repository = "owner/Umbratic";
function promotion(t, mutation = "") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-promotion-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "ci-input"), destination = path.join(root, "release");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, `Umbratic-${version}.dmg`), "unsigned Mac disk image");
  for (const [channel, name] of [["latest-mac.yml", `Umbratic-${version}.zip`],
    ["latest.yml", `Umbratic-${version}-x64.exe`], ["latest-arm64.yml", `Umbratic-${version}-arm64.exe`]]) {
    const file = path.join(source, name);
    fs.writeFileSync(file, `unsigned installer ${name}`);
    fs.writeFileSync(`${file}.blockmap`, `blockmap ${name}`);
    fs.writeFileSync(path.join(source, channel), JSON.stringify({ version, files: [{ url: name,
      size: fs.statSync(file).size, sha512: artifacts.hashFile(file, "sha512", "base64") }] }));
  }
  const verified = { id: 123, head_sha: mutation === "source" ? "b".repeat(40) : commit, event: "push",
    head_branch: "main", head_repository: { full_name: repository }, conclusion: "success", path: ".github/workflows/verify.yml" };
  const calls = [];
  let evidence;
  const execute = () => loadTypeScriptModule(new URL("../../../scripts/ci/promote-windows-release.ts", import.meta.url), {
    globals: { process: { platform: process.platform, env: { GITHUB_REPOSITORY: repository, GITHUB_SHA: commit, GITHUB_REF: "refs/heads/main", CI_RUN_ID: "123" } }, console: { log() {} } },
    mocks: {
      "./release-artifacts.ts": artifacts,
      "node:fs": { ...fs, readFileSync: (file, ...options) => file === "package.json" ? JSON.stringify({ version }) : fs.readFileSync(file, ...options) },
      "node:path": { ...path, resolve: (...parts) => parts[0] === "target/release/ci-input" ? source
        : parts[0] === "target/release/upload" ? destination : path.resolve(...parts) },
      "node:child_process": { execFileSync(command, args, options) {
        calls.push([...args]);
        if (command === "git") return commit;
        assert.equal(command, "gh");
        if (args[0] === "api") return JSON.stringify(verified);
        if (args[1] === "verify") {
          if (mutation === "signature") throw new Error("Cryptographic signature verification failed");
          return "";
        }
        assert.equal(args[1], "download");
        assert.equal(args[args.indexOf("--repo") + 1], repository);
        assert.equal(args[args.indexOf("--limit") + 1], "1");
        evidence = options.cwd;
        const subject = fs.readdirSync(source).map((name) => ({ name,
          digest: { sha256: artifacts.hashFile(path.join(source, name), "sha256", "hex") } }));
        if (mutation === "subjects") subject.pop();
        const statement = { _type: "https://in-toto.io/Statement/v1", predicateType: "https://slsa.dev/provenance/v1", subject };
        fs.writeFileSync(path.join(evidence, `sha256${process.platform === "win32" ? "-" : ":"}${artifacts.hashFile(args[2], "sha256", "hex")}.jsonl`), JSON.stringify({ dsseEnvelope: {
          payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
        } }));
        return "";
      } },
    },
  });
  return { execute, source, destination, calls, get evidence() { return evidence; } };
}

test("promotion verifies every trusted CI subject and preserves exact unsigned Windows bytes without promoting Mac", (t) => {
  const result = promotion(t);
  result.execute();
  const verification = result.calls.filter((args) => args[1] === "verify");
  assert.equal(verification.length, fs.readdirSync(result.source).length);
  for (const args of verification) {
    assert.equal(args[args.indexOf("--cert-identity") + 1], `https://github.com/${repository}/.github/workflows/verify.yml@refs/heads/main`);
    assert.equal(args[args.indexOf("--source-digest") + 1], commit);
    assert.equal(args[args.indexOf("--signer-digest") + 1], commit);
    assert.ok(args.includes("--deny-self-hosted-runners"));
  }
  assert.equal(fs.readdirSync(result.destination).length, 8);
  for (const name of fs.readdirSync(result.destination).filter((name) => !name.endsWith("-windows-provenance.json"))) {
    assert.deepEqual(fs.readFileSync(path.join(result.destination, name)), fs.readFileSync(path.join(result.source, name)));
    assert.ok(!/mac|dmg|zip/.test(name));
  }
  for (const architecture of ["x64", "arm64"]) {
    const record = JSON.parse(fs.readFileSync(path.join(result.destination, `Umbratic-${version}-${architecture}-windows-provenance.json`), "utf8"));
    assert.equal(record.signing, "unsigned");
    assert.equal(record.ciRunId, 123);
    assert.equal(record.sourceCommit, commit);
    assert.equal(record.files.length, 3);
  }
  assert.equal(fs.existsSync(result.evidence), false);
});

test("foreign source, failed signatures, or incomplete CI subjects cannot stage a release", (t) => {
  for (const mutation of ["source", "signature", "subjects"]) {
    const result = promotion(t, mutation);
    assert.throws(result.execute, /successful CI push|signature verification failed|subject set does not match/);
    assert.equal(fs.existsSync(result.destination), false);
    if (result.evidence) assert.equal(fs.existsSync(result.evidence), false);
  }
});
