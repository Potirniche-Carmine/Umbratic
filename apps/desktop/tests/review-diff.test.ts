import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const review = loadTypeScriptModule(new URL("../src/shared/reviewDiff.ts", import.meta.url));
const plain = (value) => JSON.parse(JSON.stringify(value));

test("HEAD status parsing includes only staged, unstaged, and untracked paths", () => {
  const output = [
    " M src/unstaged.ts",
    "M  src/staged.ts",
    "MM src/both.ts",
    "?? notes/new file.md",
    "R  src/renamed.ts",
    "src/original.ts",
    "",
  ].join("\0");
  assert.deepEqual(plain(review.parseGitPorcelainPaths(output)), [
    "notes/new file.md",
    "src/both.ts",
    "src/renamed.ts",
    "src/staged.ts",
    "src/unstaged.ts",
  ]);
});

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

test("alignment pairs matching lines when structured hunks list additions first", () => {
  const file = review.parseReviewPatch([
    "diff --git a/hello.py b/hello.py",
    "--- a/hello.py",
    "+++ b/hello.py",
    "@@ -1,1 +1,2 @@",
    "+for _ in range(5):",
    "+    print(\"Hello Carmine!\")",
    "-print(\"Hello Carmine!\")",
  ].join("\n"));
  const rows = review.alignReviewFile(file);
  assert.deepEqual(plain(rows.map((row) => row.kind)), ["addition", "modification"]);
  assert.equal(rows[1].left.content, "print(\"Hello Carmine!\")");
  assert.equal(rows[1].right.content, "    print(\"Hello Carmine!\")");
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

test("alignment avoids misleading intra-line fragments for asymmetric rewrites", () => {
  const file = review.parseReviewPatch([
    "diff --git a/plan.md b/plan.md",
    "--- a/plan.md",
    "+++ b/plan.md",
    "@@ -1,1 +1,1 @@",
    "-Title tag on every page",
    "+The site already has solid SEO foundations in place: every content page carries a title tag and most pages include meta descriptions.",
  ].join("\n"));
  const rows = review.alignReviewFile(file);
  assert.equal(rows[0].kind, "modification");
  assert.equal(rows[0].left.spans, undefined);
  assert.equal(rows[0].right.spans, undefined);
});

test("intra-line highlighting stays focused on a close word edit", () => {
  const file = review.parseReviewPatch([
    "diff --git a/settings.ts b/settings.ts",
    "--- a/settings.ts",
    "+++ b/settings.ts",
    "@@ -1,1 +1,1 @@",
    '-const field = "filePath";',
    '+const field = "file_path";',
  ].join("\n"));
  const row = review.alignReviewFile(file)[0];

  assert.equal(row.kind, "modification");
  assert.deepEqual(plain(row.left.spans.map((span) => span.changed)), [false, true, false]);
  assert.deepEqual(plain(row.right.spans.map((span) => span.changed)), [false, true, false]);
});

test("structural rewrites do not show unstable word fragments", () => {
  const file = review.parseReviewPatch([
    "diff --git a/tools.rs b/tools.rs",
    "--- a/tools.rs",
    "+++ b/tools.rs",
    "@@ -1,2 +1,5 @@",
    '-"read" => vec![string_arg(input, &["filePath", "path"])],',
    '-"write" => vec![string_arg(input, &["filePath", "path"])],',
    '+"read" => vec![string_arg(',
    "+    input,",
    '+    &["filePath", "file_path", "path", "directory"],',
    "+)],",
    '+"write" => vec![string_arg(input, &["filePath", "file_path", "path"])],',
  ].join("\n"));
  const rows = review.alignReviewFile(file);

  assert.equal(rows.length, 5);
  assert.equal(rows.some((row) => row.left.spans || row.right.spans), false);
});

test("large replacement blocks use the bounded alignment path", () => {
  const deletions = Array.from({ length: 160 }, (_, index) => `-old call ${index}`);
  const additions = Array.from({ length: 500 }, (_, index) => `+new call ${index}`);
  const file = review.parseReviewPatch([
    "diff --git a/large.ts b/large.ts",
    "--- a/large.ts",
    "+++ b/large.ts",
    "@@ -1,160 +1,500 @@",
    ...deletions,
    ...additions,
  ].join("\n"));
  const rows = review.alignReviewFile(file);

  assert.equal(rows.length, 500);
  assert.equal(rows.some((row) => row.left.spans || row.right.spans), false);
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

test("malformed review patches normalize without throwing", () => {
  const malformed = review.normalizeReviewFile({ path: "odd.txt", patch: "not a patch" });
  assert.equal(malformed.path, "odd.txt");
  assert.deepEqual(plain(malformed.hunks), []);
  assert.equal(typeof malformed.contentHash, "string");
});

test("oversized review patches keep counters without creating renderable rows", () => {
  const body = Array.from({ length: 5_100 }, (_, index) => `+line ${index}`);
  const file = review.parseReviewPatch([
    "diff --git a/large.txt b/large.txt",
    "--- /dev/null",
    "+++ b/large.txt",
    "@@ -0,0 +1,5100 @@",
    ...body,
  ].join("\n"));

  assert.equal(file.tooLarge, true);
  assert.equal(file.additions, 5_100);
  assert.equal(file.hunks.length, 0);
  assert.equal(review.alignReviewFile(file).length, 0);
});

test("hunk gaps report the omitted unchanged lines", () => {
  const first = { oldStart: 6, oldCount: 5, newStart: 6, newCount: 5 };
  const second = { oldStart: 22, oldCount: 5, newStart: 24, newCount: 5 };

  assert.equal(review.hiddenLinesBeforeHunk(undefined, first), 5);
  assert.equal(review.hiddenLinesBeforeHunk(first, second), 13);
});

test("buildTextDiff produces a patience unified patch for local snapshots", () => {
  const file = review.buildTextDiff("notes.txt", "alpha\nbeta\n", "alpha\ngamma\n");
  assert.equal(file?.path, "notes.txt");
  assert.equal(file?.status, "modified");
  assert.match(file?.patch ?? "", /diff --git a\/notes\.txt b\/notes\.txt/);
  assert.match(file?.patch ?? "", /-beta/);
  assert.match(file?.patch ?? "", /\+gamma/);
  assert.equal(file?.hunks.length, 1);
});


