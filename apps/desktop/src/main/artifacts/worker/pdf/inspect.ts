/**
 * Reading a PDF.
 *
 * A PDF has no blocks. It has pages, and on each page a set of glyphs at
 * coordinates that a reader's eye reassembles into paragraphs. So the outline
 * here is honestly page-shaped — page count, size, rotation, the text on each
 * page, and what the form fields are called — and the edit surface is page-level
 * to match. There is no `replaceBlock` for a PDF because there are no blocks to
 * replace; changing the words means rebuilding from source with `create`, and
 * saying so is more useful than a rewrite that reflows a page into nonsense.
 */

import { originKey } from "./create.js";

export type PdfUnsupportedKind = "encrypted" | "scanned" | "xfa";

export type PdfUnsupported = { kind: PdfUnsupportedKind; where: string };

export type PdfPageSummary = {
  number: number;
  width: number;
  height: number;
  rotation: number;
  /** Characters of extracted text, so a scanned page is visibly empty. */
  characters: number;
  text?: string;
};

export type PdfOutline = {
  pageCount: number;
  producer?: string;
  title?: string;
  author?: string;
  /** Form field names, which is what fillForm addresses. */
  fields: Array<{ name: string; kind: string }>;
  pages: PdfPageSummary[];
};

export type PdfInspection = {
  origin: "umbratic" | "foreign";
  editSurface: "surgical" | "inspect-only";
  unsupported: PdfUnsupported[];
  outline: PdfOutline;
};

/** Text kept per page in the outline. The whole document would blow the cap. */
const maxPageText = 1_200;
/** Below this, a page with a picture on it is almost certainly a scan. */
const scannedCharacterThreshold = 12;

export async function inspectPdf(bytes: Buffer): Promise<PdfInspection> {
  const { PDFDocument } = require("@cantoo/pdf-lib") as {
    PDFDocument: {
      load(bytes: Buffer, options?: Record<string, unknown>): Promise<PdfLibDocument>;
    };
  };
  const unsupported: PdfUnsupported[] = [];

  let document: PdfLibDocument;
  try {
    document = await PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false });
  } catch (error) {
    return {
      origin: "foreign",
      editSurface: "inspect-only",
      unsupported: [
        {
          kind: "encrypted",
          where: `the file could not be opened (${String(error instanceof Error ? error.message : error)})`,
        },
      ],
      outline: { pageCount: 0, fields: [], pages: [] },
    };
  }
  if (document.isEncrypted) {
    unsupported.push({ kind: "encrypted", where: "the document is encrypted" });
  }

  const keywords = document.getKeywords?.() ?? "";
  const origin = String(keywords).includes(originKey) ? "umbratic" : "foreign";

  const fields = readFields(document);
  // An XFA form is a whole second document format living inside the PDF, and
  // filling the AcroForm side of it has no effect on what the reader shows.
  if (hasXfa(document)) {
    unsupported.push({ kind: "xfa", where: "the document uses an XFA form" });
  }

  const pages = await extractPages(bytes, document);
  const textless = pages.filter((page) => page.characters < scannedCharacterThreshold);
  if (pages.length > 0 && textless.length === pages.length) {
    unsupported.push({
      kind: "scanned",
      where: `all ${pages.length} pages carry no extractable text`,
    });
  }

  // Encryption is the only thing that stops page operations; a scan still
  // merges, splits, rotates, and stamps perfectly well.
  const editSurface: PdfInspection["editSurface"] = document.isEncrypted ? "inspect-only" : "surgical";

  return {
    origin,
    editSurface,
    unsupported,
    outline: {
      pageCount: pages.length,
      ...(document.getProducer?.() ? { producer: document.getProducer() } : {}),
      ...(document.getTitle?.() ? { title: document.getTitle() } : {}),
      ...(document.getAuthor?.() ? { author: document.getAuthor() } : {}),
      fields,
      pages,
    },
  };
}

type PdfLibDocument = {
  isEncrypted: boolean;
  getPageCount(): number;
  getPages(): Array<{ getSize(): { width: number; height: number }; getRotation(): { angle: number } }>;
  getForm(): { getFields(): Array<{ getName(): string; constructor: { name: string } }> };
  getKeywords?(): string | undefined;
  getProducer?(): string | undefined;
  getTitle?(): string | undefined;
  getAuthor?(): string | undefined;
  catalog?: { get?(key: unknown): unknown };
};

function readFields(document: PdfLibDocument): Array<{ name: string; kind: string }> {
  try {
    return document
      .getForm()
      .getFields()
      .map((field) => ({
        name: field.getName(),
        // pdf-lib names its field classes PDFTextField, PDFCheckBox, and so on;
        // the tail is the vocabulary a caller reasons in.
        kind: field.constructor.name.replace(/^PDF/, "").toLowerCase(),
      }));
  } catch {
    return [];
  }
}

function hasXfa(document: PdfLibDocument): boolean {
  try {
    const serialized = JSON.stringify(document.catalog ?? {});
    return serialized.includes("XFA");
  } catch {
    return false;
  }
}

/**
 * Extracts text with pdfjs, falling back to geometry alone.
 *
 * pdfjs is already in this app for attachment rendering, and it is the only
 * thing here that actually understands a content stream. When it cannot run,
 * the pages are still reported — with no text, which is exactly what the
 * scanned-document check is looking for anyway.
 */
async function extractPages(bytes: Buffer, document: PdfLibDocument): Promise<PdfPageSummary[]> {
  const geometry = document.getPages().map((page, index) => ({
    number: index + 1,
    width: Math.round(page.getSize().width * 100) / 100,
    height: Math.round(page.getSize().height * 100) / 100,
    rotation: page.getRotation().angle,
    characters: 0,
  }));

  try {
    const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as {
      getDocument(options: Record<string, unknown>): { promise: Promise<PdfJsDocument> };
    };
    const loaded = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      useSystemFonts: false,
    }).promise;
    const pages: PdfPageSummary[] = [];
    for (let index = 0; index < loaded.numPages; index += 1) {
      const page = await loaded.getPage(index + 1);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const base = geometry[index] ?? {
        number: index + 1,
        width: 0,
        height: 0,
        rotation: 0,
        characters: 0,
      };
      pages.push({
        ...base,
        characters: text.length,
        ...(text ? { text: text.slice(0, maxPageText) } : {}),
      });
    }
    await loaded.destroy?.();
    return pages;
  } catch {
    return geometry;
  }
}

type PdfJsDocument = {
  numPages: number;
  getPage(number: number): Promise<{
    getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
  }>;
  destroy?(): Promise<void>;
};
