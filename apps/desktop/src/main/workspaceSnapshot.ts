import { imageMimeType, imagePreviewDataUrl } from "./imageAttachments";
import { chatAttachmentFromRecord } from "./chatStore";
import { PdfRenderWorkerResult, RunnerPromptPart, binarySnapshotPrefix, imageAttachmentByteLimit, missingSnapshotValue, ocrDigestPromptByteLimit, pdfAttachmentByteLimit, pdfImagePageLimit, pdfImageScale, pdfRenderTimeoutMs, textAttachmentByteLimit } from "./mainRuntime";
import {
  app,
  utilityProcess,
} from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { type OcrInputKind } from "./artifactRuntime";
import { readRegularFileSync } from "./readFile";
import { attachmentContextTokens } from "./attachmentContext";
import { generateOcrDocument, writeOcrArtifacts, type OcrDocument, type OcrPageInput } from "./ocrRuntime";
import {
  isBlockedPath,
  isGeneratedRuntimePath,
} from "./policy";
import type { CapabilityProbeReport, ChatAttachment } from "./types";
import { hasSymlinkComponent, isRecord, normalizeRelativePath, pathInside, shortHash, slugify } from "./utils";
import * as appPaths from "./appPaths";

export const ignoredSnapshotDirectories = new Set([
  ".git",
  ".umbratic",
  ".venv",
  "venv",
  "node_modules",
  "dist",
  "dist-electron",
  "target",
  "build",
  "coverage",
  ".next",
  ".vite",
  ".llama-cache",
  "vendor",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
]);

export function readTextFileIfSafe(filePath: string): string | null {
  try {
    const buffer = readRegularFileSync(filePath, textAttachmentByteLimit);
    if (buffer.includes(0)) {
      return null;
    }
    return buffer.toString("utf8");
  } catch {
    return null;
  }
}

export function binarySnapshotValue(stat: fs.Stats): string {
  return `${binarySnapshotPrefix}${stat.size}:${Math.floor(stat.mtimeMs)}`;
}

export function isBinarySnapshotValue(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(binarySnapshotPrefix);
}

export function snapshotFileValue(filePath: string): string {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return missingSnapshotValue;
  } catch {
    return missingSnapshotValue;
  }
  const text = readTextFileIfSafe(filePath);
  if (text !== null) return text;
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink() ? binarySnapshotValue(stat) : missingSnapshotValue;
  } catch {
    return missingSnapshotValue;
  }
}

export function snapshotSelectedFiles(rootPath: string, files: string[]): Record<string, string> {
  const root = path.resolve(rootPath);
  const snapshot: Record<string, string> = {};
  for (const file of files) {
    const relative = normalizeRelativePath(file);
    const absolute = path.resolve(root, relative);
    if (
      !relative
      || !pathInside(root, absolute)
      || hasSymlinkComponent(root, absolute)
      || isGeneratedRuntimePath(relative)
    ) {
      continue;
    }
    snapshot[relative] = snapshotFileValue(absolute);
  }
  return snapshot;
}

export function isPdfFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".pdf";
}

export function ocrInputKindForPath(filePath: string): OcrInputKind | null {
  if (isPdfFile(filePath)) return "pdf";
  return imageMimeType(filePath) ? "image" : null;
}

export function attachmentPathHint(file: ChatAttachment): string {
  if (file.source === "chat" && typeof file.storedPath === "string" && file.storedPath.trim()) {
    return file.storedPath;
  }
  return file.path || file.name;
}

export function ocrInputKindsForAttachments(attachments: ChatAttachment[]): OcrInputKind[] {
  const kinds = new Set<OcrInputKind>();
  for (const file of attachments) {
    const kind = ocrInputKindForPath(attachmentPathHint(file));
    if (kind) kinds.add(kind);
  }
  return [...kinds];
}

export function imageDataUrlIfSafe(filePath: string): string | null {
  try {
    const mimeType = imageMimeType(filePath);
    if (!mimeType) return null;
    const buffer = readRegularFileSync(filePath, imageAttachmentByteLimit);
    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

export function isPdfRenderWorkerResult(value: unknown): value is PdfRenderWorkerResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) {
    return typeof value.error === "string";
  }
  return (
    typeof value.pageCount === "number" &&
    Number.isInteger(value.pageCount) &&
    value.pageCount >= 0 &&
    Array.isArray(value.pages) &&
    value.pages.every(
      (page) =>
        isRecord(page) &&
        typeof page.pageNumber === "number" &&
        Number.isInteger(page.pageNumber) &&
        page.pageNumber > 0 &&
        typeof page.filePath === "string",
    )
  );
}

export async function renderPdfAttachmentInWorker(filePath: string, outputDir: string, pageNumbers?: number[]): Promise<PdfRenderWorkerResult | null> {
  const workerPath = path.resolve(__dirname, "pdfRendererWorker.js");
  if (!fs.existsSync(workerPath) || typeof utilityProcess?.fork !== "function") {
    return null;
  }
  const child = utilityProcess.fork(workerPath, [], {
    cwd: path.dirname(workerPath),
    stdio: ["ignore", "pipe", "pipe"],
    serviceName: "umbratic-pdf-renderer",
  });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: PdfRenderWorkerResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      child.removeAllListeners("message");
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, pdfRenderTimeoutMs);

    child.stdout?.on("data", () => undefined);
    child.stderr?.on("data", () => undefined);
    child.once("message", (message: unknown) => {
      finish(isPdfRenderWorkerResult(message) ? message : null);
    });
    child.once("error", () => finish(null));
    child.once("exit", () => finish(null));
    child.postMessage({
      filePath,
      outputDir,
      pageLimit: pdfImagePageLimit,
      scale: pdfImageScale,
      byteLimit: pdfAttachmentByteLimit,
      ...(pageNumbers?.length ? { pageNumbers } : {}),
    });
  });
}

export async function pdfAttachmentImageParts(filePath: string, pageNumbers?: number[]): Promise<{ pageCount: number; rendered: number; parts: RunnerPromptPart[] } | null> {
  let outputDir: string | null = null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > pdfAttachmentByteLimit) {
      return null;
    }
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-pdf-"));
    const result = await renderPdfAttachmentInWorker(filePath, outputDir, pageNumbers);
    if (!result?.ok) {
      return null;
    }
    const pages = result.pages.slice().sort((left, right) => left.pageNumber - right.pageNumber);
    const parts: RunnerPromptPart[] = [];
    for (const page of pages) {
      const pagePath = path.resolve(page.filePath);
      if (!pathInside(outputDir, pagePath) || !fs.existsSync(pagePath)) {
        return null;
      }
      const png = fs.readFileSync(pagePath);
      parts.push({ type: "text", text: `PDF page ${page.pageNumber}:` });
      parts.push({ type: "image", data_url: `data:image/png;base64,${png.toString("base64")}` });
    }
    return { pageCount: result.pageCount, rendered: pages.length, parts };
  } catch {
    return null;
  } finally {
    if (outputDir) {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }
}

export type OcrAttachmentArtifactResult =
  | {
      status: "created";
      jsonPath: string;
      markdownPath: string;
      markdown: string;
      document: OcrDocument;
    }
  | { status: "missing" | "failed"; message: string };

export function ocrArtifactOutputDirectory(rootPath: string): string {
  return appPaths.workspaceOcrDirectory(app.getPath("userData"), rootPath);
}

export function ocrArtifactBaseName(label: string, document: OcrDocument, fallback: string): string {
  const stem = slugify(path.basename(label, path.extname(label)) || label);
  const sourceHash = document.source.sha256?.replace(/^sha256:/, "").slice(0, 12) || shortHash(fallback);
  return `${stem}-${sourceHash}`;
}

export function ocrPromptDigest(markdown: string): string {
  if (Buffer.byteLength(markdown, "utf8") <= ocrDigestPromptByteLimit) return markdown.trim();
  const buffer = Buffer.from(markdown, "utf8").subarray(0, ocrDigestPromptByteLimit);
  return `${buffer.toString("utf8").trimEnd()}\n\n...(OCR digest truncated for prompt size; full OCR artifact is saved locally)`;
}

export function relativeArtifactPath(rootPath: string, artifactPath: string): string {
  const resolved = path.resolve(artifactPath);
  return pathInside(rootPath, resolved) ? normalizeRelativePath(path.relative(rootPath, resolved)) : path.basename(resolved);
}

export async function ocrAttachmentArtifact(
  rootPath: string,
  label: string,
  sourcePath: string,
  kind: OcrInputKind,
  capabilityReport: CapabilityProbeReport,
): Promise<OcrAttachmentArtifactResult> {
  const engineProbe = capabilityReport.probes.find((probe) => probe.id === "tesseract");
  if (engineProbe?.status !== "available") {
    return { status: "missing", message: "Local OCR engine is unavailable; no OCR artifact was generated." };
  }

  let outputDir: string | null = null;
  try {
    const pages: OcrPageInput[] = [];
    let sourcePageCount: number | undefined;
    if (kind === "pdf") {
      outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-ocr-pdf-"));
      const rendered = await renderPdfAttachmentInWorker(sourcePath, outputDir);
      if (!rendered?.ok) {
        return { status: "failed", message: "PDF pages could not be rendered for local OCR." };
      }
      sourcePageCount = rendered.pageCount;
      for (const page of rendered.pages.slice().sort((left, right) => left.pageNumber - right.pageNumber)) {
        const pagePath = path.resolve(page.filePath);
        if (!pathInside(outputDir, pagePath) || !fs.existsSync(pagePath)) {
          return { status: "failed", message: "Rendered PDF page was not available for local OCR." };
        }
        pages.push({ pageNumber: page.pageNumber, imagePath: pagePath });
      }
    } else {
      pages.push({ pageNumber: 1, imagePath: sourcePath });
      sourcePageCount = 1;
    }

    const document = await generateOcrDocument({
      sourcePath,
      pathLabel: label,
      kind,
      sourcePageCount,
      pages,
      engine: {
        id: "tesseract",
        command: engineProbe.detectedCommand ?? "tesseract",
        engineVersion: engineProbe.version,
      },
      pageLimit: kind === "pdf" ? pdfImagePageLimit : 1,
      imageScale: kind === "pdf" ? pdfImageScale : undefined,
    });
    const artifactDirectory = ocrArtifactOutputDirectory(rootPath);
    const fileBase = ocrArtifactBaseName(label, document, `${sourcePath}:${Date.now()}`);
    const artifactPaths = writeOcrArtifacts(document, artifactDirectory, fileBase);
    return {
      status: "created",
      jsonPath: artifactPaths.jsonPath,
      markdownPath: artifactPaths.markdownPath,
      markdown: fs.readFileSync(artifactPaths.markdownPath, "utf8"),
      document,
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { status: "failed", message: message.replace(/\s+/g, " ").trim().slice(0, 240) || "Local OCR failed." };
  } finally {
    if (outputDir) {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }
}

export function snapshotFolder(rootPath: string): Record<string, string> {
  const root = path.resolve(rootPath);
  const snapshot: Record<string, string> = {};
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = normalizeRelativePath(path.relative(root, absolute));
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!ignoredSnapshotDirectories.has(entry.name) && !isGeneratedRuntimePath(relative)) {
          stack.push(absolute);
        }
        continue;
      }
      if (!entry.isFile() || isGeneratedRuntimePath(relative) || hasSymlinkComponent(root, absolute)) {
        continue;
      }
      const text = readTextFileIfSafe(absolute);
      if (text !== null) {
        snapshot[relative] = text;
        continue;
      }
      try {
        const stat = fs.lstatSync(absolute);
        if (stat.isFile() && !stat.isSymbolicLink()) {
          snapshot[relative] = binarySnapshotValue(stat);
        }
      } catch {
        /* Ignore files that disappear while the snapshot is being collected. */
      }
    }
  }
  return snapshot;
}

export function sanitizeAttachments(input: unknown, rootPath: string, chatIdValue: string): ChatAttachment[] {
  if (!Array.isArray(input)) return [];
  const root = path.resolve(rootPath);
  const seen = new Set<string>();
  const files: ChatAttachment[] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    const chatAttachment = chatAttachmentFromRecord(item, chatIdValue);
    if (chatAttachment) {
      const key = `chat:${chatAttachment.storedPath}`;
      if (!seen.has(key)) {
        seen.add(key);
        files.push(chatAttachment);
      }
      if (files.length >= 16) break;
      continue;
    }
    const rawPath = typeof item.path === "string" ? item.path.trim() : "";
    if (!rawPath) continue;
    const absolute = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(root, normalizeRelativePath(rawPath));
    if (!pathInside(root, absolute) || !fs.existsSync(absolute)) continue;
    const relative = normalizeRelativePath(path.relative(root, absolute));
    if (!relative || isGeneratedRuntimePath(relative) || isBlockedPath(relative) || seen.has(relative)) continue;
    const name =
      typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 120) : path.basename(relative);
    seen.add(relative);
    const isFolder = fs.statSync(absolute).isDirectory();
    files.push({
      path: relative,
      name,
      kind: isFolder ? "folder" : "file",
      source: "workspace",
      previewDataUrl: isFolder ? undefined : imagePreviewDataUrl(absolute),
      contextTokens: isFolder ? undefined : attachmentContextTokens(absolute),
    });
    if (files.length >= 16) break;
  }
  return files;
}
