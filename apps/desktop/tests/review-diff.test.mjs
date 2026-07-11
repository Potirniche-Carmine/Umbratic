import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const review = loadTypeScriptModule(new URL("../src/shared/reviewDiff.ts", import.meta.url));
const plain = (value) => JSON.parse(JSON.stringify(value));

test("normalized review patches preserve hunks, context, counters, and stable ids", () => {
  const patch = [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -10,3 +10,4 @@ function run() {",
    " const id = oldId;",
    "-client.run(oldId);",
    "+client.run(newId);",
    "+log(id);",
    " return id;",
    "\\ No newline at end of file",
  ].join("\n");
  const file = review.parseReviewPatch(patch);
  assert.equal(file.path, "src/app.ts");
  assert.equal(file.additions, 2);
  assert.equal(file.deletions, 1);
  assert.equal(file.hunks.length, 1);
  assert.deepEqual(plain(file.hunks[0].lines.map((line) => [line.origin, line.oldLine, line.newLine])), [
    ["context", 10, 10],
    ["deletion", 11, null],
    ["addition", null, 11],
    ["addition", null, 12],
    ["context", 12, 13],
  ]);
  const moved = review.parseReviewPatch(patch.replace("@@ -10,3 +10,4", "@@ -20,3 +20,4"));
  assert.equal(file.hunks[0].id, moved.hunks[0].id);
});

test("alignment pairs confident replacements, pads insertions, and reconstructs intra-line text", () => {
  const file = review.parseReviewPatch([
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,3 @@",
    "-client.run(oldId);",
    "+client.run(newId);",
    "+notify();",
    " tail();",
  ].join("\n"));
  const rows = review.alignReviewFile(file);
  assert.deepEqual(plain(rows.map((row) => row.kind)), ["modification", "addition", "context"]);
  assert.equal(rows[0].left.spans.map((span) => span.text).join(""), "client.run(oldId);");
  assert.equal(rows[0].right.spans.map((span) => span.text).join(""), "client.run(newId);");
  assert.equal(rows[0].left.spans.some((span) => span.changed && span.text === "oldId"), true);
  assert.equal(rows[1].left.origin, "empty");
});

test("alignment keeps a blank-line replacement on one visual row", () => {
  const file = review.parseReviewPatch([
    "diff --git a/notes.md b/notes.md",
    "--- a/notes.md",
    "+++ b/notes.md",
    "@@ -10,2 +10,2 @@",
    "-",
    "+hello",
    " # Heading",
  ].join("\n"));
  const rows = review.alignReviewFile(file);
  assert.deepEqual(plain(rows.map((row) => row.kind)), ["modification", "context"]);
  assert.equal(rows[0].left.line, 10);
  assert.equal(rows[0].right.line, 10);
  assert.equal(rows[0].left.content, "");
  assert.equal(rows[0].right.content, "hello");
});

test("added, renamed, and binary metadata normalize safely", () => {
  const renamed = review.parseReviewPatch([
    "diff --git a/old name.txt b/new name.txt",
    "similarity index 100%",
    "rename from old name.txt",
    "rename to new name.txt",
  ].join("\n"), "new name.txt");
  assert.equal(renamed.status, "renamed");
  assert.equal(renamed.oldPath, "old name.txt");
  assert.equal(renamed.path, "new name.txt");

  const binary = review.parseReviewPatch("diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ");
  assert.equal(binary.binary, true);
  assert.equal(binary.status, "binary");
});

test("malformed input and legacy review records normalize without throwing", () => {
  const malformed = review.normalizeReviewFile({ path: "odd.txt", diff: "not a patch" });
  assert.equal(malformed.path, "odd.txt");
  assert.deepEqual(plain(malformed.hunks), []);
  assert.equal(typeof malformed.contentHash, "string");
});
