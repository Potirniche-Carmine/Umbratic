// Explicit release policy: Windows installers are unsigned, promoted unchanged
// from authenticated current-main CI. macOS is signed in its own native job.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { hashFile, verifyUpdateChannel } from "./release-artifacts.ts";
import { prepareAttestation, verifyAttestations, verifyAttestationSubjects } from "./release-attestations.ts";
import { selectVerifiedReleaseRun } from "./release-source.ts";

const repository = process.env.GITHUB_REPOSITORY!;
const commit = process.env.GITHUB_SHA!;
const runId = process.env.CI_RUN_ID!;
if (process.env.GITHUB_REF !== "refs/heads/main" || !/^[1-9]\d*$/.test(runId)) throw new Error("Unsigned releases require a verified main CI run.");
if (execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== commit) throw new Error("Release checkout identity mismatch.");
const run = JSON.parse(execFileSync("gh", ["api", `repos/${repository}/actions/runs/${runId}`], { encoding: "utf8" }));
selectVerifiedReleaseRun([run], commit, repository);
if (String(run.id) !== runId) throw new Error("CI artifact run identity mismatch.");
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const source = path.resolve("target/release/ci-input");
const destination = path.resolve("target/release/upload");
const subjects = prepareAttestation(source, version, "ci", commit).map((name) => path.join(source, name));
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-promote-"));
try {
  const installer = path.join(source, `Umbratic-${version}-x64.exe`);
  execFileSync("gh", ["attestation", "download", installer, "--repo", repository,
    "--predicate-type", "https://slsa.dev/provenance/v1", "--limit", "1"], { cwd: evidence, encoding: "utf8", timeout: 60_000 });
  const bundle = path.join(evidence, `sha256${process.platform === "win32" ? "-" : ":"}${hashFile(installer, "sha256", "hex")}.jsonl`);
  verifyAttestations(subjects, bundle, { repository, commit, sourceRef: "refs/heads/main", workflow: "verify.yml" });
  verifyAttestationSubjects(subjects, bundle);
  fs.mkdirSync(destination, { recursive: true });
  if (fs.readdirSync(destination).length !== 0) throw new Error("Release staging directory must be empty.");
  for (const architecture of ["x64", "arm64"]) {
    const name = `Umbratic-${version}-${architecture}.exe`;
    const channel = architecture === "x64" ? "latest.yml" : "latest-arm64.yml";
    const names = verifyUpdateChannel(source, version, channel, name);
    if (fs.existsSync(path.join(source, `${name}.blockmap`))) names.push(`${name}.blockmap`);
    for (const asset of names) fs.copyFileSync(path.join(source, asset), path.join(destination, asset));
    fs.writeFileSync(path.join(destination, `Umbratic-${version}-${architecture}-windows-provenance.json`), JSON.stringify({
      version, sourceCommit: commit, architecture, signing: "unsigned", ciRunId: run.id,
      installer: { name, sha256: hashFile(path.join(source, name), "sha256", "hex") },
      files: names.sort().map((asset) => ({ path: asset, sha256: hashFile(path.join(source, asset), "sha256", "hex") })),
    }, null, 2) + "\n", { flag: "wx" });
  }
} finally { fs.rmSync(evidence, { recursive: true, force: true }); }
console.log(`Promoted authenticated unsigned Windows installers from CI run ${runId}.`);
