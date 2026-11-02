import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { verifyReleaseAttestations } from "./release-attestations.ts";
import { hashFile, publicReleaseArtifactNames } from "./release-artifacts.ts";

const repository = process.env.GITHUB_REPOSITORY!;
const commit = process.env.RELEASE_COMMIT!;
const tag = process.env.RELEASE_TAG!;
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
if (execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== commit) throw new Error("Release checkout does not match the trusted event commit.");
if (tag !== `v${version}` || !/^[0-9a-f]{40}$/.test(commit)) throw new Error("Invalid release identity.");
function gh(args: string[]) {
  return execFileSync("gh", args, { encoding: "utf8" });
}
function api(endpoint: string) { return JSON.parse(gh(["api", endpoint])); }
const directory = path.resolve("target/release/upload");
verifyReleaseAttestations(directory, version, repository, commit);
const files = publicReleaseArtifactNames(version);
const main = api(`repos/${repository}/git/ref/heads/main`).object.sha;
if (main !== commit) throw new Error("Main changed while packaging. Release the newest verified main instead.");
const releases = api(`repos/${repository}/releases?per_page=100`);
const existing = releases.find((release) => release.tag_name === tag);
if (existing && !existing.draft) throw new Error(`${tag} is already published; published assets are immutable.`);
const tags = api(`repos/${repository}/git/matching-refs/tags/${tag}`);
if (tags.some((ref) => ref.ref === `refs/tags/${tag}` && ref.object.sha !== commit)) throw new Error("Release tag points at another commit.");
const tuple = (value: string) => value.replace(/^v/, "").split(".").map(Number);
for (const release of releases.filter((release) => !release.draft && !release.prerelease && /^v\d+\.\d+\.\d+$/.test(release.tag_name))) {
  const current = tuple(version);
  const published = tuple(release.tag_name);
  const difference = current.map((part, index) => part - published[index]).find((part) => part !== 0) ?? 0;
  if (difference <= 0) throw new Error("A release cannot move the latest stable version backwards.");
}
const notes = `Windows x64 and ARM64 installers are unsigned. macOS builds are Developer ID signed and notarized. [Code signing policy](https://github.com/${repository}/blob/${commit}/CODE_SIGNING_POLICY.md)`;
if (!existing) gh(["release", "create", tag, "--repo", repository, "--target", commit, "--title", `Umbratic ${version}`, "--generate-notes", "--notes", notes, "--draft"]);
if (existing) {
  const allowed = new Set(files);
  const assets = api(`repos/${repository}/releases/${existing.id}/assets?per_page=100`);
  if (assets.some((asset) => !allowed.has(asset.name))) throw new Error("Existing draft contains unexpected assets. Remove the stale draft before retrying.");
  // A draft may not have a tag yet. Its saved target can otherwise create the
  // eventual tag from an older branch/commit despite our verified checkout.
  gh(["release", "edit", tag, "--repo", repository, "--target", commit, "--notes", notes, "--draft"]);
}
// Evidence and generated updater metadata stay in the workflow artifacts.
// The release stays a draft until every app download has uploaded and GitHub's
// digests match the verified bytes used by the app's updater.
gh(["release", "upload", tag, "--repo", repository, "--clobber", ...files.map((name) => path.join(directory, name))]);
const draft = api(`repos/${repository}/releases?per_page=100`).find((release) => release.tag_name === tag);
if (!draft?.draft) throw new Error("Release is no longer a draft.");
const uploaded = api(`repos/${repository}/releases/${draft.id}/assets?per_page=100`);
if (!Array.isArray(uploaded) || uploaded.length !== files.length
    || new Set(uploaded.map((asset) => asset.name)).size !== files.length
    || uploaded.some((asset) => !files.includes(asset.name) || asset.state !== "uploaded"
      || asset.size !== fs.statSync(path.join(directory, asset.name)).size
      || asset.digest !== `sha256:${hashFile(path.join(directory, asset.name), "sha256", "hex")}`)) {
  throw new Error("Uploaded release assets do not match the verified app downloads. The release remains a draft.");
}
if (api(`repos/${repository}/git/ref/heads/main`).object.sha !== commit) throw new Error("Main changed during upload. The release remains a draft.");
gh(["release", "edit", tag, "--repo", repository, "--target", commit, "--draft=false", "--latest"]);
console.log(`Published verified ${tag} from ${commit}.`);
