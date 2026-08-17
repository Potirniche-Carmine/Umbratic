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
const packageModule = load("package.ts");
const opc = load("opc.ts");
const xml = load("xml.ts");
const text = load("text.ts");

const createdAt = "2026-01-01T00:00:00Z";

// Modules load inside a vm context with its own realm, so an array that came
// back from one is not an instance of this realm's Array and deepEqual sees a
// prototype mismatch. Round-tripping through JSON compares the data.
const plain = (value) => JSON.parse(JSON.stringify(value));

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-pptx-"));
}

/** Builds a deck from a spec object and returns the package plus its bytes. */
async function build(input, root = workspace()) {
  const read = spec.readPresentationSpec(input);
  assert.deepEqual(plain(read.errors), [], "spec should be valid");
  const result = create.createPresentation({ spec: read.spec, workspaceRoot: root, createdAt });
  assert.deepEqual(plain(result.errors), [], "create should not error");
  const bytes = await result.pack.write();
  return { pack: result.pack, bytes, names: result.slideNames };
}

const everyLayoutSpec = {
  format: "pptx",
  theme: { preset: "clean-light", accent: "#2F6FD0" },
  meta: { title: "Q3 Review", author: "Umbratic" },
  slides: [
    { layout: "title", title: "Q3 Review", subtitle: "EMEA business unit", notes: "Open with the headline number." },
    { layout: "section", title: "Where we landed" },
    { layout: "bullets", title: "Highlights", bullets: ["Revenue up **12%**", { text: "Driven by renewals", level: 1 }] },
    { layout: "two-column", title: "Split", left: { bullets: ["Left one"] }, right: { text: "Right side prose" } },
    {
      layout: "chart",
      title: "Revenue by quarter",
      chart: {
        type: "column",
        categories: ["Q1", "Q2", "Q3"],
        series: [{ name: "Revenue", values: [1.2, 1.6, 1.9] }],
      },
    },
    { layout: "table", title: "Pipeline", columns: ["Stage", "Count"], rows: [["Qualified", "18"], ["Won", "7"]] },
    { layout: "kpis", title: "At a glance", items: [{ label: "ARR", value: "$4.2M", delta: "+12%" }, { label: "Churn", value: "2.1%", delta: "-0.3%" }] },
    { layout: "quote", quote: "The renewals story carried the quarter.", attribution: "Head of Revenue" },
    { layout: "closing", title: "Questions" },
  ],
};

test("every layout builds a package that inspect reads back with the names create wrote", async () => {
  const { bytes, names } = await build(everyLayoutSpec);
  const reopened = await packageModule.OoxmlPackage.read(bytes);
  const inspection = inspect.inspectPresentation(reopened);

  assert.equal(inspection.origin, "umbratic", "a deck we wrote carries the origin stamp");
  assert.equal(inspection.editSurface, "full");
  assert.deepEqual(plain(inspection.unsupported), []);
  assert.equal(inspection.outline.slideCount, everyLayoutSpec.slides.length);

  // The vocabulary contract: what create named is what edit can address.
  inspection.outline.slides.forEach((slide, index) => {
    assert.deepEqual(
      plain(slide.shapes.map((shape) => shape.name)),
      plain(names[index]),
      `slide ${index + 1} shape names`,
    );
  });

  const bulletsSlide = inspection.outline.slides[2];
  assert.equal(bulletsSlide.title, "Highlights");
  // Inline markup is formatting, not literal text: the reader sees the words.
  assert.match(bulletsSlide.shapes[1].text, /Revenue up 12%/);

  const chartSlide = inspection.outline.slides[4];
  const chartShape = chartSlide.shapes.find((shape) => shape.kind === "chart");
  assert.equal(chartShape.chartType, "barChart");
  assert.equal(chartShape.seriesCount, 1);

  const tableShape = inspection.outline.slides[5].shapes.find((shape) => shape.kind === "table");
  assert.equal(tableShape.columns, 2);
  assert.equal(tableShape.rows, 3, "header plus two body rows");

  assert.equal(inspection.outline.slides[0].notes, "Open with the headline number.");
});

test("the package declares a content type and a relationship for every part it contains", async () => {
  const { pack } = await build(everyLayoutSpec);
  const types = opc.readContentTypes(pack);
  for (const name of pack.names()) {
    if (name === "[Content_Types].xml" || name.endsWith(".rels")) continue;
    assert.ok(opc.contentTypeOf(types, name), `${name} has no content type`);
  }
  // A relationship that points at nothing is the other half of the same bug.
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

test("two builds of the same spec produce byte-identical files", async () => {
  const root = workspace();
  const first = await build(everyLayoutSpec, root);
  const second = await build(everyLayoutSpec, root);
  assert.ok(first.bytes.equals(second.bytes), "output must not depend on the clock");
});

test("slide order follows the presentation part rather than the zip's entry names", async () => {
  const { pack } = await build(everyLayoutSpec);
  assert.deepEqual(
    plain(inspect.orderedSlideParts(pack)),
    everyLayoutSpec.slides.map((_, index) => `ppt/slides/slide${index + 1}.xml`),
  );
});

test("spec limits fail with the JSON path that has to change", () => {
  const tooManyBullets = spec.readPresentationSpec({
    slides: [{ layout: "bullets", title: "Too much", bullets: ["a", "b", "c", "d", "e", "f", "g"] }],
  });
  assert.deepEqual(plain(tooManyBullets.errors), [
    { path: "slides[0].bullets", message: "has 7 items; max 6 — split the slide" },
  ]);

  const seriesMismatch = spec.readPresentationSpec({
    slides: [
      {
        layout: "chart",
        title: "Mismatch",
        chart: { type: "line", categories: ["Q1", "Q2"], series: [{ name: "Revenue", values: [1] }] },
      },
    ],
  });
  assert.deepEqual(plain(seriesMismatch.errors), [
    {
      path: "slides[0].chart.series[0].values",
      message: "has 1 values but there are 2 categories",
    },
  ]);

  const longTitle = spec.readPresentationSpec({
    slides: [{ layout: "section", title: "x".repeat(61) }],
  });
  assert.equal(longTitle.errors[0].path, "slides[0].title");

  const wideTable = spec.readPresentationSpec({
    slides: [
      {
        layout: "table",
        title: "Wide",
        columns: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
        rows: [],
      },
    ],
  });
  assert.equal(wideTable.errors[0].path, "slides[0].columns");

  const tooFewKpis = spec.readPresentationSpec({
    slides: [{ layout: "kpis", title: "One", items: [{ label: "ARR", value: "$4M" }] }],
  });
  assert.equal(tooFewKpis.errors[0].path, "slides[0].items");
});

test("a valid example of every layout passes the spec reader", () => {
  const read = spec.readPresentationSpec(everyLayoutSpec);
  assert.deepEqual(plain(read.errors), []);
  assert.equal(read.spec.slides.length, everyLayoutSpec.slides.length);
});

test("an image outside the workspace never reaches the package", async () => {
  const root = workspace();
  const read = spec.readPresentationSpec({
    slides: [{ layout: "image", title: "Escape", image: "../outside.png" }],
  });
  assert.deepEqual(plain(read.errors), []);
  const result = create.createPresentation({ spec: read.spec, workspaceRoot: root, createdAt });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /outside the workspace/);
});

test("an image that is not a PNG, JPEG, or GIF is refused by content, not by name", async () => {
  const root = workspace();
  // An ICNS header renamed to .png. This is the family of formats whose parsers
  // carry unfixed denial-of-service advisories, so it must never be decoded.
  fs.writeFileSync(path.join(root, "trap.png"), Buffer.from("icns   ", "binary"));
  const read = spec.readPresentationSpec({
    slides: [{ layout: "image", title: "Trap", image: "trap.png" }],
  });
  const result = create.createPresentation({ spec: read.spec, workspaceRoot: root, createdAt });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /not a PNG, JPEG, or GIF/);
});

test("a real PNG embeds once and keeps its aspect ratio", async () => {
  const root = workspace();
  // A 2x1 PNG, written by hand so the test does not depend on an encoder.
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000020000000108060000006ff4c47e"
      + "0000000a49444154789c6360000000020001e221bc330000000049454e44ae426082",
    "hex",
  );
  fs.writeFileSync(path.join(root, "wide.png"), png);
  const { pack } = await build(
    {
      slides: [
        { layout: "image", title: "First", image: "wide.png" },
        { layout: "image", title: "Second", image: "wide.png" },
      ],
    },
    root,
  );
  const media = pack.names().filter((name) => name.startsWith("ppt/media/"));
  assert.deepEqual(plain(media), ["ppt/media/image1.png"], "the same file embeds once");

  const slide = xml.parseXml(pack.text("ppt/slides/slide1.xml"));
  const extent = xml.firstElement(xml.firstElement(slide, "pic"), "ext");
  const width = Number(xml.attribute(extent, "cx"));
  const height = Number(xml.attribute(extent, "cy"));
  assert.ok(Math.abs(width / height - 2) < 0.01, `2:1 image kept its ratio, got ${width}x${height}`);
});

test("a package that is an OLE compound file is named as encrypted or legacy, not corrupt", async () => {
  const ole = Buffer.alloc(64);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(ole);
  await assert.rejects(
    () => packageModule.OoxmlPackage.read(ole),
    (error) => error.kind === "encrypted",
  );
});

test("XML with a DOCTYPE is refused before an entity can expand", () => {
  assert.throws(
    () => xml.parseXml('<!DOCTYPE p [<!ENTITY a "b">]><p>&a;</p>'),
    /DOCTYPE or entity/,
  );
});

test("text measurement uses real advance widths, not a character count", () => {
  assert.ok(text.metricsAvailable(), "the Liberation metrics should be readable");
  const narrow = text.measureText("iiiiiiiiii", 18);
  const wide = text.measureText("MMMMMMMMMM", 18);
  assert.ok(wide > narrow * 2.5, `M should be far wider than i, got ${narrow} and ${wide}`);

  const lines = text.wrapText("alpha bravo charlie delta echo foxtrot", 60, 18);
  assert.ok(lines.length > 1, "a long line wraps");
  for (const line of lines) {
    if (line.includes(" ")) assert.ok(text.measureText(line, 18) <= 60);
  }
});
