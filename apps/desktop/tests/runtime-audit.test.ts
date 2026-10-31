import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { reviewedDisposition, validateOsvBatch, verifyControlFiles } from "../../../scripts/audit-managed-runtimes.ts";

test("runtime advisories require the exact reviewed version and evaluated source/applicability evidence", () => {
  const verified = { joseSourceVerified: true, setuptoolsInstallVerified: true, openPgpImported: false };
  const jose = { ecosystem: "Go" as const, name: "github.com/go-jose/go-jose/v3", version: "v3.0.5" };
  assert.match(reviewedDisposition(jose, "GHSA-mgcc-cww5-fp2q", verified)!, /source backports/);
  assert.equal(reviewedDisposition(jose, "GHSA-mgcc-cww5-fp2q", { ...verified, joseSourceVerified: false }), undefined);
  assert.equal(reviewedDisposition(jose, "GHSA-unknown-new-finding", verified), undefined);
  assert.equal(reviewedDisposition({ ...jose, version: "v3.0.4" }, "GHSA-mgcc-cww5-fp2q", verified), undefined);
  const setuptools = { ecosystem: "PyPI" as const, name: "setuptools", version: "78.1.1" };
  assert.match(reviewedDisposition(setuptools, "GHSA-h35f-9h28-mq5c", verified)!, /Mac-only offline wheel/);
  assert.equal(reviewedDisposition(setuptools, "GHSA-h35f-9h28-mq5c", { ...verified, setuptoolsInstallVerified: false }), undefined);
  assert.equal(reviewedDisposition({ ...setuptools, version: "77.0.3" }, "GHSA-h35f-9h28-mq5c", verified), undefined);
  const cryptoModule = { ecosystem: "Go" as const, name: "golang.org/x/crypto", version: "v0.58.0" };
  assert.match(reviewedDisposition(cryptoModule, "GO-2026-5932", verified)!, /not imported/);
  assert.equal(reviewedDisposition(cryptoModule, "GO-2026-5932", { ...verified, openPgpImported: true }), undefined);
});

test("runtime applicability is invalidated by missing or changed executable installation controls", () => {
  const files = ["infrastructure/veil-console/deploy/build-metal-kit.py", "infrastructure/veil-console/internal/deployment/host.go",
    "infrastructure/veil-console/internal/deployment/package.go"];
  const original = Buffer.from("reviewed executable installation control");
  const hash = crypto.createHash("sha256").update(original).digest("hex");
  const proof = Object.fromEntries(files.map((name) => [name, hash]));
  assert.doesNotThrow(() => verifyControlFiles(proof, () => original));
  assert.throws(() => verifyControlFiles({}, () => original), /complete reviewed/);
  assert.throws(() => verifyControlFiles(proof, (name) => name.endsWith("host.go") ? Buffer.from("changed install command") : original), /require review/);
});

test("runtime advisory queries fail closed on partial results, errors and changed reviewed content", () => {
  const advisory = { id: "GHSA-mgcc-cww5-fp2q", modified: "2026-10-27T19:15:23.147827Z" };
  assert.deepEqual(validateOsvBatch({ results: [{}, { vulns: [advisory] }] }, 2), [[], [advisory]]);
  for (const data of [null, { results: [] }, { error: "partial", results: [{}] }, { results: [null] },
    { results: [{ error: { code: 429 } }] }, { results: [{ code: 429, message: "rate limited" }] },
    { results: [{ next_page_token: "more", vulns: [] }] },
    { results: [{ vulns: null }] }, { results: [{ vulns: ["invalid"] }] },
    { results: [{ vulns: [{ ...advisory, modified: "not a timestamp" }] }] }]) {
    assert.throws(() => validateOsvBatch(data, 1), /OSV/);
  }
  assert.throws(() => validateOsvBatch({ results: [{ vulns: [{ ...advisory, modified: "2026-10-31T00:00:00Z" }] }] }, 1), /changed and requires review/);
});
