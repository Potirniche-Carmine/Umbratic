import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const cache = new Map();
const load = (relative) =>
  loadTypeScriptModule(new URL(`../src/main/artifacts/worker/${relative}`, import.meta.url), { cache, realm: "host" });

const blockSpec = load("blocks/spec.ts");
const create = load("docx/create.ts");
const inspect = load("docx/inspect.ts");
const edit = load("docx/edit.ts");
const qa = load("docx/qa.ts");
const opc = load("opc.ts");
const engine = load("engine.ts");
const xml = load("xml.ts");

const createdAt = "2026-01-01T00:00:00Z";
const plain = (value) => JSON.parse(JSON.stringify(value));

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-docx-"));
}

const everyBlockSpec = {
  format: "docx",
  preset: "standard_business_brief",
  page: { size: "Letter", orientation: "portrait" },
  meta: { title: "Quarterly Brief", author: "Umbratic" },
  header: { text: "Confidential" },
  footer: { text: "Quarterly Brief", pageNumbers: true },
  toc: true,
  blocks: [
    { type: "title", text: "Quarterly Brief", subtitle: "EMEA business unit" },
    { type: "heading", level: 1, text: "Summary" },
    { type: "paragraph", text: "Revenue grew **12%** against a flat pipeline." },
    { type: "bullets", items: ["Renewals carried the quarter", "New logos were flat"] },
    { type: "numbered", items: ["Confirm the forecast", "Rebalance the pipeline"] },
    { type: "checklist", items: ["Send the board pack", "Book the review"] },
    {
      type: "definitions",
      items: [{ term: "ARR", definition: "Annual recurring revenue at period end." }],
    },
    { type: "callout", style: "decision", title: "Decision", text: "Hold headcount until Q1." },
    {
      type: "table",
      columns: [
        { header: "Stage", width: "60%", align: "left" },
        { header: "Count", width: "40%", align: "right" },
      ],
      rows: [["Qualified", "18"], ["Won", "7"]],
      caption: "Pipeline at quarter end",
    },
    { type: "quote", text: "Renewals carried the quarter.", attribution: "Head of Revenue" },
    { type: "pageBreak" },
    { type: "heading", level: 2, text: "Appendix" },
    { type: "paragraph", text: "Prepared for {{recipient}} on {{date}}." },
    { type: "signature", fields: ["Name", "Date"] },
    { type: "formField", label: "Approved", kind: "checkbox" },
  ],
};

function buildPack(input = everyBlockSpec, root = workspace()) {
  const read = blockSpec.readDocumentSpec(input, "docx");
  assert.deepEqual(plain(read.errors), [], "spec should be valid");
  const built = create.createDocument({ spec: read.spec, workspaceRoot: root, createdAt });
  assert.deepEqual(plain(built.errors), [], "create should not error");
  return { pack: built.pack, root, spec: read.spec, blockIds: built.blockIds };
}

function apply(ops, input = everyBlockSpec, options = {}) {
  const { pack, root } = buildPack(input);
  const inspection = inspect.inspectDocument(pack);
  return {
    result: edit.applyDocxOps({
      pack,
      inspection,
      ops,
      author: options.author ?? "Umbratic",
      timestamp: createdAt,
    }),
    before: pack,
    root,
  };
}

test("every block type builds a document inspect reads back with stable ids", () => {
  const { pack, blockIds } = buildPack();
  const inspection = inspect.inspectDocument(pack);
  assert.equal(inspection.origin, "umbratic");
  assert.equal(inspection.editSurface, "full");
  assert.deepEqual(plain(inspection.unsupported), []);

  const outline = inspection.outline;
  assert.equal(outline.page.size, "Letter");
  assert.equal(outline.page.orientation, "portrait");
  assert.ok(outline.wordCount > 20, `expected real words, got ${outline.wordCount}`);

  // Every id create recorded has to be findable in the outline, or an edit
  // addressing what create built would miss.
  const reported = new Set(outline.blocks.map((block) => block.id));
  for (const id of blockIds) {
    assert.ok(reported.has(id), `block id ${id} is not in the outline`);
  }
  assert.ok(outline.blocks.every((block) => block.id));

  const title = outline.blocks.find((block) => block.kind === "title");
  assert.equal(title.text, "Quarterly Brief");
  const heading = outline.blocks.find((block) => block.kind === "heading");
  assert.equal(heading.level, 1);
  // Inline markup is formatting: the reader sees the words without the stars.
  assert.ok(outline.blocks.some((block) => block.text === "Revenue grew 12% against a flat pipeline."));
  const table = outline.blocks.find((block) => block.kind === "table");
  assert.equal(table.columns, 2);
  assert.equal(table.rows, 3, "header plus two body rows");
  assert.deepEqual(plain(outline.placeholders), ["recipient", "date"]);
});

test("headings carry outline levels so Word can build the contents it was asked for", () => {
  const { pack } = buildPack();
  const styles = xml.parseXml(pack.text("word/styles.xml"));
  const heading1 = xml
    .findElements(styles, "style")
    .find((node) => xml.attribute(node, "styleId") === "Heading1");
  assert.equal(xml.attribute(xml.firstElement(heading1, "outlineLvl"), "val"), "0");
  // The TOC is a field, not a rendered list: a rendered list is correct once.
  assert.match(pack.text("word/document.xml"), /TOC \\o/);
});

test("the package declares a content type and a relationship for every part", () => {
  const { pack } = buildPack();
  const types = opc.readContentTypes(pack);
  for (const name of pack.names()) {
    if (name === "[Content_Types].xml" || name.endsWith(".rels")) continue;
    assert.ok(opc.contentTypeOf(types, name), `${name} has no content type`);
  }
  for (const name of pack.names()) {
    if (!name.includes("/_rels/") && name !== "_rels/.rels") continue;
    const owner = name.replace(/_rels\//, "").replace(/\.rels$/, "");
    for (const relationship of opc.readRelationships(pack, owner)) {
      const target = opc.relationshipTarget(owner, relationship);
      if (!target) continue;
      assert.ok(pack.has(target), `${owner} references missing part ${target}`);
    }
  }
});

test("spec limits fail with the JSON path that has to change", () => {
  const wide = blockSpec.readDocumentSpec(
    {
      blocks: [
        {
          type: "table",
          columns: Array.from({ length: 11 }, (_, index) => `c${index}`),
          rows: [],
        },
      ],
    },
    "docx",
  );
  assert.equal(wide.errors[0].path, "blocks[0].columns");
  assert.match(wide.errors[0].message, /max 10/);

  const badWidths = blockSpec.readDocumentSpec(
    {
      blocks: [
        {
          type: "table",
          columns: [
            { header: "a", width: "50%" },
            { header: "b", width: "30%" },
          ],
          rows: [],
        },
      ],
    },
    "docx",
  );
  assert.match(badWidths.errors[0].message, /add up to 80%/);

  const twoTitles = blockSpec.readDocumentSpec(
    { blocks: [{ type: "title", text: "One" }, { type: "title", text: "Two" }] },
    "docx",
  );
  assert.match(twoTitles.errors[0].message, /one title/);

  const tocWithoutHeadings = blockSpec.readDocumentSpec(
    { toc: true, blocks: [{ type: "paragraph", text: "No headings here." }] },
    "docx",
  );
  assert.equal(tocWithoutHeadings.errors[0].path, "toc");

  const unknown = blockSpec.readDocumentSpec({ blocks: [{ type: "sidebar", text: "x" }] }, "docx");
  assert.equal(unknown.errors[0].path, "blocks[0].type");
  assert.match(unknown.errors[0].message, /is not a block type/);

  const badCallout = blockSpec.readDocumentSpec(
    { blocks: [{ type: "callout", style: "danger", text: "x" }] },
    "docx",
  );
  assert.equal(badCallout.errors[0].path, "blocks[0].style");
});

test("two builds of the same spec produce byte-identical files", async () => {
  const root = workspace();
  const first = await buildPack(everyBlockSpec, root).pack.write();
  const second = await buildPack(everyBlockSpec, root).pack.write();
  assert.ok(first.equals(second), "output must not depend on the clock");
});

/* ---------------------------------- edit ----------------------------------- */

test("replaceText matches across the runs Word splits a sentence into", () => {
  const { pack, root } = buildPack();
  const document = pack.text("word/document.xml");
  const split = document.replace(
    /<w:t xml:space="preserve">Revenue grew <\/w:t>/,
    '<w:t xml:space="preserve">Reven</w:t></w:r><w:r><w:t xml:space="preserve">ue gr</w:t></w:r><w:r><w:t xml:space="preserve">ew </w:t>',
  );
  assert.notEqual(split, document, "the fixture should actually be split");
  pack.set("word/document.xml", split);

  const result = edit.applyDocxOps({
    pack,
    inspection: inspect.inspectDocument(pack),
    ops: [{ op: "replaceText", find: "Revenue grew", replace: "Revenue fell" }],
    author: "Umbratic",
    timestamp: createdAt,
  });
  assert.equal(result.ok, true, JSON.stringify(plain(result.errors ?? [])));
  assert.match(qa.documentText(result.pack), /Revenue fell/);
  void root;
});

test("a tracked replacement writes a real redline a reviewer can accept", () => {
  const { result } = apply(
    [{ op: "replaceText", find: "Renewals carried the quarter", replace: "New logos carried the quarter", tracked: true }],
    everyBlockSpec,
    { author: "Dana Reyes" },
  );
  assert.equal(result.ok, true, JSON.stringify(plain(result.errors ?? [])));
  const document = xml.parseXml(result.pack.text("word/document.xml"));

  const deletions = xml.findElements(document, "del");
  const insertions = xml.findElements(document, "ins");
  assert.ok(deletions.length > 0 && insertions.length > 0, "a redline is a deletion and an insertion");
  assert.equal(xml.attribute(deletions[0], "author"), "Dana Reyes");
  assert.equal(xml.attribute(insertions[0], "date"), createdAt);
  // The deleted words must be w:delText: as w:t they would still read as present.
  assert.ok(xml.findElements(deletions[0], "delText").length > 0);
  assert.equal(xml.findElements(deletions[0], "t").length, 0);

  const inspection = inspect.inspectDocument(result.pack);
  assert.equal(inspection.outline.trackedChanges.insertions, insertions.length);
  assert.deepEqual(plain(inspection.outline.trackedChanges.authors), ["Dana Reyes"]);
  // Inspect reports what a reader sees, which excludes the struck-through text.
  assert.ok(!qa.documentText(result.pack).includes("Renewals carried the quarter."));
});

test("accepting changes keeps the insertions and drops the deletions", () => {
  const tracked = apply([
    { op: "replaceText", find: "flat pipeline", replace: "growing pipeline", tracked: true },
  ]);
  assert.equal(tracked.result.ok, true);
  const accepted = edit.applyDocxOps({
    pack: tracked.result.pack,
    inspection: inspect.inspectDocument(tracked.result.pack),
    ops: [{ op: "acceptAllChanges" }],
    author: "Umbratic",
    timestamp: createdAt,
  });
  assert.equal(accepted.ok, true, JSON.stringify(plain(accepted.errors ?? [])));
  const text = qa.documentText(accepted.pack);
  assert.match(text, /growing pipeline/);
  assert.ok(!text.includes("flat pipeline"));
  assert.equal(inspect.inspectDocument(accepted.pack).outline.trackedChanges.insertions, 0);

  const rejected = edit.applyDocxOps({
    pack: tracked.result.pack,
    inspection: inspect.inspectDocument(tracked.result.pack),
    ops: [{ op: "rejectAllChanges" }],
    author: "Umbratic",
    timestamp: createdAt,
  });
  assert.equal(rejected.ok, true);
  assert.match(qa.documentText(rejected.pack), /flat pipeline/);
});

test("fillPlaceholders replaces every named placeholder and names the ones it cannot find", () => {
  const { result } = apply([
    { op: "fillPlaceholders", values: { recipient: "The Board", date: "16 August 2026" } },
  ]);
  assert.equal(result.ok, true, JSON.stringify(plain(result.errors ?? [])));
  const text = qa.documentText(result.pack);
  assert.match(text, /Prepared for The Board on 16 August 2026\./);
  assert.deepEqual(plain(inspect.inspectDocument(result.pack).outline.placeholders), []);

  const missing = apply([{ op: "fillPlaceholders", values: { nobody: "x" } }]);
  assert.equal(missing.result.ok, false);
  assert.match(missing.result.errors[0].message, /\{\{nobody\}\}/);
});

test("addComment writes the body, the range, and the reference together", () => {
  const { result } = apply([
    { op: "addComment", on: "Renewals carried the quarter", text: "Confirm with finance." },
  ]);
  assert.equal(result.ok, true, JSON.stringify(plain(result.errors ?? [])));
  const inspection = inspect.inspectDocument(result.pack);
  assert.equal(inspection.outline.comments.length, 1);
  assert.equal(inspection.outline.comments[0].text, "Confirm with finance.");
  // The structural check is what proves all four parts landed.
  assert.deepEqual(
    plain(qa.checkDocument(result.pack, "standard_business_brief").filter((f) => f.severity === "error")),
    [],
  );
});

test("block ops address the ids inspect reported", () => {
  const { pack, root } = buildPack();
  const inspection = inspect.inspectDocument(pack);
  // The generated table of contents puts a "Contents" heading first, so the
  // block this addresses is named rather than taken by position.
  const heading = inspection.outline.blocks.find(
    (block) => block.kind === "heading" && block.text === "Summary",
  );
  assert.ok(heading.anchored, "a heading create wrote carries a bookmark id");

  const inserted = edit.applyDocxOps({
    pack,
    inspection,
    ops: [{ op: "insertAfter", after: heading.id, text: "An inserted paragraph." }],
    author: "Umbratic",
    timestamp: createdAt,
  });
  assert.equal(inserted.ok, true, JSON.stringify(plain(inserted.errors ?? [])));
  assert.match(qa.documentText(inserted.pack), /An inserted paragraph\./);

  const promoted = edit.applyDocxOps({
    pack,
    inspection,
    ops: [{ op: "setHeading", block: heading.id, level: 3 }],
    author: "Umbratic",
    timestamp: createdAt,
  });
  assert.equal(promoted.ok, true);
  const after = inspect.inspectDocument(promoted.pack).outline.blocks.find((block) => block.id === heading.id);
  assert.equal(after.level, 3);

  const deleted = edit.applyDocxOps({
    pack,
    inspection,
    ops: [{ op: "deleteBlock", block: heading.id }],
    author: "Umbratic",
    timestamp: createdAt,
  });
  assert.equal(deleted.ok, true);
  assert.ok(!qa.documentText(deleted.pack).includes("Summary"));
  void root;
});

test("an id that is not in the outline is refused with the reason", () => {
  const { result } = apply([{ op: "deleteBlock", block: "b999" }]);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /no block with id b999/);
});

test("one bad op discards the whole batch", () => {
  const { result, before } = apply([
    { op: "replaceText", find: "Summary", replace: "Overview" },
    { op: "deleteBlock", block: "b999" },
  ]);
  assert.equal(result.ok, false);
  assert.match(qa.documentText(before), /Summary/);
});

/* ------------------------------ foreign files ------------------------------ */

function makeForeign(pack) {
  const copy = pack.clone();
  copy.set(
    "docProps/custom.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"/>',
  );
  return copy;
}

test("a foreign document is surgical and takes only the surgical ops", () => {
  const { pack } = buildPack();
  const foreign = makeForeign(pack);
  const inspection = inspect.inspectDocument(foreign);
  assert.equal(inspection.origin, "foreign");
  assert.equal(inspection.editSurface, "surgical");

  const allowed = edit.applyDocxOps({
    pack: foreign,
    inspection,
    ops: [{ op: "replaceText", find: "Summary", replace: "Overview" }],
    author: "Umbratic",
    timestamp: createdAt,
  });
  assert.equal(allowed.ok, true, JSON.stringify(plain(allowed.errors ?? [])));

  const refused = edit.applyDocxOps({
    pack: foreign,
    inspection,
    ops: [{ op: "setHeading", block: "b2", level: 2 }],
    author: "Umbratic",
    timestamp: createdAt,
  });
  assert.equal(refused.ok, false);
  assert.match(refused.errors[0].message, /needs a full edit surface/);
});

test("a document with content controls or a macro reports them and drops to surgical", () => {
  const { pack } = buildPack();
  const withControl = pack.clone();
  withControl.set(
    "word/document.xml",
    pack
      .text("word/document.xml")
      .replace("</w:body>", '<w:sdt><w:sdtPr/><w:sdtContent/></w:sdt></w:body>'),
  );
  const controlled = inspect.inspectDocument(withControl);
  assert.ok(controlled.unsupported.some((entry) => entry.kind === "content-control"));
  assert.equal(controlled.editSurface, "surgical");

  const withMacro = pack.clone();
  withMacro.set("word/vbaProject.bin", Buffer.from("stub"));
  assert.ok(inspect.inspectDocument(withMacro).unsupported.some((entry) => entry.kind === "macro"));
});

/* ------------------------------------ QA ----------------------------------- */

test("QA catches a column too narrow for its longest word", () => {
  const { pack } = buildPack({
    blocks: [
      {
        type: "table",
        columns: [
          { header: "Key", width: "8%", align: "left" },
          { header: "Value", width: "92%", align: "left" },
        ],
        rows: [["Antidisestablishmentarianism", "short"]],
      },
    ],
  });
  const finding = qa
    .checkDocument(pack, "standard_business_brief")
    .find((entry) => entry.kind === "narrow-column");
  assert.ok(finding, "expected a narrow-column finding");
  assert.match(finding.message, /the longest word needs \d+pt/);
});

test("QA catches a heading with nothing under it", () => {
  const { pack } = buildPack({
    blocks: [
      { type: "heading", level: 1, text: "Empty" },
      { type: "heading", level: 1, text: "Also empty" },
      { type: "paragraph", text: "Content." },
    ],
  });
  assert.ok(
    qa.checkDocument(pack, "standard_business_brief").some((entry) => entry.kind === "empty-section"),
  );
});

test("QA catches a comment whose anchor or body is missing", () => {
  const { result } = apply([
    { op: "addComment", on: "Renewals carried the quarter", text: "Confirm." },
  ]);
  const orphaned = result.pack.clone();
  orphaned.set(
    "word/document.xml",
    result.pack.text("word/document.xml").replace(/<w:commentRangeStart[^>]*\/>/, ""),
  );
  assert.ok(
    qa.checkDocument(orphaned, "standard_business_brief").some((entry) => entry.kind === "orphan-comment"),
  );
});

test("a well-formed document reports no errors", () => {
  const { pack } = buildPack();
  assert.deepEqual(
    plain(qa.checkDocument(pack, "standard_business_brief").filter((entry) => entry.severity === "error")),
    [],
  );
});

/* ---------------------------------- engine --------------------------------- */

test("a missing blocks array returns a valid repair example without writing a file", async () => {
  const root = workspace();
  try {
    const job = { action: "create", format: "docx", workspaceRoot: root, absoluteOut: path.join(root, "repair.docx") };
    const rejected = await engine.runArtifactJob({ ...job, spec: { sections: [{ body: [] }] } });
    assert.equal(rejected.ok, false);
    assert.equal(fs.existsSync(job.absoluteOut), false);
    const example = rejected.errors[0].message.match(/Example spec: (\{.*\})\. Full schema:/)?.[1];
    assert.ok(example, "the validation error must show the block fields needed to repair the request");
    const repaired = await engine.runArtifactJob({ ...job, spec: JSON.parse(example) });
    assert.equal(repaired.ok, true, JSON.stringify(repaired));
    assert.ok(fs.statSync(job.absoluteOut).size > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the engine round-trips docx create, inspect, and a tracked edit", async () => {
  const root = workspace();
  const out = path.join(root, ".umbratic", "artifacts", "docx", "brief.docx");
  const created = await engine.runArtifactJob({
    action: "create",
    format: "docx",
    absoluteOut: out,
    out: ".umbratic/artifacts/docx/brief.docx",
    spec: everyBlockSpec,
    workspaceRoot: root,
    createdAt,
  });
  assert.equal(created.ok, true, JSON.stringify(plain(created.errors ?? [])));
  assert.equal(created.origin, "umbratic");
  assert.match(created.summary, /blocks · \d+ words/);
  assert.ok(fs.existsSync(out));

  const inspected = await engine.runArtifactJob({
    action: "inspect",
    format: "docx",
    absolutePath: out,
    path: ".umbratic/artifacts/docx/brief.docx",
    workspaceRoot: root,
  });
  assert.equal(inspected.ok, true);
  assert.ok(inspected.outline.blocks.length > 5);

  const edited = await engine.runArtifactJob({
    action: "edit",
    format: "docx",
    absolutePath: out,
    absoluteOut: out,
    path: ".umbratic/artifacts/docx/brief.docx",
    ops: [{ op: "replaceText", find: "Summary", replace: "Overview", tracked: true }],
    options: { author: "Dana Reyes" },
    workspaceRoot: root,
    createdAt,
  });
  assert.equal(edited.ok, true, JSON.stringify(plain(edited.errors ?? [])));
  assert.match(edited.summary, /1 op applied/);
});

test("the engine writes nothing when a docx spec is invalid", async () => {
  const root = workspace();
  const out = path.join(root, "bad.docx");
  const response = await engine.runArtifactJob({
    action: "create",
    format: "docx",
    absoluteOut: out,
    spec: { blocks: [{ type: "heading", level: 9, text: "Nope" }] },
    workspaceRoot: root,
    createdAt,
  });
  assert.equal(response.ok, false);
  assert.equal(response.errors[0].path, "blocks[0].level");
  assert.equal(fs.existsSync(out), false);
});
