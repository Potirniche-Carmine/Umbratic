/**
 * Editing a PDF.
 *
 * Every op here is page-level or metadata-level, and that is the whole design
 * rather than a limitation we intend to lift. A PDF's words are glyphs at
 * coordinates with no paragraph structure behind them; "replace this sentence"
 * would mean re-flowing a page whose line breaks were decided by a program we
 * never saw, and the honest answer to that request is to rebuild from source
 * with `create`. The tool says so instead of producing an overlapping mess.
 */

import * as path from "node:path";

import { loadImage } from "../images.js";
import type { PdfInspection } from "./inspect.js";

export type OpError = { path: string; message: string };

export type PdfEditResult =
  | { ok: true; bytes: Buffer; applied: string[] }
  | { ok: false; errors: OpError[] };

const pageOps = new Set([
  "merge",
  "split",
  "extractPages",
  "deletePages",
  "reorder",
  "rotate",
  "insertBlank",
  "watermark",
  "stamp",
  "fillForm",
  "flatten",
  "setMetadata",
]);

export type PdfEditOptions = {
  bytes: Buffer;
  inspection: PdfInspection;
  ops: unknown[];
  workspaceRoot: string;
  /** Where `split` writes its parts, absolute and already confined. */
  outDirectory?: string;
};

export type PdfEditExtraOutput = { absolutePath: string; bytes: Buffer };

export async function applyPdfOps(
  options: PdfEditOptions,
): Promise<PdfEditResult & { extra?: PdfEditExtraOutput[] }> {
  if (options.inspection.editSurface === "inspect-only") {
    return {
      ok: false,
      errors: [
        {
          path: "ops[0]",
          message: `editSurface is inspect-only (${options.inspection.unsupported.map((entry) => entry.kind).join(", ") || "unreadable"})`,
        },
      ],
    };
  }
  const lib = require("@cantoo/pdf-lib") as PdfLib;
  let document: PdfLibDocument;
  try {
    document = await lib.PDFDocument.load(options.bytes, { throwOnInvalidObject: false });
  } catch (error) {
    return {
      ok: false,
      errors: [{ path: "path", message: `the file could not be opened (${String(error instanceof Error ? error.message : error)})` }],
    };
  }

  const applied: string[] = [];
  const extra: PdfEditExtraOutput[] = [];

  for (const [index, raw] of options.ops.entries()) {
    const opPath = `ops[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, errors: [{ path: opPath, message: "must be an object with an op field" }] };
    }
    const op = raw as Record<string, unknown>;
    const kind = typeof op.op === "string" ? op.op : "";
    if (!pageOps.has(kind)) {
      return {
        ok: false,
        errors: [
          {
            path: `${opPath}.op`,
            message:
              `${kind || "(missing)"} is not a PDF operation; use one of ${[...pageOps].sort().join(", ")}. `
              + "A PDF's body text cannot be rewritten in place — rebuild it from source with create.",
          },
        ],
      };
    }
    try {
      const outcome = await applyOne(lib, document, kind, op, opPath, options);
      document = outcome.document;
      applied.push(outcome.summary);
      if (outcome.extra) extra.push(...outcome.extra);
    } catch (error) {
      return {
        ok: false,
        errors: [{ path: opPath, message: String(error instanceof Error ? error.message : error) }],
      };
    }
  }

  const saved = await document.save({ useObjectStreams: false });
  return { ok: true, bytes: Buffer.from(saved), applied, ...(extra.length > 0 ? { extra } : {}) };
}

type Outcome = { document: PdfLibDocument; summary: string; extra?: PdfEditExtraOutput[] };

async function applyOne(
  lib: PdfLib,
  document: PdfLibDocument,
  kind: string,
  op: Record<string, unknown>,
  opPath: string,
  options: PdfEditOptions,
): Promise<Outcome> {
  switch (kind) {
    case "merge":
      return { document: await merge(lib, document, op, opPath, options), summary: "merge" };
    case "extractPages":
      return extractPages(lib, document, op, opPath);
    case "deletePages":
      return deletePages(document, op, opPath);
    case "reorder":
      return reorder(lib, document, op, opPath);
    case "rotate":
      return rotate(lib, document, op, opPath);
    case "insertBlank":
      return insertBlank(document, op, opPath);
    case "split":
      return split(lib, document, op, opPath, options);
    case "watermark":
      return watermark(lib, document, op, opPath);
    case "stamp":
      return stamp(lib, document, op, opPath, options);
    case "fillForm":
      return fillForm(document, op, opPath);
    case "flatten":
      return flatten(document);
    case "setMetadata":
      return setMetadata(document, op, opPath);
    default:
      throw new Error(`${kind} is not implemented`);
  }
}

/**
 * Reads a page selector.
 *
 * Everything a caller sends is one-based, because that is what inspect reports
 * and what a person sees in a reader. It becomes zero-based exactly once, here.
 */
function pageIndexes(
  op: Record<string, unknown>,
  field: string,
  count: number,
  opPath: string,
  fallbackAll = false,
): number[] {
  const value = op[field];
  if (value === undefined && fallbackAll) return Array.from({ length: count }, (_, index) => index);
  if (!Array.isArray(value)) {
    throw new Error(`${opPath}.${field} must be an array of page numbers, starting at 1`);
  }
  const indexes = value.map((entry) => {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 1 || entry > count) {
      throw new Error(`${opPath}.${field} has ${String(entry)}; the document has ${count} pages`);
    }
    return entry - 1;
  });
  if (indexes.length === 0) throw new Error(`${opPath}.${field} must name at least one page`);
  return indexes;
}

function workspacePath(relative: string, options: PdfEditOptions, opPath: string): string {
  const absolute = path.resolve(options.workspaceRoot, relative);
  const root = path.resolve(options.workspaceRoot);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new Error(`${opPath} ${relative} is outside the workspace`);
  }
  return absolute;
}

async function merge(
  lib: PdfLib,
  document: PdfLibDocument,
  op: Record<string, unknown>,
  opPath: string,
  options: PdfEditOptions,
): Promise<PdfLibDocument> {
  const files = op.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`${opPath}.files must be an array of workspace-relative PDF paths`);
  }
  const fs = await import("node:fs");
  for (const [index, entry] of files.entries()) {
    if (typeof entry !== "string") throw new Error(`${opPath}.files[${index}] must be a string`);
    const absolute = workspacePath(entry, options, `${opPath}.files[${index}]`);
    const other = await lib.PDFDocument.load(fs.readFileSync(absolute), { throwOnInvalidObject: false });
    const copied = await document.copyPages(other, other.getPageIndices());
    for (const page of copied) document.addPage(page);
  }
  return document;
}

async function extractPages(
  lib: PdfLib,
  document: PdfLibDocument,
  op: Record<string, unknown>,
  opPath: string,
): Promise<Outcome> {
  const indexes = pageIndexes(op, "pages", document.getPageCount(), opPath);
  const extracted = await lib.PDFDocument.create();
  const copied = await extracted.copyPages(document, indexes);
  for (const page of copied) extracted.addPage(page);
  return { document: extracted, summary: `extractPages ${indexes.length}` };
}

function deletePages(document: PdfLibDocument, op: Record<string, unknown>, opPath: string): Outcome {
  const indexes = pageIndexes(op, "pages", document.getPageCount(), opPath);
  if (indexes.length >= document.getPageCount()) {
    throw new Error("a PDF must keep at least one page");
  }
  // Removed high-to-low, so each removal does not shift the indexes still to
  // come — the classic off-by-one in every page-deletion routine.
  for (const index of [...new Set(indexes)].sort((left, right) => right - left)) {
    document.removePage(index);
  }
  return { document, summary: `deletePages ${indexes.length}` };
}

async function reorder(
  lib: PdfLib,
  document: PdfLibDocument,
  op: Record<string, unknown>,
  opPath: string,
): Promise<Outcome> {
  const count = document.getPageCount();
  const indexes = pageIndexes(op, "order", count, opPath);
  if (indexes.length !== count || new Set(indexes).size !== count) {
    throw new Error(`${opPath}.order must list every one of the ${count} pages exactly once`);
  }
  const reordered = await lib.PDFDocument.create();
  const copied = await reordered.copyPages(document, indexes);
  for (const page of copied) reordered.addPage(page);
  return { document: reordered, summary: "reorder" };
}

function rotate(
  lib: PdfLib,
  document: PdfLibDocument,
  op: Record<string, unknown>,
  opPath: string,
): Outcome {
  const angle = op.angle;
  if (angle !== 90 && angle !== 180 && angle !== 270 && angle !== -90) {
    throw new Error(`${opPath}.angle must be 90, 180, 270, or -90`);
  }
  const indexes = pageIndexes(op, "pages", document.getPageCount(), opPath, true);
  for (const index of indexes) {
    const page = document.getPage(index);
    // Rotation accumulates: a caller asking to rotate twice means twice.
    page.setRotation(lib.degrees((page.getRotation().angle + Number(angle) + 360) % 360));
  }
  return { document, summary: `rotate ${indexes.length} page${indexes.length === 1 ? "" : "s"}` };
}

function insertBlank(document: PdfLibDocument, op: Record<string, unknown>, opPath: string): Outcome {
  const count = document.getPageCount();
  const at = op.at === undefined ? count + 1 : op.at;
  if (typeof at !== "number" || !Number.isInteger(at) || at < 1 || at > count + 1) {
    throw new Error(`${opPath}.at must be a position from 1 to ${count + 1}`);
  }
  // The new page matches the one it follows, so a blank inserted into a
  // landscape document is landscape.
  const reference = document.getPage(Math.min(at - 1, count - 1));
  const size = reference.getSize();
  document.insertPage(at - 1, [size.width, size.height]);
  return { document, summary: `insertBlank at ${at}` };
}

async function split(
  lib: PdfLib,
  document: PdfLibDocument,
  op: Record<string, unknown>,
  opPath: string,
  options: PdfEditOptions,
): Promise<Outcome> {
  const every = op.every ?? 1;
  if (typeof every !== "number" || !Number.isInteger(every) || every < 1) {
    throw new Error(`${opPath}.every must be a positive whole number of pages per part`);
  }
  if (!options.outDirectory) {
    throw new Error("split needs an out directory; send out as a folder path");
  }
  const count = document.getPageCount();
  const extra: PdfEditExtraOutput[] = [];
  for (let start = 0; start < count; start += every) {
    const indexes = Array.from(
      { length: Math.min(every, count - start) },
      (_, offset) => start + offset,
    );
    const part = await lib.PDFDocument.create();
    const copied = await part.copyPages(document, indexes);
    for (const page of copied) part.addPage(page);
    const saved = await part.save({ useObjectStreams: false });
    const number = String(Math.floor(start / every) + 1).padStart(3, "0");
    extra.push({
      absolutePath: path.join(options.outDirectory, `part-${number}.pdf`),
      bytes: Buffer.from(saved),
    });
  }
  return { document, summary: `split into ${extra.length} parts`, extra };
}

async function watermark(
  lib: PdfLib,
  document: PdfLibDocument,
  op: Record<string, unknown>,
  opPath: string,
): Promise<Outcome> {
  const text = op.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error(`${opPath}.text must be the watermark text`);
  }
  const font = await document.embedFont(lib.StandardFonts.HelveticaBold);
  const indexes = pageIndexes(op, "pages", document.getPageCount(), opPath, true);
  const opacity = typeof op.opacity === "number" && op.opacity > 0 && op.opacity <= 1 ? op.opacity : 0.12;
  for (const index of indexes) {
    const page = document.getPage(index);
    const size = page.getSize();
    // Sized to the diagonal so one setting works on any page shape, and drawn
    // under nothing — pdf-lib appends, so it sits over the content at low
    // opacity, which is what a watermark is.
    const fontSize = Math.min(size.width, size.height) / Math.max(6, text.length * 0.55);
    const width = font.widthOfTextAtSize(text, fontSize);
    page.drawText(text, {
      x: size.width / 2 - (width / 2) * Math.cos(Math.PI / 6),
      y: size.height / 2 - (width / 2) * Math.sin(Math.PI / 6),
      size: fontSize,
      font,
      color: lib.rgb(0.45, 0.45, 0.45),
      rotate: lib.degrees(30),
      opacity,
    });
  }
  return { document, summary: `watermark ${indexes.length} page${indexes.length === 1 ? "" : "s"}` };
}

async function stamp(
  lib: PdfLib,
  document: PdfLibDocument,
  op: Record<string, unknown>,
  opPath: string,
  options: PdfEditOptions,
): Promise<Outcome> {
  const indexes = pageIndexes(op, "pages", document.getPageCount(), opPath, true);
  const corner = typeof op.corner === "string" ? op.corner : "bottom-right";
  const margin = 24;

  if (typeof op.image === "string") {
    const absolute = workspacePath(op.image, options, `${opPath}.image`);
    const image = loadImage(absolute);
    if (image.format === "gif") throw new Error(`${opPath}.image is a GIF; PDF stamps take PNG or JPEG`);
    const embedded =
      image.format === "png" ? await document.embedPng(image.bytes) : await document.embedJpg(image.bytes);
    const width = typeof op.width === "number" && op.width > 0 ? op.width : 96;
    const height = (width * embedded.height) / Math.max(1, embedded.width);
    for (const index of indexes) {
      const page = document.getPage(index);
      const position = cornerPosition(corner, page.getSize(), width, height, margin);
      page.drawImage(embedded, { ...position, width, height });
    }
    return { document, summary: `stamp image on ${indexes.length} page${indexes.length === 1 ? "" : "s"}` };
  }

  const text = op.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error(`${opPath} must have text or image`);
  }
  const font = await document.embedFont(lib.StandardFonts.Helvetica);
  const size = typeof op.size === "number" && op.size > 0 ? op.size : 9;
  for (const index of indexes) {
    const page = document.getPage(index);
    const width = font.widthOfTextAtSize(text, size);
    const position = cornerPosition(corner, page.getSize(), width, size, margin);
    page.drawText(text, { ...position, size, font, color: lib.rgb(0.35, 0.4, 0.45) });
  }
  return { document, summary: `stamp text on ${indexes.length} page${indexes.length === 1 ? "" : "s"}` };
}

function cornerPosition(
  corner: string,
  size: { width: number; height: number },
  width: number,
  height: number,
  margin: number,
): { x: number; y: number } {
  switch (corner) {
    case "top-left":
      return { x: margin, y: size.height - margin - height };
    case "top-right":
      return { x: size.width - margin - width, y: size.height - margin - height };
    case "bottom-left":
      return { x: margin, y: margin };
    default:
      return { x: size.width - margin - width, y: margin };
  }
}

function fillForm(document: PdfLibDocument, op: Record<string, unknown>, opPath: string): Outcome {
  const values = op.values;
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    throw new Error(`${opPath}.values must be an object of field names to values`);
  }
  const form = document.getForm();
  const available = form.getFields().map((field) => field.getName());
  for (const [name, value] of Object.entries(values as Record<string, unknown>)) {
    if (!available.includes(name)) {
      throw new Error(
        `the document has no field named "${name}"; inspect reports ${available.length > 0 ? available.join(", ") : "no fields"}`,
      );
    }
    if (typeof value === "boolean") {
      const box = form.getCheckBox(name);
      if (value) box.check();
      else box.uncheck();
      continue;
    }
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(`${opPath}.values.${name} must be a string, a number, or a boolean`);
    }
    form.getTextField(name).setText(String(value));
  }
  return { document, summary: `fillForm ${Object.keys(values as object).length} field(s)` };
}

function flatten(document: PdfLibDocument): Outcome {
  const form = document.getForm();
  if (form.getFields().length === 0) {
    throw new Error("the document has no form fields to flatten");
  }
  // Flattening is one-way: the values become page content and the fields are
  // gone. That is what makes a filled form safe to circulate.
  form.flatten();
  return { document, summary: "flatten" };
}

function setMetadata(document: PdfLibDocument, op: Record<string, unknown>, opPath: string): Outcome {
  let changed = 0;
  const apply = (field: string, setter: (value: string) => void) => {
    const value = op[field];
    if (value === undefined) return;
    if (typeof value !== "string") throw new Error(`${opPath}.${field} must be a string`);
    setter(value);
    changed += 1;
  };
  apply("title", (value) => document.setTitle(value));
  apply("author", (value) => document.setAuthor(value));
  apply("subject", (value) => document.setSubject(value));
  if (changed === 0) throw new Error(`${opPath} must set at least one of title, author, subject`);
  return { document, summary: `setMetadata (${changed} field${changed === 1 ? "" : "s"})` };
}

type PdfLib = {
  PDFDocument: {
    create(): Promise<PdfLibDocument>;
    load(bytes: Buffer, options?: Record<string, unknown>): Promise<PdfLibDocument>;
  };
  StandardFonts: Record<string, string>;
  rgb(r: number, g: number, b: number): unknown;
  degrees(value: number): unknown;
};

type PdfLibPage = {
  getSize(): { width: number; height: number };
  getRotation(): { angle: number };
  setRotation(value: unknown): void;
  drawText(text: string, options: Record<string, unknown>): void;
  drawImage(image: unknown, options: Record<string, unknown>): void;
};

type PdfLibDocument = {
  getPageCount(): number;
  getPage(index: number): PdfLibPage;
  getPages(): PdfLibPage[];
  getPageIndices(): number[];
  addPage(page?: unknown): PdfLibPage;
  insertPage(index: number, size: [number, number]): PdfLibPage;
  removePage(index: number): void;
  copyPages(from: PdfLibDocument, indexes: number[]): Promise<PdfLibPage[]>;
  embedFont(name: string): Promise<{ widthOfTextAtSize(text: string, size: number): number }>;
  embedPng(bytes: Buffer): Promise<{ width: number; height: number }>;
  embedJpg(bytes: Buffer): Promise<{ width: number; height: number }>;
  getForm(): {
    getFields(): Array<{ getName(): string }>;
    getTextField(name: string): { setText(value: string): void };
    getCheckBox(name: string): { check(): void; uncheck(): void };
    flatten(): void;
  };
  setTitle(value: string): void;
  setAuthor(value: string): void;
  setSubject(value: string): void;
  save(options?: Record<string, unknown>): Promise<Uint8Array>;
};
