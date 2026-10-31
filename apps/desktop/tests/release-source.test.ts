import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { selectVerifiedReleaseRun } from "../../../scripts/ci/release-source.ts";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const main = "a".repeat(40);
const repository = "owner/Umbratic";
const verified = { head_sha: main, event: "push", head_branch: "main", head_repository: { full_name: repository },
  conclusion: "success", path: ".github/workflows/verify.yml" };

test("release selection accepts only a successful CI push for current main in this repository", () => {
  assert.equal(selectVerifiedReleaseRun([verified], main, repository), verified);
  const rejected = [
    { head_sha: "b".repeat(40) }, { event: "pull_request" }, { event: "workflow_dispatch" },
    { head_branch: "feature" }, { head_repository: { full_name: "fork/Umbratic" } },
    { conclusion: "failure" }, { conclusion: "cancelled" }, { path: ".github/workflows/unrelated.yml" },
  ];
  for (const patch of rejected) {
    assert.throws(() => selectVerifiedReleaseRun([{ ...verified, ...patch }], main, repository), /successful CI push/);
  }
  assert.throws(() => selectVerifiedReleaseRun([verified], "untrusted-output\n", repository), /Invalid main commit/);
});

test("release preflight reads the small main ref and preserves exact event identity", () => {
  const calls = [], output = [];
  const manifest = fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8");
  const tag = `v${JSON.parse(manifest).version}`;
  const execute = (eventCommit = main) => loadTypeScriptModule(new URL("../../../scripts/ci/select-release.ts", import.meta.url), {
    globals: { process: { env: { GITHUB_REPOSITORY: repository, GITHUB_REF: "refs/heads/main", GITHUB_SHA: eventCommit,
      CI_RUN_ID: "123", GITHUB_OUTPUT: "output" } } },
    mocks: {
      "./release-source.ts": { selectVerifiedReleaseRun },
      "node:fs": { appendFileSync: (file, value) => { assert.equal(file, "output"); output.push(value); } },
      "node:child_process": { execFileSync(command, args, options) {
        assert.equal(options.encoding, "utf8");
        assert.equal(Object.hasOwn(options, "maxBuffer"), false);
        if (command === "git") {
          assert.deepEqual(Array.from(args), ["show", `${main}:package.json`]);
          return manifest;
        }
        assert.equal(command, "gh");
        assert.equal(args[0], "api");
        calls.push(args[1]);
        // Commit details can exceed execFileSync's default output bound. The
        // branch ref supplies identity without downloading file patches.
        if (args[1].endsWith("/commits/main")) throw Object.assign(new Error("commit details exceed buffer"), { code: "ENOBUFS" });
        if (args[1] === `repos/${repository}/git/ref/heads/main`) return JSON.stringify({ object: { sha: main } });
        if (args[1] === `repos/${repository}/actions/runs/123`) return JSON.stringify(verified);
        if (args[1] === `repos/${repository}/releases?per_page=100` || args[1] === `repos/${repository}/git/matching-refs/tags/${tag}`) return "[]";
        throw new Error("Unexpected release API call");
      } },
    },
  });
  execute();
  assert.equal(calls[0], `repos/${repository}/git/ref/heads/main`);
  assert.deepEqual(output, [`prepare=true\ntag=${tag}\n`]);
  calls.length = output.length = 0;
  assert.throws(() => execute("b".repeat(40)), /no longer identifies current main/);
  assert.deepEqual(calls, [`repos/${repository}/git/ref/heads/main`]);
  assert.deepEqual(output, []);
});
