import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const review = loadTypeScriptModule(new URL("../src/shared/documentReview.ts", import.meta.url));

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    documentPath: ".umbratic/artifacts/docx/proposal.docx",
    title: "Proposal",
    blocks: [
      { id: "title", style: "title", text: "Proposal" },
      { id: "opening", style: "paragraph", text: "First sentence. Second sentence." },
    ],
    ...overrides,
  };
}

test("document review snapshots validate and normalize task-owned preview content", () => {
  const parsed = review.parseDocumentReviewSnapshot(snapshot({
    title: " Proposal\r\n",
    blocks: [
      { id: "title", style: "title", text: "Proposal" },
      { id: "opening", style: "paragraph", text: "First sentence.\r\nSecond sentence." },
    ],
  }), ".umbratic/artifacts/docx/proposal.docx");
  assert.equal(parsed.title, "Proposal");
  assert.equal(parsed.blocks[1].text, "First sentence. Second sentence.");
  assert.equal(review.documentReviewSidecarPath(parsed.documentPath), ".umbratic/artifacts/docx/proposal.docx.review.json");
  assert.equal(review.isDocumentReviewSidecarPath(".umbratic/artifacts/docx/proposal.docx.review.json"), true);
});

test("document review snapshots reject unknown fields, mismatches, duplicate ids, and unsafe paths", () => {
  assert.throws(() => review.parseDocumentReviewSnapshot(snapshot({ extra: true })), /unsupported field/);
  assert.throws(() => review.parseDocumentReviewSnapshot(snapshot(), ".umbratic/artifacts/docx/other.docx"), /does not match/);
  assert.throws(() => review.parseDocumentReviewSnapshot(snapshot({
    blocks: [
      { id: "same", style: "title", text: "Proposal" },
      { id: "same", style: "paragraph", text: "Body" },
    ],
  })), /duplicate id/);
  assert.throws(() => review.parseDocumentReviewSnapshot(snapshot({ documentPath: "../proposal.docx" })), /outside/);
});
