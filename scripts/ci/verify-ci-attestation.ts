// This proves unsigned CI provenance, never release signing or notarization.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { releaseArtifactNames, verifyExactAssetSet } from "./release-artifacts.ts";
import { checksums, checksumName, verifyAttestations, verifyAttestationSubjects, verifyTamperedAttestationRejection } from "./release-attestations.ts";

const directory = path.resolve("target/release/upload");
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const files = releaseArtifactNames(directory, version);
verifyExactAssetSet(directory, [...files, checksumName]);
if (fs.readFileSync(path.join(directory, checksumName), "utf8") !== checksums(directory, files)) throw new Error("CI checksum mismatch.");
const commit = process.env.GITHUB_SHA!;
if (execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== commit) throw new Error("CI checkout identity mismatch.");
const identity = { repository: process.env.GITHUB_REPOSITORY!, commit, sourceRef: "refs/heads/main", workflow: "verify.yml" as const };
if (process.env.GITHUB_EVENT_NAME !== "push" || process.env.GITHUB_REF !== identity.sourceRef) throw new Error("CI attestations require a trusted main push.");
const bundle = process.env.ATTESTATION_BUNDLE!;
verifyAttestations([...files, checksumName].map((name) => path.join(directory, name)), bundle, identity);
verifyAttestationSubjects([...files, checksumName].map((name) => path.join(directory, name)), bundle);
verifyTamperedAttestationRejection(path.join(directory, files.find((name) => name.endsWith(".exe"))!), bundle, identity);
console.log("Verified unsigned CI installer provenance and tamper rejection.");
