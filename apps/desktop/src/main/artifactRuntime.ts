import type { CapabilityProbeReport } from "./types";

export type ArtifactKind = "pdf" | "docx" | "pptx" | "xlsx";
export type OcrInputKind = "image" | "pdf";

type ArtifactCapability = "available" | "missing";
type ArtifactRuntimePromptOptions = {
  ocrInputKinds?: OcrInputKind[];
};

const artifactFolders: Record<ArtifactKind, { output: string; template: string; label: string }> = {
  pdf: { output: ".umbratic/artifacts/pdf", template: ".umbratic/templates/pdf", label: "PDF" },
  docx: { output: ".umbratic/artifacts/docx", template: ".umbratic/templates/word", label: "DOCX" },
  pptx: { output: ".umbratic/artifacts/pptx", template: ".umbratic/templates/powerpoint", label: "PPTX" },
  xlsx: { output: ".umbratic/artifacts/xlsx", template: ".umbratic/templates/spreadsheets", label: "XLSX" },
};

function isAvailable(report: CapabilityProbeReport, id: string): boolean {
  return report.probes.some((probe) => probe.id === id && probe.status === "available");
}

function capability(value: boolean): ArtifactCapability {
  return value ? "available" : "missing";
}

export function promptLooksLikeArtifactTask(prompt: string): boolean {
  return /\b(pdf|docx|word document|powerpoint|pptx|presentation|deck|slides?|xlsx|excel|spreadsheet|workbook|artifact|one[-\s]?pager|report|whitepaper|white paper)\b/i.test(prompt);
}

export function promptLooksLikeOcrTask(prompt: string): boolean {
  return /\b(ocr|optical character recognition|extract text|read text|text from (?:an? )?(?:image|screenshot|scan|scanned|pdf)|transcribe|scan(?:ned)? document|screenshot text|image text|what does this say|form fields?|source-grounded extraction)\b/i.test(prompt);
}

export function artifactKindsForPrompt(prompt: string): ArtifactKind[] {
  const text = prompt.toLowerCase();
  const kinds: ArtifactKind[] = [];
  if (/\b(pdf|one[-\s]?pager|report|whitepaper|white paper)\b/.test(text)) kinds.push("pdf");
  if (/\b(docx|word document|word|memo|proposal document)\b/.test(text)) kinds.push("docx");
  if (/\b(powerpoint|pptx|presentation|deck|slides?)\b/.test(text)) kinds.push("pptx");
  if (/\b(xlsx|excel|spreadsheet|workbook|worksheet)\b/.test(text)) kinds.push("xlsx");
  return kinds;
}

function pushPdfPlan(lines: string[], report: CapabilityProbeReport) {
  const generation = capability(isAvailable(report, "py-reportlab"));
  const extraction = capability(isAvailable(report, "py-pdfplumber") || isAvailable(report, "py-pypdf"));
  const render = capability(isAvailable(report, "pdftoppm") && isAvailable(report, "pdfinfo"));
  lines.push(
    `- PDF generation with reportlab: ${generation}`,
    `- PDF extraction with pdfplumber/pypdf: ${extraction}`,
    `- PDF render/visual QA with Poppler: ${render}`,
  );
  if (render === "missing") {
    lines.push("- do not claim PDF visual QA unless Poppler render output is produced and inspected.");
  }
}

function pushOfficePlan(lines: string[], kind: Extract<ArtifactKind, "docx" | "pptx" | "xlsx">, report: CapabilityProbeReport) {
  const packageId = kind === "docx" ? "node-docx" : kind === "pptx" ? "node-pptx" : "node-xlsx";
  const runtimeLabel = kind === "docx" ? "DOCX JavaScript authoring runtime" : kind === "pptx" ? "PPTX JavaScript authoring runtime" : "XLSX JavaScript workbook runtime";
  const runtime = capability(isAvailable(report, packageId));
  const render = capability(isAvailable(report, "libreoffice"));
  lines.push(
    `- ${runtimeLabel}: ${runtime}`,
    `- LibreOffice render/export verification: ${render}`,
  );
  if (runtime === "missing") {
    lines.push(`- if ${artifactFolders[kind].label} authoring is requested and the runtime is missing, provide structured source content or state the generation gap.`);
  }
  if (render === "missing") {
    lines.push(`- do not claim ${artifactFolders[kind].label} render/export QA unless LibreOffice output is produced and inspected.`);
  }
}

function pushOcrPlan(lines: string[], report: CapabilityProbeReport, inputKinds: OcrInputKind[]) {
  const engine = capability(isAvailable(report, "tesseract"));
  const pdfRender = capability(isAvailable(report, "pdf-to-img"));
  const inputLabel = inputKinds.length ? [...new Set(inputKinds)].join(", ") : "requested inputs";
  lines.push(
    "",
    "OCR:",
    "- output folder: .umbratic/artifacts/ocr",
    `- local OCR engine (Tesseract CLI): ${engine}`,
    `- PDF page rendering for OCR attachments: ${pdfRender}`,
    `- input types in scope: ${inputLabel}`,
    "- write durable JSON and Markdown OCR digests with text, page numbers, coordinates, confidence, warnings, and timing.",
    "- keep OCR text, coordinates, image data, and debug details local; managed telemetry should stay to capability status and compact run facts.",
    "- do not use hosted OCR APIs, runtime model downloads, training, RL, or automatic learning loops.",
  );
  if (engine === "missing") {
    lines.push("- if local OCR is unavailable, do not invent OCR text; use normal image/PDF context if available or state the gap.");
  }
}

export function artifactRuntimePromptGuidance(
  report: CapabilityProbeReport,
  prompt: string,
  options: ArtifactRuntimePromptOptions = {},
): string {
  const kinds = artifactKindsForPrompt(prompt);
  const ocrInputKinds = options.ocrInputKinds ?? [];
  const includeOcr = promptLooksLikeOcrTask(prompt) || ocrInputKinds.length > 0;
  if (!kinds.length && !includeOcr) return "";

  const lines = [
    "Artifact runtime plan:",
    "- keep generated artifacts under `.umbratic/artifacts/<kind>/` unless the user asks for a specific workspace path.",
    "- use `.umbratic/templates/<kind>/` only as a local cache for server-selected templates; do not invent a template if none is supplied in protected context.",
  ];
  for (const kind of kinds) {
    const folders = artifactFolders[kind];
    lines.push("", `${folders.label}:`, `- output folder: ${folders.output}`, `- template cache folder: ${folders.template}`);
    if (kind === "pdf") {
      pushPdfPlan(lines, report);
    } else {
      pushOfficePlan(lines, kind, report);
    }
  }
  if (includeOcr) {
    pushOcrPlan(lines, report, ocrInputKinds);
  }
  return lines.join("\n");
}
