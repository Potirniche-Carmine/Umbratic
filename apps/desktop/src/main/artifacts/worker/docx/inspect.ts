/**
 * Reading a .docx.
 *
 * The outline is a list of blocks with stable ids, because that is what edit
 * addresses. Our own documents carry those ids as bookmarks; a stranger's do
 * not, so ids are assigned by position on read and reported as such. Either way
 * the model plans against what inspect returned rather than against a paragraph
 * index it counted itself.
 *
 * Runs are coalesced before anything is reported. Word splits a sentence across
 * runs wherever a spellcheck pass, a language tag, or a font change touched it,
 * so text that is not coalesced does not match what the reader sees — and a
 * `replaceText` built on it would miss.
 */

import { OoxmlPackage } from "../package.js";
import { readRelationships, relationshipTarget } from "../opc.js";
import {
  attribute,
  childElements,
  findElements,
  firstElement,
  localNameOf,
  parseXml,
  textOf,
} from "../xml.js";
import { originPropertyName } from "./create.js";

export type DocxUnsupportedKind =
  | "content-control"
  | "vml-drawing"
  | "mail-merge"
  | "macro"
  | "encrypted"
  | "legacy-doc";

export type DocxUnsupported = { kind: DocxUnsupportedKind; where: string };

export type DocxBlockSummary = {
  id: string;
  kind: "title" | "heading" | "paragraph" | "list" | "table" | "image" | "quote" | "pageBreak" | "other";
  /** Present on headings. */
  level?: number;
  text?: string;
  style?: string;
  rows?: number;
  columns?: number;
  /** True when the id came from a bookmark we wrote rather than from position. */
  anchored?: boolean;
};

export type DocxOutline = {
  blockCount: number;
  wordCount: number;
  page: { size?: string; orientation: "portrait" | "landscape" };
  styles: string[];
  blocks: DocxBlockSummary[];
  comments: Array<{ id: string; author: string; text: string }>;
  trackedChanges: { insertions: number; deletions: number; authors: string[] };
  placeholders: string[];
};

export type DocxInspection = {
  origin: "umbratic" | "foreign";
  editSurface: "full" | "surgical" | "inspect-only";
  unsupported: DocxUnsupported[];
  outline: DocxOutline;
};

/** `{{name}}` — what `fillPlaceholders` replaces. */
const placeholderPattern = /\{\{\s*([\w.-]{1,60})\s*\}\}/g;

export function inspectDocument(pack: OoxmlPackage): DocxInspection {
  const unsupported: DocxUnsupported[] = [];
  const origin = hasOriginStamp(pack) ? "umbratic" : "foreign";

  if (pack.names().some((name) => name.endsWith("vbaProject.bin"))) {
    unsupported.push({ kind: "macro", where: "the document carries a VBA project" });
  }

  const xml = pack.text("word/document.xml");
  if (!xml) {
    return {
      origin,
      editSurface: "inspect-only",
      unsupported: [{ kind: "encrypted", where: "the document part is missing or unreadable" }],
      outline: emptyOutline(),
    };
  }
  let document: Document;
  try {
    document = parseXml(xml);
  } catch (error) {
    return {
      origin,
      editSurface: "inspect-only",
      unsupported: [
        {
          kind: "encrypted",
          where: `the document part could not be parsed (${String(error instanceof Error ? error.message : error)})`,
        },
      ],
      outline: emptyOutline(),
    };
  }

  if (firstElement(document, "sdt")) {
    unsupported.push({ kind: "content-control", where: "the document uses content controls" });
  }
  if (findElements(document, "pict").length > 0 || pack.names().some((name) => name.endsWith(".vml"))) {
    unsupported.push({ kind: "vml-drawing", where: "the document uses legacy VML drawings" });
  }
  if (findElements(document, "fldSimple").some((node) => /MERGEFIELD/i.test(attribute(node, "instr") ?? ""))
    || findElements(document, "instrText").some((node) => /MERGEFIELD/i.test(textOf(node)))) {
    unsupported.push({ kind: "mail-merge", where: "the document has mail-merge fields" });
  }

  const body = firstElement(document, "body");
  const blocks: DocxBlockSummary[] = [];
  const placeholders = new Set<string>();
  let wordCount = 0;
  let position = 0;

  // A bookmark cannot wrap a table, so a table's id sits on an empty paragraph
  // immediately before it. That paragraph is not content and does not belong in
  // the outline, but its id does — it is carried forward to the block it was
  // written for.
  let pendingAnchor: string | undefined;

  for (const node of body ? childElements(body) : []) {
    const tag = localNameOf(node);
    if (tag === "sectPr") continue;
    position += 1;
    const summary =
      tag === "tbl" ? summarizeTable(node, position) : tag === "p" ? summarizeParagraph(node, position) : undefined;
    if (!summary) continue;
    if (pendingAnchor) {
      summary.id = pendingAnchor;
      summary.anchored = true;
      pendingAnchor = undefined;
    }
    // A paragraph with no text and no drawing is spacing, not content, and a
    // list of forty empty blocks is not an outline anyone can plan from.
    if (summary.kind === "other" && !summary.text) {
      if (summary.anchored) pendingAnchor = summary.id;
      continue;
    }
    blocks.push(summary);
    if (summary.text) {
      wordCount += summary.text.split(/\s+/).filter(Boolean).length;
      for (const match of summary.text.matchAll(placeholderPattern)) {
        placeholders.add(match[1]!);
      }
    }
  }

  const comments = readComments(pack);
  const insertions = findElements(document, "ins");
  const deletions = findElements(document, "del");
  const authors = [...insertions, ...deletions]
    .map((node) => attribute(node, "author") ?? "")
    .filter((author, index, all) => author && all.indexOf(author) === index);

  const section = firstElement(document, "sectPr");
  const pageSize = section ? firstElement(section, "pgSz") : undefined;

  const outline: DocxOutline = {
    blockCount: blocks.length,
    wordCount,
    page: {
      ...(pageSize ? { size: describePageSize(pageSize) } : {}),
      orientation: attribute(pageSize, "orient") === "landscape" ? "landscape" : "portrait",
    },
    styles: readStyleNames(pack),
    blocks,
    comments,
    trackedChanges: { insertions: insertions.length, deletions: deletions.length, authors },
    placeholders: [...placeholders],
  };

  const editSurface: DocxInspection["editSurface"] =
    origin === "umbratic" && unsupported.length === 0 ? "full" : "surgical";
  return { origin, editSurface, unsupported, outline };
}

function emptyOutline(): DocxOutline {
  return {
    blockCount: 0,
    wordCount: 0,
    page: { orientation: "portrait" },
    styles: [],
    blocks: [],
    comments: [],
    trackedChanges: { insertions: 0, deletions: 0, authors: [] },
    placeholders: [],
  };
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
 * The block id for a paragraph.
 *
 * A bookmark we wrote wins, because it survives insertions above it. Position
 * is the fallback for a foreign document, and it is reported as unanchored so a
 * caller knows the id is only good until the document changes.
 */
function blockIdFor(node: Element, position: number): { id: string; anchored: boolean } {
  const bookmark = findElements(node, "bookmarkStart")
    .map((start) => attribute(start, "name") ?? "")
    .find((name) => /^b\d+$/.test(name));
  return bookmark ? { id: bookmark, anchored: true } : { id: `p${position}`, anchored: false };
}

function summarizeParagraph(node: Element, position: number): DocxBlockSummary | undefined {
  const { id, anchored } = blockIdFor(node, position);
  const style = attribute(firstElement(node, "pStyle"), "val");
  const text = paragraphText(node);
  const hasDrawing = Boolean(firstElement(node, "drawing"));
  const hasPageBreak = findElements(node, "br").some((br) => attribute(br, "type") === "page");
  const numbering = firstElement(node, "numPr");

  const kind: DocxBlockSummary["kind"] = hasDrawing
    ? "image"
    : hasPageBreak && !text
      ? "pageBreak"
      : style === "Title"
        ? "title"
        : style?.startsWith("Heading")
          ? "heading"
          : style === "Quote"
            ? "quote"
            : numbering || style === "ListParagraph"
              ? "list"
              : text
                ? "paragraph"
                : "other";

  const level = kind === "heading" ? Number(style?.replace("Heading", "")) || 1 : undefined;
  return {
    id,
    kind,
    ...(anchored ? { anchored } : {}),
    ...(level ? { level } : {}),
    ...(style ? { style } : {}),
    ...(text ? { text: text.slice(0, 2_000) } : {}),
  };
}

function summarizeTable(node: Element, position: number): DocxBlockSummary {
  const rows = findElements(node, "tr");
  return {
    id: `p${position}`,
    kind: "table",
    rows: rows.length,
    columns: findElements(node, "gridCol").length || (rows[0] ? findElements(rows[0], "tc").length : 0),
    // The first row is the useful summary: it is almost always the header, and
    // it tells the model what the table is about without dumping the data.
    ...(rows[0] ? { text: findElements(rows[0], "tc").map((cell) => paragraphText(cell)).join(" | ") } : {}),
  };
}

/**
 * A paragraph's visible text.
 *
 * Deleted runs are skipped: `w:delText` is what a tracked deletion leaves
 * behind, and including it would report text that is struck through on screen
 * as though it were still part of the sentence.
 */
export function paragraphText(node: Element): string {
  let text = "";
  const visit = (current: Element) => {
    for (const child of childElements(current)) {
      const tag = localNameOf(child);
      if (tag === "del") continue;
      if (tag === "t") text += textOf(child);
      else if (tag === "tab") text += "\t";
      else if (tag === "br") text += "\n";
      else visit(child);
    }
  };
  visit(node);
  return text.trim();
}

function readComments(pack: OoxmlPackage): Array<{ id: string; author: string; text: string }> {
  const xml = pack.text("word/comments.xml");
  if (!xml) return [];
  try {
    return findElements(parseXml(xml), "comment").map((node) => ({
      id: attribute(node, "id") ?? "",
      author: attribute(node, "author") ?? "",
      text: paragraphText(node).slice(0, 1_000),
    }));
  } catch {
    return [];
  }
}

function readStyleNames(pack: OoxmlPackage): string[] {
  const xml = pack.text("word/styles.xml");
  if (!xml) return [];
  try {
    return findElements(parseXml(xml), "style")
      .map((node) => attribute(node, "styleId") ?? "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function describePageSize(node: Element): string {
  const width = Number(attribute(node, "w") ?? 0);
  const height = Number(attribute(node, "h") ?? 0);
  const near = (value: number, target: number) => Math.abs(value - target) < 60;
  // Twips: Letter is 12240 × 15840, A4 is 11906 × 16838.
  if ((near(width, 12_240) && near(height, 15_840)) || (near(width, 15_840) && near(height, 12_240))) {
    return "Letter";
  }
  if ((near(width, 11_906) && near(height, 16_838)) || (near(width, 16_838) && near(height, 11_906))) {
    return "A4";
  }
  return `${Math.round(width / 20)}×${Math.round(height / 20)}pt`;
}

/** Whether a package still has the parts a comment needs. */
export function hasCommentParts(pack: OoxmlPackage): boolean {
  return pack.has("word/comments.xml");
}

/** The relationship a document part holds for a given type, if any. */
export function documentRelationshipTarget(pack: OoxmlPackage, type: string): string | undefined {
  const relationship = readRelationships(pack, "word/document.xml").find((entry) => entry.type === type);
  return relationship ? relationshipTarget("word/document.xml", relationship) : undefined;
}
