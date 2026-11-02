import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { hashFile, releaseArtifactNames, verifyExactAssetSet, verifyReleaseArtifacts } from "./release-artifacts.ts";

export const checksumName = "SHA256SUMS";
export const provenanceName = "release-provenance.jsonl";

/** Bound the opened file itself, including replacement and growth checks. */
function readEvidence(file: string): string {
  const descriptor = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(descriptor);
    const name = fs.lstatSync(file);
    if (!stat.isFile() || !name.isFile() || stat.dev !== name.dev || stat.ino !== name.ino
        || stat.size === 0 || stat.size > 16 * 1024 * 1024) throw new Error("Invalid bounded release evidence file.");
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length !== stat.size) throw new Error("Release evidence changed while reading.");
    return bytes.subarray(0, length).toString("utf8");
  } finally { fs.closeSync(descriptor); }
}

type Identity = {
  repository: string;
  commit: string;
  sourceRef: string;
  workflow: "release.yml" | "verify.yml";
};

export function checksums(directory: string, files: readonly string[]): string {
  return [...files].sort().map((name) => `${hashFile(path.join(directory, name), "sha256", "hex")}  ${name}\n`).join("");
}

function signedReleaseFiles(directory: string, releaseVersion: string): string[] {
  return [...releaseArtifactNames(directory, releaseVersion),
    `Umbratic-${releaseVersion}-x64-windows-provenance.json`,
    `Umbratic-${releaseVersion}-arm64-windows-provenance.json`].sort();
}

function verifyWindowsProvenance(directory: string, releaseVersion: string, commit: string): void {
  for (const architecture of ["x64", "arm64"]) {
    const file = path.join(directory, `Umbratic-${releaseVersion}-${architecture}-windows-provenance.json`);
    const record = JSON.parse(readEvidence(file));
    const installer = `Umbratic-${releaseVersion}-${architecture}.exe`;
    if (record.sourceCommit !== commit || record.architecture !== architecture || record.version !== releaseVersion
        || record.installer?.name !== installer
        || record.installer?.sha256 !== hashFile(path.join(directory, installer), "sha256", "hex")
        || !Array.isArray(record.files) || record.files.length === 0) {
      throw new Error(`Windows provenance does not match the release: ${architecture}.`);
    }
  }
}

/** Run before attestation generation, while the directory contains only payloads. */
export function prepareAttestation(directory: string, releaseVersion: string, kind: "release" | "ci", commit: string): string[] {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Invalid attestation source commit.");
  const files = kind === "release" ? signedReleaseFiles(directory, releaseVersion) : verifyReleaseArtifacts(directory, releaseVersion);
  verifyExactAssetSet(directory, files);
  if (kind === "release") verifyWindowsProvenance(directory, releaseVersion, commit);
  fs.writeFileSync(path.join(directory, checksumName), checksums(directory, files), { flag: "wx" });
  return [...files, checksumName];
}

/** Delegate cryptographic, certificate and digest checks to GitHub's verifier. */
export function verifyAttestations(files: readonly string[], bundle: string, identity: Identity): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(identity.repository)
      || !/^[0-9a-f]{40}$/.test(identity.commit)
      || !/^refs\/heads\/[A-Za-z0-9_./-]+$/.test(identity.sourceRef)
      || !["release.yml", "verify.yml"].includes(identity.workflow)) throw new Error("Invalid attestation identity.");
  readEvidence(bundle);
  const workflow = `${identity.repository}/.github/workflows/${identity.workflow}`;
  for (const file of files) {
    execFileSync("gh", ["attestation", "verify", file,
      "--bundle", bundle,
      "--repo", identity.repository,
      "--predicate-type", "https://slsa.dev/provenance/v1",
      "--cert-oidc-issuer", "https://token.actions.githubusercontent.com",
      "--cert-identity", `https://github.com/${workflow}@${identity.sourceRef}`,
      "--signer-workflow", workflow,
      "--signer-digest", identity.commit,
      "--source-digest", identity.commit,
      "--source-ref", identity.sourceRef,
      "--deny-self-hosted-runners"], { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
  }
}

/** The one signed statement must name exactly the published bytes, without extras. */
export function verifyAttestationSubjects(files: readonly string[], bundle: string): void {
  const envelope = JSON.parse(readEvidence(bundle)).dsseEnvelope;
  if (envelope?.payloadType !== "application/vnd.in-toto+json" || typeof envelope.payload !== "string") {
    throw new Error("Invalid attestation statement envelope.");
  }
  const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  const expected = new Map(files.map((file) => [path.basename(file), hashFile(file, "sha256", "hex")]));
  if (expected.size !== files.length || statement._type !== "https://in-toto.io/Statement/v1"
      || statement.predicateType !== "https://slsa.dev/provenance/v1"
      || !Array.isArray(statement.subject) || statement.subject.length !== expected.size) {
    throw new Error("Attestation subject set does not match the complete payload.");
  }
  for (const subject of statement.subject) {
    if (!expected.has(subject.name) || subject.digest?.sha256 !== expected.get(subject.name)
        || Object.keys(subject.digest).length !== 1) throw new Error("Attestation subject set does not match the complete payload.");
    expected.delete(subject.name);
  }
}

/** Only a real cryptographic verification failure counts as the negative proof. */
export function verifyTamperedAttestationRejection(file: string, bundle: string, identity: Identity): void {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-attestation-negative-"));
  try {
    const changed = path.join(temporary, path.basename(file));
    fs.copyFileSync(file, changed);
    fs.appendFileSync(changed, "tampered attestation negative control");
    let rejected = false;
    try { verifyAttestations([changed], bundle, identity); } catch (error) {
      // gh wraps only the offline Sigstore verifier's failure with this text.
      // TUF/network initialization, policy and process errors have other paths.
      if (error.status !== 1 || error.signal
          || !/^Error: verifying with issuer "(?:GitHub, Inc\.|sigstore\.dev)"\s*$/m.test(String(error.stderr))) throw error;
      rejected = true;
    }
    if (!rejected) throw new Error("Attestation verifier accepted tampered installer bytes.");
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

export function verifyReleaseAttestations(directory: string, releaseVersion: string, repository: string, commit: string): string[] {
  const files = signedReleaseFiles(directory, releaseVersion);
  verifyExactAssetSet(directory, [...files, checksumName, provenanceName]);
  verifyWindowsProvenance(directory, releaseVersion, commit);
  if (fs.readFileSync(path.join(directory, checksumName), "utf8") !== checksums(directory, files)) {
    throw new Error("Release SHA256SUMS does not match the complete payload.");
  }
  verifyAttestations([...files, checksumName].map((name) => path.join(directory, name)), path.join(directory, provenanceName), {
    repository, commit, sourceRef: "refs/heads/main", workflow: "release.yml",
  });
  verifyAttestationSubjects([...files, checksumName].map((name) => path.join(directory, name)), path.join(directory, provenanceName));
  return [...files, checksumName, provenanceName].sort();
}
