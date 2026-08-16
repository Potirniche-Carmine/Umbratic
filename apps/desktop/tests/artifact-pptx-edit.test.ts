import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const cache = new Map();
const load = (relative) =>
  loadTypeScriptModule(new URL(`../src/main/artifacts/worker/${relative}`, import.meta.url), { cache, realm: "host" });

const spec = load("pptx/spec.ts");
const create = load("pptx/create.ts");
const inspect = load("pptx/inspect.ts");
const edit = load("pptx/edit.ts");
const qa = load("pptx/qa.ts");
const packageModule = load("package.ts");
const engine = load("engine.ts");
const xml = load("xml.ts");

const createdAt = "2026-01-01T00:00:00Z";
const plain = (value) => JSON.parse(JSON.stringify(value));

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-pptx-edit-"));
}

const baseSpec = {
  meta: { title: "Deck", author: "Umbratic" },
  slides: [
    { layout: "title", title: "Original title", subtitle: "Original subtitle" },
    { layout: "bullets", title: "Points", bullets: ["First point", "Second point"] },
    {
      layout: "chart",
      title: "Revenue",
      chart: { type: "column", categories: ["Q1", "Q2"], series: [{ name: "Rev", values: [1, 2] }] },
    },
    { layout: "table", title: "Grid", columns: ["Stage", "Count"], rows: [["Won", "7"]] },
  ],
};

function buildPack(input = baseSpec, root = workspace()) {
  const read = spec.readPresentationSpec(input);
  assert.deepEqual(plain(read.errors), []);
  const built = create.createPresentation({ spec: read.spec, workspaceRoot: root, createdAt });
  assert.deepEqual(plain(built.errors), []);
  return { pack: built.pack, root };
}

function apply(ops, input = baseSpec) {
  const { pack, root } = buildPack(input);
  const inspection = inspect.inspectPresentation(pack);
  return { result: edit.applyOps({ pack, inspection, ops, workspaceRoot: root }), before: pack, root };
}

test("replaceText changes the words and leaves every other part byte-identical", () => {
  const { pack, root } = buildPack();
  const before = new Map(pack.names().map((name) => [name, pack.bytes(name)]));
  const inspection = inspect.inspectPresentation(pack);
  const result = edit.applyOps({
    pack,
    inspection,
    ops: [{ op: "replaceText", slide: 1, shape: "Title 1", text: "Replaced title" }],
    workspaceRoot: root,
  });
  assert.equal(result.ok, true, JSON.stringify(plain(result.errors ?? [])));

  const after = inspect.inspectPresentation(result.pack);
  assert.equal(after.outline.slides[0].title, "Replaced title");
  // The rule that makes editing a stranger's deck safe.
  const changed = result.pack
    .names()
    .filter((name) => !before.get(name)?.equals(result.pack.bytes(name)));
  assert.deepEqual(plain(changed), ["ppt/slides/slide1.xml"]);
});

test("setBullets rewrites the list and keeps the run formatting that was there", () => {
  const { result } = apply([
    { op: "setBullets", slide: 2, shape: "Content 2", bullets: ["Only one", { text: "Nested", level: 1 }] },
  ]);
  assert.equal(result.ok, true);
  const after = inspect.inspectPresentation(result.pack);
  assert.equal(after.outline.slides[1].shapes[1].text, "Only one\nNested");

  const slide = xml.parseXml(result.pack.text("ppt/slides/slide2.xml"));
  const runs = xml.findElements(slide, "rPr");
  // The original body run was 1800 hundredths; a rewrite that dropped rPr would
  // leave the text at the master's default instead.
  assert.ok(runs.some((run) => xml.attribute(run, "sz") === "1800"));
  const levels = xml.findElements(slide, "pPr").map((node) => xml.attribute(node, "lvl"));
  assert.ok(levels.includes("1"), "the second bullet kept its level");
});

test("findReplace matches across the runs a paragraph is split into", () => {
  const { pack, root } = buildPack();
  // Split "Original title" across three runs the way PowerPoint does after an
  // edit, so a run-by-run search would find nothing.
  const slide = pack.text("ppt/slides/slide1.xml");
  const split = slide.replace(
    /<a:t>Original title<\/a:t>/,
    "<a:t>Origi</a:t></a:r><a:r><a:rPr lang=\"en-US\"/><a:t>nal ti</a:t></a:r><a:r><a:rPr lang=\"en-US\"/><a:t>tle</a:t>",
  );
  assert.notEqual(split, slide, "the fixture should actually be split");
  pack.set("ppt/slides/slide1.xml", split);

  const inspection = inspect.inspectPresentation(pack);
  const result = edit.applyOps({
    pack,
    inspection,
    ops: [{ op: "findReplace", find: "Original title", replace: "Rewritten" }],
    workspaceRoot: root,
  });
  assert.equal(result.ok, true, JSON.stringify(plain(result.errors ?? [])));
  assert.equal(inspect.inspectPresentation(result.pack).outline.slides[0].title, "Rewritten");
});

test("findReplace that matches nothing fails instead of reporting a silent success", () => {
  const { result } = apply([{ op: "findReplace", find: "absent phrase", replace: "x" }]);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /does not appear/);
});

test("setChartData refreshes the numbers and is validated by the create schema", () => {
  const { result } = apply([
    {
      op: "setChartData",
      slide: 3,
      shape: "Chart 2",
      chart: { type: "column", categories: ["Q1", "Q2", "Q3"], series: [{ name: "Rev", values: [4, 5, 6] }] },
    },
  ]);
  assert.equal(result.ok, true, JSON.stringify(plain(result.errors ?? [])));
  const chart = result.pack.text("ppt/charts/chart3.xml");
  assert.match(chart, /<c:v>Q3<\/c:v>/);
  assert.match(chart, /<c:v>6<\/c:v>/);

  const mismatched = apply([
    {
      op: "setChartData",
      slide: 3,
      shape: "Chart 2",
      chart: { type: "column", categories: ["Q1", "Q2"], series: [{ name: "Rev", values: [1] }] },
    },
  ]);
  assert.equal(mismatched.result.ok, false);
  assert.match(mismatched.result.errors[0].message, /1 values but there are 2 categories/);
});

test("setTable replaces cells and refuses to invent rows", () => {
  const { result } = apply([
    { op: "setTable", slide: 4, shape: "Table 2", rows: [["Lost", "3"]] },
  ]);
  assert.equal(result.ok, true, JSON.stringify(plain(result.errors ?? [])));
  assert.match(result.pack.text("ppt/slides/slide4.xml"), /Lost/);

  const overflowing = apply([
    { op: "setTable", slide: 4, shape: "Table 2", rows: [["a", "1"], ["b", "2"], ["c", "3"]] },
  ]);
  assert.equal(overflowing.result.ok, false);
  assert.match(overflowing.result.errors[0].message, /does not add rows/);
});

test("slide ops keep the id list and the relationships agreeing", () => {
  const moved = apply([{ op: "moveSlide", slide: 1, to: 3 }]);
  assert.equal(moved.result.ok, true);
  const order = inspect.orderedSlideParts(moved.result.pack);
  assert.deepEqual(plain(order), [
    "ppt/slides/slide2.xml",
    "ppt/slides/slide3.xml",
    "ppt/slides/slide1.xml",
    "ppt/slides/slide4.xml",
  ]);

  const duplicated = apply([{ op: "duplicateSlide", slide: 2 }]);
  assert.equal(duplicated.result.ok, true);
  const after = inspect.inspectPresentation(duplicated.result.pack);
  assert.equal(after.outline.slideCount, 5);
  assert.equal(after.outline.slides[1].title, after.outline.slides[2].title);

  const deleted = apply([{ op: "deleteSlide", slide: 2 }]);
  assert.equal(deleted.result.ok, true);
  assert.equal(inspect.inspectPresentation(deleted.result.pack).outline.slideCount, 3);
  assert.equal(deleted.result.pack.has("ppt/slides/slide2.xml"), false);
  assert.deepEqual(plain(qa.checkPresentation(deleted.result.pack).filter((f) => f.severity === "error")), []);
});

test("deleting the last remaining slide is refused", () => {
  const { result } = apply([{ op: "deleteSlide", slide: 1 }], {
    slides: [{ layout: "title", title: "Only" }],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /at least one slide/);
});

test("an unknown shape name lists the names that do exist", () => {
  const { result } = apply([{ op: "replaceText", slide: 1, shape: "Nope", text: "x" }]);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /Title 1/);
});

test("one bad op discards the whole batch", () => {
  const { result, before } = apply([
    { op: "replaceText", slide: 1, shape: "Title 1", text: "Changed" },
    { op: "replaceText", slide: 1, shape: "Missing", text: "x" },
  ]);
  assert.equal(result.ok, false);
  // The source package is untouched; applyOps worked on a clone.
  assert.match(before.text("ppt/slides/slide1.xml"), /Original title/);
});

/* --------------------------- foreign-deck behaviour -------------------------- */

/** Strips our origin stamp, which is what makes a deck "someone else's". */
function makeForeign(pack) {
  const copy = pack.clone();
  copy.set(
    "docProps/custom.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"/>',
  );
  return copy;
}

test("a foreign deck opens as surgical and takes surgical ops", () => {
  const { pack, root } = buildPack();
  const foreign = makeForeign(pack);
  const inspection = inspect.inspectPresentation(foreign);
  assert.equal(inspection.origin, "foreign");
  assert.equal(inspection.editSurface, "surgical");

  const result = edit.applyOps({
    pack: foreign,
    inspection,
    ops: [{ op: "replaceText", slide: 1, shape: "Title 1", text: "Their words, our edit" }],
    workspaceRoot: root,
  });
  assert.equal(result.ok, true, JSON.stringify(plain(result.errors ?? [])));
});

test("an op outside the surgical set is refused on a foreign deck", () => {
  const { pack, root } = buildPack();
  const foreign = makeForeign(pack);
  const result = edit.applyOps({
    pack: foreign,
    inspection: inspect.inspectPresentation(foreign),
    ops: [{ op: "insertSlide", at: 1, layout: "bullets" }],
    workspaceRoot: root,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /needs a full edit surface/);
});

test("a deck holding SmartArt reports it and refuses to clone that slide", () => {
  const { pack, root } = buildPack();
  const slide = pack.text("ppt/slides/slide2.xml");
  pack.set(
    "ppt/slides/slide2.xml",
    slide.replace(
      "</p:spTree>",
      '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="90" name="Diagram 90"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>'
        + '<p:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></p:xfrm>'
        + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"/></a:graphic></p:graphicFrame></p:spTree>',
    ),
  );
  const inspection = inspect.inspectPresentation(pack);
  assert.ok(inspection.unsupported.some((entry) => entry.kind === "smart-art"));
  assert.equal(inspection.editSurface, "surgical");

  const cloned = edit.applyOps({
    pack,
    inspection,
    ops: [{ op: "duplicateSlide", slide: 2 }],
    workspaceRoot: root,
  });
  assert.equal(cloned.ok, false);
  assert.match(cloned.errors[0].message, /smart-art/);

  // The text on that slide is still editable: the diagram part is never read.
  const text = edit.applyOps({
    pack,
    inspection,
    ops: [{ op: "replaceText", slide: 2, shape: "Title 1", text: "Still editable" }],
    workspaceRoot: root,
  });
  assert.equal(text.ok, true, JSON.stringify(plain(text.errors ?? [])));
});

/* ----------------------------------- QA ------------------------------------ */

test("QA reports text that does not fit its box as an error, with the ratio", () => {
  // The spec's own limits keep a *created* deck inside its boxes, so the way to
  // overflow one is an edit — `replaceText` takes whatever string it is given,
  // which is exactly the case this detector exists for.
  const { result } = apply([
    {
      op: "replaceText",
      slide: 1,
      shape: "Title 1",
      text: "a title that simply will not stop going on and on ".repeat(12),
    },
  ]);
  assert.equal(result.ok, true, JSON.stringify(plain(result.errors ?? [])));
  const findings = qa.checkPresentation(result.pack);
  const overflow = findings.find((finding) => finding.kind === "text-overflow");
  assert.ok(overflow, `expected an overflow finding, got ${JSON.stringify(plain(findings))}`);
  assert.equal(overflow.severity, "error");
  assert.match(overflow.message, /\d+% of the box height/);
  assert.match(overflow.fix, /shorten/);
});

test("the spec's limits keep a created deck inside its boxes on every layout", () => {
  // The claim fixed geometry makes: fill every layout to its stated maximum and
  // nothing overflows. If a limit or a box changes and this stops holding, the
  // limit is wrong — that is what this guards.
  const { pack } = buildPack({
    slides: [
      { layout: "title", title: "x".repeat(60), subtitle: "y".repeat(160) },
      { layout: "section", title: "x".repeat(60) },
      {
        layout: "bullets",
        title: "x".repeat(60),
        bullets: Array.from({ length: 6 }, () => "m".repeat(90)),
      },
      {
        layout: "two-column",
        title: "x".repeat(60),
        left: { bullets: Array.from({ length: 6 }, () => "m".repeat(90)) },
        right: { text: "m".repeat(600) },
      },
      { layout: "quote", quote: "q".repeat(400), attribution: "a".repeat(160) },
      {
        layout: "kpis",
        title: "x".repeat(60),
        items: Array.from({ length: 4 }, () => ({ label: "l".repeat(40), value: "$4.2M", delta: "+12%" })),
      },
    ],
  });
  const overflowing = qa
    .checkPresentation(pack)
    .filter((finding) => finding.kind === "text-overflow" && finding.severity === "error");
  assert.deepEqual(plain(overflowing), []);
});

test("a deck that fits reports no errors at all", () => {
  const { pack } = buildPack();
  assert.deepEqual(
    plain(qa.checkPresentation(pack).filter((finding) => finding.severity === "error")),
    [],
  );
});

test("QA catches each corruption rule from a hand-damaged package", () => {
  const cases = [
    {
      kind: "shape-without-text-body",
      damage: (slide) => slide.replace(/<p:txBody>[\s\S]*?<\/p:txBody>/, ""),
    },
    {
      kind: "invalid-color",
      damage: (slide) => slide.replace(/val="[0-9A-F]{6}"/, 'val="FF2F6FD0"'),
    },
    {
      kind: "malformed-xml",
      damage: (slide) => slide.replace("</p:sld>", ""),
    },
  ];
  for (const { kind, damage } of cases) {
    const { pack } = buildPack();
    pack.set("ppt/slides/slide1.xml", damage(pack.text("ppt/slides/slide1.xml")));
    const findings = qa.checkPresentation(pack);
    assert.ok(
      findings.some((finding) => finding.kind === kind),
      `expected a ${kind} finding, got ${findings.map((f) => f.kind).join(", ")}`,
    );
  }
});

test("QA catches a relationship that points at a part the package does not have", () => {
  const { pack } = buildPack();
  pack.delete("ppt/charts/chart3.xml");
  const findings = qa.checkPresentation(pack);
  assert.ok(findings.some((finding) => finding.kind === "dangling-relationship"));
});

/* --------------------------------- engine ---------------------------------- */

test("the engine writes nothing when the spec is invalid", async () => {
  const root = workspace();
  const out = path.join(root, ".umbratic", "artifacts", "pptx", "deck.pptx");
  const response = await engine.runArtifactJob({
    action: "create",
    format: "pptx",
    absoluteOut: out,
    out: ".umbratic/artifacts/pptx/deck.pptx",
    spec: { slides: [{ layout: "bullets", title: "Too many", bullets: ["a", "b", "c", "d", "e", "f", "g"] }] },
    workspaceRoot: root,
    createdAt,
  });
  assert.equal(response.ok, false);
  assert.equal(response.errors[0].path, "slides[0].bullets");
  assert.equal(fs.existsSync(out), false, "a rejected build must not leave a file");
});

test("the engine round-trips create, inspect, and edit through the filesystem", async () => {
  const root = workspace();
  const out = path.join(root, ".umbratic", "artifacts", "pptx", "deck.pptx");
  const created = await engine.runArtifactJob({
    action: "create",
    format: "pptx",
    absoluteOut: out,
    out: ".umbratic/artifacts/pptx/deck.pptx",
    spec: baseSpec,
    workspaceRoot: root,
    createdAt,
  });
  assert.equal(created.ok, true, JSON.stringify(plain(created.errors ?? [])));
  assert.equal(created.origin, "umbratic");
  assert.equal(created.editSurface, "full");
  assert.ok(fs.existsSync(out));
  assert.equal(created.outline, undefined, "create stays under the shown cap");

  const inspected = await engine.runArtifactJob({
    action: "inspect",
    format: "pptx",
    absolutePath: out,
    path: ".umbratic/artifacts/pptx/deck.pptx",
    workspaceRoot: root,
  });
  assert.equal(inspected.ok, true);
  assert.equal(inspected.outline.slideCount, 4);

  const edited = await engine.runArtifactJob({
    action: "edit",
    format: "pptx",
    absolutePath: out,
    absoluteOut: out,
    path: ".umbratic/artifacts/pptx/deck.pptx",
    ops: [{ op: "replaceText", slide: 1, shape: "Title 1", text: "Edited in place" }],
    workspaceRoot: root,
  });
  assert.equal(edited.ok, true, JSON.stringify(plain(edited.errors ?? [])));

  const reopened = await packageModule.OoxmlPackage.read(fs.readFileSync(out));
  assert.equal(inspect.inspectPresentation(reopened).outline.slides[0].title, "Edited in place");
});

test("the engine names an encrypted or legacy file rather than calling it corrupt", async () => {
  const root = workspace();
  const file = path.join(root, "legacy.pptx");
  const ole = Buffer.alloc(512);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(ole);
  fs.writeFileSync(file, ole);
  const response = await engine.runArtifactJob({
    action: "inspect",
    format: "pptx",
    absolutePath: file,
    path: "legacy.pptx",
    workspaceRoot: root,
  });
  assert.equal(response.ok, false);
  assert.equal(response.kind, "unsupported");
  assert.match(response.errors[0].message, /inspect-only/);
});

test("a format with no engine yet says so instead of failing obscurely", async () => {
  const response = await engine.runArtifactJob({
    action: "create",
    format: "xlsx",
    spec: {},
    workspaceRoot: workspace(),
  });
  assert.equal(response.ok, false);
  assert.match(response.errors[0].message, /not built yet/);
});

test("insertSlide builds with the create vocabulary and lands where it was asked to", () => {
  const { result } = apply([
    { op: "insertSlide", at: 2, layout: "bullets", title: "Inserted", bullets: ["New point"] },
  ]);
  assert.equal(result.ok, true, JSON.stringify(plain(result.errors ?? [])));
  const after = inspect.inspectPresentation(result.pack);
  assert.equal(after.outline.slideCount, 5);
  assert.equal(after.outline.slides[1].title, "Inserted");
  // The shape names have to match what create writes, or a follow-up edit
  // addressing the new slide would find nothing.
  assert.deepEqual(plain(after.outline.slides[1].shapes.map((shape) => shape.name)), ["Title 1", "Content 2"]);
  assert.deepEqual(plain(qa.checkPresentation(result.pack).filter((f) => f.severity === "error")), []);
});

test("an inserted chart slide does not overwrite a chart part the deck already had", () => {
  const { result } = apply([
    {
      op: "insertSlide",
      at: 1,
      layout: "chart",
      title: "Added chart",
      chart: { type: "line", categories: ["A", "B"], series: [{ name: "S", values: [1, 2] }] },
    },
  ]);
  assert.equal(result.ok, true, JSON.stringify(plain(result.errors ?? [])));
  const charts = result.pack.names().filter((name) => name.startsWith("ppt/charts/"));
  assert.equal(charts.length, 2, `expected the original and the new chart, got ${charts.join(", ")}`);
  // The deck's own chart still holds its own numbers.
  assert.match(result.pack.text("ppt/charts/chart3.xml"), /<c:v>Q1<\/c:v>/);
  assert.deepEqual(plain(qa.checkPresentation(result.pack).filter((f) => f.severity === "error")), []);
});

test("insertSlide validates against the same limits create uses", () => {
  const { result } = apply([
    { op: "insertSlide", at: 1, layout: "bullets", title: "Too many", bullets: ["a", "b", "c", "d", "e", "f", "g"] },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /max 6/);
});

test("an inserted slide with notes keeps its notes part wired to the new slide", () => {
  const { result } = apply([
    { op: "insertSlide", at: 1, layout: "section", title: "With notes", notes: "Say this out loud." },
  ]);
  assert.equal(result.ok, true, JSON.stringify(plain(result.errors ?? [])));
  const after = inspect.inspectPresentation(result.pack);
  assert.equal(after.outline.slides[0].notes, "Say this out loud.");
  assert.deepEqual(plain(qa.checkPresentation(result.pack).filter((f) => f.severity === "error")), []);
});

test("setNotes adds a notes slide to a slide that had none, and replaces one that did", () => {
  const added = apply([{ op: "setNotes", slide: 2, notes: "Fresh notes" }]);
  assert.equal(added.result.ok, true, JSON.stringify(plain(added.result.errors ?? [])));
  assert.equal(inspect.inspectPresentation(added.result.pack).outline.slides[1].notes, "Fresh notes");
  assert.deepEqual(plain(qa.checkPresentation(added.result.pack).filter((f) => f.severity === "error")), []);

  const replaced = apply(
    [{ op: "setNotes", slide: 1, notes: "Replaced notes" }],
    { slides: [{ layout: "title", title: "T", notes: "Original notes" }] },
  );
  assert.equal(replaced.result.ok, true, JSON.stringify(plain(replaced.result.errors ?? [])));
  assert.equal(inspect.inspectPresentation(replaced.result.pack).outline.slides[0].notes, "Replaced notes");
});
