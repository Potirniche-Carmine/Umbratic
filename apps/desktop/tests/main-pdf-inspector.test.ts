import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const pdfInspector = loadTypeScriptModule(new URL("../src/main/pdfInspector.ts", import.meta.url));
const plain = (value) => JSON.parse(JSON.stringify(value));

const inspection = (overrides = {}) => ({
  pdfType: "text_based",
  pageCount: 4,
  confidence: 0.92,
  pagesNeedingOcr: [],
  hasEncodingIssues: false,
  ocrRecommended: false,
  markdown: "--- Page 1 ---\n\nbody",
  estimatedTokens: 640,
  ...overrides,
});

test("parsePdfInspection accepts the CLI contract and rejects malformed payloads", () => {
  const parsed = pdfInspector.parsePdfInspection(inspection());
  assert.equal(parsed.pdfType, "text_based");
  assert.equal(parsed.estimatedTokens, 640);

  assert.equal(pdfInspector.parsePdfInspection(null), null);
  assert.equal(pdfInspector.parsePdfInspection({ error: { code: "encrypted" } }), null);
  assert.equal(pdfInspector.parsePdfInspection(inspection({ pdfType: "hologram" })), null);
  assert.equal(pdfInspector.parsePdfInspection(inspection({ pageCount: -1 })), null);
  assert.equal(pdfInspector.parsePdfInspection(inspection({ pagesNeedingOcr: [0] })), null);
  assert.equal(pdfInspector.parsePdfInspection(inspection({ pagesNeedingOcr: "1,2" })), null);
  assert.equal(pdfInspector.parsePdfInspection(inspection({ markdown: 42 })), null);
  assert.equal(pdfInspector.parsePdfInspection(inspection({ estimatedTokens: 1.5 })), null);
});

test("pdfPromptRoute sends confident text PDFs to native text and everything risky to vision", () => {
  assert.deepEqual(plain(pdfInspector.pdfPromptRoute(inspection(), 12)), { mode: "text" });
  assert.deepEqual(plain(pdfInspector.pdfPromptRoute(null, 12)), { mode: "vision" });
  assert.deepEqual(plain(pdfInspector.pdfPromptRoute(inspection({ hasEncodingIssues: true }), 12)), { mode: "vision" });
  assert.deepEqual(plain(pdfInspector.pdfPromptRoute(inspection({ confidence: 0.5 }), 12)), { mode: "vision" });
  assert.deepEqual(plain(pdfInspector.pdfPromptRoute(inspection({ pdfType: "scanned", pagesNeedingOcr: [1, 2, 3, 4] }), 12)), {
    mode: "vision",
  });
  assert.deepEqual(plain(pdfInspector.pdfPromptRoute(inspection({ pdfType: "image_based", pagesNeedingOcr: [1] }), 12)), {
    mode: "vision",
  });
});

test("pdfPromptRoute rasterizes only the vision-window OCR pages of mixed PDFs", () => {
  assert.deepEqual(
    plain(pdfInspector.pdfPromptRoute(inspection({ pdfType: "mixed", pageCount: 20, pagesNeedingOcr: [2, 5, 14] }), 12)),
    { mode: "mixed", ocrPages: [2, 5] },
  );
  // Every page needing OCR sits beyond the vision window: nothing to render.
  assert.deepEqual(
    plain(pdfInspector.pdfPromptRoute(inspection({ pdfType: "mixed", pageCount: 30, pagesNeedingOcr: [20, 25] }), 12)),
    { mode: "text" },
  );
});

test("inspectPdf resolves null when the inspector binary is unavailable", async () => {
  assert.equal(await pdfInspector.inspectPdf("/tmp/anything.pdf", { binaryPath: null }), null);
});

function minimalTextPdf(text) {
  const contentStream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objects[3] =
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objects[5] = `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`;
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 1; index <= 5; index += 1) {
    offsets[index] = body.length;
    body += `${index} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = body.length;
  body += "xref\n0 6\n0000000000 65535 f \n";
  for (let index = 1; index <= 5; index += 1) {
    body += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const builtInspector = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../target/release",
  process.platform === "win32" ? "umbratic-pdf.exe" : "umbratic-pdf",
);

test("inspectPdf and pdfContextTokens run the built CLI end to end", async () => {
    assert.equal(
      fs.existsSync(builtInspector),
      true,
      `umbratic-pdf release binary is not built at ${builtInspector}`,
    );
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-pdf-test-"));
    try {
      const pdfPath = path.join(directory, "fixture.pdf");
      fs.writeFileSync(pdfPath, minimalTextPdf("A native text page with plenty of characters for classification."));

      const full = await pdfInspector.inspectPdf(pdfPath, { full: true, binaryPath: builtInspector });
      assert.equal(full.pdfType, "text_based");
      assert.equal(full.pageCount, 1);
      assert.match(full.markdown, /native text page/);

      // Detect-only estimates page text without the extract's page markers, so
      // it tracks the full estimate without matching it exactly.
      const tokens = pdfInspector.pdfContextTokens(pdfPath, builtInspector);
      assert.ok(Number.isInteger(tokens) && tokens > 0 && tokens <= full.estimatedTokens);
      // Second call is served from the cache even without a binary.
      assert.equal(pdfInspector.pdfContextTokens(pdfPath, null), tokens);
      pdfInspector.clearPdfContextTokenCache();
      assert.equal(pdfInspector.pdfContextTokens(pdfPath, null), undefined);

      assert.equal(await pdfInspector.inspectPdf(path.join(directory, "missing.pdf"), { binaryPath: builtInspector }), null);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
});
