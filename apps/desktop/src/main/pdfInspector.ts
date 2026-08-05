import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type PdfType = "text_based" | "scanned" | "image_based" | "mixed";

export type PdfInspection = {
  pdfType: PdfType;
  pageCount: number;
  confidence: number;
  pagesNeedingOcr: number[];
  hasEncodingIssues: boolean;
  ocrRecommended: boolean;
  markdown?: string;
  estimatedTokens: number;
};

export type PdfPromptRoute =
  | { mode: "text" }
  | { mode: "mixed"; ocrPages: number[] }
  | { mode: "vision" };

/** Below this classification confidence the router falls back to page images. */
export const pdfInspectConfidenceThreshold = 0.7;

const fullInspectTimeoutMs = 20000;
const detectTimeoutMs = 8000;
const inspectOutputByteLimit = 8 * 1024 * 1024;
const contextTokenCacheLimit = 64;

const pdfTypes = new Set<PdfType>(["text_based", "scanned", "image_based", "mixed"]);

function nativePdfInspectorFilename(): string {
  return process.platform === "win32" ? "umbratic-pdf.exe" : "umbratic-pdf";
}

export function pdfInspectorBinaryPath(): string | null {
  const filename = nativePdfInspectorFilename();
  const candidates: string[] = [];
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) candidates.push(path.join(resourcesPath, "pdf", filename));
  candidates.push(path.resolve(__dirname, "../../../../target/release", filename));
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* Keep looking. */
    }
  }
  return null;
}

export function parsePdfInspection(value: unknown): PdfInspection | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const pdfType = record.pdfType;
  if (typeof pdfType !== "string" || !pdfTypes.has(pdfType as PdfType)) return null;
  const pageCount = record.pageCount;
  const confidence = record.confidence;
  const estimatedTokens = record.estimatedTokens;
  if (typeof pageCount !== "number" || !Number.isInteger(pageCount) || pageCount < 0) return null;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  if (typeof estimatedTokens !== "number" || !Number.isInteger(estimatedTokens) || estimatedTokens < 0) return null;
  if (typeof record.hasEncodingIssues !== "boolean" || typeof record.ocrRecommended !== "boolean") return null;
  if (!Array.isArray(record.pagesNeedingOcr)) return null;
  const pagesNeedingOcr = record.pagesNeedingOcr.filter(
    (page): page is number => typeof page === "number" && Number.isInteger(page) && page >= 1,
  );
  if (pagesNeedingOcr.length !== record.pagesNeedingOcr.length) return null;
  if (record.markdown !== undefined && typeof record.markdown !== "string") return null;
  return {
    pdfType: pdfType as PdfType,
    pageCount,
    confidence,
    pagesNeedingOcr,
    hasEncodingIssues: record.hasEncodingIssues,
    ocrRecommended: record.ocrRecommended,
    markdown: record.markdown as string | undefined,
    estimatedTokens,
  };
}

function parseInspectStdout(stdout: string): PdfInspection | null {
  const line = stdout.trim().split(/\r?\n/).at(-1);
  if (!line) return null;
  try {
    return parsePdfInspection(JSON.parse(line));
  } catch {
    return null;
  }
}

function inspectArguments(filePath: string, options: { full?: boolean; tokenBudget?: number; maxBytes?: number }): string[] {
  const cliArguments = ["inspect"];
  if (options.full) cliArguments.push("--full");
  if (Number.isInteger(options.tokenBudget) && (options.tokenBudget ?? 0) >= 0) {
    cliArguments.push("--token-budget", String(options.tokenBudget));
  }
  if (Number.isInteger(options.maxBytes) && (options.maxBytes ?? 0) > 0) {
    cliArguments.push("--max-bytes", String(options.maxBytes));
  }
  cliArguments.push(filePath);
  return cliArguments;
}

export type InspectPdfOptions = {
  full?: boolean;
  tokenBudget?: number;
  maxBytes?: number;
  timeoutMs?: number;
  /** Overrides binary resolution; pass null to simulate a missing inspector. */
  binaryPath?: string | null;
};

/**
 * Runs `umbratic-pdf inspect` and returns the parsed result, or null when the
 * inspector is unavailable or the PDF cannot be inspected (callers fall back
 * to the vision render path).
 */
export async function inspectPdf(filePath: string, options: InspectPdfOptions = {}): Promise<PdfInspection | null> {
  const binaryPath = options.binaryPath !== undefined ? options.binaryPath : pdfInspectorBinaryPath();
  if (!binaryPath) return null;
  const timeoutMs = options.timeoutMs ?? (options.full ? fullInspectTimeoutMs : detectTimeoutMs);
  return new Promise((resolve) => {
    const child = spawn(binaryPath, inspectArguments(filePath, options), {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    let settled = false;
    const finish = (result: PdfInspection | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < inspectOutputByteLimit) stdout += chunk.toString("utf8");
    });
    child.once("error", () => finish(null));
    child.once("exit", (code) => {
      finish(code === 0 ? parseInspectStdout(stdout) : null);
    });
  });
}

type ContextTokenCacheEntry = { mtimeMs: number; size: number; tokens: number | undefined };

const contextTokenCache = new Map<string, ContextTokenCacheEntry>();

/**
 * Synchronous route-aware token estimate for the attachment meter. Detect-only
 * inspection is fast (tens of milliseconds) and results are cached per file
 * stamp because draft updates re-report attachments frequently.
 */
export function pdfContextTokens(filePath: string, binaryPath?: string | null): number | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile()) return undefined;
  } catch {
    return undefined;
  }
  const cached = contextTokenCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.tokens;
  }
  const resolvedBinary = binaryPath !== undefined ? binaryPath : pdfInspectorBinaryPath();
  let tokens: number | undefined;
  if (resolvedBinary) {
    const result = spawnSync(resolvedBinary, inspectArguments(filePath, {}), {
      timeout: detectTimeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    });
    if (!result.error && result.status === 0) {
      tokens = parseInspectStdout(result.stdout ?? "")?.estimatedTokens;
    }
  }
  if (contextTokenCache.size >= contextTokenCacheLimit) {
    const oldest = contextTokenCache.keys().next().value;
    if (oldest !== undefined) contextTokenCache.delete(oldest);
  }
  contextTokenCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, tokens });
  return tokens;
}

export function clearPdfContextTokenCache(): void {
  contextTokenCache.clear();
}

/**
 * Classify-then-route decision for the attachment prompt: native text for
 * confident text PDFs, per-page rasterization for mixed documents, and the
 * vision render path for everything else (scans, low confidence, encoding
 * issues, or a failed inspection).
 */
export function pdfPromptRoute(inspection: PdfInspection | null, pageLimit: number): PdfPromptRoute {
  if (!inspection || inspection.hasEncodingIssues || inspection.confidence < pdfInspectConfidenceThreshold) {
    return { mode: "vision" };
  }
  if (inspection.pdfType === "text_based") return { mode: "text" };
  if (inspection.pdfType === "mixed") {
    const ocrPages = inspection.pagesNeedingOcr.filter((page) => page <= pageLimit);
    return ocrPages.length ? { mode: "mixed", ocrPages } : { mode: "text" };
  }
  return { mode: "vision" };
}
