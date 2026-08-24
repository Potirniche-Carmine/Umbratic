/**
 * Editing an existing .pptx.
 *
 * Two rules shape everything here. The first is that a part no op targeted must
 * come out byte-identical: this module rewrites only the parts it changes, and
 * a deck that came from someone else keeps their masters, their theme, and
 * their untouched slides exactly as they wrote them. The second is that an op
 * the file's edit surface does not allow is refused rather than approximated —
 * a `duplicateSlide` on a slide holding SmartArt would produce a deck that
 * PowerPoint offers to repair, and a repaired deck is worse than a refused op.
 *
 * Ops address what `inspect` reported: slide numbers and shape names. Nothing
 * takes a coordinate, and nothing takes an internal id.
 */

import * as path from "node:path";

import { loadImage } from "../images.js";
import { OoxmlPackage, relationshipPartFor, resolveRelativePart } from "../package.js";
import {
  nextRelationshipId,
  readContentTypes,
  readRelationships,
  relationshipTarget,
  relationshipTypes,
  writeContentTypes,
  writeRelationships,
  type Relationship,
} from "../opc.js";
import {
  attribute,
  childElements,
  element,
  findElements,
  firstElement,
  localNameOf,
  parseXml,
  serializeDom,
  serializeXml,
  textOf,
  type XmlNode,
} from "../xml.js";
import { chartXml } from "./chart.js";
import { notesSlideContentType, slideContentType } from "./scaffold.js";
import { readPresentationSpec, type SpecError } from "./spec.js";
import { resolvePalette } from "./theme.js";
import type { Inspection, UnsupportedKind } from "./inspect.js";
import { orderedSlideParts } from "./inspect.js";

export type OpError = { path: string; message: string };

export type EditResult =
  | { ok: true; pack: OoxmlPackage; applied: string[] }
  | { ok: false; errors: OpError[] };

/** Ops allowed on a foreign or feature-carrying deck. */
const surgicalOps = new Set([
  "replaceText",
  "setBullets",
  "setNotes",
  "replaceImage",
  "setChartData",
  "setTable",
  "findReplace",
  "duplicateSlide",
  "moveSlide",
  "deleteSlide",
]);

/** Ops that additionally need the deck to be ours, with nothing unsupported. */
const fullOnlyOps = new Set(["insertSlide"]);

/**
 * Features that make a *slide* untouchable by the ops that clone or move it.
 *
 * A text replacement on a slide that also holds SmartArt is fine — the diagram
 * part is not read or rewritten. Cloning that slide is not: the copy would
 * reference a diagram part it does not own.
 */
const uncloneable: UnsupportedKind[] = ["smart-art", "ole"];

export type EditOptions = {
  pack: OoxmlPackage;
  inspection: Inspection;
  ops: unknown[];
  workspaceRoot: string;
};

export function applyOps(options: EditOptions): EditResult {
  const { inspection } = options;
  if (inspection.editSurface === "inspect-only") {
    return {
      ok: false,
      errors: [
        {
          path: "ops[0]",
          message: `editSurface is inspect-only (${inspection.unsupported.map((entry) => entry.kind).join(", ") || "unreadable"})`,
        },
      ],
    };
  }
  // Everything runs against a copy. A failure part-way through therefore
  // discards the whole batch rather than leaving a file that had four of six
  // ops applied to it.
  const pack = options.pack.clone();
  const errors: OpError[] = [];
  const applied: string[] = [];

  options.ops.forEach((raw, index) => {
    if (errors.length > 0) return;
    const opPath = `ops[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      errors.push({ path: opPath, message: "must be an object with an op field" });
      return;
    }
    const op = raw as Record<string, unknown>;
    const kind = typeof op.op === "string" ? op.op : "";
    if (!surgicalOps.has(kind) && !fullOnlyOps.has(kind)) {
      errors.push({
        path: `${opPath}.op`,
        message: `${kind || "(missing)"} is not an operation; use one of ${[...surgicalOps, ...fullOnlyOps].sort().join(", ")}`,
      });
      return;
    }
    if (fullOnlyOps.has(kind) && inspection.editSurface !== "full") {
      errors.push({
        path: `${opPath}.op`,
        message: `${kind} needs a full edit surface; this file is surgical (${inspection.unsupported.map((entry) => entry.kind).join(", ") || "foreign origin"})`,
      });
      return;
    }
    try {
      applied.push(applyOne(pack, kind, op, opPath, options));
    } catch (error) {
      errors.push({
        path: opPath,
        message: String(error instanceof Error ? error.message : error),
      });
    }
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, pack, applied };
}

function applyOne(
  pack: OoxmlPackage,
  kind: string,
  op: Record<string, unknown>,
  opPath: string,
  options: EditOptions,
): string {
  switch (kind) {
    case "replaceText":
      return replaceText(pack, op, opPath);
    case "setBullets":
      return setBullets(pack, op, opPath);
    case "setNotes":
      return setNotes(pack, op, opPath);
    case "findReplace":
      return findReplace(pack, op, opPath);
    case "replaceImage":
      return replaceImage(pack, op, opPath, options.workspaceRoot);
    case "setChartData":
      return setChartData(pack, op, opPath);
    case "setTable":
      return setTable(pack, op, opPath);
    case "duplicateSlide":
      return duplicateSlide(pack, op, opPath, options.inspection);
    case "moveSlide":
      return moveSlide(pack, op, opPath);
    case "deleteSlide":
      return deleteSlide(pack, op, opPath);
    case "insertSlide":
      return insertSlide(pack, op, opPath, options.workspaceRoot);
    default:
      throw new Error(`${kind} is not implemented`);
  }
}

/**
 * Adds a slide built from the create vocabulary.
 *
 * It is rendered by building a one-slide presentation with the same code path
 * `create` uses and grafting the result in, rather than by a second slide
 * builder living here. That keeps one definition of what a "bullets" slide is:
 * the same layout table, the same limits, the same shape names — so a slide
 * inserted into a deck is indistinguishable from one that was there from the
 * start.
 *
 * This is a full-surface op, which means the deck is ours, which means our
 * layout parts are already present for the grafted slide to point at.
 */
function insertSlide(
  pack: OoxmlPackage,
  op: Record<string, unknown>,
  opPath: string,
  workspaceRoot: string,
): string {
  const parts = orderedSlideParts(pack);
  const at = op.at === undefined ? parts.length + 1 : op.at;
  if (typeof at !== "number" || !Number.isInteger(at) || at < 1 || at > parts.length + 1) {
    throw new Error(`${opPath}.at must be a position from 1 to ${parts.length + 1}`);
  }
  const { at: _position, op: _kind, ...slide } = op;
  const read = readPresentationSpec({ slides: [slide] });
  if (read.errors.length > 0) {
    const first = read.errors[0] as SpecError;
    throw new Error(`${opPath}.${first.path.replace("slides[0].", "")} ${first.message}`);
  }
  // Lazily imported: `create` imports nothing from here, and taking the
  // dependency at module scope would make the two files circular.
  const { createPresentation } = require("./create.js") as typeof import("./create.js");
  const rendered = createPresentation({
    spec: read.spec!,
    workspaceRoot,
    createdAt: new Date(0).toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
  if (rendered.errors.length > 0) {
    throw new Error(`${opPath} ${rendered.errors[0]!.message}`);
  }

  const number = nextSlideNumber(pack);
  const slidePart = `ppt/slides/slide${number}.xml`;
  const types = readContentTypes(pack);
  // Media and chart parts come out of the render numbered from one, which will
  // already exist in the destination. Each is renamed and its relationship
  // retargeted so nothing overwrites a part the deck already had.
  // Only the parts the rendered slide brought with it move. The layout
  // relationship is left exactly as it is: it points at a layout this deck
  // already has, which is the whole reason this op needs a full surface.
  const carriedStems: Record<string, string> = {
    [relationshipTypes.chart]: "chart",
    [relationshipTypes.image]: "image",
    [relationshipTypes.notesSlide]: "notesSlide",
  };
  const renderedTypes = readContentTypes(rendered.pack);
  const relationships = readRelationships(rendered.pack, "ppt/slides/slide1.xml").map(
    (relationship) => {
      const stem = carriedStems[relationship.type];
      const target = relationshipTarget("ppt/slides/slide1.xml", relationship);
      if (!stem || !target || !rendered.pack.has(target)) return relationship;
      const extension = target.slice(target.lastIndexOf("."));
      const directory = target.slice(0, target.lastIndexOf("/"));
      const renamed = uniquePartName(pack, `${directory}/${stem}`, extension);
      pack.set(renamed, rendered.pack.bytes(target)!);
      const renderedType = renderedTypes.overrides.get(`/${target}`);
      if (renderedType) types.overrides.set(`/${renamed}`, renderedType);
      for (const [extensionName, value] of renderedTypes.defaults) {
        if (!types.defaults.has(extensionName)) types.defaults.set(extensionName, value);
      }
      // A notes slide points back at the slide it belongs to, and the rendered
      // one points at a slide part that does not exist here. The back
      // relationship is rewritten rather than dropped: an orphaned notes part
      // is what the structural check flags next.
      if (relationship.type === relationshipTypes.notesSlide) {
        writeRelationships(pack, renamed, [
          { id: "rId1", type: relationshipTypes.slide, target: `../slides/slide${number}.xml` },
        ]);
      }
      // Every carried part lives under `ppt/`, and the slide that references it
      // lives in `ppt/slides/`, so the target is the part path with `ppt/`
      // swapped for one level up.
      return { ...relationship, target: `../${renamed.slice("ppt/".length)}` };
    },
  );

  pack.set(slidePart, rendered.pack.bytes("ppt/slides/slide1.xml")!);
  writeRelationships(pack, slidePart, relationships);
  types.overrides.set(`/${slidePart}`, slideContentType);
  writeContentTypes(pack, types);

  const order = [...parts];
  order.splice(at - 1, 0, slidePart);
  rewriteSlideOrder(pack, order);
  return `insertSlide at ${at} (${String(slide.layout)})`;
}

function uniquePartName(pack: OoxmlPackage, stem: string, extension: string): string {
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = `${stem}${index}${extension}`;
    if (!pack.has(candidate)) return candidate;
  }
  throw new Error("could not find a free part name");
}

/* ------------------------------- addressing -------------------------------- */

function slidePartFor(pack: OoxmlPackage, op: Record<string, unknown>, opPath: string): string {
  const number = op.slide;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
    throw new Error(`${opPath}.slide must be a slide number from inspect, starting at 1`);
  }
  const parts = orderedSlideParts(pack);
  const part = parts[number - 1];
  if (!part) {
    throw new Error(`slide ${number} does not exist; the deck has ${parts.length} slides`);
  }
  return part;
}

function shapeNodeFor(
  document: Document,
  op: Record<string, unknown>,
  opPath: string,
): { node: Element; name: string } {
  const name = op.shape;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`${opPath}.shape must be a shape name from inspect`);
  }
  const tree = firstElement(document, "spTree");
  const found = tree
    ? childElements(tree).find(
        (node) => attribute(firstElement(node, "cNvPr"), "name") === name,
      )
    : undefined;
  if (!found) {
    const available = tree
      ? childElements(tree)
          .map((node) => attribute(firstElement(node, "cNvPr"), "name"))
          .filter((value): value is string => Boolean(value))
      : [];
    throw new Error(
      `no shape named "${name}" on that slide; inspect reported ${available.length > 0 ? available.join(", ") : "no named shapes"}`,
    );
  }
  return { node: found, name };
}

function requiredText(op: Record<string, unknown>, field: string, opPath: string): string {
  const value = op[field];
  if (typeof value !== "string") throw new Error(`${opPath}.${field} must be a string`);
  return value;
}

/* --------------------------------- text ops -------------------------------- */

/**
 * Replaces a shape's text, keeping the run properties already on it.
 *
 * The first run of the first paragraph is the template: its `rPr` is cloned
 * onto every new run. That is what makes this work on a stranger's deck —
 * their font, their size, their colour survive, and only the words change.
 */
function rewriteParagraphs(
  document: Document,
  shape: Element,
  paragraphs: Array<{ text: string; level?: number }>,
): void {
  const body = firstElement(shape, "txBody");
  if (!body) throw new Error("the shape has no text body, so its text cannot be replaced");
  const templateRun = findElements(body, "r")[0];
  const templateProperties = templateRun ? firstElement(templateRun, "rPr") : undefined;
  const templateParagraph = findElements(body, "p")[0];
  const templateParagraphProperties = templateParagraph
    ? firstElement(templateParagraph, "pPr")
    : undefined;

  for (const paragraph of findElements(body, "p")) {
    paragraph.parentNode?.removeChild(paragraph);
  }
  for (const entry of paragraphs) {
    const parts: string[] = [];
    if (templateParagraphProperties) {
      const clone = templateParagraphProperties.cloneNode(true) as unknown as Element;
      if (entry.level !== undefined) {
        if (entry.level > 0) clone.setAttribute("lvl", String(entry.level));
        else clone.removeAttribute("lvl");
      }
      parts.push(serializeDom(clone));
    }
    parts.push(
      serializeXml(
        element("a:r", {}, [
          templateProperties ? { kind: "raw", xml: serializeDom(templateProperties) } : element("a:rPr", { lang: "en-US" }),
          element("a:t", {}, [entry.text]),
        ] as XmlNode[]),
      ),
    );
    const fragment = parseXml(
      `<a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${parts.join("")}</a:p>`,
    );
    body.appendChild(
      document.importNode(fragment.documentElement as unknown as Node, true) as never,
    );
  }
}

function replaceText(pack: OoxmlPackage, op: Record<string, unknown>, opPath: string): string {
  const part = slidePartFor(pack, op, opPath);
  const document = parseSlide(pack, part);
  const { node, name } = shapeNodeFor(document, op, opPath);
  const text = requiredText(op, "text", opPath);
  rewriteParagraphs(document, node, text.split("\n").map((line) => ({ text: line })));
  pack.set(part, serializeDom(document));
  return `replaceText on ${name}`;
}

function setBullets(pack: OoxmlPackage, op: Record<string, unknown>, opPath: string): string {
  const part = slidePartFor(pack, op, opPath);
  const document = parseSlide(pack, part);
  const { node, name } = shapeNodeFor(document, op, opPath);
  if (!Array.isArray(op.bullets)) throw new Error(`${opPath}.bullets must be an array`);
  const bullets = op.bullets.map((entry, index) => {
    if (typeof entry === "string") return { text: entry, level: 0 };
    if (typeof entry === "object" && entry !== null && typeof (entry as { text?: unknown }).text === "string") {
      const level = (entry as { level?: unknown }).level;
      return {
        text: (entry as { text: string }).text,
        level: typeof level === "number" && Number.isInteger(level) && level >= 0 ? level : 0,
      };
    }
    throw new Error(`${opPath}.bullets[${index}] must be a string or a {text, level} object`);
  });
  rewriteParagraphs(document, node, bullets);
  pack.set(part, serializeDom(document));
  return `setBullets on ${name} (${bullets.length})`;
}

function setNotes(pack: OoxmlPackage, op: Record<string, unknown>, opPath: string): string {
  const part = slidePartFor(pack, op, opPath);
  const notes = requiredText(op, "notes", opPath);
  const relationships = readRelationships(pack, part);
  const existing = relationships.find((entry) => entry.type === relationshipTypes.notesSlide);
  const target = existing ? relationshipTarget(part, existing) : undefined;
  if (target && pack.has(target)) {
    const document = parseXml(pack.text(target)!);
    const body = findElements(document, "txBody")[0];
    if (!body) throw new Error("the notes slide has no text body");
    rewriteParagraphs(document, body.parentNode as unknown as Element, notes.split("\n").map((text) => ({ text })));
    pack.set(target, serializeDom(document));
    return "setNotes (replaced)";
  }
  // No notes slide yet: one is created, which needs its own part, content type,
  // and a relationship in both directions.
  const number = /slide(\d+)\.xml$/.exec(part)?.[1] ?? String(orderedSlideParts(pack).indexOf(part) + 1);
  const notesPart = `ppt/notesSlides/notesSlide${number}.xml`;
  pack.set(notesPart, notesSlideDocument(notes));
  writeRelationships(pack, notesPart, [
    { id: "rId1", type: relationshipTypes.slide, target: `../slides/${part.slice(part.lastIndexOf("/") + 1)}` },
  ]);
  writeRelationships(pack, part, [
    ...relationships,
    {
      id: nextRelationshipId(relationships),
      type: relationshipTypes.notesSlide,
      target: `../notesSlides/notesSlide${number}.xml`,
    },
  ]);
  const types = readContentTypes(pack);
  types.overrides.set(`/${notesPart}`, notesSlideContentType);
  writeContentTypes(pack, types);
  return "setNotes (added)";
}

function notesSlideDocument(notes: string): string {
  const paragraphs = notes
    .split("\n")
    .map((line) =>
      serializeXml(
        element("a:p", {}, [
          element("a:r", {}, [element("a:rPr", { lang: "en-US" }), element("a:t", {}, [line])]),
        ]),
      ),
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder 1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
}

/**
 * Search and replace across the deck's visible text.
 *
 * Runs are coalesced per paragraph before matching, which is the only way this
 * finds what the user sees: PowerPoint splits a sentence into separate runs
 * whenever a spellcheck pass or a font change touched part of it, so a
 * run-by-run search misses most real phrases.
 */
function findReplace(pack: OoxmlPackage, op: Record<string, unknown>, opPath: string): string {
  const find = requiredText(op, "find", opPath);
  const replace = requiredText(op, "replace", opPath);
  if (find.length === 0) throw new Error(`${opPath}.find must not be empty`);
  const scope = typeof op.scope === "number" ? op.scope : undefined;
  const parts = orderedSlideParts(pack);
  const targets = scope === undefined ? parts : [parts[scope - 1]].filter(Boolean);
  if (targets.length === 0) throw new Error(`slide ${scope} does not exist`);

  let replaced = 0;
  for (const part of targets as string[]) {
    const document = parseSlide(pack, part);
    let touched = false;
    for (const paragraph of findElements(document, "p")) {
      const runs = findElements(paragraph, "r");
      if (runs.length === 0) continue;
      const combined = runs.map((run) => textOf(firstElement(run, "t"))).join("");
      if (!combined.includes(find)) continue;
      const updated = combined.split(find).join(replace);
      replaced += combined.split(find).length - 1;
      // The first run keeps the whole replaced string and the rest are dropped:
      // the alternative is guessing which run each character belonged to, and a
      // guess would move formatting boundaries the user chose.
      const first = runs[0]!;
      const textNode = firstElement(first, "t");
      if (textNode) {
        while (textNode.firstChild) textNode.removeChild(textNode.firstChild);
        textNode.appendChild(document.createTextNode(updated) as never);
      }
      for (const run of runs.slice(1)) run.parentNode?.removeChild(run);
      touched = true;
    }
    if (touched) pack.set(part, serializeDom(document));
  }
  if (replaced === 0) throw new Error(`"${find}" does not appear in the deck, so nothing was changed`);
  return `findReplace ${replaced} occurrence${replaced === 1 ? "" : "s"}`;
}

/* -------------------------------- media ops -------------------------------- */

function replaceImage(
  pack: OoxmlPackage,
  op: Record<string, unknown>,
  opPath: string,
  workspaceRoot: string,
): string {
  const part = slidePartFor(pack, op, opPath);
  const document = parseSlide(pack, part);
  const { node, name } = shapeNodeFor(document, op, opPath);
  if (localNameOf(node) !== "pic") throw new Error(`"${name}" is not a picture`);
  const relative = requiredText(op, "image", opPath);
  const absolute = path.resolve(workspaceRoot, relative);
  const root = path.resolve(workspaceRoot);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new Error(`${opPath}.image ${relative} is outside the workspace`);
  }
  const image = loadImage(absolute);
  const embed = firstElement(node, "blip")?.getAttribute("r:embed");
  const relationships = readRelationships(pack, part);
  const relationship = relationships.find((entry) => entry.id === embed);
  const target = relationship ? relationshipTarget(part, relationship) : undefined;
  if (!target) throw new Error(`"${name}" has no resolvable image relationship`);
  // The media part is replaced in place, keeping its name, so the relationship
  // and every other reference to it stay valid. The extension may now disagree
  // with the bytes, which the content type has to be told about.
  pack.set(target, image.bytes);
  const types = readContentTypes(pack);
  types.overrides.set(`/${target}`, `image/${image.format}`);
  writeContentTypes(pack, types);
  return `replaceImage on ${name}`;
}

function setChartData(pack: OoxmlPackage, op: Record<string, unknown>, opPath: string): string {
  const part = slidePartFor(pack, op, opPath);
  const document = parseSlide(pack, part);
  const { node, name } = shapeNodeFor(document, op, opPath);
  const chartNode = firstElement(node, "chart");
  const embed = chartNode ? attribute(chartNode, "id") : undefined;
  const relationship = readRelationships(pack, part).find((entry) => entry.id === embed);
  const target = relationship ? relationshipTarget(part, relationship) : undefined;
  if (!target || !pack.has(target)) throw new Error(`"${name}" is not a chart`);

  // The chart spec is validated by the same reader `create` uses, so a chart
  // refreshed by an edit obeys the same limits as one built from scratch.
  const read = readPresentationSpec({
    slides: [{ layout: "chart", title: "chart", chart: op.chart }],
  });
  if (read.errors.length > 0) {
    const first = read.errors[0] as SpecError;
    throw new Error(`${opPath}.${first.path.replace("slides[0].", "")} ${first.message}`);
  }
  const chart = read.spec!.slides[0]!.chart!;
  pack.set(target, chartXml(chart, undefined, resolvePalette({})));
  return `setChartData on ${name}`;
}

function setTable(pack: OoxmlPackage, op: Record<string, unknown>, opPath: string): string {
  const part = slidePartFor(pack, op, opPath);
  const document = parseSlide(pack, part);
  const { node, name } = shapeNodeFor(document, op, opPath);
  const tableNode = firstElement(node, "tbl");
  if (!tableNode) throw new Error(`"${name}" is not a table`);
  if (!Array.isArray(op.rows)) throw new Error(`${opPath}.rows must be an array of row arrays`);
  const columns = findElements(tableNode, "gridCol").length;
  const rows = op.rows.map((row, index) => {
    if (!Array.isArray(row)) throw new Error(`${opPath}.rows[${index}] must be an array`);
    if (row.length !== columns) {
      throw new Error(
        `${opPath}.rows[${index}] has ${row.length} cells but the table has ${columns} columns`,
      );
    }
    return row.map((cell) => (cell === null || cell === undefined ? "" : String(cell)));
  });
  const existing = findElements(tableNode, "tr");
  const header = typeof op.header === "boolean" ? op.header : true;
  const bodyRows = existing.slice(header ? 1 : 0);
  if (rows.length > bodyRows.length) {
    throw new Error(
      `${opPath}.rows has ${rows.length} rows but the table has ${bodyRows.length}; setTable replaces cells and does not add rows`,
    );
  }
  rows.forEach((row, rowIndex) => {
    const cells = findElements(bodyRows[rowIndex]!, "tc");
    row.forEach((value, cellIndex) => {
      const cell = cells[cellIndex];
      if (!cell) return;
      rewriteParagraphs(document, cell, [{ text: value }]);
    });
  });
  pack.set(part, serializeDom(document));
  return `setTable on ${name} (${rows.length} rows)`;
}

/* -------------------------------- slide ops -------------------------------- */

function duplicateSlide(
  pack: OoxmlPackage,
  op: Record<string, unknown>,
  opPath: string,
  inspection: Inspection,
): string {
  const part = slidePartFor(pack, op, opPath);
  const parts = orderedSlideParts(pack);
  const index = parts.indexOf(part);
  const summary = inspection.outline.slides[index];
  const blocking = summary?.unsupported.filter((kind) => uncloneable.includes(kind)) ?? [];
  if (blocking.length > 0) {
    throw new Error(
      `slide ${index + 1} contains ${blocking.join(", ")}; duplicating it would produce a deck PowerPoint reports as damaged`,
    );
  }
  const number = nextSlideNumber(pack);
  const copy = `ppt/slides/slide${number}.xml`;
  pack.set(copy, pack.bytes(part)!);
  const relationships = pack.text(relationshipPartFor(part));
  if (relationships) pack.set(relationshipPartFor(copy), relationships);
  const types = readContentTypes(pack);
  types.overrides.set(`/${copy}`, slideContentType);
  writeContentTypes(pack, types);
  const order = [...parts];
  order.splice(index + 1, 0, copy);
  rewriteSlideOrder(pack, order);
  return `duplicateSlide ${index + 1}`;
}

function moveSlide(pack: OoxmlPackage, op: Record<string, unknown>, opPath: string): string {
  const part = slidePartFor(pack, op, opPath);
  const parts = orderedSlideParts(pack);
  const to = op.to;
  if (typeof to !== "number" || !Number.isInteger(to) || to < 1 || to > parts.length) {
    throw new Error(`${opPath}.to must be a slide position from 1 to ${parts.length}`);
  }
  const from = parts.indexOf(part);
  const order = [...parts];
  order.splice(from, 1);
  order.splice(to - 1, 0, part);
  rewriteSlideOrder(pack, order);
  return `moveSlide ${from + 1} to ${to}`;
}

function deleteSlide(pack: OoxmlPackage, op: Record<string, unknown>, opPath: string): string {
  const part = slidePartFor(pack, op, opPath);
  const parts = orderedSlideParts(pack);
  if (parts.length === 1) throw new Error("a presentation must keep at least one slide");
  const index = parts.indexOf(part);
  // The slide's own parts go, and so does anything only it referenced. A notes
  // slide left behind is an orphan the structural check would then flag.
  for (const relationship of readRelationships(pack, part)) {
    if (relationship.type !== relationshipTypes.notesSlide) continue;
    const target = relationshipTarget(part, relationship);
    if (target) {
      pack.delete(target);
      pack.delete(relationshipPartFor(target));
    }
  }
  pack.delete(part);
  pack.delete(relationshipPartFor(part));
  const types = readContentTypes(pack);
  types.overrides.delete(`/${part}`);
  writeContentTypes(pack, types);
  rewriteSlideOrder(
    pack,
    parts.filter((entry) => entry !== part),
  );
  return `deleteSlide ${index + 1}`;
}

function nextSlideNumber(pack: OoxmlPackage): number {
  let highest = 0;
  for (const name of pack.namesUnder("ppt/slides/slide")) {
    const match = /slide(\d+)\.xml$/.exec(name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

/**
 * Rewrites `sldIdLst` and the presentation's relationships to a new order.
 *
 * Both are regenerated from one array rather than patched, because the failure
 * mode of patching them independently is a deck that opens with a slide missing
 * and no error — the id list and the relationship set simply stop agreeing.
 */
function rewriteSlideOrder(pack: OoxmlPackage, order: string[]): void {
  const existing = readRelationships(pack, "ppt/presentation.xml");
  const kept = existing.filter((relationship) => relationship.type !== relationshipTypes.slide);
  const slideRelationships: Relationship[] = order.map((part, index) => ({
    id: `rId${100 + index}`,
    type: relationshipTypes.slide,
    target: part.replace(/^ppt\//, ""),
  }));
  writeRelationships(pack, "ppt/presentation.xml", [...kept, ...slideRelationships]);

  const document = parseXml(pack.text("ppt/presentation.xml")!);
  const list = firstElement(document, "sldIdLst");
  if (!list) return;
  while (list.firstChild) list.removeChild(list.firstChild);
  slideRelationships.forEach((relationship, index) => {
    const fragment = parseXml(
      `<p:sldId xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" id="${256 + index}" r:id="${relationship.id}"/>`,
    );
    list.appendChild(document.importNode(fragment.documentElement as unknown as Node, true) as never);
  });
  pack.set("ppt/presentation.xml", serializeDom(document));
}

function parseSlide(pack: OoxmlPackage, part: string): Document {
  const xml = pack.text(part);
  if (!xml) throw new Error(`${part} is not in the package`);
  return parseXml(xml);
}

/** Exported for the structural check, which needs the same resolution rule. */
export { resolveRelativePart };
