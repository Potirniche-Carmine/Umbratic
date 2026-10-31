import assert from "node:assert/strict";
import test from "node:test";
import { selectVerifiedReleaseRun } from "../../../scripts/ci/release-source.ts";

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
