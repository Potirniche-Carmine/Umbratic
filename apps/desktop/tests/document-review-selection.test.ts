import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const selection = loadTypeScriptModule(new URL("../src/renderer/review/documentReviewSelection.ts", import.meta.url));
const preview = {
  documentPath: ".umbratic/artifacts/docx/proposal.docx",
  title: "Proposal",
  blocks: [
    { id: "title", style: "title", text: "Proposal" },
    { id: "opening", style: "paragraph", text: "First sentence. Second sentence." },
    { id: "close", style: "paragraph", text: "Third sentence." },
  ],
};

test("document review selection segments sentences and labels focused selections", () => {
  const sentences = selection.segmentDocumentReview(preview);
  assert.deepEqual(sentences.map((sentence) => sentence.text), [
    "Proposal",
    "First sentence.",
    "Second sentence.",
    "Third sentence.",
  ]);
  const one = selection.documentReviewSelectionDetails(preview, [sentences[1].id]);
  assert.equal(one.label, "Selected text");
  assert.equal(one.excerpt, "First sentence.");
  const paragraph = selection.documentReviewSelectionDetails(preview, [sentences[1].id, sentences[2].id]);
  assert.equal(paragraph.label, "Selected text");
  const multiple = selection.documentReviewSelectionDetails(preview, [sentences[1].id, sentences[3].id]);
  assert.equal(multiple.label, "Selected text");
});
