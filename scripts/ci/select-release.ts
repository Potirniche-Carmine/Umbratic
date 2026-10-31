import fs from "node:fs";
import { selectVerifiedReleaseRun } from "./release-source.ts";
import { execFileSync } from "node:child_process";

const repository = process.env.GITHUB_REPOSITORY!;
function api(endpoint: string) {
  return JSON.parse(execFileSync("gh", ["api", endpoint], { encoding: "utf8" }));
}
if (process.env.GITHUB_REF !== "refs/heads/main") throw new Error("Releases must run from main.");
const main = api(`repos/${repository}/commits/main`).sha;
const runId = process.env.CI_RUN_ID;
const runs = runId ? [api(`repos/${repository}/actions/runs/${runId}`)]
  : api(`repos/${repository}/actions/workflows/verify.yml/runs?branch=main&event=push&status=success&per_page=20`).workflow_runs;
selectVerifiedReleaseRun(runs, main, repository);
const version = JSON.parse(execFileSync("git", ["show", `${main}:package.json`], { encoding: "utf8" })).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Releases require a stable semantic version.");
const tag = `v${version}`;
const releases = api(`repos/${repository}/releases?per_page=100`);
const existing = releases.find((release) => release.tag_name === tag);
if (existing && !existing.draft) {
  if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch") throw new Error(`${tag} is already published.`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT!, "prepare=false\n");
} else {
  const tags = api(`repos/${repository}/git/matching-refs/tags/${tag}`);
  if (tags.some((ref) => ref.ref === `refs/tags/${tag}` && ref.object.sha !== main)) {
    throw new Error(`${tag} already identifies another commit. Bump the version.`);
  }
  fs.appendFileSync(process.env.GITHUB_OUTPUT!, `prepare=true\ntag=${tag}\ncommit=${main}\n`);
}
