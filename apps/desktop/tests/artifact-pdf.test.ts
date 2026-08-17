import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const require = createRequire(import.meta.url);
const cache = new Map();
const load = (relative) =>
  loadTypeScriptModule(new URL(`../src/main/artifacts/worker/${relative}`, import.meta.url), { cache, realm: "host" });

const blockSpec = load("blocks/spec.ts");
const create = load("pdf/create.ts");
const inspect = load("pdf/inspect.ts");
const edit = load("pdf/edit.ts");
const engine = load("engine.ts");

const createdAt = "2026-01-01T00:00:00Z";
const plain = (value) => JSON.parse(JSON.stringify(value));

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-pdf-"));
}

const everyBlockSpec = {
  format: "pdf",
  preset: "narrative_proposal",
  page: { size: "A4", orientation: "portrait" },
  meta: { title: "Field Proposal", author: "Umbratic", subject: "Q3" },
  header: { text: "Confidential" },
  footer: { text: "Field Proposal", pageNumbers: true },
  toc: true,
  blocks: [
    { type: "title", text: "Field Proposal", subtitle: "A worked example" },
    { type: "heading", level: 1, text: "Summary" },
    { type: "paragraph", text: "The programme delivers **three** outcomes in the first year." },
    { type: "bullets", items: ["Lower unit cost", "Shorter cycle time"] },
    { type: "numbered", items: ["Agree the scope", "Sign the order"] },
    { type: "checklist", items: ["Legal review", "Security review"] },
    { type: "definitions", items: [{ term: "SLA", definition: "The response time we commit to." }] },
    { type: "callout", style: "warning", title: "Risk", text: "The pilot depends on a single supplier." },
    {
      type: "table",
      columns: [
        { header: "Phase", width: "50%", align: "left" },
        { header: "Weeks", width: "25%", align: "right" },
        { header: "Owner", width: "25%", align: "left" },
      ],
      rows: [["Discovery", "4", "Ops"], ["Pilot", "8", "Eng"]],
      caption: "Programme phases",
    },
    { type: "quote", text: "It paid for itself in the first quarter.", attribution: "A customer" },
    { type: "pageBreak" },
    { type: "heading", level: 2, text: "Terms" },
    { type: "paragraph", text: "Prepared for review." },
    { type: "signature", fields: ["Name", "Date"] },
    { type: "formField", label: "Approved", kind: "checkbox" },
  ],
};

async function buildPdf(input = everyBlockSpec, root = workspace()) {
  const read = blockSpec.readDocumentSpec(input, "pdf");
  assert.deepEqual(plain(read.errors), [], "spec should be valid");
  const built = await create.createPdf({ spec: read.spec, workspaceRoot: root, createdAt });
  assert.deepEqual(plain(built.errors), [], "create should not error");
  return { ...built, root };
}

test("every block type renders to a readable PDF with the metadata it was given", async () => {
  const built = await buildPdf();
  assert.ok(built.bytes.subarray(0, 5).toString("ascii") === "%PDF-", "output is a PDF");
  assert.ok(built.pageCount >= 2, `expected the page break to produce pages, got ${built.pageCount}`);

  const inspection = await inspect.inspectPdf(built.bytes);
  assert.equal(inspection.origin, "umbratic", "our own PDF carries the origin stamp");
  assert.equal(inspection.editSurface, "surgical", "a PDF is always page-level");
  assert.deepEqual(plain(inspection.unsupported), []);
  assert.equal(inspection.outline.title, "Field Proposal");
  assert.equal(inspection.outline.pageCount, built.pageCount);

  // The text has to actually come back out, or nothing downstream can read it.
  const text = inspection.outline.pages.map((page) => page.text ?? "").join(" ");
  assert.match(text, /Field Proposal/);
  assert.match(text, /three outcomes/, "inline markup renders as words, not stars");
  assert.match(text, /Discovery/);
  assert.match(text, /It paid for itself/);
  // A4 portrait is 595.28 × 841.89 points.
  assert.ok(Math.abs(inspection.outline.pages[0].width - 595.28) < 1);
});

test("a page number and a header land on every page", async () => {
  const built = await buildPdf();
  const inspection = await inspect.inspectPdf(built.bytes);
  for (const page of inspection.outline.pages) {
    assert.match(page.text ?? "", /Confidential/, `page ${page.number} has the header`);
    assert.match(page.text ?? "", new RegExp(`${page.number} of ${built.pageCount}`), `page ${page.number} is numbered`);
  }
});

test("a long table repeats its header on every page it crosses", async () => {
  const built = await buildPdf({
    preset: "compact_reference_guide",
    blocks: [
      {
        type: "table",
        columns: [
          { header: "Identifier", width: "50%", align: "left" },
          { header: "Description", width: "50%", align: "left" },
        ],
        rows: Array.from({ length: 90 }, (_, index) => [
          `ROW-${index + 1}`,
          "A description long enough to take a line of its own on the page.",
        ]),
      },
    ],
  });
  assert.ok(built.pageCount > 1, "the fixture should span pages");
  const inspection = await inspect.inspectPdf(built.bytes);
  for (const page of inspection.outline.pages) {
    assert.match(page.text ?? "", /Identifier/, `page ${page.number} repeats the header`);
  }
});

test("text outside Latin-1 survives, which needs a real embedded font", async () => {
  const built = await buildPdf({
    blocks: [{ type: "paragraph", text: "Größenordnung — coûts — 日本語" }],
  });
  const inspection = await inspect.inspectPdf(built.bytes);
  const text = inspection.outline.pages.map((page) => page.text ?? "").join(" ");
  assert.match(text, /Größenordnung/);
  assert.match(text, /coûts/);
});

test("an image outside the workspace never reaches the document", async () => {
  const root = workspace();
  const read = blockSpec.readDocumentSpec(
    { blocks: [{ type: "image", path: "../outside.png", width: "80%" }] },
    "pdf",
  );
  const built = await create.createPdf({ spec: read.spec, workspaceRoot: root, createdAt });
  assert.equal(built.errors.length, 1);
  assert.match(built.errors[0].message, /outside the workspace/);
});

/* ---------------------------------- edit ----------------------------------- */

async function editPdf(ops, options = {}) {
  const built = await buildPdf(options.spec ?? everyBlockSpec, options.root);
  const inspection = await inspect.inspectPdf(built.bytes);
  const result = await edit.applyPdfOps({
    bytes: built.bytes,
    inspection,
    ops,
    workspaceRoot: built.root,
    ...(options.outDirectory ? { outDirectory: options.outDirectory } : {}),
  });
  return { result, built };
}

test("page ops rotate, delete, reorder, and insert by the numbers inspect reports", async () => {
  const rotated = await editPdf([{ op: "rotate", angle: 90, pages: [1] }]);
  assert.equal(rotated.result.ok, true, JSON.stringify(plain(rotated.result.errors ?? [])));
  const afterRotate = await inspect.inspectPdf(rotated.result.bytes);
  assert.equal(afterRotate.outline.pages[0].rotation, 90);

  const deleted = await editPdf([{ op: "deletePages", pages: [1] }]);
  assert.equal(deleted.result.ok, true);
  const afterDelete = await inspect.inspectPdf(deleted.result.bytes);
  assert.equal(afterDelete.outline.pageCount, deleted.built.pageCount - 1);

  const inserted = await editPdf([{ op: "insertBlank", at: 1 }]);
  assert.equal(inserted.result.ok, true);
  assert.equal(
    (await inspect.inspectPdf(inserted.result.bytes)).outline.pageCount,
    inserted.built.pageCount + 1,
  );

  const built = await buildPdf();
  const order = Array.from({ length: built.pageCount }, (_, index) => built.pageCount - index);
  const reordered = await edit.applyPdfOps({
    bytes: built.bytes,
    inspection: await inspect.inspectPdf(built.bytes),
    ops: [{ op: "reorder", order }],
    workspaceRoot: built.root,
  });
  assert.equal(reordered.ok, true, JSON.stringify(plain(reordered.errors ?? [])));
  const afterReorder = await inspect.inspectPdf(reordered.bytes);
  assert.equal(afterReorder.outline.pageCount, built.pageCount);
});

test("a page number outside the document is refused with the count", async () => {
  const { result } = await editPdf([{ op: "deletePages", pages: [999] }]);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /the document has \d+ pages/);
});

test("an incomplete reorder is refused rather than silently dropping pages", async () => {
  const { result } = await editPdf([{ op: "reorder", order: [1] }]);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /every one of the \d+ pages exactly once/);
});

test("deleting every page is refused", async () => {
  const built = await buildPdf({ blocks: [{ type: "paragraph", text: "Only page." }] });
  const result = await edit.applyPdfOps({
    bytes: built.bytes,
    inspection: await inspect.inspectPdf(built.bytes),
    ops: [{ op: "deletePages", pages: [1] }],
    workspaceRoot: built.root,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /at least one page/);
});

test("merge appends another workspace PDF, and split writes the parts", async () => {
  const root = workspace();
  const other = await buildPdf({ blocks: [{ type: "paragraph", text: "Appended document." }] }, root);
  fs.writeFileSync(path.join(root, "other.pdf"), other.bytes);

  const merged = await editPdf([{ op: "merge", files: ["other.pdf"] }], { root });
  assert.equal(merged.result.ok, true, JSON.stringify(plain(merged.result.errors ?? [])));
  const afterMerge = await inspect.inspectPdf(merged.result.bytes);
  assert.equal(afterMerge.outline.pageCount, merged.built.pageCount + other.pageCount);
  assert.match(
    afterMerge.outline.pages.map((page) => page.text ?? "").join(" "),
    /Appended document/,
  );

  const outDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-split-"));
  const split = await editPdf([{ op: "split", every: 1 }], { outDirectory });
  assert.equal(split.result.ok, true, JSON.stringify(plain(split.result.errors ?? [])));
  assert.equal(split.result.extra.length, split.built.pageCount);
  assert.equal(split.result.extra[0].absolutePath.endsWith("part-001.pdf"), true);
});

test("watermark and stamp draw without disturbing the text already there", async () => {
  const { result, built } = await editPdf([
    { op: "watermark", text: "DRAFT" },
    { op: "stamp", text: "Umbratic", corner: "bottom-left" },
  ]);
  assert.equal(result.ok, true, JSON.stringify(plain(result.errors ?? [])));
  const after = await inspect.inspectPdf(result.bytes);
  assert.equal(after.outline.pageCount, built.pageCount);
  const text = after.outline.pages.map((page) => page.text ?? "").join(" ");
  assert.match(text, /DRAFT/);
  assert.match(text, /Field Proposal/, "the original text is still there");
});

test("setMetadata rewrites the fields inspect reports", async () => {
  const { result } = await editPdf([
    { op: "setMetadata", title: "Renamed", author: "Dana Reyes" },
  ]);
  assert.equal(result.ok, true, JSON.stringify(plain(result.errors ?? [])));
  const after = await inspect.inspectPdf(result.bytes);
  assert.equal(after.outline.title, "Renamed");
  assert.equal(after.outline.author, "Dana Reyes");
});

test("a body-text rewrite is refused with the reason and the alternative", async () => {
  const { result } = await editPdf([{ op: "replaceText", find: "Summary", replace: "Overview" }]);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /is not a PDF operation/);
  assert.match(result.errors[0].message, /rebuild it from source with create/);
});

test("fillForm names the fields the document actually has", async () => {
  const { result } = await editPdf([{ op: "fillForm", values: { nothere: "x" } }]);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /no field named "nothere"/);
});

/* --------------------------------- inspect --------------------------------- */

test("a foreign PDF with no extractable text is reported as scanned", async () => {
  const { PDFDocument } = require("@cantoo/pdf-lib");
  const document = await PDFDocument.create();
  document.addPage([612, 792]);
  const bytes = Buffer.from(await document.save());
  const inspection = await inspect.inspectPdf(bytes);
  assert.equal(inspection.origin, "foreign");
  assert.ok(inspection.unsupported.some((entry) => entry.kind === "scanned"));
  // A scan still merges, rotates, and stamps, so it stays surgical.
  assert.equal(inspection.editSurface, "surgical");
});

test("a file that is not a PDF is reported as unopenable rather than as empty", async () => {
  const inspection = await inspect.inspectPdf(Buffer.from("this is not a pdf"));
  assert.equal(inspection.editSurface, "inspect-only");
  assert.equal(inspection.unsupported[0].kind, "encrypted");
});

/* ---------------------------------- engine --------------------------------- */

test("the engine round-trips pdf create, inspect, and a page edit", async () => {
  const root = workspace();
  const out = path.join(root, ".umbratic", "artifacts", "pdf", "proposal.pdf");
  const created = await engine.runArtifactJob({
    action: "create",
    format: "pdf",
    absoluteOut: out,
    out: ".umbratic/artifacts/pdf/proposal.pdf",
    spec: everyBlockSpec,
    workspaceRoot: root,
    createdAt,
  });
  assert.equal(created.ok, true, JSON.stringify(plain(created.errors ?? [])));
  assert.equal(created.origin, "umbratic");
  assert.match(created.summary, /\d+ pages/);
  assert.ok(fs.existsSync(out));

  const inspected = await engine.runArtifactJob({
    action: "inspect",
    format: "pdf",
    absolutePath: out,
    path: ".umbratic/artifacts/pdf/proposal.pdf",
    workspaceRoot: root,
  });
  assert.equal(inspected.ok, true);
  assert.ok(inspected.outline.pages.length >= 2);

  const edited = await engine.runArtifactJob({
    action: "edit",
    format: "pdf",
    absolutePath: out,
    absoluteOut: out,
    path: ".umbratic/artifacts/pdf/proposal.pdf",
    ops: [{ op: "watermark", text: "DRAFT" }],
    workspaceRoot: root,
  });
  assert.equal(edited.ok, true, JSON.stringify(plain(edited.errors ?? [])));
  assert.match(edited.summary, /1 op applied/);
});

test("the engine writes nothing when a pdf spec is invalid", async () => {
  const root = workspace();
  const out = path.join(root, "bad.pdf");
  const response = await engine.runArtifactJob({
    action: "create",
    format: "pdf",
    absoluteOut: out,
    spec: { blocks: [{ type: "callout", style: "danger", text: "x" }] },
    workspaceRoot: root,
    createdAt,
  });
  assert.equal(response.ok, false);
  assert.equal(response.errors[0].path, "blocks[0].style");
  assert.equal(fs.existsSync(out), false);
});
