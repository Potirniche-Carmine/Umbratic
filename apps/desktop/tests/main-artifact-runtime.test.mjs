import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const artifactRuntime = loadTypeScriptModule(new URL("../src/main/artifactRuntime.ts", import.meta.url));
const plain = (value) => JSON.parse(JSON.stringify(value));

function report(statusById) {
  return {
    checkedAt: "2026-01-01T00:00:00.000Z",
    probes: Object.entries(statusById).map(([id, status]) => ({
      id,
      label: id,
      category: "optional-artifacts",
      importance: "optional",
      status,
      purpose: "",
      installHint: "",
      workflows: ["artifacts"],
      checkedAt: "2026-01-01T00:00:00.000Z",
    })),
    summary: {
      available: 0,
      missing: 0,
      error: 0,
      unknown: 0,
      requiredMissing: 0,
      recommendedMissing: 0,
      optionalMissing: 0,
    },
  };
}

test("artifactKindsForPrompt selects concrete artifact types from realistic requests", () => {
  assert.deepEqual(plain(artifactRuntime.artifactKindsForPrompt("Create a board deck in PPTX.")), ["pptx"]);
  assert.deepEqual(plain(artifactRuntime.artifactKindsForPrompt("Build a PDF report and Excel workbook.")), ["pdf", "xlsx"]);
  assert.deepEqual(plain(artifactRuntime.artifactKindsForPrompt("Fix the login test.")), []);
  assert.equal(artifactRuntime.promptLooksLikeArtifactTask("Write a one-pager"), true);
  assert.equal(artifactRuntime.promptLooksLikeArtifactTask("Explain this function"), false);
  assert.equal(artifactRuntime.promptLooksLikeOcrTask("Extract text from this screenshot."), true);
  assert.equal(artifactRuntime.promptLooksLikeOcrTask("Refactor this parser."), false);
});

test("artifactRuntimePromptGuidance gives PDF output paths and refuses visual QA without render probes", () => {
  const guidance = artifactRuntime.artifactRuntimePromptGuidance(
    report({
      "py-reportlab": "available",
      "py-pypdf": "available",
      pdftoppm: "missing",
      pdfinfo: "available",
    }),
    "Create a PDF report.",
  );

  assert.match(guidance, /Artifact runtime plan/);
  assert.match(guidance, /\.umbratic\/artifacts\/pdf/);
  assert.match(guidance, /\.umbratic\/templates\/pdf/);
  assert.match(guidance, /PDF generation with reportlab: available/);
  assert.match(guidance, /PDF extraction with pdfplumber\/pypdf: available/);
  assert.match(guidance, /PDF render\/visual QA with Poppler: missing/);
  assert.match(guidance, /do not claim PDF visual QA/);
});

test("artifactRuntimePromptGuidance gates Office artifacts by JS runtime and LibreOffice probes", () => {
  const guidance = artifactRuntime.artifactRuntimePromptGuidance(
    report({
      "node-pptx": "available",
      libreoffice: "missing",
    }),
    "Create a PowerPoint deck.",
  );

  assert.match(guidance, /\.umbratic\/artifacts\/pptx/);
  assert.match(guidance, /\.umbratic\/templates\/powerpoint/);
  assert.match(guidance, /PPTX JavaScript authoring runtime: available/);
  assert.match(guidance, /LibreOffice render\/export verification: missing/);
  assert.match(guidance, /do not claim PPTX render\/export QA/);
});

test("artifactRuntimePromptGuidance adds local OCR plan for OCR prompts and image attachments", () => {
  const guidance = artifactRuntime.artifactRuntimePromptGuidance(
    report({
      tesseract: "missing",
      "pdf-to-img": "available",
    }),
    "What does this say?",
    { ocrInputKinds: ["image"] },
  );

  assert.match(guidance, /OCR:/);
  assert.match(guidance, /\.umbratic\/artifacts\/ocr/);
  assert.match(guidance, /local OCR engine \(Tesseract CLI\): missing/);
  assert.match(guidance, /PDF page rendering for OCR attachments: available/);
  assert.match(guidance, /do not use hosted OCR APIs/);
  assert.match(guidance, /do not invent OCR text/);
});
