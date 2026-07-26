import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

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
  assert.match(output, /\*\*src\/app\.ts · Lines 12, 14\*\*/);
  assert.match(output, /\*\*src\/app\.ts · Lines 8\*\*/);
  assert.match(output, /> const next = value;/);
  assert.equal(comments.appendReviewFeedback(output, [comment({ lineNumbers: [12, 14] })]), output);
});

test("serialized review feedback becomes display-only message metadata", () => {
  const serialized = comments.appendReviewFeedback("Please tighten this loop.", [comment({ lineNumbers: [12, 14] })]);
  const visible = comments.visibleReviewPrompt(serialized);
  assert.equal(visible.text, "Please tighten this loop.");
  assert.deepEqual(JSON.parse(JSON.stringify(visible.feedback)), [{
    filePath: "src/app.ts",
    lineLabel: "Lines 12, 14",
    body: "Keep the gutters aligned when this wraps.",
    excerpt: "const next = value;",
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(comments.visibleReviewPrompt("Please address this review feedback:\n\nordinary text"))), {
    text: "Please address this review feedback:\n\nordinary text",
    feedback: [],
  });
});

test("review line labels collapse consecutive lines into ranges", () => {
  assert.equal(comments.reviewCommentLineLabel(comment({ lineNumbers: [4, 5, 6, 9] })), "Lines 4-6, 9");
});

test("document review feedback keeps its selected excerpt in the next prompt without paragraph numbers", () => {
  const documentComment = comment({
    filePath: ".umbratic/artifacts/docx/proposal.docx",
    hunkId: "document:proposal",
    startLine: 2,
    endLine: 2,
    lineNumbers: [2],
    excerpt: "First sentence.",
    documentSelection: {
      blockIds: ["opening"],
      sentenceIds: ["opening:sentence:1"],
      label: "Selected text",
    },
  });
  const serialized = comments.appendReviewFeedback("Revise the proposal.", [documentComment]);
  assert.match(serialized, /\*\*\.umbratic\/artifacts\/docx\/proposal\.docx · Selected text\*\*/);
  assert.deepEqual(JSON.parse(JSON.stringify(comments.visibleReviewPrompt(serialized))), {
    text: "Revise the proposal.",
    feedback: [{
      filePath: ".umbratic/artifacts/docx/proposal.docx",
      lineLabel: "Selected text",
      body: "Keep the gutters aligned when this wraps.",
      excerpt: "First sentence.",
    }],
  });
});

test("legacy document review labels remain readable", () => {
  const value = "Revise this.\n\nPlease address this review feedback:\n\n**.umbratic/artifacts/docx/proposal.docx · Paragraph 2 · Sentence 1**\n\n> First sentence.\n\nTighten this sentence.";
  assert.equal(comments.visibleReviewPrompt(value).feedback[0].body, "Tighten this sentence.");
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
