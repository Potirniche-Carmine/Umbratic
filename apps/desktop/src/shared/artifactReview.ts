/**
 * Document previews for supported files in a task's review list, wherever the
 * user saved them in the workspace. Main-process validation confines reads to
 * that list and workspace. Content comes from the engine's own inspection.
 *
 * What it produces is deliberately not a rendering. A deck becomes a list of
 * slide cards, a workbook becomes its sheets and headers, a PDF becomes its
 * page text. Word documents include their paragraphs and table cells; layout
 * remains the review panel's typography rather than Word's page rendering.
 */

import type { DocumentReviewBlock, DocumentReviewSnapshot } from "./documentReview";
import { isRecord } from "./records";

export const artifactFormats = ["pptx", "docx", "xlsx", "pdf"] as const;
export type ArtifactFormat = (typeof artifactFormats)[number];

function normalized(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

/** Whether this workspace-relative file has a supported document format. */
export function isArtifactPath(value: string): boolean {
  return artifactFormatOf(value) !== null;
}

export function artifactFormatOf(value: string): ArtifactFormat | null {
  const path = normalized(value);
  if (!path || path.startsWith("/") || /^[a-z]:/i.test(path) || path.split("/").includes("..")) return null;
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return artifactFormats.find((format) => format === extension) ?? null;
}

/** How many blocks a preview may hold before it is cut with a note. */
export const artifactPreviewBlockLimit = 400;

type Outline = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function block(
  id: string,
  style: DocumentReviewBlock["style"],
  value: string,
): DocumentReviewBlock | null {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? { id, style, text: trimmed } : null;
}

/**
 * Turns an engine outline into the blocks the review panel already renders.
 *
 * Reusing the existing block vocabulary rather than inventing a per-format one
 * is what keeps this to a mapping: the panel, its styles, and its selection
 * behaviour are unchanged, and each format only has to decide what its heading
 * and body lines are.
 */
export function artifactPreviewFromOutline(
  documentPath: string,
  format: ArtifactFormat,
  outline: unknown,
): DocumentReviewSnapshot | null {
  if (!isRecord(outline)) return null;
  const blocks: DocumentReviewBlock[] = [];
  const push = (candidate: DocumentReviewBlock | null) => {
    if (candidate && blocks.length < artifactPreviewBlockLimit) blocks.push(candidate);
  };

  const title = fileTitle(documentPath);
  switch (format) {
    case "pptx":
      slideBlocks(outline, push);
      break;
    case "docx":
      documentBlocks(outline, push);
      break;
    case "xlsx":
      sheetBlocks(outline, push);
      break;
    case "pdf":
      pageBlocks(outline, push);
      break;
  }
  if (blocks.length === 0) return null;
  return { documentPath: normalized(documentPath), title, blocks };
}

function fileTitle(documentPath: string): string {
  const name = normalized(documentPath).split("/").pop() ?? documentPath;
  return name.replace(/\.[^.]+$/, "");
}

function slideBlocks(outline: Outline, push: (block: DocumentReviewBlock | null) => void): void {
  const slides = Array.isArray(outline.slides) ? outline.slides : [];
  for (const [index, entry] of slides.entries()) {
    if (!isRecord(entry)) continue;
    const number = typeof entry.number === "number" ? entry.number : index + 1;
    push(block(`slide-${number}`, "heading1", `Slide ${number} — ${text(entry.title) || "Untitled"}`));
    const shapes = Array.isArray(entry.shapes) ? entry.shapes : [];
    for (const [shapeIndex, shape] of shapes.entries()) {
      if (!isRecord(shape)) continue;
      const body = text(shape.text);
      if (body) {
        // A shape's paragraphs are the bullets a reader sees, so each one is
        // its own line rather than a run-on block.
        for (const [lineIndex, line] of body.split("\n").entries()) {
          push(block(`slide-${number}-${shapeIndex}-${lineIndex}`, "bullet", line));
        }
        continue;
      }
      const kind = text(shape.kind);
      if (kind === "picture" || kind === "chart" || kind === "table") {
        const detail =
          kind === "table"
            ? `table, ${String(shape.rows ?? "?")} × ${String(shape.columns ?? "?")}`
            : kind === "chart"
              ? `chart, ${String(shape.seriesCount ?? "?")} series`
              : "picture";
        push(block(`slide-${number}-${shapeIndex}`, "quote", `[${detail}]`));
      }
    }
    const notes = text(entry.notes);
    if (notes) push(block(`slide-${number}-notes`, "paragraph", `Notes: ${notes}`));
  }
}

function documentBlocks(outline: Outline, push: (block: DocumentReviewBlock | null) => void): void {
  const entries = Array.isArray(outline.blocks) ? outline.blocks : [];
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry)) continue;
    const id = text(entry.id) || `block-${index}`;
    const kind = text(entry.kind);
    const body = text(entry.text);
    switch (kind) {
      case "title":
        push(block(id, "title", body));
        break;
      case "heading": {
        const level = typeof entry.level === "number" ? entry.level : 1;
        push(block(id, level >= 3 ? "heading3" : level === 2 ? "heading2" : "heading1", body));
        break;
      }
      case "list":
        push(block(id, "bullet", body));
        break;
      case "quote":
        push(block(id, "quote", body));
        break;
      case "table": {
        const cells = Array.isArray(entry.cells)
          ? entry.cells.filter(Array.isArray).map((row) => row.map(text))
          : [];
        if (cells.length) {
          push({ id, style: "table", text: cells.map((row) => row.join(" | ")).join("\n"), cells });
          break;
        }
        push(
          block(
            id,
            "quote",
            `[table, ${String(entry.rows ?? "?")} × ${String(entry.columns ?? "?")}] ${body}`,
          ),
        );
        break;
      }
      case "image":
        push(block(id, "quote", "[image]"));
        break;
      case "pageBreak":
        push(block(id, "quote", "— page break —"));
        break;
      default:
        push(block(id, "paragraph", body));
    }
  }
}

function sheetBlocks(outline: Outline, push: (block: DocumentReviewBlock | null) => void): void {
  const sheets = Array.isArray(outline.sheets) ? outline.sheets : [];
  for (const sheet of sheets) {
    if (!isRecord(sheet)) continue;
    const name = text(sheet.name) || "Sheet";
    push(
      block(
        `sheet-${name}`,
        "heading1",
        `${name} — ${String(sheet.rows ?? 0)} rows × ${String(sheet.columns ?? 0)} columns`,
      ),
    );
    const header = Array.isArray(sheet.header) ? sheet.header.map(text) : [];
    if (header.length > 0) push(block(`sheet-${name}-header`, "heading3", header.join(" | ")));
    const sample = Array.isArray(sheet.sample) ? sheet.sample : [];
    for (const [rowIndex, row] of sample.entries()) {
      if (!Array.isArray(row)) continue;
      push(block(`sheet-${name}-row-${rowIndex}`, "paragraph", row.map(text).join(" | ")));
    }
    const formulas = typeof sheet.formulaCount === "number" ? sheet.formulaCount : 0;
    if (formulas > 0) {
      push(
        block(
          `sheet-${name}-formulas`,
          "quote",
          `${formulas} formula${formulas === 1 ? "" : "s"}`,
        ),
      );
    }
  }
}

function pageBlocks(outline: Outline, push: (block: DocumentReviewBlock | null) => void): void {
  const pages = Array.isArray(outline.pages) ? outline.pages : [];
  for (const [index, page] of pages.entries()) {
    if (!isRecord(page)) continue;
    const number = typeof page.number === "number" ? page.number : index + 1;
    push(block(`page-${number}`, "heading1", `Page ${number}`));
    const body = text(page.text);
    // A page with no extractable text is a scan, and saying so beats an empty
    // card the reader has to interpret.
    push(
      block(
        `page-${number}-text`,
        body ? "paragraph" : "quote",
        body || "[no extractable text — this page is an image]",
      ),
    );
  }
}
