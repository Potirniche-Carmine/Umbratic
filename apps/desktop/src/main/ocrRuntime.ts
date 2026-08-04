import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type OcrSourceKind = "image" | "pdf";
export type OcrEngineId = "tesseract" | "none";

export type OcrWarning =
  | { code: "page_limit_reached"; message: string }
  | { code: "low_confidence"; message: string }
  | { code: "multi_column_suspected"; message: string }
  | { code: "engine_missing"; message: string }
  | { code: "render_failed"; message: string };

export type OcrLine = {
  order: number;
  text: string;
  confidence: number;
  polygon: Array<[number, number]>;
  bbox: [number, number, number, number];
  lowConfidence?: boolean;
};

export type OcrPage = {
  pageNumber: number;
  width: number;
  height: number;
  text: string;
  lines: OcrLine[];
};

export type OcrDocument = {
  source: {
    pathLabel: string;
    kind: OcrSourceKind;
    sha256?: string;
    pageCount?: number;
  };
  engine: {
    id: OcrEngineId;
    engineVersion?: string;
    model?: string;
    localOnly: true;
  };
  settings: {
    pageLimit: number;
    imageScale?: number;
    textDetThresh?: number;
    textDetBoxThresh?: number;
    textDetUnclipRatio?: number;
    textRecScoreThresh: number;
  };
  pages: OcrPage[];
  warnings: OcrWarning[];
  metrics: {
    totalMs: number;
    renderedPages?: number;
    detectedBoxes: number;
    recognizedLines: number;
    averageConfidence?: number;
  };
};

export type OcrPageInput = {
  pageNumber: number;
  imagePath: string;
  width?: number;
  height?: number;
};

type ExecFileLike = (
  file: string,
  args: string[],
  options: Record<string, unknown>,
  callback: (
    error: (Error & { code?: string | number; signal?: NodeJS.Signals; killed?: boolean }) | null,
    stdout: string | Buffer,
    stderr: string | Buffer,
  ) => void,
) => unknown;

type TesseractEngineInput =
  | {
      id: "tesseract";
      command?: string;
      engineVersion?: string;
      model?: string;
    }
  | { id: "none"; engineVersion?: string; model?: string };

export type GenerateOcrDocumentInput = {
  sourcePath: string;
  pathLabel: string;
  kind: OcrSourceKind;
  sourcePageCount?: number;
  pages: OcrPageInput[];
  engine: TesseractEngineInput;
  pageLimit: number;
  imageScale?: number;
  textRecScoreThresh?: number;
  timeoutMs?: number;
  now?: () => number;
  execFile?: ExecFileLike;
};

export type OcrArtifactPaths = {
  jsonPath: string;
  markdownPath: string;
};

type ExecOutcome = {
  ok: boolean;
  stdout: string;
  stderr: string;
  errorMessage?: string;
};

type OcrWord = {
  key: string;
  text: string;
  confidence: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
};

const defaultTextRecScoreThresh = 0.5;
const defaultTesseractTimeoutMs = 20000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizedConfidence(value: number): number {
  return clamp(value / 100, 0, 1);
}

function compactMessage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 240) || undefined;
}

function normalizeOutput(value: string | Buffer): string {
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

async function runExecFile(
  file: string,
  args: string[],
  options: Pick<GenerateOcrDocumentInput, "execFile" | "timeoutMs">,
): Promise<ExecOutcome> {
  const execFileImpl = options.execFile ?? (execFile as unknown as ExecFileLike);
  return new Promise((resolve) => {
    execFileImpl(
      file,
      args,
      {
        timeout: options.timeoutMs ?? defaultTesseractTimeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdoutValue, stderrValue) => {
        const stdout = normalizeOutput(stdoutValue);
        const stderr = normalizeOutput(stderrValue);
        if (!error) {
          resolve({ ok: true, stdout, stderr });
          return;
        }
        resolve({
          ok: false,
          stdout,
          stderr,
          errorMessage: compactMessage(error.message) ?? compactMessage(stderr) ?? "OCR engine failed.",
        });
      },
    );
  });
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  return buffer[offset] + (buffer[offset + 1] << 8) + (buffer[offset + 2] << 16);
}

function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24 || buffer.toString("hex", 0, 8) !== "89504e470d0a1a0a") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function gifDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 10 || !["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) return null;
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function jpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 < buffer.length) {
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && offset + 7 <= buffer.length) {
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return null;
}

function webpDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
    return null;
  }
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X" && buffer.length >= 30) {
    return { width: readUInt24LE(buffer, 24) + 1, height: readUInt24LE(buffer, 27) + 1 };
  }
  if (chunk === "VP8 " && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
    const width = 1 + (((buffer[22] & 0x3f) << 8) | buffer[21]);
    const height = 1 + (((buffer[24] & 0x0f) << 10) | (buffer[23] << 2) | ((buffer[22] & 0xc0) >> 6));
    return { width, height };
  }
  return null;
}

export function imageDimensionsFromBuffer(buffer: Buffer): { width: number; height: number } | null {
  return pngDimensions(buffer) ?? jpegDimensions(buffer) ?? gifDimensions(buffer) ?? webpDimensions(buffer);
}

export function imageDimensions(filePath: string): { width: number; height: number } | null {
  try {
    return imageDimensionsFromBuffer(fs.readFileSync(filePath));
  } catch {
    return null;
  }
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function sortLinesForReadingOrder(lines: OcrLine[]): OcrLine[] {
  const rowTolerance = Math.max(8, median(lines.map((line) => Math.max(1, line.bbox[3] - line.bbox[1]))) * 0.75);
  return lines
    .slice()
    .sort((left, right) => {
      const yDelta = left.bbox[1] - right.bbox[1];
      if (Math.abs(yDelta) <= rowTolerance) return left.bbox[0] - right.bbox[0];
      return yDelta;
    })
    .map((line, index) => ({ ...line, order: index + 1 }));
}

function tsvColumns(header: string[]): Record<string, number> {
  return Object.fromEntries(header.map((name, index) => [name.trim(), index]));
}

function numberCell(columns: string[], index: number | undefined): number | null {
  if (index === undefined) return null;
  const value = Number(columns[index]);
  return Number.isFinite(value) ? value : null;
}

export function parseTesseractTsv(
  tsv: string,
  pageNumber: number,
  width: number,
  height: number,
  textRecScoreThresh = defaultTextRecScoreThresh,
): OcrLine[] {
  void pageNumber;
  const rows = tsv.split(/\r?\n/).filter((row) => row.trim());
  if (rows.length < 2) return [];
  const columnsByName = tsvColumns(rows[0].split("\t"));
  const required = ["level", "block_num", "par_num", "line_num", "left", "top", "width", "height", "conf", "text"];
  if (required.some((name) => columnsByName[name] === undefined)) return [];

  const words: OcrWord[] = [];
  for (const row of rows.slice(1)) {
    const columns = row.split("\t");
    const level = numberCell(columns, columnsByName.level);
    if (level !== null && level !== 5) continue;
    const text = (columns[columnsByName.text] ?? "").trim();
    if (!text) continue;
    const confidence = numberCell(columns, columnsByName.conf);
    if (confidence === null || confidence < 0) continue;
    const left = numberCell(columns, columnsByName.left);
    const top = numberCell(columns, columnsByName.top);
    const wordWidth = numberCell(columns, columnsByName.width);
    const wordHeight = numberCell(columns, columnsByName.height);
    if (left === null || top === null || wordWidth === null || wordHeight === null || wordWidth <= 0 || wordHeight <= 0) continue;
    const block = columns[columnsByName.block_num] ?? "0";
    const paragraph = columns[columnsByName.par_num] ?? "0";
    const line = columns[columnsByName.line_num] ?? "0";
    words.push({
      key: `${block}:${paragraph}:${line}`,
      text,
      confidence,
      left,
      top,
      right: left + wordWidth,
      bottom: top + wordHeight,
    });
  }

  const groups = new Map<string, OcrWord[]>();
  for (const word of words) {
    groups.set(word.key, [...(groups.get(word.key) ?? []), word]);
  }

  const lines: OcrLine[] = [];
  for (const groupWords of groups.values()) {
    const text = groupWords.map((word) => word.text).join(" ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const left = clamp(Math.min(...groupWords.map((word) => word.left)), 0, width);
    const top = clamp(Math.min(...groupWords.map((word) => word.top)), 0, height);
    const right = clamp(Math.max(...groupWords.map((word) => word.right)), 0, width);
    const bottom = clamp(Math.max(...groupWords.map((word) => word.bottom)), 0, height);
    if (right <= left || bottom <= top) continue;
    const confidence = groupWords.reduce((total, word) => total + normalizedConfidence(word.confidence), 0) / groupWords.length;
    lines.push({
      order: 0,
      text,
      confidence,
      polygon: [
        [left, top],
        [right, top],
        [right, bottom],
        [left, bottom],
      ],
      bbox: [left, top, right, bottom],
      lowConfidence: confidence < textRecScoreThresh || undefined,
    });
  }

  return sortLinesForReadingOrder(lines);
}

function sha256File(filePath: string): string | undefined {
  try {
    return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
  } catch {
    return undefined;
  }
}

function inferredPageSize(page: OcrPageInput, lines: OcrLine[]): { width: number; height: number } {
  const dimensions = imageDimensions(page.imagePath);
  const width = page.width ?? dimensions?.width ?? Math.ceil(Math.max(0, ...lines.map((line) => line.bbox[2])));
  const height = page.height ?? dimensions?.height ?? Math.ceil(Math.max(0, ...lines.map((line) => line.bbox[3])));
  return { width, height };
}

async function recognizePage(
  page: OcrPageInput,
  input: GenerateOcrDocumentInput,
  warnings: OcrWarning[],
): Promise<OcrPage> {
  const preflightSize = inferredPageSize(page, []);
  if (input.engine.id === "none") {
    warnings.push({ code: "engine_missing", message: "No local OCR engine is available for this attachment." });
    return { pageNumber: page.pageNumber, width: preflightSize.width, height: preflightSize.height, text: "", lines: [] };
  }

  const args = [page.imagePath, "stdout"];
  if (input.engine.model) args.push("-l", input.engine.model);
  args.push("--psm", "6", "tsv");
  const result = await runExecFile(input.engine.command ?? "tesseract", args, input);
  if (!result.ok) {
    warnings.push({
      code: "render_failed",
      message: `OCR failed for page ${page.pageNumber}: ${result.errorMessage ?? "engine returned an error"}`,
    });
    return { pageNumber: page.pageNumber, width: preflightSize.width, height: preflightSize.height, text: "", lines: [] };
  }

  const size = inferredPageSize(page, []);
  const lines = parseTesseractTsv(result.stdout, page.pageNumber, size.width, size.height, input.textRecScoreThresh ?? defaultTextRecScoreThresh);
  return {
    pageNumber: page.pageNumber,
    width: size.width,
    height: size.height,
    text: lines.map((line) => line.text).join("\n"),
    lines,
  };
}

function addQualityWarnings(pages: OcrPage[], warnings: OcrWarning[]) {
  const lowConfidenceLines = pages.flatMap((page) => page.lines.filter((line) => line.lowConfidence).map((line) => ({ page, line })));
  if (lowConfidenceLines.length) {
    warnings.push({
      code: "low_confidence",
      message: `${lowConfidenceLines.length} OCR line${lowConfidenceLines.length === 1 ? "" : "s"} fell below the confidence threshold.`,
    });
  }

  for (const page of pages) {
    if (page.lines.length < 8 || page.width <= 0) continue;
    const leftColumn = page.lines.filter((line) => line.bbox[2] < page.width * 0.58);
    const rightColumn = page.lines.filter((line) => line.bbox[0] > page.width * 0.38);
    const overlappingRows = leftColumn.filter((left) =>
      rightColumn.some((right) => Math.min(left.bbox[3], right.bbox[3]) - Math.max(left.bbox[1], right.bbox[1]) > 0),
    );
    if (leftColumn.length >= 3 && rightColumn.length >= 3 && overlappingRows.length >= 2) {
      warnings.push({
        code: "multi_column_suspected",
        message: `Page ${page.pageNumber} may contain multiple columns or table-like layout; simple reading order may need review.`,
      });
    }
  }
}

export async function generateOcrDocument(input: GenerateOcrDocumentInput): Promise<OcrDocument> {
  const startedAt = input.now?.() ?? Date.now();
  const pageLimit = Math.max(1, Math.floor(input.pageLimit));
  const selectedPages = input.pages.slice(0, pageLimit);
  const warnings: OcrWarning[] = [];
  if (input.sourcePageCount && selectedPages.length < input.sourcePageCount) {
    warnings.push({
      code: "page_limit_reached",
      message: `Processed ${selectedPages.length} of ${input.sourcePageCount} page${input.sourcePageCount === 1 ? "" : "s"}.`,
    });
  }

  const pages: OcrPage[] = [];
  for (const page of selectedPages) {
    pages.push(await recognizePage(page, input, warnings));
  }
  addQualityWarnings(pages, warnings);

  const allLines = pages.flatMap((page) => page.lines);
  const averageConfidence = allLines.length
    ? allLines.reduce((total, line) => total + line.confidence, 0) / allLines.length
    : undefined;
  return {
    source: {
      pathLabel: input.pathLabel,
      kind: input.kind,
      sha256: sha256File(input.sourcePath),
      pageCount: input.sourcePageCount,
    },
    engine: {
      id: input.engine.id,
      engineVersion: input.engine.engineVersion,
      model: input.engine.model,
      localOnly: true,
    },
    settings: {
      pageLimit,
      imageScale: input.imageScale,
      textRecScoreThresh: input.textRecScoreThresh ?? defaultTextRecScoreThresh,
    },
    pages,
    warnings,
    metrics: {
      totalMs: Math.max(0, Math.round((input.now?.() ?? Date.now()) - startedAt)),
      renderedPages: input.kind === "pdf" ? selectedPages.length : undefined,
      detectedBoxes: allLines.length,
      recognizedLines: allLines.length,
      averageConfidence,
    },
  };
}

function markdownNumber(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

function inlineCode(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim().slice(0, 180).replace(/`/g, "'");
  return `\`${compact || "(empty)"}\``;
}

export function ocrDocumentToMarkdown(document: OcrDocument): string {
  const processed = document.pages.length;
  const total = document.source.pageCount ?? processed;
  const lines = [
    `# OCR: ${document.source.pathLabel}`,
    "",
    `> Source: ${document.source.pathLabel}`,
    `> Engine: ${document.engine.id}, local only`,
    `> Pages processed: ${processed} of ${total}`,
    `> Average confidence: ${markdownNumber(document.metrics.averageConfidence)}`,
  ];
  if (document.warnings.length) {
    lines.push(`> Warnings: ${document.warnings.length}`);
  }

  for (const page of document.pages) {
    lines.push("", `## Page ${page.pageNumber}`, "", page.text.trim() || "(no text recognized)");
  }

  const lowConfidence = document.pages.flatMap((page) =>
    page.lines.filter((line) => line.lowConfidence).map((line) => ({ pageNumber: page.pageNumber, line })),
  );
  if (lowConfidence.length) {
    lines.push("", "## Low-Confidence Lines", "");
    for (const item of lowConfidence) {
      lines.push(`- Page ${item.pageNumber}, line ${item.line.order}, confidence ${item.line.confidence.toFixed(2)}: ${inlineCode(item.line.text)}`);
    }
  }

  if (document.warnings.length) {
    lines.push("", "## Warnings", "");
    for (const warning of document.warnings) {
      lines.push(`- ${warning.code}: ${warning.message}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function writeOcrArtifacts(document: OcrDocument, outputDirectory: string, fileBase: string): OcrArtifactPaths {
  fs.mkdirSync(outputDirectory, { recursive: true });
  const safeBase = fileBase.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "ocr";
  const jsonPath = path.join(outputDirectory, `${safeBase}.ocr.json`);
  const markdownPath = path.join(outputDirectory, `${safeBase}.ocr.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, ocrDocumentToMarkdown(document), "utf8");
  return { jsonPath, markdownPath };
}
