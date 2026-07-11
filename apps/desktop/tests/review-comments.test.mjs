import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const review = loadTypeScriptModule(new URL("../src/shared/reviewDiff.ts", import.meta.url));
const comments = loadTypeScriptModule(new URL("../src/renderer/review/reviewComments.ts", import.meta.url));

function comment(overrides = {}) {
  return {
    id: "c-1",
    taskId: "task-1",
    patchHash: "old",
    filePath: "src/app.ts",
    hunkId: "h-1",
    side: "new",
    startLine: 12,
    endLine: 14,
    body: "Keep the gutters aligned when this wraps.",
    excerpt: "const next = value;",
    ...overrides,
  };
}

test("review feedback serialization uses visible source-side line labels and is deterministic", () => {
  const output = comments.serializeReviewComments([comment({ lineNumbers: [12, 14] }), comment({ id: "c-2", side: "old", startLine: 8, endLine: 8, excerpt: "" })]);
  assert.match(output, /\*\*src\/app\.ts · new lines 12, 14\*\*/);
  assert.match(output, /\*\*src\/app\.ts · old line 8\*\*/);
  assert.match(output, /> const next = value;/);
  assert.equal(comments.appendReviewFeedback(output, [comment({ lineNumbers: [12, 14] })]), output);
});

test("comment reconciliation survives offset-only hunk movement and marks changed hunks stale", () => {
  const first = review.parseReviewPatch("diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -12,1 +12,1 @@\n-old\n+new");
  const moved = review.parseReviewPatch("diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -22,1 +22,1 @@\n-old\n+new");
  const anchored = comment({ hunkId: first.hunks[0].id, startLine: 12, endLine: 12 });
  const sameContent = comments.reconcileReviewComments([anchored], [first], "next")[0];
  assert.equal(sameContent.stale, false);
  assert.equal(sameContent.patchHash, "next");
  const movedResult = comments.reconcileReviewComments([anchored], [moved], "later")[0];
  assert.equal(movedResult.stale, true);
  const changed = review.parseReviewPatch("diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -12,1 +12,1 @@\n-old\n+different");
  assert.equal(comments.reconcileReviewComments([anchored], [changed], "changed")[0].stale, true);
});
