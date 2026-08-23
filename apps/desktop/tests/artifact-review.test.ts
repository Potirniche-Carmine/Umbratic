import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const cache = new Map();
const load = (relative) =>
  loadTypeScriptModule(new URL(relative, import.meta.url), { cache, realm: "host" });

const review = load("../src/shared/artifactReview.ts");
// The artifact engine is committed separately from this file; a checkout
// without src/main/artifacts/ skips the engine-backed cases instead of
// failing on module resolution.
const engineAvailable = fs.existsSync(new URL("../src/main/artifacts/worker/engine.ts", import.meta.url));
const engine = engineAvailable ? load("../src/main/artifacts/worker/engine.ts") : null;
const engineTest = engineAvailable
  ? test
  : (name, fn) => test(name, { skip: "artifact engine sources are missing from this checkout" }, fn);

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-review-"));
}

test("the path rule accepts every format the tool writes and nothing else", () => {
  for (const format of ["pptx", "docx", "xlsx", "pdf"]) {
    assert.equal(review.isArtifactPath(`.umbratic/artifacts/${format}/deck.${format}`), true);
    assert.equal(review.artifactFormatOf(`.umbratic/artifacts/${format}/deck.${format}`), format);
  }
  // The directory and the extension have to agree, or a PDF in the pptx folder
  // would preview as a deck.
  assert.equal(review.isArtifactPath(".umbratic/artifacts/pptx/report.pdf"), false);
  assert.equal(review.isArtifactPath(".umbratic/artifacts/pptx/../../etc/passwd"), false);
  assert.equal(review.isArtifactPath(".umbratic/runtime/runner.log"), false);
  assert.equal(review.isArtifactPath("decks/board.pptx"), false, "only what the tool wrote");
  // The sidecar this replaced is not a thing any more.
  assert.equal(review.isArtifactPath(".umbratic/artifacts/docx/brief.docx.review.json"), false);
});

engineTest("a deck previews as slide cards built from its own outline", async () => {
  const root = workspace();
  const out = path.join(root, ".umbratic", "artifacts", "pptx", "deck.pptx");
  const created = await engine.runArtifactJob({
    action: "create",
    format: "pptx",
    absoluteOut: out,
    spec: {
      slides: [
        { layout: "title", title: "Q3 Review", subtitle: "EMEA", notes: "Open with ARR." },
        { layout: "bullets", title: "Highlights", bullets: ["Revenue up 12%", "Churn flat"] },
        {
          layout: "chart",
          title: "Revenue",
          chart: { type: "column", categories: ["Q1"], series: [{ name: "Rev", values: [1] }] },
        },
      ],
    },
    workspaceRoot: root,
  });
  assert.equal(created.ok, true, JSON.stringify(created.errors ?? []));

  const inspected = await engine.runArtifactJob({
    action: "inspect",
    format: "pptx",
    absolutePath: out,
    path: ".umbratic/artifacts/pptx/deck.pptx",
    workspaceRoot: root,
  });
  const preview = review.artifactPreviewFromOutline(
    ".umbratic/artifacts/pptx/deck.pptx",
    "pptx",
    inspected.outline,
  );
  assert.ok(preview);
  assert.equal(preview.title, "deck");
  const rendered = preview.blocks.map((block) => block.text);
  assert.ok(rendered.some((text) => text.startsWith("Slide 1 — Q3 Review")));
  assert.ok(rendered.includes("Revenue up 12%"), "each bullet is its own line");
  assert.ok(rendered.some((text) => text.startsWith("Notes: Open with ARR")));
  assert.ok(rendered.some((text) => text.includes("[chart")), "a chart is described, not rendered");
  // Every block needs a unique id, or selection in the panel picks the wrong one.
  assert.equal(new Set(preview.blocks.map((block) => block.id)).size, preview.blocks.length);
});

engineTest("a PDF previews page by page and says which pages are images", async () => {
  const root = workspace();
  const out = path.join(root, ".umbratic", "artifacts", "pdf", "report.pdf");
  await engine.runArtifactJob({
    action: "create",
    format: "pdf",
    absoluteOut: out,
    spec: { blocks: [{ type: "title", text: "Field Report" }] },
    workspaceRoot: root,
  });
  const inspected = await engine.runArtifactJob({
    action: "inspect",
    format: "pdf",
    absolutePath: out,
    workspaceRoot: root,
  });
  const preview = review.artifactPreviewFromOutline(
    ".umbratic/artifacts/pdf/report.pdf",
    "pdf",
    inspected.outline,
  );
  assert.ok(preview);
  assert.ok(preview.blocks.some((block) => block.text === "Page 1"));
  assert.ok(preview.blocks.some((block) => block.text.includes("Field Report")));

  const scanned = review.artifactPreviewFromOutline(".umbratic/artifacts/pdf/scan.pdf", "pdf", {
    pages: [{ number: 1, characters: 0 }],
  });
  assert.match(scanned.blocks[1].text, /no extractable text/);
});

test("a workbook previews as sheets with their headers and sample rows", () => {
  const preview = review.artifactPreviewFromOutline(".umbratic/artifacts/xlsx/model.xlsx", "xlsx", {
    sheets: [
      {
        name: "Assumptions",
        rows: 3,
        columns: 2,
        header: ["Item", "Value"],
        sample: [["Growth", "0.05"]],
        formulaCount: 2,
      },
    ],
  });
  assert.ok(preview);
  const rendered = preview.blocks.map((block) => block.text);
  assert.ok(rendered.includes("Assumptions — 3 rows × 2 columns"));
  assert.ok(rendered.includes("Item | Value"));
  assert.ok(rendered.includes("Growth | 0.05"));
  assert.ok(rendered.includes("2 formulas"));
});

test("a document previews with its headings at the right level", () => {
  const preview = review.artifactPreviewFromOutline(".umbratic/artifacts/docx/brief.docx", "docx", {
    blocks: [
      { id: "b1", kind: "title", text: "Brief" },
      { id: "b2", kind: "heading", level: 2, text: "Detail" },
      { id: "b3", kind: "paragraph", text: "Body." },
      { id: "b4", kind: "table", rows: 3, columns: 2, text: "Stage | Count" },
    ],
  });
  assert.ok(preview);
  const byId = new Map(preview.blocks.map((block) => [block.id, block]));
  assert.equal(byId.get("b1").style, "title");
  assert.equal(byId.get("b2").style, "heading2");
  assert.equal(byId.get("b3").style, "paragraph");
  assert.match(byId.get("b4").text, /\[table, 3 × 2\]/);
});

test("an outline with nothing in it produces no preview rather than an empty panel", () => {
  assert.equal(review.artifactPreviewFromOutline(".umbratic/artifacts/pptx/x.pptx", "pptx", {}), null);
  assert.equal(review.artifactPreviewFromOutline(".umbratic/artifacts/pptx/x.pptx", "pptx", null), null);
});
