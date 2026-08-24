/**
 * Reading a .pptx — ours or a stranger's.
 *
 * The outline this produces is the vocabulary `edit` addresses: slide numbers
 * and shape names, nothing else. It is also the thing the model plans from, so
 * it reports what is *there* rather than what we would have written — a foreign
 * deck's own shape names, its own layouts, its own tables — and names every
 * feature we cannot safely touch instead of quietly ignoring it.
 */

import { OoxmlPackage, relationshipPartFor } from "../package.js";
import {
  contentTypeOf,
  readContentTypes,
  readRelationships,
  relationshipTarget,
  relationshipTypes,
} from "../opc.js";
import {
  attribute,
  childElements,
  findElements,
  firstElement,
  localNameOf,
  parseXml,
  textOf,
} from "../xml.js";
import { originPropertyName } from "./scaffold.js";

export type UnsupportedKind =
  | "smart-art"
  | "ole"
  | "animation"
  | "embedded-media"
  | "encrypted"
  | "legacy-ppt";

export type Unsupported = { kind: UnsupportedKind; where: string };

export type ShapeSummary = {
  name: string;
  kind: "text" | "picture" | "table" | "chart" | "group" | "other";
  text?: string;
  bbox?: { x: number; y: number; width: number; height: number };
  /** Present on tables, so `setTable` knows the shape it is replacing. */
  rows?: number;
  columns?: number;
  /** Present on charts, so `setChartData` can be checked against reality. */
  chartType?: string;
  seriesCount?: number;
  categoryCount?: number;
};

export type SlideSummary = {
  number: number;
  /** The layout's own name from the deck, which is what template reuse maps to. */
  layout: string;
  title?: string;
  shapes: ShapeSummary[];
  notes?: string;
  unsupported: UnsupportedKind[];
};

export type LayoutSummary = {
  name: string;
  /** Placeholder types present, which is what makes a layout usable for us. */
  placeholders: string[];
};

export type PptxOutline = {
  slideCount: number;
  slideSize: { width: number; height: number };
  theme?: { name?: string; majorFont?: string; minorFont?: string; accent?: string };
  layouts: LayoutSummary[];
  slides: SlideSummary[];
};

export type Inspection = {
  origin: "umbratic" | "foreign";
  editSurface: "full" | "surgical" | "inspect-only";
  unsupported: Unsupported[];
  outline: PptxOutline;
};

/** The relationship types that mean a part we will not clone or rewrite. */
const oleRelationship =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject";
const mediaRelationships = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/video",
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio",
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/media",
]);

export function inspectPresentation(pack: OoxmlPackage): Inspection {
  const types = readContentTypes(pack);
  const unsupported: Unsupported[] = [];
  const origin = hasOriginStamp(pack) ? "umbratic" : "foreign";

  const slideParts = orderedSlideParts(pack);
  const layouts = readLayouts(pack);
  const slides = slideParts.map((part, index) =>
    readSlide(pack, part, index + 1, layouts, unsupported),
  );

  const outline: PptxOutline = {
    slideCount: slides.length,
    slideSize: readSlideSize(pack),
    theme: readTheme(pack),
    layouts,
    slides,
  };

  // A macro-enabled deck is not refused — a .pptm opens and edits fine — but a
  // deck we cannot parse at all is, and so is one whose only content is behind
  // a feature we would corrupt by touching.
  const editSurface: Inspection["editSurface"] =
    origin === "umbratic" && unsupported.length === 0 ? "full" : "surgical";

  // Unknown content types are worth reporting rather than ignoring: they are
  // how an unfamiliar producer's extension shows up.
  for (const name of pack.names()) {
    if (name.endsWith(".rels") || name === "[Content_Types].xml") continue;
    if (!contentTypeOf(types, name)) {
      unsupported.push({ kind: "ole", where: `${name} has no declared content type` });
    }
  }

  return { origin, editSurface, unsupported, outline };
}

function hasOriginStamp(pack: OoxmlPackage): boolean {
  const xml = pack.text("docProps/custom.xml");
  if (!xml) return false;
  try {
    return findElements(parseXml(xml), "property").some(
      (node) => attribute(node, "name") === originPropertyName && textOf(node).trim() === "1",
    );
  } catch {
    return false;
  }
}

/**
 * Slide parts in presentation order.
 *
 * The zip's entry order and the numeric suffix both lie: a deck edited in
 * PowerPoint routinely has slide7.xml sitting third. Only `sldIdLst` and the
 * presentation's relationships know the real order.
 */
export function orderedSlideParts(pack: OoxmlPackage): string[] {
  const xml = pack.text("ppt/presentation.xml");
  if (!xml) return pack.namesUnder("ppt/slides/slide");
  const relationships = new Map(
    readRelationships(pack, "ppt/presentation.xml").map((relationship) => [
      relationship.id,
      relationship,
    ]),
  );
  const ordered: string[] = [];
  try {
    for (const node of findElements(parseXml(xml), "sldId")) {
      // `sldId` carries both a numeric `id` and the relationship's `r:id`, so
      // the prefixed name has to be asked for exactly: a local-name lookup
      // would return the number and find no relationship.
      const relationshipId = node.getAttribute("r:id") ?? node.getAttribute("relationships:id");
      const relationship = relationshipId ? relationships.get(relationshipId) : undefined;
      if (!relationship) continue;
      const target = relationshipTarget("ppt/presentation.xml", relationship);
      if (target && pack.has(target)) ordered.push(target);
    }
  } catch {
    return pack.namesUnder("ppt/slides/slide");
  }
  return ordered.length > 0 ? ordered : pack.namesUnder("ppt/slides/slide");
}

function readSlideSize(pack: OoxmlPackage): { width: number; height: number } {
  const xml = pack.text("ppt/presentation.xml");
  if (!xml) return { width: 12_192_000, height: 6_858_000 };
  try {
    const size = firstElement(parseXml(xml), "sldSz");
    return {
      width: Number(attribute(size, "cx") ?? 12_192_000),
      height: Number(attribute(size, "cy") ?? 6_858_000),
    };
  } catch {
    return { width: 12_192_000, height: 6_858_000 };
  }
}

function readTheme(pack: OoxmlPackage): PptxOutline["theme"] {
  const part = pack.namesUnder("ppt/theme/theme")[0];
  const xml = part ? pack.text(part) : undefined;
  if (!xml) return undefined;
  try {
    const document = parseXml(xml);
    const majorFont = firstElement(document, "majorFont");
    const minorFont = firstElement(document, "minorFont");
    const accent = firstElement(document, "accent1");
    return {
      name: attribute(document.documentElement as unknown as Element, "name") ?? undefined,
      majorFont: attribute(majorFont ? firstElement(majorFont, "latin") : undefined, "typeface"),
      minorFont: attribute(minorFont ? firstElement(minorFont, "latin") : undefined, "typeface"),
      accent: attribute(accent ? firstElement(accent, "srgbClr") : undefined, "val"),
    };
  } catch {
    return undefined;
  }
}

function readLayouts(pack: OoxmlPackage): LayoutSummary[] {
  return pack.namesUnder("ppt/slideLayouts/slideLayout").flatMap((part) => {
    const xml = pack.text(part);
    if (!xml) return [];
    try {
      const document = parseXml(xml);
      const common = firstElement(document, "cSld");
      const placeholders = findElements(document, "ph")
        .map((node) => attribute(node, "type") ?? "body")
        .filter((type, index, all) => all.indexOf(type) === index);
      return [
        {
          name:
            attribute(common, "name")
            ?? part.slice(part.lastIndexOf("/") + 1).replace(/\.xml$/, ""),
          placeholders,
        },
      ];
    } catch {
      return [];
    }
  });
}

function readSlide(
  pack: OoxmlPackage,
  part: string,
  number: number,
  layouts: LayoutSummary[],
  unsupported: Unsupported[],
): SlideSummary {
  const where = `slide ${number}`;
  const slideUnsupported = new Set<UnsupportedKind>();
  const relationships = readRelationships(pack, part);
  for (const relationship of relationships) {
    if (relationship.type === oleRelationship) slideUnsupported.add("ole");
    if (mediaRelationships.has(relationship.type)) slideUnsupported.add("embedded-media");
  }

  const xml = pack.text(part);
  const shapes: ShapeSummary[] = [];
  let title: string | undefined;
  const layout = layoutNameFor(pack, part, relationships, layouts);

  if (xml) {
    try {
      const document = parseXml(xml);
      // Animation lives in a timing node; a deck with one is still editable,
      // but reordering or deleting a slide can strand a timing reference, so it
      // is reported and the surgical set is what remains available.
      if (firstElement(document, "timing")) slideUnsupported.add("animation");
      if (findElements(document, "graphicData").some((node) =>
        (attribute(node, "uri") ?? "").includes("diagram"),
      )) {
        slideUnsupported.add("smart-art");
      }
      const tree = firstElement(document, "spTree");
      if (tree) {
        for (const node of childElements(tree)) {
          const summary = summarizeShape(node);
          if (!summary) continue;
          // A chart's shape says nothing about its data; the numbers live in a
          // separate part, and a model asked to refresh them needs to know how
          // many series and categories it is replacing.
          if (summary.kind === "chart") Object.assign(summary, describeChart(pack, part, node));
          shapes.push(summary);
          if (!title && isTitlePlaceholder(node) && summary.text) title = summary.text;
        }
      }
      if (!title) title = shapes.find((shape) => shape.kind === "text" && shape.text)?.text;
    } catch (error) {
      slideUnsupported.add("ole");
      unsupported.push({
        kind: "ole",
        where: `${where} could not be parsed (${String(error instanceof Error ? error.message : error)})`,
      });
    }
  }

  for (const kind of slideUnsupported) unsupported.push({ kind, where });

  const notes = readNotes(pack, part, relationships);
  return {
    number,
    layout,
    ...(title ? { title: title.slice(0, 200) } : {}),
    shapes,
    ...(notes ? { notes: notes.slice(0, 2_000) } : {}),
    unsupported: [...slideUnsupported],
  };
}

function layoutNameFor(
  pack: OoxmlPackage,
  part: string,
  relationships: ReturnType<typeof readRelationships>,
  layouts: LayoutSummary[],
): string {
  const relationship = relationships.find((entry) => entry.type === relationshipTypes.slideLayout);
  const target = relationship ? relationshipTarget(part, relationship) : undefined;
  if (!target) return layouts[0]?.name ?? "unknown";
  const xml = pack.text(target);
  if (!xml) return target.slice(target.lastIndexOf("/") + 1).replace(/\.xml$/, "");
  try {
    return (
      attribute(firstElement(parseXml(xml), "cSld"), "name")
      ?? target.slice(target.lastIndexOf("/") + 1).replace(/\.xml$/, "")
    );
  } catch {
    return "unknown";
  }
}

function readNotes(
  pack: OoxmlPackage,
  part: string,
  relationships: ReturnType<typeof readRelationships>,
): string | undefined {
  const relationship = relationships.find((entry) => entry.type === relationshipTypes.notesSlide);
  const target = relationship ? relationshipTarget(part, relationship) : undefined;
  const xml = target ? pack.text(target) : undefined;
  if (!xml) return undefined;
  try {
    const paragraphs = findElements(parseXml(xml), "p").map((node) => textOf(node));
    const notes = paragraphs.join("\n").trim();
    return notes.length > 0 ? notes : undefined;
  } catch {
    return undefined;
  }
}

function isTitlePlaceholder(node: Element): boolean {
  const placeholder = firstElement(node, "ph");
  const type = attribute(placeholder, "type");
  if (type === "title" || type === "ctrTitle") return true;
  // Our own decks place explicit text boxes rather than placeholders, so the
  // name is the only signal — and it is a reliable one, because create writes
  // it.
  return (attribute(firstElement(node, "cNvPr"), "name") ?? "").startsWith("Title");
}

function summarizeShape(node: Element): ShapeSummary | undefined {
  const tag = localNameOf(node);
  const name = attribute(firstElement(node, "cNvPr"), "name") ?? "";
  if (!name) return undefined;
  const bbox = readBoundingBox(node);
  if (tag === "sp") {
    return { name, kind: "text", text: shapeText(node), ...(bbox ? { bbox } : {}) };
  }
  if (tag === "pic") {
    return { name, kind: "picture", ...(bbox ? { bbox } : {}) };
  }
  if (tag === "grpSp") {
    return { name, kind: "group", ...(bbox ? { bbox } : {}) };
  }
  if (tag === "graphicFrame") {
    const tableNode = firstElement(node, "tbl");
    if (tableNode) {
      const rows = findElements(tableNode, "tr");
      return {
        name,
        kind: "table",
        rows: rows.length,
        columns: findElements(tableNode, "gridCol").length,
        ...(bbox ? { bbox } : {}),
      };
    }
    if (firstElement(node, "chart")) {
      return { name, kind: "chart", ...(bbox ? { bbox } : {}) };
    }
  }
  return { name, kind: "other", ...(bbox ? { bbox } : {}) };
}

function readBoundingBox(
  node: Element,
): { x: number; y: number; width: number; height: number } | undefined {
  const transform = firstElement(node, "xfrm");
  const offset = transform ? firstElement(transform, "off") : undefined;
  const extent = transform ? firstElement(transform, "ext") : undefined;
  if (!offset || !extent) return undefined;
  return {
    x: Number(attribute(offset, "x") ?? 0),
    y: Number(attribute(offset, "y") ?? 0),
    width: Number(attribute(extent, "cx") ?? 0),
    height: Number(attribute(extent, "cy") ?? 0),
  };
}

/**
 * The visible text of a shape, paragraph by paragraph.
 *
 * Runs are joined without a separator and paragraphs with a newline, which is
 * what makes a `findReplace` match what the user sees: PowerPoint splits a
 * sentence across runs whenever a spellcheck or a font change touched it, and
 * a search that respected run boundaries would miss most real text.
 */
export function shapeText(node: Element): string {
  const body = firstElement(node, "txBody");
  if (!body) return "";
  return findElements(body, "p")
    .map((paragraph) =>
      findElements(paragraph, "t")
        .map((run) => textOf(run))
        .join(""),
    )
    .join("\n")
    .trim();
}

/** Reads the chart part behind a chart frame, for the outline's series counts. */
export function describeChart(
  pack: OoxmlPackage,
  slidePart: string,
  frame: Element,
): { chartType?: string; seriesCount?: number; categoryCount?: number } {
  const chartNode = firstElement(frame, "chart");
  const relationshipId = attribute(chartNode, "id");
  if (!relationshipId) return {};
  const relationship = readRelationships(pack, slidePart).find(
    (entry) => entry.id === relationshipId,
  );
  const target = relationship ? relationshipTarget(slidePart, relationship) : undefined;
  const xml = target ? pack.text(target) : undefined;
  if (!xml) return {};
  try {
    const document = parseXml(xml);
    const plot = firstElement(document, "plotArea");
    const chartType = plot
      ? childElements(plot)
          .map((node) => localNameOf(node))
          .find((name) => name.endsWith("Chart"))
      : undefined;
    const series = findElements(document, "ser");
    const firstCategoryCount = series[0]
      ? findElements(series[0], "ptCount")[0]
      : undefined;
    return {
      ...(chartType ? { chartType } : {}),
      seriesCount: series.length,
      ...(firstCategoryCount
        ? { categoryCount: Number(attribute(firstCategoryCount, "val") ?? 0) }
        : {}),
    };
  } catch {
    return {};
  }
}

/** True when a part exists but its relationship part does not, which is corrupt. */
export function missingRelationshipParts(pack: OoxmlPackage): string[] {
  return pack
    .names()
    .filter((name) => name.startsWith("ppt/slides/slide") && name.endsWith(".xml"))
    .filter((name) => !pack.has(relationshipPartFor(name)));
}
