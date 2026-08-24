/**
 * Building a .docx from the shared block spec.
 *
 * WordprocessingML is written directly, on the same OOXML foundation the PPTX
 * engine uses. That is what makes the edit ops possible: run merging, tracked
 * changes, and comments are all operations on this markup, and a create path
 * that went through a library would produce a document whose internals the
 * edit path then had to reverse-engineer.
 *
 * Blocks become paragraphs with named styles rather than direct formatting.
 * A heading is `<w:pStyle w:val="Heading1"/>`, not a font size — so the
 * document's outline pane works, a table of contents can be built, and a person
 * who opens it in Word can restyle the whole thing from the styles gallery.
 */

import * as path from "node:path";

import { loadImage } from "../images.js";
import { OoxmlPackage } from "../package.js";
import { relationshipTypes, writeContentTypes, writeRelationships, type ContentTypes, type Relationship } from "../opc.js";
import { element, serializeDocument, type XmlNode } from "../xml.js";
import { calloutAccent, calloutBackground, pageDimensions, presetFor, type BlockPreset } from "../blocks/presets.js";
import type { Block, DocumentSpec, SpecError } from "../blocks/spec.js";
import { barChartSvg, chartFallbackTable, chartsAvailable } from "../blocks/chart.js";

export const wordNamespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const drawingNamespace = "http://schemas.openxmlformats.org/drawingml/2006/main";
const relationshipNamespace = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const pictureNamespace = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const wordDrawingNamespace =
  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";

/** Twentieths of a point, the unit almost every WordprocessingML measure uses. */
const twipsPerPoint = 20;
/** English metric units per point, for drawing extents. */
const emuPerPoint = 12_700;

export const originPropertyName = "UmbraticArtifact";

const namespaces = {
  "xmlns:w": wordNamespace,
  "xmlns:r": relationshipNamespace,
  "xmlns:a": drawingNamespace,
  "xmlns:pic": pictureNamespace,
  "xmlns:wp": wordDrawingNamespace,
};

export type DocxCreateResult = {
  pack: OoxmlPackage;
  errors: SpecError[];
  /** Block ids in document order, which is what inspect reports and edit uses. */
  blockIds: string[];
};

export type DocxCreateOptions = {
  spec: DocumentSpec;
  workspaceRoot: string;
  createdAt: string;
};

type Build = {
  body: XmlNode[];
  relationships: Relationship[];
  parts: Array<{ name: string; content: string | Buffer; contentType?: string }>;
  blockIds: string[];
  media: Map<string, string>;
  errors: SpecError[];
};

export function createDocument(options: DocxCreateOptions): DocxCreateResult {
  const { spec } = options;
  const preset = presetFor(spec.preset);
  const pack = OoxmlPackage.empty();
  const types = baseContentTypes();
  const build: Build = {
    body: [],
    relationships: [],
    parts: [],
    blockIds: [],
    media: new Map(),
    errors: [],
  };

  if (spec.toc) build.body.push(...tableOfContents(preset));

  spec.blocks.forEach((block, index) => {
    try {
      build.body.push(...renderBlock(build, block, index, preset, spec, options.workspaceRoot, types));
    } catch (error) {
      build.errors.push({
        path: `blocks[${index}]`,
        message: String(error instanceof Error ? error.message : error),
      });
    }
  });

  build.body.push(sectionProperties(spec, preset, Boolean(spec.header), Boolean(spec.footer)));

  pack.set(
    "_rels/.rels",
    serializeDocument(
      element("Relationships", { xmlns: "http://schemas.openxmlformats.org/package/2006/relationships" }, [
        element("Relationship", { Id: "rId1", Type: relationshipTypes.officeDocument, Target: "word/document.xml" }),
        element("Relationship", { Id: "rId2", Type: relationshipTypes.coreProperties, Target: "docProps/core.xml" }),
        element("Relationship", { Id: "rId3", Type: relationshipTypes.extendedProperties, Target: "docProps/app.xml" }),
        element("Relationship", { Id: "rId4", Type: relationshipTypes.customProperties, Target: "docProps/custom.xml" }),
      ]),
    ),
  );
  pack.set("word/document.xml", serializeDocument(element("w:document", namespaces, [element("w:body", {}, build.body)])));
  pack.set("word/styles.xml", stylesXml(preset));
  pack.set("word/numbering.xml", numberingXml());
  pack.set("word/settings.xml", settingsXml());

  const documentRelationships: Relationship[] = [
    { id: "rIdStyles", type: `${relationshipNamespace}/styles`, target: "styles.xml" },
    { id: "rIdNumbering", type: `${relationshipNamespace}/numbering`, target: "numbering.xml" },
    { id: "rIdSettings", type: `${relationshipNamespace}/settings`, target: "settings.xml" },
    ...build.relationships,
  ];
  if (spec.header) {
    pack.set("word/header1.xml", headerXml(spec.header.text, preset));
    types.overrides.set("/word/header1.xml", `${wordContentTypePrefix}.header+xml`);
    documentRelationships.push({ id: "rIdHeader", type: `${relationshipNamespace}/header`, target: "header1.xml" });
  }
  if (spec.footer) {
    pack.set("word/footer1.xml", footerXml(spec.footer, preset));
    types.overrides.set("/word/footer1.xml", `${wordContentTypePrefix}.footer+xml`);
    documentRelationships.push({ id: "rIdFooter", type: `${relationshipNamespace}/footer`, target: "footer1.xml" });
  }
  writeRelationships(pack, "word/document.xml", documentRelationships);

  for (const part of build.parts) {
    pack.set(part.name, part.content);
    if (part.contentType) types.overrides.set(`/${part.name}`, part.contentType);
  }
  pack.set("docProps/core.xml", corePropertiesXml(spec, options.createdAt));
  pack.set("docProps/app.xml", appPropertiesXml(spec));
  pack.set("docProps/custom.xml", customPropertiesXml());
  writeContentTypes(pack, types);
  return { pack, errors: build.errors, blockIds: build.blockIds };
}

const wordContentTypePrefix = "application/vnd.openxmlformats-officedocument.wordprocessingml";

function baseContentTypes(): ContentTypes {
  return {
    defaults: new Map([
      ["rels", "application/vnd.openxmlformats-package.relationships+xml"],
      ["xml", "application/xml"],
      ["png", "image/png"],
      ["jpeg", "image/jpeg"],
      ["jpg", "image/jpeg"],
      ["gif", "image/gif"],
    ]),
    overrides: new Map([
      ["/word/document.xml", `${wordContentTypePrefix}.document.main+xml`],
      ["/word/styles.xml", `${wordContentTypePrefix}.styles+xml`],
      ["/word/numbering.xml", `${wordContentTypePrefix}.numbering+xml`],
      ["/word/settings.xml", `${wordContentTypePrefix}.settings+xml`],
      ["/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"],
      ["/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml"],
      ["/docProps/custom.xml", "application/vnd.openxmlformats-officedocument.custom-properties+xml"],
    ]),
  };
}

/* ------------------------------- text runs -------------------------------- */

export type RunStyle = {
  size?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  code?: boolean;
};

/** Splits `**bold**`, `*italic*`, and `` `code` `` the same way PPTX does. */
export function inlineRuns(value: string): Array<{ text: string; bold?: boolean; italic?: boolean; code?: boolean }> {
  const runs: Array<{ text: string; bold?: boolean; italic?: boolean; code?: boolean }> = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let cursor = 0;
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    if (match.index > cursor) runs.push({ text: value.slice(cursor, match.index) });
    const token = match[0];
    if (token.startsWith("**")) runs.push({ text: token.slice(2, -2), bold: true });
    else if (token.startsWith("`")) runs.push({ text: token.slice(1, -1), code: true });
    else runs.push({ text: token.slice(1, -1), italic: true });
    cursor = match.index + token.length;
  }
  if (cursor < value.length) runs.push({ text: value.slice(cursor) });
  return runs.length > 0 ? runs : [{ text: value }];
}

export function runNode(text: string, style: RunStyle = {}): XmlNode {
  const properties: XmlNode[] = [];
  if (style.code) properties.push(element("w:rFonts", { "w:ascii": "Consolas", "w:hAnsi": "Consolas" }));
  if (style.bold) properties.push(element("w:b"));
  if (style.italic) properties.push(element("w:i"));
  if (style.color) properties.push(element("w:color", { "w:val": style.color }));
  if (style.size) {
    // Half-points, and Word wants both the Latin and complex-script size or a
    // right-to-left run silently keeps the default.
    const halfPoints = Math.round(style.size * 2);
    properties.push(element("w:sz", { "w:val": halfPoints }));
    properties.push(element("w:szCs", { "w:val": halfPoints }));
  }
  return element("w:r", {}, [
    properties.length > 0 ? element("w:rPr", {}, properties) : undefined,
    // `xml:space="preserve"` or Word drops the spaces at a run boundary, which
    // is exactly where inline markup puts them.
    element("w:t", { "xml:space": "preserve" }, [text]),
  ]);
}

function markedUpRuns(value: string, style: RunStyle = {}): XmlNode[] {
  return inlineRuns(value).map((run) =>
    runNode(run.text, {
      ...style,
      ...(run.bold ? { bold: true } : {}),
      ...(run.italic ? { italic: true } : {}),
      ...(run.code ? { code: true } : {}),
    }),
  );
}

export type ParagraphOptions = {
  style?: string;
  spaceBefore?: number;
  spaceAfter?: number;
  align?: "left" | "center" | "right" | "both";
  /** Numbering definition and level, for lists. */
  numbering?: { id: number; level: number };
  indent?: number;
  shading?: string;
  keepNext?: boolean;
  /** The `w:id` recorded in a bookmark, which is how edit addresses this block. */
  blockId?: string;
};

export function paragraphNode(children: XmlNode[], options: ParagraphOptions = {}): XmlNode {
  const properties: XmlNode[] = [];
  if (options.style) properties.push(element("w:pStyle", { "w:val": options.style }));
  if (options.numbering) {
    properties.push(
      element("w:numPr", {}, [
        element("w:ilvl", { "w:val": options.numbering.level }),
        element("w:numId", { "w:val": options.numbering.id }),
      ]),
    );
  }
  if (options.shading) {
    properties.push(element("w:shd", { "w:val": "clear", "w:color": "auto", "w:fill": options.shading }));
  }
  if (options.indent !== undefined) {
    properties.push(element("w:ind", { "w:left": Math.round(options.indent * twipsPerPoint) }));
  }
  if (options.spaceBefore !== undefined || options.spaceAfter !== undefined) {
    properties.push(
      element("w:spacing", {
        ...(options.spaceBefore !== undefined
          ? { "w:before": Math.round(options.spaceBefore * twipsPerPoint) }
          : {}),
        ...(options.spaceAfter !== undefined
          ? { "w:after": Math.round(options.spaceAfter * twipsPerPoint) }
          : {}),
      }),
    );
  }
  if (options.align && options.align !== "left") {
    properties.push(element("w:jc", { "w:val": options.align }));
  }
  // A heading that lands at the foot of a page with its first paragraph on the
  // next one is the most common ugly break in a generated document.
  if (options.keepNext) properties.push(element("w:keepNext"));

  const body: Array<XmlNode | undefined> = [
    properties.length > 0 ? element("w:pPr", {}, properties) : undefined,
  ];
  if (options.blockId) {
    // A bookmark is the only stable address WordprocessingML offers: paragraph
    // indexes shift under every insertion, and a foreign document has no ids of
    // its own. Inspect reports these; edit resolves them.
    body.push(element("w:bookmarkStart", { "w:id": bookmarkNumber(options.blockId), "w:name": options.blockId }));
  }
  body.push(...children);
  if (options.blockId) body.push(element("w:bookmarkEnd", { "w:id": bookmarkNumber(options.blockId) }));
  return element("w:p", {}, body);
}

/** Bookmark ids are numeric in the format; block ids are `b12`. */
function bookmarkNumber(blockId: string): number {
  return Number(blockId.replace(/^b/, "")) || 0;
}

/* -------------------------------- blocks ---------------------------------- */

function renderBlock(
  build: Build,
  block: Block,
  index: number,
  preset: BlockPreset,
  spec: DocumentSpec,
  workspaceRoot: string,
  types: ContentTypes,
): XmlNode[] {
  const blockId = `b${index + 1}`;
  build.blockIds.push(blockId);
  const colors = preset.colors;

  switch (block.type) {
    case "title": {
      const nodes = [
        paragraphNode(markedUpRuns(block.text), {
          style: "Title",
          spaceAfter: block.subtitle ? 2 : preset.spaceBeforeParagraph,
          blockId,
          keepNext: true,
        }),
      ];
      if (block.subtitle) {
        nodes.push(
          paragraphNode(markedUpRuns(block.subtitle, { size: preset.subtitle, color: colors.muted }), {
            style: "Subtitle",
            spaceAfter: preset.spaceBeforeHeading,
          }),
        );
      }
      return nodes;
    }
    case "heading":
      return [
        paragraphNode(markedUpRuns(block.text), {
          style: `Heading${block.level}`,
          spaceBefore: preset.spaceBeforeHeading,
          spaceAfter: preset.spaceBeforeParagraph,
          keepNext: true,
          blockId,
        }),
      ];
    case "paragraph":
      return [
        paragraphNode(markedUpRuns(block.text), {
          style: "BodyText",
          spaceBefore: preset.spaceBeforeParagraph,
          blockId,
        }),
      ];
    case "bullets":
    case "numbered":
      return block.items.map((item, itemIndex) =>
        paragraphNode(markedUpRuns(item), {
          style: "ListParagraph",
          numbering: { id: block.type === "bullets" ? 1 : 2, level: 0 },
          spaceBefore: itemIndex === 0 ? preset.spaceBeforeList : 0,
          ...(itemIndex === 0 ? { blockId } : {}),
        }),
      );
    case "checklist":
      return block.items.map((item, itemIndex) =>
        paragraphNode(
          // A literal ballot box rather than a content control: a content
          // control is a feature the edit surface refuses to touch, and this
          // has to survive a round trip through our own inspect.
          [runNode("☐  ", { size: preset.body }), ...markedUpRuns(item)],
          {
            style: "BodyText",
            indent: 18,
            spaceBefore: itemIndex === 0 ? preset.spaceBeforeList : 2,
            ...(itemIndex === 0 ? { blockId } : {}),
          },
        ),
      );
    case "definitions":
      return block.items.flatMap((item, itemIndex) => [
        paragraphNode(markedUpRuns(item.term, { bold: true }), {
          style: "BodyText",
          spaceBefore: itemIndex === 0 ? preset.spaceBeforeList : 6,
          keepNext: true,
          ...(itemIndex === 0 ? { blockId } : {}),
        }),
        paragraphNode(markedUpRuns(item.definition), { style: "BodyText", indent: 18 }),
      ]);
    case "callout": {
      const shading = calloutBackground(preset, block.style);
      const accent = calloutAccent(preset, block.style);
      const nodes: XmlNode[] = [];
      if (block.title) {
        nodes.push(
          paragraphNode(markedUpRuns(block.title, { bold: true, color: accent }), {
            style: "BodyText",
            shading,
            spaceBefore: preset.spaceBeforeParagraph,
            indent: 8,
            keepNext: true,
            blockId,
          }),
        );
      }
      nodes.push(
        paragraphNode(markedUpRuns(block.text), {
          style: "BodyText",
          shading,
          indent: 8,
          spaceBefore: block.title ? 0 : preset.spaceBeforeParagraph,
          spaceAfter: preset.spaceBeforeParagraph,
          ...(block.title ? {} : { blockId }),
        }),
      );
      return nodes;
    }
    case "table":
      return tableNodes(block, preset, blockId);
    case "image": {
      const embedded = embedImage(build, block.path, workspaceRoot, types);
      const usableWidth = usableWidthPoints(spec, preset);
      const width = (usableWidth * block.width) / 100;
      const height = embedded.width > 0 ? (width * embedded.height) / embedded.width : width * 0.6;
      const nodes = [
        paragraphNode(
          [drawingNode(embedded.relationshipId, width, height, block.alt ?? block.caption ?? "image", index)],
          { align: "center", spaceBefore: preset.spaceBeforeParagraph, blockId },
        ),
      ];
      if (block.caption) {
        nodes.push(
          paragraphNode(markedUpRuns(block.caption, { size: preset.small, color: colors.muted, italic: true }), {
            style: "Caption",
            align: "center",
          }),
        );
      }
      return nodes;
    }
    case "chart": {
      // Charts in a text document are drawn rather than made native: a native
      // DrawingML chart needs an embedded workbook, and the value here is the
      // picture, not the ability to edit the numbers in Word.
      if (!chartsAvailable()) {
        // No rasteriser: the numbers go in as a table rather than as a frame
        // with nothing in it. Uglier, equally true, and the QA pass says so.
        const fallback = chartFallbackTable(block.chart);
        build.blockIds.pop();
        return tableNodes(
          {
            type: "table",
            columns: fallback.columns.map((header) => ({ header, align: "left" as const })),
            rows: fallback.rows,
            ...(block.caption ? { caption: block.caption } : {}),
          },
          preset,
          blockId,
        ).map((node, nodeIndex) => {
          if (nodeIndex === 0) build.blockIds.push(blockId);
          return node;
        });
      }
      const svg = barChartSvg(block.chart, preset, usableWidthPoints(spec, preset));
      const embedded = embedBytes(build, types, svg.png, "png");
      const nodes = [
        paragraphNode([drawingNode(embedded, svg.width, svg.height, block.caption ?? "chart", index)], {
          align: "center",
          spaceBefore: preset.spaceBeforeParagraph,
          blockId,
        }),
      ];
      if (block.caption) {
        nodes.push(
          paragraphNode(markedUpRuns(block.caption, { size: preset.small, color: colors.muted, italic: true }), {
            style: "Caption",
            align: "center",
          }),
        );
      }
      return nodes;
    }
    case "quote": {
      const nodes = [
        paragraphNode(markedUpRuns(block.text, { italic: true, color: colors.heading }), {
          style: "Quote",
          indent: 24,
          spaceBefore: preset.spaceBeforeParagraph,
          blockId,
        }),
      ];
      if (block.attribution) {
        nodes.push(
          paragraphNode(markedUpRuns(`— ${block.attribution}`, { size: preset.small, color: colors.muted }), {
            style: "Quote",
            indent: 24,
          }),
        );
      }
      return nodes;
    }
    case "pageBreak":
      return [
        paragraphNode([element("w:r", {}, [element("w:br", { "w:type": "page" })])], { blockId }),
      ];
    case "signature":
      return block.fields.flatMap((field, fieldIndex) => [
        paragraphNode([runNode("​")], {
          spaceBefore: fieldIndex === 0 ? 28 : 20,
          ...(fieldIndex === 0 ? { blockId } : {}),
        }),
        paragraphNode(
          // The rule is an underline on a run of spaces, which is what survives
          // both printing and a paste into another document.
          [runNode("                                        ", { size: preset.body })],
          { style: "SignatureRule" },
        ),
        paragraphNode(markedUpRuns(field, { size: preset.small, color: colors.muted })),
      ]);
    case "formField":
      return [
        paragraphNode(
          [
            ...markedUpRuns(block.label, { bold: true }),
            runNode("  "),
            ...(block.kind === "checkbox"
              ? [runNode("☐", { size: preset.body })]
              : block.kind === "choice"
                ? [runNode((block.choices ?? []).map((choice) => `☐ ${choice}`).join("    "), { size: preset.body })]
                : [runNode("_".repeat(40), { color: colors.rule })]),
          ],
          { style: "BodyText", spaceBefore: preset.spaceBeforeParagraph, blockId },
        ),
      ];
  }
}

function usableWidthPoints(spec: DocumentSpec, preset: BlockPreset): number {
  const page = pageDimensions(spec.page.size, spec.page.orientation);
  return page.width - preset.margin * 2;
}

function tableNodes(
  block: Extract<Block, { type: "table" }>,
  preset: BlockPreset,
  blockId: string,
): XmlNode[] {
  const declared = block.columns.every((column) => column.width !== undefined);
  // Word lays out in fiftieths of a percent when the table is set to auto-fit
  // the window, which keeps a table correct on Letter and on A4 without this
  // engine knowing which one it is.
  const widths = block.columns.map((column) =>
    Math.round(((declared ? column.width! : 100 / block.columns.length) * 5000) / 100),
  );
  const headerRow = element("w:tr", {}, [
    element("w:trPr", {}, [element("w:tblHeader")]),
    ...block.columns.map((column, index) =>
      tableCell(column.header, widths[index]!, preset, column.align, true),
    ),
  ]);
  const bodyRows = block.rows.map((row) =>
    element(
      "w:tr",
      {},
      row.map((cell, index) => tableCell(cell, widths[index]!, preset, block.columns[index]!.align, false)),
    ),
  );
  const table = element("w:tbl", {}, [
    element("w:tblPr", {}, [
      element("w:tblStyle", { "w:val": "UmbraticTable" }),
      element("w:tblW", { "w:w": 5000, "w:type": "pct" }),
      element("w:tblLayout", { "w:type": "fixed" }),
    ]),
    element("w:tblGrid", {}, widths.map((width) => element("w:gridCol", { "w:w": width }))),
    headerRow,
    ...bodyRows,
  ]);
  const nodes: XmlNode[] = [
    // A bookmark cannot wrap a table, so the block id sits on an empty
    // paragraph immediately before it — which is also where Word puts a
    // caption, so nothing is added that a reader would notice.
    paragraphNode([], { spaceBefore: preset.spaceBeforeParagraph, blockId, keepNext: true }),
    table,
  ];
  if (block.caption) {
    nodes.push(
      paragraphNode(markedUpRuns(block.caption, { size: preset.small, color: preset.colors.muted, italic: true }), {
        style: "Caption",
      }),
    );
  }
  return nodes;
}

function tableCell(
  text: string,
  width: number,
  preset: BlockPreset,
  align: "left" | "center" | "right",
  header: boolean,
): XmlNode {
  return element("w:tc", {}, [
    element("w:tcPr", {}, [
      element("w:tcW", { "w:w": width, "w:type": "pct" }),
      header
        ? element("w:shd", { "w:val": "clear", "w:color": "auto", "w:fill": preset.colors.summary })
        : undefined,
    ]),
    paragraphNode(markedUpRuns(text, { bold: header, size: preset.body }), {
      style: "BodyText",
      align,
      spaceBefore: 3,
      spaceAfter: 3,
    }),
  ]);
}

/* -------------------------------- drawing --------------------------------- */

function drawingNode(
  relationshipId: string,
  widthPoints: number,
  heightPoints: number,
  description: string,
  index: number,
): XmlNode {
  const cx = Math.round(widthPoints * emuPerPoint);
  const cy = Math.round(heightPoints * emuPerPoint);
  const id = 1_000 + index;
  return element("w:drawing", {}, [
    element("wp:inline", { distT: 0, distB: 0, distL: 0, distR: 0 }, [
      element("wp:extent", { cx, cy }),
      element("wp:docPr", { id, name: `Picture ${index + 1}`, descr: description }),
      element("a:graphic", {}, [
        element("a:graphicData", { uri: pictureNamespace }, [
          element("pic:pic", {}, [
            element("pic:nvPicPr", {}, [
              element("pic:cNvPr", { id, name: `Picture ${index + 1}`, descr: description }),
              element("pic:cNvPicPr"),
            ]),
            element("pic:blipFill", {}, [
              element("a:blip", { "r:embed": relationshipId }),
              element("a:stretch", {}, [element("a:fillRect")]),
            ]),
            element("pic:spPr", {}, [
              element("a:xfrm", {}, [
                element("a:off", { x: 0, y: 0 }),
                element("a:ext", { cx, cy }),
              ]),
              element("a:prstGeom", { prst: "rect" }, [element("a:avLst")]),
            ]),
          ]),
        ]),
      ]),
    ]),
  ]);
}

function embedImage(
  build: Build,
  relativePath: string,
  workspaceRoot: string,
  types: ContentTypes,
): { relationshipId: string; width: number; height: number } {
  const absolute = path.resolve(workspaceRoot, relativePath);
  const root = path.resolve(workspaceRoot);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new Error(`image ${relativePath} is outside the workspace`);
  }
  const image = loadImage(absolute);
  const existing = build.media.get(absolute);
  if (existing) return { relationshipId: existing, width: image.width, height: image.height };
  const relationshipId = embedBytes(build, types, image.bytes, image.format === "jpeg" ? "jpeg" : image.format);
  build.media.set(absolute, relationshipId);
  return { relationshipId, width: image.width, height: image.height };
}

function embedBytes(build: Build, types: ContentTypes, bytes: Buffer, extension: string): string {
  const index = build.parts.filter((part) => part.name.startsWith("word/media/")).length + 1;
  const name = `word/media/image${index}.${extension}`;
  build.parts.push({ name, content: bytes });
  types.defaults.set(extension, `image/${extension === "jpg" ? "jpeg" : extension}`);
  const relationshipId = `rIdMedia${index}`;
  build.relationships.push({
    id: relationshipId,
    type: relationshipTypes.image,
    target: `media/image${index}.${extension}`,
  });
  return relationshipId;
}

/* ------------------------------ document parts ----------------------------- */

/**
 * A field-based table of contents.
 *
 * The entries are not written out: `TOC \o "1-3"` tells Word to build them, and
 * Word rebuilds them whenever the document changes. Writing the entries here
 * would produce a list that is correct exactly once.
 */
function tableOfContents(preset: BlockPreset): XmlNode[] {
  return [
    paragraphNode(markedUpRuns("Contents", { bold: true, size: preset.heading1, color: preset.colors.heading }), {
      style: "Heading1",
      spaceAfter: preset.spaceBeforeParagraph,
    }),
    element("w:p", {}, [
      element("w:pPr", {}, [element("w:pStyle", { "w:val": "BodyText" })]),
      element("w:r", {}, [element("w:fldChar", { "w:fldCharType": "begin", "w:dirty": "true" })]),
      element("w:r", {}, [
        element("w:instrText", { "xml:space": "preserve" }, ['TOC \\o "1-3" \\h \\z \\u']),
      ]),
      element("w:r", {}, [element("w:fldChar", { "w:fldCharType": "separate" })]),
      element("w:r", {}, [
        element("w:t", {}, ["Right-click and choose Update Field to build the table of contents."]),
      ]),
      element("w:r", {}, [element("w:fldChar", { "w:fldCharType": "end" })]),
    ]),
    paragraphNode([element("w:r", {}, [element("w:br", { "w:type": "page" })])]),
  ];
}

function sectionProperties(
  spec: DocumentSpec,
  preset: BlockPreset,
  hasHeader: boolean,
  hasFooter: boolean,
): XmlNode {
  const page = pageDimensions(spec.page.size, spec.page.orientation);
  const margin = Math.round(preset.margin * twipsPerPoint);
  return element("w:sectPr", {}, [
    hasHeader ? element("w:headerReference", { "w:type": "default", "r:id": "rIdHeader" }) : undefined,
    hasFooter ? element("w:footerReference", { "w:type": "default", "r:id": "rIdFooter" }) : undefined,
    element("w:pgSz", {
      "w:w": Math.round(page.width * twipsPerPoint),
      "w:h": Math.round(page.height * twipsPerPoint),
      ...(spec.page.orientation === "landscape" ? { "w:orient": "landscape" } : {}),
    }),
    element("w:pgMar", {
      "w:top": margin,
      "w:right": margin,
      "w:bottom": margin,
      "w:left": margin,
      "w:header": Math.round(margin / 2),
      "w:footer": Math.round(margin / 2),
      "w:gutter": 0,
    }),
  ]);
}

function headerXml(text: string, preset: BlockPreset): string {
  return serializeDocument(
    element("w:hdr", namespaces, [
      paragraphNode(markedUpRuns(text, { size: preset.small, color: preset.colors.muted }), {
        style: "BodyText",
      }),
    ]),
  );
}

function footerXml(footer: { text?: string; pageNumbers: boolean }, preset: BlockPreset): string {
  const children: XmlNode[] = [];
  if (footer.text) children.push(...markedUpRuns(footer.text, { size: preset.small, color: preset.colors.muted }));
  if (footer.pageNumbers) {
    if (footer.text) children.push(runNode("    ", { size: preset.small }));
    // PAGE is a field for the same reason the TOC is: the number has to be the
    // page it is printed on, which only the renderer knows.
    children.push(
      element("w:r", {}, [element("w:fldChar", { "w:fldCharType": "begin" })]),
      element("w:r", {}, [element("w:instrText", { "xml:space": "preserve" }, ["PAGE"])]),
      element("w:r", {}, [element("w:fldChar", { "w:fldCharType": "separate" })]),
      runNode("1", { size: preset.small, color: preset.colors.muted }),
      element("w:r", {}, [element("w:fldChar", { "w:fldCharType": "end" })]),
    );
  }
  return serializeDocument(
    element("w:ftr", namespaces, [
      paragraphNode(children, { style: "BodyText", align: footer.text ? "left" : "center" }),
    ]),
  );
}

function stylesXml(preset: BlockPreset): string {
  const body = preset.serif ? "Cambria" : "Calibri";
  const display = preset.serif ? "Cambria" : "Calibri Light";
  const style = (
    id: string,
    name: string,
    size: number,
    options: { color?: string; bold?: boolean; font?: string; italic?: boolean; outline?: number } = {},
  ): XmlNode =>
    element("w:style", { "w:type": "paragraph", "w:styleId": id }, [
      element("w:name", { "w:val": name }),
      element("w:basedOn", { "w:val": "Normal" }),
      element("w:qFormat"),
      element("w:pPr", {}, [
        element("w:spacing", { "w:line": Math.round(preset.lineHeight * 240), "w:lineRule": "auto" }),
        // The outline level is what makes a heading appear in the navigation
        // pane and in the TOC field's output.
        options.outline !== undefined
          ? element("w:outlineLvl", { "w:val": options.outline })
          : undefined,
      ]),
      element("w:rPr", {}, [
        element("w:rFonts", {
          "w:ascii": options.font ?? body,
          "w:hAnsi": options.font ?? body,
        }),
        options.bold ? element("w:b") : undefined,
        options.italic ? element("w:i") : undefined,
        element("w:color", { "w:val": options.color ?? preset.colors.text }),
        element("w:sz", { "w:val": Math.round(size * 2) }),
        element("w:szCs", { "w:val": Math.round(size * 2) }),
      ]),
    ]);

  return serializeDocument(
    element("w:styles", namespaces, [
      element("w:docDefaults", {}, [
        element("w:rPrDefault", {}, [
          element("w:rPr", {}, [
            element("w:rFonts", { "w:ascii": body, "w:hAnsi": body }),
            element("w:sz", { "w:val": Math.round(preset.body * 2) }),
          ]),
        ]),
      ]),
      style("Normal", "Normal", preset.body),
      style("BodyText", "Body Text", preset.body),
      style("Title", "Title", preset.title, { bold: true, color: preset.colors.heading, font: display }),
      style("Subtitle", "Subtitle", preset.subtitle, { color: preset.colors.muted }),
      style("Heading1", "heading 1", preset.heading1, {
        bold: true,
        color: preset.colors.heading,
        font: display,
        outline: 0,
      }),
      style("Heading2", "heading 2", preset.heading2, {
        bold: true,
        color: preset.colors.heading,
        font: display,
        outline: 1,
      }),
      style("Heading3", "heading 3", preset.heading3, {
        bold: true,
        color: preset.colors.muted,
        outline: 2,
      }),
      style("Caption", "caption", preset.small, { color: preset.colors.muted, italic: true }),
      style("Quote", "Quote", preset.body, { color: preset.colors.heading, italic: true }),
      style("ListParagraph", "List Paragraph", preset.body),
      element("w:style", { "w:type": "paragraph", "w:styleId": "SignatureRule" }, [
        element("w:name", { "w:val": "Signature Rule" }),
        element("w:basedOn", { "w:val": "Normal" }),
        element("w:pPr", {}, [
          element("w:pBdr", {}, [
            element("w:bottom", {
              "w:val": "single",
              "w:sz": 6,
              "w:space": 1,
              "w:color": preset.colors.rule,
            }),
          ]),
        ]),
      ]),
      element("w:style", { "w:type": "table", "w:styleId": "UmbraticTable" }, [
        element("w:name", { "w:val": "Umbratic Table" }),
        element("w:tblPr", {}, [
          element("w:tblBorders", {}, [
            element("w:top", { "w:val": "single", "w:sz": 4, "w:color": preset.colors.rule }),
            element("w:bottom", { "w:val": "single", "w:sz": 4, "w:color": preset.colors.rule }),
            element("w:insideH", { "w:val": "single", "w:sz": 4, "w:color": preset.colors.rule }),
          ]),
        ]),
      ]),
    ]),
  );
}

function numberingXml(): string {
  const abstract = (id: number, format: string, text: string): XmlNode =>
    element("w:abstractNum", { "w:abstractNumId": id }, [
      element("w:multiLevelType", { "w:val": "hybridMultilevel" }),
      ...Array.from({ length: 3 }, (_, level) =>
        element("w:lvl", { "w:ilvl": level }, [
          element("w:start", { "w:val": 1 }),
          element("w:numFmt", { "w:val": format }),
          element("w:lvlText", { "w:val": format === "bullet" ? ["•", "◦", "▪"][level] : text }),
          element("w:lvlJc", { "w:val": "left" }),
          element("w:pPr", {}, [
            element("w:ind", { "w:left": 360 * (level + 1), "w:hanging": 360 }),
          ]),
        ]),
      ),
    ]);
  return serializeDocument(
    element("w:numbering", namespaces, [
      abstract(0, "bullet", ""),
      abstract(1, "decimal", "%1."),
      element("w:num", { "w:numId": 1 }, [element("w:abstractNumId", { "w:val": 0 })]),
      element("w:num", { "w:numId": 2 }, [element("w:abstractNumId", { "w:val": 1 })]),
    ]),
  );
}

function settingsXml(): string {
  return serializeDocument(
    element("w:settings", namespaces, [
      // Without this the TOC and PAGE fields show their placeholder text until
      // someone presses F9.
      element("w:updateFields", { "w:val": "true" }),
    ]),
  );
}

function corePropertiesXml(spec: DocumentSpec, createdAt: string): string {
  return serializeDocument(
    element(
      "cp:coreProperties",
      {
        "xmlns:cp": "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
        "xmlns:dc": "http://purl.org/dc/elements/1.1/",
        "xmlns:dcterms": "http://purl.org/dc/terms/",
        "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
      },
      [
        element("dc:title", {}, [spec.meta.title]),
        element("dc:creator", {}, [spec.meta.author]),
        spec.meta.subject ? element("dc:subject", {}, [spec.meta.subject]) : undefined,
        element("cp:lastModifiedBy", {}, [spec.meta.author]),
        element("dcterms:created", { "xsi:type": "dcterms:W3CDTF" }, [createdAt]),
        element("dcterms:modified", { "xsi:type": "dcterms:W3CDTF" }, [createdAt]),
      ],
    ),
  );
}

function appPropertiesXml(spec: DocumentSpec): string {
  return serializeDocument(
    element(
      "Properties",
      {
        xmlns: "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties",
        "xmlns:vt": "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes",
      },
      [element("Application", {}, ["Umbratic"]), element("Company", {}, [spec.meta.author])],
    ),
  );
}

function customPropertiesXml(): string {
  return serializeDocument(
    element(
      "Properties",
      {
        xmlns: "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties",
        "xmlns:vt": "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes",
      },
      [
        element(
          "property",
          { fmtid: "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}", pid: 2, name: originPropertyName },
          [element("vt:lpwstr", {}, ["1"])],
        ),
      ],
    ),
  );
}
