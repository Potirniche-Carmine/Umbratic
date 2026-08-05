import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const pdfPrompt = loadTypeScriptModule(new URL("../src/main/pdfPrompt.ts", import.meta.url));

const inspection = (overrides = {}) => ({
  pdfType: "text_based",
  pageCount: 3,
  confidence: 0.92,
  pagesNeedingOcr: [],
  hasEncodingIssues: false,
  ocrRecommended: false,
  markdown: "--- Page 1 ---\n\nNative body text",
  estimatedTokens: 120,
  ...overrides,
});

function section(inspectionValue, renderResult, budgetTokens = 4000) {
  const renderCalls = [];
  const promise = pdfPrompt.pdfAttachmentPromptSection({
    inspect: async () => inspectionValue,
    renderImages: async (pageNumbers) => {
      renderCalls.push(pageNumbers ?? null);
      return renderResult;
    },
    fullAccessHint: "Complete extracted text: use read.",
    pageLimit: 12,
    textBudget: { remainingTokens: budgetTokens },
  });
  return promise.then((result) => ({ ...result, renderCalls }));
}

test("text-based PDFs inject the native extract and never rasterize", async () => {
  const result = await section(inspection(), { pageCount: 3, rendered: 3, parts: ["img"] });
  assert.equal(result.imageParts, null);
  assert.deepEqual(result.renderCalls, []);
  const text = result.lines.join("\n");
  assert.match(text, /native text layer \(3 pages\)/);
  assert.match(text, /no page images attached/);
  assert.match(text, /Native body text/);
  assert.match(text, /Complete extracted text: use read\./);
});

test("mixed PDFs extract text and rasterize only the OCR pages inside the vision window", async () => {
  const result = await section(
    inspection({ pdfType: "mixed", pageCount: 20, pagesNeedingOcr: [2, 5, 14] }),
    { pageCount: 20, rendered: 2, parts: ["page2", "page5"] },
  );
  assert.deepEqual(result.renderCalls, [[2, 5]]);
  assert.deepEqual(result.imageParts, ["page2", "page5"]);
  const text = result.lines.join("\n");
  assert.match(text, /partial text layer/);
  assert.match(text, /pages 2, 5 lack a text layer/);
  assert.match(text, /Native body text/);
});

test("scanned, garbled, low-confidence, and uninspectable PDFs fall back to the vision render", async () => {
  for (const value of [
    inspection({ pdfType: "scanned", pagesNeedingOcr: [1, 2, 3] }),
    inspection({ hasEncodingIssues: true }),
    inspection({ confidence: 0.4 }),
    null,
  ]) {
    const result = await section(value, { pageCount: 3, rendered: 3, parts: ["a", "b", "c"] });
    assert.deepEqual(result.renderCalls, [null], "vision render must run without page filtering");
    assert.deepEqual(result.imageParts, ["a", "b", "c"]);
    assert.match(result.lines.join("\n"), /rendered as images for the vision model/);
  }
});

test("vision fallback explains classification and encoding issues", async () => {
  const scanned = await section(inspection({ pdfType: "scanned", pagesNeedingOcr: [1] }), {
    pageCount: 14,
    rendered: 12,
    parts: ["x"],
  });
  const scannedText = scanned.lines.join("\n");
  assert.match(scannedText, /no machine-readable text layer \(classified scanned\)/);
  assert.match(scannedText, /first 12 of 14 pages/);

  const garbled = await section(inspection({ hasEncodingIssues: true }), { pageCount: 1, rendered: 1, parts: ["x"] });
  assert.match(garbled.lines.join("\n"), /encoding issues; pages are attached as images/);
});

test("failed renders degrade to explicit notes instead of silent empty prompts", async () => {
  const visionFailure = await section(null, null);
  assert.equal(visionFailure.imageParts, null);
  assert.match(visionFailure.lines.join("\n"), /could not be rendered for image input/);

  const mixedFailure = await section(
    inspection({ pdfType: "mixed", pageCount: 4, pagesNeedingOcr: [2] }),
    null,
  );
  assert.equal(mixedFailure.imageParts, null);
  const text = mixedFailure.lines.join("\n");
  assert.match(text, /Native body text/);
  assert.match(text, /could not be rendered as images/);
});

test("the markdown excerpt is bounded by and decrements the shared text budget", async () => {
  const budget = { remainingTokens: 10 };
  const long = inspection({ markdown: `--- Page 1 ---\n\n${"budgeted words repeat here ".repeat(200)}` });
  const result = await pdfPrompt.pdfAttachmentPromptSection({
    inspect: async () => long,
    renderImages: async () => null,
    fullAccessHint: "Complete extracted text: use read.",
    pageLimit: 12,
    textBudget: budget,
  });
  assert.equal(budget.remainingTokens, 0);
  assert.match(result.lines.join("\n"), /bounded extract|omitted to preserve/);
});
