/**
 * Building a PDF from the shared block spec.
 *
 * A PDF has no reflow: every glyph is placed at a coordinate, and pagination is
 * this module's job rather than a reader's. So the work is a layout pass —
 * measure each block, decide whether it fits the page that is open, break where
 * it does not — and the rules about where *not* to break are what separate a
 * typeset document from a wall of text: a heading never ends a page, a table
 * header repeats when its body continues, and a caption stays with its figure.
 *
 * The same Liberation faces the PPTX engine measures with are embedded here, so
 * a document rendered to both formats wraps in the same places, and text outside
 * Latin-1 survives instead of becoming question marks.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { barChartSvg, chartFallbackTable, chartsAvailable } from "../blocks/chart.js";
import { calloutAccent, calloutBackground, pageDimensions, presetFor, type BlockPreset } from "../blocks/presets.js";
import type { Block, DocumentSpec, SpecError, TableColumn } from "../blocks/spec.js";
import { inlineRuns, type InlineRun } from "../inlineText.js";
import { loadImage } from "../images.js";

export const originKey = "UmbraticArtifact";

type PdfFont = {
  widthOfTextAtSize(text: string, size: number): number;
  heightAtSize(size: number): number;
};

type PdfPage = {
  drawText(text: string, options: Record<string, unknown>): void;
  drawRectangle(options: Record<string, unknown>): void;
  drawLine(options: Record<string, unknown>): void;
  drawImage(image: unknown, options: Record<string, unknown>): void;
  getSize(): { width: number; height: number };
};

type PdfDocument = {
  addPage(size: [number, number]): PdfPage;
  getPages(): PdfPage[];
  embedFont(bytes: Buffer | string, options?: { subset?: boolean }): Promise<PdfFont>;
  embedPng(bytes: Buffer): Promise<{ width: number; height: number }>;
  embedJpg(bytes: Buffer): Promise<{ width: number; height: number }>;
  registerFontkit(fontkit: unknown): void;
  setTitle(value: string): void;
  setAuthor(value: string): void;
  setSubject(value: string): void;
  setProducer(value: string): void;
  setCreator(value: string): void;
  setKeywords(values: string[]): void;
  setCreationDate(value: Date): void;
  setModificationDate(value: Date): void;
  save(options?: Record<string, unknown>): Promise<Uint8Array>;
};

export type PdfCreateResult = {
  bytes: Buffer;
  errors: SpecError[];
  pageCount: number;
  /** Block ids in order, matching what inspect will report. */
  blockIds: string[];
};

export type PdfCreateOptions = {
  spec: DocumentSpec;
  workspaceRoot: string;
  createdAt: string;
};

type Fonts = { regular: PdfFont; bold: PdfFont; italic: PdfFont; mono: PdfFont };

type Layout = {
  document: PdfDocument;
  page: PdfPage;
  /** Distance from the top of the page to the next line's baseline area. */
  cursor: number;
  pageWidth: number;
  pageHeight: number;
  margin: number;
  preset: BlockPreset;
  fonts: Fonts;
  spec: DocumentSpec;
  pageNumber: number;
  rgb: (r: number, g: number, b: number) => unknown;
};

export async function createPdf(options: PdfCreateOptions): Promise<PdfCreateResult> {
  const { PDFDocument, rgb } = require("@cantoo/pdf-lib") as {
    PDFDocument: { create(): Promise<PdfDocument> };
    rgb: (r: number, g: number, b: number) => unknown;
  };
  const { spec } = options;
  const preset = presetFor(spec.preset);
  const document = await PDFDocument.create();
  registerFonts(document);
  const fonts = await embedFonts(document, preset);
  const page = pageDimensions(spec.page.size, spec.page.orientation);

  const layout: Layout = {
    document,
    page: document.addPage([page.width, page.height]),
    cursor: preset.margin,
    pageWidth: page.width,
    pageHeight: page.height,
    margin: preset.margin,
    preset,
    fonts,
    spec,
    pageNumber: 1,
    rgb,
  };

  const errors: SpecError[] = [];
  const blockIds: string[] = [];

  if (spec.toc) drawTableOfContents(layout);

  for (const [index, block] of spec.blocks.entries()) {
    blockIds.push(`b${index + 1}`);
    try {
      await drawBlock(layout, block, options.workspaceRoot);
    } catch (error) {
      errors.push({
        path: `blocks[${index}]`,
        message: String(error instanceof Error ? error.message : error),
      });
    }
  }

  // Headers and footers are drawn last, when the page count is known — a footer
  // that says "page 1 of 4" cannot be written while page 2 is still open.
  drawRunningHeadersAndFooters(layout);

  document.setTitle(spec.meta.title);
  document.setAuthor(spec.meta.author);
  if (spec.meta.subject) document.setSubject(spec.meta.subject);
  document.setCreator("Umbratic");
  // The origin stamp. PDF has no custom-property dictionary a reader will keep,
  // so it rides in Keywords, which round-trips through every tool that matters.
  document.setKeywords([originKey]);
  document.setProducer("Umbratic");
  const stamp = new Date(options.createdAt);
  const fixed = Number.isNaN(stamp.getTime()) ? new Date(0) : stamp;
  document.setCreationDate(fixed);
  document.setModificationDate(fixed);

  const saved = await document.save({ useObjectStreams: false });
  return {
    bytes: Buffer.from(saved),
    errors,
    pageCount: document.getPages().length,
    blockIds,
  };
}

function registerFonts(document: PdfDocument): void {
  try {
    document.registerFontkit(require("fontkit"));
  } catch {
    // Without fontkit only the standard faces are available; embedFonts falls
    // back to them and the QA pass reports the encoding limit that implies.
  }
}

/** Where the Liberation faces live, mirroring the measurement module's search. */
function fontFile(name: string): string | undefined {
  const suffix = path.join("pdfjs-dist", "standard_fonts", name);
  try {
    const manifest = require.resolve("pdfjs-dist/package.json");
    const candidate = path.join(path.dirname(manifest), "standard_fonts", name);
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // Fall through to the directory walk.
  }
  let directory = __dirname;
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = path.join(directory, "node_modules", suffix);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

async function embedFonts(document: PdfDocument, preset: BlockPreset): Promise<Fonts> {
  const { StandardFonts } = require("@cantoo/pdf-lib") as { StandardFonts: Record<string, string> };
  const embed = async (file: string, fallback: string): Promise<PdfFont> => {
    const resolved = fontFile(file);
    if (resolved) {
      try {
        return await document.embedFont(fs.readFileSync(resolved), { subset: true });
      } catch {
        // A face that will not embed is not worth failing the document over.
      }
    }
    return document.embedFont(fallback);
  };
  const serif = preset.serif;
  return {
    regular: await embed(
      serif ? "LiberationSerif-Regular.ttf" : "LiberationSans-Regular.ttf",
      serif ? StandardFonts.TimesRoman! : StandardFonts.Helvetica!,
    ),
    bold: await embed(
      serif ? "LiberationSerif-Bold.ttf" : "LiberationSans-Bold.ttf",
      serif ? StandardFonts.TimesRomanBold! : StandardFonts.HelveticaBold!,
    ),
    italic: await embed(
      serif ? "LiberationSerif-Italic.ttf" : "LiberationSans-Italic.ttf",
      serif ? StandardFonts.TimesRomanItalic! : StandardFonts.HelveticaOblique!,
    ),
    mono: await document.embedFont(StandardFonts.Courier!),
  };
}

/* --------------------------------- layout ---------------------------------- */

function usableWidth(layout: Layout): number {
  return layout.pageWidth - layout.margin * 2;
}

function remaining(layout: Layout): number {
  // The bottom margin is reserved for the footer, so content stops above it.
  return layout.pageHeight - layout.margin - layout.cursor;
}

function newPage(layout: Layout): void {
  layout.page = layout.document.addPage([layout.pageWidth, layout.pageHeight]);
  layout.cursor = layout.margin;
  layout.pageNumber += 1;
}

/** Opens a new page when the next `height` points would not fit on this one. */
function ensureSpace(layout: Layout, height: number): void {
  if (height <= remaining(layout)) return;
  newPage(layout);
}

type TextStyle = {
  size: number;
  color: string;
  font?: "regular" | "bold" | "italic" | "mono";
  align?: "left" | "center" | "right";
  lineHeight?: number;
};

function fontFor(layout: Layout, style: TextStyle, run: { bold?: boolean; italic?: boolean; code?: boolean }): PdfFont {
  if (run.code) return layout.fonts.mono;
  if (run.bold || style.font === "bold") return layout.fonts.bold;
  if (run.italic || style.font === "italic") return layout.fonts.italic;
  return layout.fonts.regular;
}


type WrappedLine = { runs: Array<InlineRun & { width: number }>; width: number };

/**
 * Wraps marked-up text to a width, keeping each word's run identity.
 *
 * Wrapping the plain string and re-applying formatting afterwards is what makes
 * a bold phrase drift a word to the left of where it belongs, so the runs are
 * carried through the break.
 */
function wrapRuns(layout: Layout, value: string, style: TextStyle, width: number): WrappedLine[] {
  const lines: WrappedLine[] = [];
  let current: WrappedLine = { runs: [], width: 0 };

  const push = () => {
    if (current.runs.length > 0) lines.push(current);
    current = { runs: [], width: 0 };
  };

  for (const paragraph of value.split("\n")) {
    for (const run of inlineRuns(paragraph)) {
      const font = fontFor(layout, style, run);
      const words = run.text.split(/(\s+)/).filter((part) => part.length > 0);
      for (const word of words) {
        const wordWidth = font.widthOfTextAtSize(word, style.size);
        if (current.width + wordWidth > width && current.runs.length > 0 && word.trim().length > 0) {
          push();
        }
        // A space that lands at the start of a wrapped line is invisible
        // indentation; dropping it is what keeps the left edge straight.
        if (current.runs.length === 0 && word.trim().length === 0) continue;
        current.runs.push({ ...run, text: word, width: wordWidth });
        current.width += wordWidth;
      }
    }
    push();
  }
  return lines.length > 0 ? lines : [{ runs: [], width: 0 }];
}

function lineHeightFor(layout: Layout, style: TextStyle): number {
  return style.size * (style.lineHeight ?? layout.preset.lineHeight);
}

function colorOf(layout: Layout, hex: string): unknown {
  const value = hex.replace(/^#/, "");
  return layout.rgb(
    parseInt(value.slice(0, 2), 16) / 255,
    parseInt(value.slice(2, 4), 16) / 255,
    parseInt(value.slice(4, 6), 16) / 255,
  );
}

/** Draws wrapped text at the cursor, breaking pages as it goes. */
function drawWrapped(
  layout: Layout,
  value: string,
  style: TextStyle,
  options: { width?: number; left?: number; spaceBefore?: number; keepLines?: number } = {},
): void {
  const width = options.width ?? usableWidth(layout);
  const left = options.left ?? layout.margin;
  const lines = wrapRuns(layout, value, style, width);
  const lineHeight = lineHeightFor(layout, style);

  if (options.spaceBefore) layout.cursor += options.spaceBefore;
  // Keeping the first N lines together is how a heading avoids being orphaned
  // at the foot of a page: it is asked for with its following line.
  const keep = Math.min(options.keepLines ?? 1, lines.length);
  ensureSpace(layout, lineHeight * keep);

  for (const line of lines) {
    ensureSpace(layout, lineHeight);
    const y = layout.pageHeight - layout.cursor - style.size;
    let x = left;
    if (style.align === "center") x = left + (width - line.width) / 2;
    else if (style.align === "right") x = left + width - line.width;
    for (const run of line.runs) {
      layout.page.drawText(run.text, {
        x,
        y,
        size: style.size,
        font: fontFor(layout, style, run),
        color: colorOf(layout, style.color),
      });
      x += run.width;
    }
    layout.cursor += lineHeight;
  }
}

function measureHeight(layout: Layout, value: string, style: TextStyle, width: number): number {
  return wrapRuns(layout, value, style, width).length * lineHeightFor(layout, style);
}

/* --------------------------------- blocks ---------------------------------- */

async function drawBlock(layout: Layout, block: Block, workspaceRoot: string): Promise<void> {
  const preset = layout.preset;
  const colors = preset.colors;
  const body: TextStyle = { size: preset.body, color: colors.text };

  switch (block.type) {
    case "title": {
      drawWrapped(layout, block.text, {
        size: preset.title,
        color: colors.heading,
        font: "bold",
        lineHeight: 1.15,
      }, { spaceBefore: 0, keepLines: 2 });
      if (block.subtitle) {
        drawWrapped(layout, block.subtitle, { size: preset.subtitle, color: colors.muted }, { spaceBefore: 4 });
      }
      layout.cursor += preset.spaceBeforeHeading;
      return;
    }
    case "heading": {
      const size = block.level === 1 ? preset.heading1 : block.level === 2 ? preset.heading2 : preset.heading3;
      drawWrapped(
        layout,
        block.text,
        { size, color: block.level === 3 ? colors.muted : colors.heading, font: "bold", lineHeight: 1.2 },
        { spaceBefore: preset.spaceBeforeHeading, keepLines: 2 },
      );
      layout.cursor += preset.spaceBeforeParagraph / 2;
      return;
    }
    case "paragraph":
      drawWrapped(layout, block.text, body, { spaceBefore: preset.spaceBeforeParagraph });
      return;
    case "bullets":
    case "numbered":
    case "checklist": {
      layout.cursor += preset.spaceBeforeList;
      const indent = 16;
      block.items.forEach((item, index) => {
        const marker =
          block.type === "bullets" ? "•" : block.type === "numbered" ? `${index + 1}.` : "☐";
        const markerWidth = layout.fonts.regular.widthOfTextAtSize(`${marker} `, preset.body);
        ensureSpace(layout, lineHeightFor(layout, body));
        layout.page.drawText(marker, {
          x: layout.margin + indent,
          y: layout.pageHeight - layout.cursor - preset.body,
          size: preset.body,
          font: layout.fonts.regular,
          color: colorOf(layout, colors.text),
        });
        drawWrapped(layout, item, body, {
          left: layout.margin + indent + markerWidth,
          width: usableWidth(layout) - indent - markerWidth,
          spaceBefore: index === 0 ? 0 : 2,
        });
      });
      return;
    }
    case "definitions": {
      layout.cursor += preset.spaceBeforeList;
      for (const item of block.items) {
        drawWrapped(layout, item.term, { size: preset.body, color: colors.heading, font: "bold" }, { keepLines: 2, spaceBefore: 6 });
        drawWrapped(layout, item.definition, body, {
          left: layout.margin + 16,
          width: usableWidth(layout) - 16,
        });
      }
      return;
    }
    case "callout": {
      const padding = 10;
      const innerWidth = usableWidth(layout) - padding * 2 - 4;
      const titleHeight = block.title
        ? measureHeight(layout, block.title, { size: preset.body, color: colors.heading, font: "bold" }, innerWidth)
        : 0;
      const textHeight = measureHeight(layout, block.text, body, innerWidth);
      const total = titleHeight + textHeight + padding * 2;
      layout.cursor += preset.spaceBeforeParagraph;
      ensureSpace(layout, total);
      const top = layout.pageHeight - layout.cursor;
      layout.page.drawRectangle({
        x: layout.margin,
        y: top - total,
        width: usableWidth(layout),
        height: total,
        color: colorOf(layout, calloutBackground(preset, block.style)),
      });
      // A rule down the left edge is what makes a callout read as an aside
      // rather than as a shaded paragraph.
      layout.page.drawRectangle({
        x: layout.margin,
        y: top - total,
        width: 3,
        height: total,
        color: colorOf(layout, calloutAccent(preset, block.style)),
      });
      layout.cursor += padding;
      if (block.title) {
        drawWrapped(
          layout,
          block.title,
          { size: preset.body, color: calloutAccent(preset, block.style), font: "bold" },
          { left: layout.margin + padding + 4, width: innerWidth },
        );
      }
      drawWrapped(layout, block.text, body, {
        left: layout.margin + padding + 4,
        width: innerWidth,
      });
      layout.cursor += padding + preset.spaceBeforeParagraph;
      return;
    }
    case "table":
      drawTable(layout, block);
      return;
    case "image": {
      const absolute = path.resolve(workspaceRoot, block.path);
      const root = path.resolve(workspaceRoot);
      if (absolute !== root && !absolute.startsWith(root + path.sep)) {
        throw new Error(`image ${block.path} is outside the workspace`);
      }
      const image = loadImage(absolute);
      if (image.format === "gif") {
        throw new Error(`image ${block.path} is a GIF; PDF embeds PNG and JPEG`);
      }
      const embedded =
        image.format === "png"
          ? await layout.document.embedPng(image.bytes)
          : await layout.document.embedJpg(image.bytes);
      const width = (usableWidth(layout) * block.width) / 100;
      const height = embedded.width > 0 ? (width * embedded.height) / embedded.width : width * 0.6;
      layout.cursor += preset.spaceBeforeParagraph;
      ensureSpace(layout, height);
      layout.page.drawImage(embedded, {
        x: layout.margin + (usableWidth(layout) - width) / 2,
        y: layout.pageHeight - layout.cursor - height,
        width,
        height,
      });
      layout.cursor += height;
      if (block.caption) {
        drawWrapped(layout, block.caption, { size: preset.small, color: colors.muted, font: "italic", align: "center" }, { spaceBefore: 4 });
      }
      return;
    }
    case "chart": {
      if (!chartsAvailable()) {
        const fallback = chartFallbackTable(block.chart);
        drawTable(layout, {
          type: "table",
          columns: fallback.columns.map((header) => ({ header, align: "left" as const })),
          rows: fallback.rows,
          ...(block.caption ? { caption: block.caption } : {}),
        });
        return;
      }
      const rendered = barChartSvg(block.chart, preset, usableWidth(layout));
      const embedded = await layout.document.embedPng(rendered.png);
      layout.cursor += preset.spaceBeforeParagraph;
      ensureSpace(layout, rendered.height);
      layout.page.drawImage(embedded, {
        x: layout.margin,
        y: layout.pageHeight - layout.cursor - rendered.height,
        width: rendered.width,
        height: rendered.height,
      });
      layout.cursor += rendered.height;
      if (block.caption) {
        drawWrapped(layout, block.caption, { size: preset.small, color: colors.muted, font: "italic", align: "center" }, { spaceBefore: 4 });
      }
      return;
    }
    case "quote": {
      const indent = 24;
      layout.cursor += preset.spaceBeforeParagraph;
      const height = measureHeight(
        layout,
        block.text,
        { size: preset.body, color: colors.heading, font: "italic" },
        usableWidth(layout) - indent,
      );
      ensureSpace(layout, height);
      layout.page.drawRectangle({
        x: layout.margin,
        y: layout.pageHeight - layout.cursor - height,
        width: 2,
        height,
        color: colorOf(layout, colors.rule),
      });
      drawWrapped(
        layout,
        block.text,
        { size: preset.body, color: colors.heading, font: "italic" },
        { left: layout.margin + indent, width: usableWidth(layout) - indent },
      );
      if (block.attribution) {
        drawWrapped(
          layout,
          `— ${block.attribution}`,
          { size: preset.small, color: colors.muted },
          { left: layout.margin + indent, width: usableWidth(layout) - indent },
        );
      }
      return;
    }
    case "pageBreak":
      newPage(layout);
      return;
    case "signature": {
      layout.cursor += 28;
      for (const field of block.fields) {
        ensureSpace(layout, 44);
        const y = layout.pageHeight - layout.cursor - 14;
        layout.page.drawLine({
          start: { x: layout.margin, y },
          end: { x: layout.margin + Math.min(260, usableWidth(layout)), y },
          thickness: 0.75,
          color: colorOf(layout, colors.rule),
        });
        layout.cursor += 18;
        drawWrapped(layout, field, { size: preset.small, color: colors.muted });
        layout.cursor += 12;
      }
      return;
    }
    case "formField": {
      layout.cursor += preset.spaceBeforeParagraph;
      const labelWidth = layout.fonts.bold.widthOfTextAtSize(`${block.label}  `, preset.body);
      ensureSpace(layout, lineHeightFor(layout, body));
      const y = layout.pageHeight - layout.cursor - preset.body;
      layout.page.drawText(block.label, {
        x: layout.margin,
        y,
        size: preset.body,
        font: layout.fonts.bold,
        color: colorOf(layout, colors.text),
      });
      const trailing =
        block.kind === "checkbox"
          ? "☐"
          : block.kind === "choice"
            ? (block.choices ?? []).map((choice) => `☐ ${choice}`).join("    ")
            : "";
      if (trailing) {
        layout.page.drawText(trailing, {
          x: layout.margin + labelWidth,
          y,
          size: preset.body,
          font: layout.fonts.regular,
          color: colorOf(layout, colors.text),
        });
      } else {
        layout.page.drawLine({
          start: { x: layout.margin + labelWidth, y: y - 2 },
          end: { x: layout.margin + usableWidth(layout), y: y - 2 },
          thickness: 0.75,
          color: colorOf(layout, colors.rule),
        });
      }
      layout.cursor += lineHeightFor(layout, body);
      return;
    }
  }
}

/**
 * Draws a table, repeating the header whenever the body crosses a page.
 *
 * A table that breaks without repeating its header leaves the reader with a
 * block of unlabelled numbers, which is the single most common defect in a
 * generated report.
 */
function drawTable(layout: Layout, block: Extract<Block, { type: "table" }>): void {
  const preset = layout.preset;
  const total = usableWidth(layout);
  const declared = block.columns.every((column) => column.width !== undefined);
  const widths = block.columns.map((column) =>
    declared ? (total * column.width!) / 100 : total / block.columns.length,
  );
  const padding = 6;
  const bodyStyle: TextStyle = { size: preset.body, color: preset.colors.text };
  const headerStyle: TextStyle = { size: preset.body, color: preset.colors.heading, font: "bold" };

  const rowHeight = (cells: string[], style: TextStyle) =>
    Math.max(
      ...cells.map((cell, index) =>
        measureHeight(layout, cell || " ", style, widths[index]! - padding * 2),
      ),
    ) + padding;

  const drawRow = (cells: string[], style: TextStyle, columns: TableColumn[], fill?: string) => {
    const height = rowHeight(cells, style);
    ensureSpace(layout, height);
    const top = layout.pageHeight - layout.cursor;
    if (fill) {
      layout.page.drawRectangle({
        x: layout.margin,
        y: top - height,
        width: total,
        height,
        color: colorOf(layout, fill),
      });
    }
    const startCursor = layout.cursor;
    let x = layout.margin;
    cells.forEach((cell, index) => {
      layout.cursor = startCursor + padding / 2;
      drawWrapped(layout, cell, { ...style, align: columns[index]!.align }, {
        left: x + padding,
        width: widths[index]! - padding * 2,
      });
      x += widths[index]!;
    });
    layout.cursor = startCursor + height;
    layout.page.drawLine({
      start: { x: layout.margin, y: layout.pageHeight - layout.cursor },
      end: { x: layout.margin + total, y: layout.pageHeight - layout.cursor },
      thickness: 0.5,
      color: colorOf(layout, preset.colors.rule),
    });
  };

  layout.cursor += preset.spaceBeforeParagraph;
  const headerCells = block.columns.map((column) => column.header);
  drawRow(headerCells, headerStyle, block.columns, preset.colors.summary);
  let pageOfHeader = layout.pageNumber;
  for (const row of block.rows) {
    const before = layout.pageNumber;
    const height = rowHeight(row, bodyStyle);
    if (height > remaining(layout)) {
      newPage(layout);
      drawRow(headerCells, headerStyle, block.columns, preset.colors.summary);
      pageOfHeader = layout.pageNumber;
    }
    void before;
    drawRow(row, bodyStyle, block.columns);
  }
  void pageOfHeader;
  if (block.caption) {
    drawWrapped(layout, block.caption, { size: preset.small, color: preset.colors.muted, font: "italic" }, { spaceBefore: 4 });
  }
}

/**
 * A placeholder contents page.
 *
 * A PDF has no field that rebuilds itself, and the page numbers are not known
 * until every block has been laid out — so this reserves the page and says what
 * it is, rather than printing numbers that would be wrong.
 */
function drawTableOfContents(layout: Layout): void {
  const preset = layout.preset;
  drawWrapped(layout, "Contents", { size: preset.heading1, color: preset.colors.heading, font: "bold" });
  layout.cursor += preset.spaceBeforeParagraph;
  const headings = layout.spec.blocks.filter(
    (block): block is Extract<Block, { type: "heading" }> => block.type === "heading",
  );
  for (const heading of headings) {
    drawWrapped(
      layout,
      heading.text,
      { size: preset.body, color: preset.colors.text },
      { left: layout.margin + (heading.level - 1) * 14, width: usableWidth(layout) - (heading.level - 1) * 14 },
    );
  }
  newPage(layout);
}

function drawRunningHeadersAndFooters(layout: Layout): void {
  const preset = layout.preset;
  const pages = layout.document.getPages();
  pages.forEach((page, index) => {
    const size = page.getSize();
    if (layout.spec.header) {
      page.drawText(layout.spec.header.text, {
        x: layout.margin,
        y: size.height - preset.margin / 2,
        size: preset.small,
        font: layout.fonts.regular,
        color: colorOf(layout, preset.colors.muted),
      });
    }
    if (!layout.spec.footer) return;
    const footer = layout.spec.footer;
    if (footer.text) {
      page.drawText(footer.text, {
        x: layout.margin,
        y: preset.margin / 2,
        size: preset.small,
        font: layout.fonts.regular,
        color: colorOf(layout, preset.colors.muted),
      });
    }
    if (footer.pageNumbers) {
      const label = `${index + 1} of ${pages.length}`;
      const width = layout.fonts.regular.widthOfTextAtSize(label, preset.small);
      page.drawText(label, {
        x: size.width - layout.margin - width,
        y: preset.margin / 2,
        size: preset.small,
        font: layout.fonts.regular,
        color: colorOf(layout, preset.colors.muted),
      });
    }
  });
}
