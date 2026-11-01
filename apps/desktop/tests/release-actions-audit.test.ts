import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import test from "node:test";
import { verifyActionControls, verifyActionBlob, actionPackages, reviewActionFindings } from "../../../scripts/audit-release-actions.ts";
import { validateOsvBatch } from "../../../scripts/audit-managed-runtimes.ts";

const review = JSON.parse(fs.readFileSync(new URL("../../../third_party/release-actions-security.json", import.meta.url), "utf8"));
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

function controls() {
  const fixture = structuredClone(review);
  const sources = new Map(Object.keys(fixture.controls).map((name) => [name, Buffer.from(
    name.endsWith(".yml") ? fixture.actions.map((action) => `uses: ${action.repository}@${action.commit}`).join("\n") : name,
  )]));
  for (const [name, source] of sources) fixture.controls[name] = hash(source);
  return { fixture, sources };
}

test("changing an applicability control, omitting one or changing an action pin requires review", () => {
  const { fixture, sources } = controls();
  verifyActionControls(fixture, (name) => sources.get(name));
  sources.set("scripts/ci/release-attestations.ts", Buffer.from("changed certificate policy"));
  assert.throws(() => verifyActionControls(fixture, (name) => sources.get(name)), /control changed/);
  const other = controls();
  delete other.fixture.controls["scripts/ci/windows-signing.ts"];
  assert.throws(() => verifyActionControls(other.fixture, (name) => other.sources.get(name)), /Incomplete/);
  const changed = controls();
  changed.fixture.actions[0].commit = "b".repeat(40);
  assert.throws(() => verifyActionControls(changed.fixture, (name) => changed.sources.get(name)), /Unreviewed action revision/);
});

test("an altered action bundle or unrecorded blob fails source identity verification", () => {
  const action = structuredClone(review.actions[0]);
  action.blobs["dist/index.js"] = hash("reviewed source");
  verifyActionBlob(action, "dist/index.js", Buffer.from("reviewed source"));
  assert.throws(() => verifyActionBlob(action, "dist/index.js", Buffer.from("altered source")), /blob changed/);
  assert.throws(() => verifyActionBlob(action, "other.js", Buffer.from("reviewed source")), /blob changed/);
});

test("the production lock graph is queried exactly; dev-only packages are not misrepresented as bundled runtime", () => {
  const packages = actionPackages(review.actions[0], { "package-lock.json": Buffer.from(JSON.stringify({ packages: {
    "": { name: "action", version: "1.0.0" },
    "node_modules/example": { version: "2.0.0" },
    "node_modules/parent/node_modules/example": { version: "2.0.0" },
    "node_modules/dev-only": { version: "3.0.0", dev: true },
  } })) });
  assert.deepEqual(packages, [{ name: "example", version: "2.0.0" }]);
  assert.throws(() => actionPackages(review.actions[1], { "index.js": Buffer.from("different embedded dependency") }), /identity changed/);
});

test("new, modified, duplicate or removed advisory matches fail instead of silently inheriting a package exemption", () => {
  const entry = review.actions[0].findings[0];
  const action = { ...review.actions[0], findings: [entry] };
  const packages = [{ name: entry.package, version: entry.version }];
  assert.equal(reviewActionFindings(action, packages, [[{ id: entry.id, modified: entry.modified }]]).length, 1);
  assert.throws(() => reviewActionFindings(action, packages, [[{ id: "GHSA-new-unreviewed", modified: entry.modified }]]), /New or changed/);
  assert.throws(() => reviewActionFindings(action, packages, [[{ id: entry.id, modified: "2026-11-02T00:00:00Z" }]]), /New or changed/);
  assert.throws(() => reviewActionFindings(action, packages, [[{ id: entry.id, modified: entry.modified }, { id: entry.id, modified: entry.modified }]]), /New or changed/);
  assert.throws(() => reviewActionFindings(action, packages, [[]]), /inventory changed/);
});

test("partial or paginated advisory responses cannot establish an action audit", () => {
  assert.throws(() => validateOsvBatch({ results: [{ next_page_token: "more" }] }, 1), /paginated/);
  assert.throws(() => validateOsvBatch({ results: [{ error: "unavailable" }] }, 1), /erroneous/);
  assert.throws(() => validateOsvBatch({ results: [] }, 1), /incomplete/);
});
