import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { hashFile, verifyReleaseArtifacts } from "./release-artifacts.ts";

const repository = process.env.GITHUB_REPOSITORY!;
const commit = process.env.RELEASE_COMMIT!;
const tag = process.env.RELEASE_TAG!;
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
if (tag !== `v${version}` || !/^[0-9a-f]{40}$/.test(commit)) throw new Error("Invalid release identity.");
function gh(args: string[]) {
  return execFileSync("gh", args, { encoding: "utf8" });
}
function api(endpoint: string) { return JSON.parse(gh(["api", endpoint])); }
const directory = path.resolve("target/release/upload");
const files = verifyReleaseArtifacts(directory, version);
const main = api(`repos/${repository}/commits/main`).sha;
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
const sums = files.map((name) => `${hashFile(path.join(directory, name), "sha256", "hex")}  ${name}`).join("\n");
fs.writeFileSync(path.join(directory, "SHA256SUMS"), `${sums}\n`);
if (!existing) gh(["release", "create", tag, "--repo", repository, "--target", commit, "--title", `Umbratic ${version}`, "--generate-notes", "--draft"]);
if (existing) {
  const allowed = new Set([...files, "SHA256SUMS"]);
  const assets = api(`repos/${repository}/releases/${existing.id}/assets?per_page=100`);
  if (assets.some((asset) => !allowed.has(asset.name))) throw new Error("Existing draft contains unexpected assets. Remove the stale draft before retrying.");
}
// The release stays a draft until every platform artifact and its metadata
// have uploaded; the public updater can never observe a partial release.
gh(["release", "upload", tag, "--repo", repository, "--clobber", ...files.map((name) => path.join(directory, name)), path.join(directory, "SHA256SUMS")]);
gh(["release", "edit", tag, "--repo", repository, "--draft=false", "--latest"]);
console.log(`Published verified ${tag} from ${commit}.`);
