/**
 * The engine: one job in, one result out.
 *
 * This is the whole contract between the desktop and the document code. It is
 * deliberately a pure function of a request plus the filesystem — no Electron,
 * no IPC, no sockets — so the same code runs inside the utility process in
 * production and directly inside a test.
 *
 * Writing is atomic and last. Everything that can fail — parsing, validating,
 * building, checking — happens against bytes in memory, and the destination is
 * only touched once a complete, checked file exists. That is what makes "nothing
 * is written when ok is false" true rather than aspirational.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { readDocumentSpec } from "./blocks/spec.js";
import { createDocument } from "./docx/create.js";
import { applyDocxOps } from "./docx/edit.js";
import { inspectDocument } from "./docx/inspect.js";
import {
  checkDocument,
  isStructural as isStructuralDocxFinding,
  orderFindings as orderDocxFindings,
} from "./docx/qa.js";
import { OoxmlPackage, PackageError, maxInflatedBytes } from "./package.js";
import { createPdf } from "./pdf/create.js";
import { applyPdfOps } from "./pdf/edit.js";
import { inspectPdf } from "./pdf/inspect.js";
import { createPresentation } from "./pptx/create.js";
import { applyOps } from "./pptx/edit.js";
import { inspectPresentation, type Inspection } from "./pptx/inspect.js";
import { checkPresentation, orderFindings, type QaFinding } from "./pptx/qa.js";
import { readPresentationSpec } from "./pptx/spec.js";
import { runXlsxJob } from "./xlsx/sidecar.js";

export type ArtifactRequest = {
  action: "inspect" | "create" | "edit";
  format: string;
  /** Absolute, already confined by the runner. */
  absolutePath?: string;
  absoluteOut?: string;
  /** Workspace-relative, for messages the model reads. */
  path?: string;
  out?: string;
  spec?: unknown;
  ops?: unknown[];
  options?: Record<string, unknown>;
  /** The workspace root, so spec-internal paths resolve and stay confined. */
  workspaceRoot: string;
  /** Supplied rather than read from the clock, so builds are reproducible. */
  createdAt?: string;
};

export type ArtifactSuccess = {
  ok: true;
  path: string;
  bytes: number;
  origin: "umbratic" | "foreign";
  editSurface: "full" | "surgical" | "inspect-only";
  unsupported: Array<{ kind: string; where: string }>;
  summary: string;
  qa: QaFinding[];
  outline?: unknown;
};

export type ArtifactFailure = {
  ok: false;
  kind: "validation" | "unsupported" | "runtime";
  errors: Array<{ path: string; message: string }>;
};

export type ArtifactResponse = ArtifactSuccess | ArtifactFailure;

/** QA findings carried in a result. The rest stay reachable by context hash. */
const maxReportedFindings = 25;

export async function runArtifactJob(request: ArtifactRequest): Promise<ArtifactResponse> {
  const handled = ["pptx", "docx", "pdf", "xlsx"];
  if (!handled.includes(request.format)) {
    return {
      ok: false,
      kind: "unsupported",
      errors: [
        { path: "format", message: `${request.format} is not built yet; this engine handles ${handled.join(", ")}` },
      ],
    };
  }
  // Spreadsheets go to the Rust sidecar; the other three are built here.
  if (request.format === "xlsx") {
    return runXlsxJob(request, xlsxTimeoutMs(request));
  }
  const docx = request.format === "docx";
  const pdf = request.format === "pdf";
  try {
    switch (request.action) {
      case "inspect":
        return pdf ? await inspectPdfJob(request) : docx ? await inspectDocxJob(request) : await inspectJob(request);
      case "create":
        return pdf ? await createPdfJob(request) : docx ? await createDocxJob(request) : await createJob(request);
      case "edit":
        return pdf ? await editPdfJob(request) : docx ? await editDocxJob(request) : await editJob(request);
      default:
        return {
          ok: false,
          kind: "validation",
          errors: [{ path: "action", message: `${String(request.action)} is not an action` }],
        };
    }
  } catch (error) {
    return failureFor(error);
  }
}

async function inspectJob(request: ArtifactRequest): Promise<ArtifactResponse> {
  const { pack, bytes } = await readPackage(request.absolutePath);
  const inspection = inspectPresentation(pack);
  return {
    ok: true,
    path: request.path ?? request.absolutePath ?? "",
    bytes,
    origin: inspection.origin,
    editSurface: inspection.editSurface,
    unsupported: inspection.unsupported,
    summary: summaryFor(inspection, []),
    qa: [],
    outline: inspection.outline,
  };
}

async function createJob(request: ArtifactRequest): Promise<ArtifactResponse> {
  const read = readPresentationSpec(request.spec);
  if (read.errors.length > 0) return { ok: false, kind: "validation", errors: read.errors };

  const built = createPresentation({
    spec: read.spec!,
    workspaceRoot: request.workspaceRoot,
    // A spec with no timestamp still has to produce a file; the clock is only
    // consulted when the caller declined to fix one.
    createdAt: request.createdAt ?? new Date(0).toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
  if (built.errors.length > 0) return { ok: false, kind: "validation", errors: built.errors };

  const findings = orderFindings(checkPresentation(built.pack));
  // A structural error means the file would not open. Nothing is written, and
  // the finding is returned as an error path rather than as QA on a file the
  // model would then be told exists.
  const fatal = findings.filter((finding) => finding.severity === "error" && isStructural(finding));
  if (fatal.length > 0) {
    return {
      ok: false,
      kind: "runtime",
      errors: fatal.map((finding) => ({ path: finding.where, message: finding.message })),
    };
  }
  const bytes = await built.pack.write();
  const destination = requireDestination(request.absoluteOut);
  writeAtomically(destination, bytes);

  const inspection = inspectPresentation(built.pack);
  return {
    ok: true,
    path: request.out ?? destination,
    bytes: bytes.byteLength,
    origin: inspection.origin,
    editSurface: inspection.editSurface,
    unsupported: inspection.unsupported,
    summary: summaryFor(inspection, findings),
    qa: findings.slice(0, maxReportedFindings),
  };
}

async function editJob(request: ArtifactRequest): Promise<ArtifactResponse> {
  const { pack } = await readPackage(request.absolutePath);
  const inspection = inspectPresentation(pack);
  const result = applyOps({
    pack,
    inspection,
    ops: request.ops ?? [],
    workspaceRoot: request.workspaceRoot,
  });
  if (!result.ok) return { ok: false, kind: "validation", errors: result.errors };

  const findings = orderFindings(checkPresentation(result.pack));
  const fatal = findings.filter((finding) => finding.severity === "error" && isStructural(finding));
  if (fatal.length > 0) {
    return {
      ok: false,
      kind: "runtime",
      errors: fatal.map((finding) => ({ path: finding.where, message: finding.message })),
    };
  }
  const bytes = await result.pack.write();
  const destination = requireDestination(request.absoluteOut ?? request.absolutePath);
  writeAtomically(destination, bytes);

  const after = inspectPresentation(result.pack);
  return {
    ok: true,
    path: request.out ?? request.path ?? destination,
    bytes: bytes.byteLength,
    origin: after.origin,
    editSurface: after.editSurface,
    unsupported: after.unsupported,
    summary: `${result.applied.length} op${result.applied.length === 1 ? "" : "s"} applied · ${summaryFor(after, findings)}`,
    qa: findings.slice(0, maxReportedFindings),
  };
}

/* ---------------------------------- docx ----------------------------------- */

async function inspectDocxJob(request: ArtifactRequest): Promise<ArtifactResponse> {
  const { pack, bytes } = await readPackage(request.absolutePath);
  const inspection = inspectDocument(pack, request.options?.includeContent === true);
  return {
    ok: true,
    path: request.path ?? request.absolutePath ?? "",
    bytes,
    origin: inspection.origin,
    editSurface: inspection.editSurface,
    unsupported: inspection.unsupported,
    summary: docxSummary(inspection.outline.blockCount, inspection.outline.wordCount, []),
    qa: [],
    outline: inspection.outline,
  };
}

async function createDocxJob(request: ArtifactRequest): Promise<ArtifactResponse> {
  const read = readDocumentSpec(request.spec, "docx");
  if (read.errors.length > 0) return { ok: false, kind: "validation", errors: read.errors };

  const built = createDocument({
    spec: read.spec!,
    workspaceRoot: request.workspaceRoot,
    createdAt: request.createdAt ?? new Date(0).toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
  if (built.errors.length > 0) return { ok: false, kind: "validation", errors: built.errors };

  const findings = orderDocxFindings(checkDocument(built.pack, read.spec!.preset));
  const fatal = findings.filter(
    (finding) => finding.severity === "error" && isStructuralDocxFinding(finding),
  );
  if (fatal.length > 0) {
    return {
      ok: false,
      kind: "runtime",
      errors: fatal.map((finding) => ({ path: finding.where, message: finding.message })),
    };
  }
  const bytes = await built.pack.write();
  writeAtomically(requireDestination(request.absoluteOut), bytes);

  const inspection = inspectDocument(built.pack);
  return {
    ok: true,
    path: request.out ?? requireDestination(request.absoluteOut),
    bytes: bytes.byteLength,
    origin: inspection.origin,
    editSurface: inspection.editSurface,
    unsupported: inspection.unsupported,
    summary: docxSummary(inspection.outline.blockCount, inspection.outline.wordCount, findings),
    qa: findings.slice(0, maxReportedFindings),
  };
}

async function editDocxJob(request: ArtifactRequest): Promise<ArtifactResponse> {
  const { pack } = await readPackage(request.absolutePath);
  const inspection = inspectDocument(pack);
  const options = request.options ?? {};
  const result = applyDocxOps({
    pack,
    inspection,
    ops: request.ops ?? [],
    author: typeof options.author === "string" && options.author ? options.author : "Umbratic",
    timestamp: request.createdAt ?? new Date(0).toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
  if (!result.ok) return { ok: false, kind: "validation", errors: result.errors };

  // A foreign document has no preset of its own; the checks that depend on one
  // are all width comparisons, and the default's body size is the closest
  // available guess rather than a claim about how it was written.
  const findings = orderDocxFindings(checkDocument(result.pack, "standard_business_brief"));
  const fatal = findings.filter(
    (finding) => finding.severity === "error" && isStructuralDocxFinding(finding),
  );
  if (fatal.length > 0) {
    return {
      ok: false,
      kind: "runtime",
      errors: fatal.map((finding) => ({ path: finding.where, message: finding.message })),
    };
  }
  const bytes = await result.pack.write();
  writeAtomically(requireDestination(request.absoluteOut ?? request.absolutePath), bytes);

  const after = inspectDocument(result.pack);
  return {
    ok: true,
    path: request.out ?? request.path ?? requireDestination(request.absoluteOut ?? request.absolutePath),
    bytes: bytes.byteLength,
    origin: after.origin,
    editSurface: after.editSurface,
    unsupported: after.unsupported,
    summary: `${result.applied.length} op${result.applied.length === 1 ? "" : "s"} applied · ${docxSummary(after.outline.blockCount, after.outline.wordCount, findings)}`,
    qa: findings.slice(0, maxReportedFindings),
  };
}

/* ----------------------------------- pdf ----------------------------------- */

async function inspectPdfJob(request: ArtifactRequest): Promise<ArtifactResponse> {
  const bytes = readBytes(request.absolutePath);
  const inspection = await inspectPdf(bytes);
  return {
    ok: true,
    path: request.path ?? request.absolutePath ?? "",
    bytes: bytes.byteLength,
    origin: inspection.origin,
    editSurface: inspection.editSurface,
    unsupported: inspection.unsupported,
    summary: pdfSummary(inspection.outline.pageCount, []),
    qa: [],
    outline: inspection.outline,
  };
}

async function createPdfJob(request: ArtifactRequest): Promise<ArtifactResponse> {
  const read = readDocumentSpec(request.spec, "pdf");
  if (read.errors.length > 0) return { ok: false, kind: "validation", errors: read.errors };

  const built = await createPdf({
    spec: read.spec!,
    workspaceRoot: request.workspaceRoot,
    createdAt: request.createdAt ?? new Date(0).toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
  if (built.errors.length > 0) return { ok: false, kind: "validation", errors: built.errors };

  const destination = requireDestination(request.absoluteOut);
  writeAtomically(destination, built.bytes);
  const inspection = await inspectPdf(built.bytes);
  return {
    ok: true,
    path: request.out ?? destination,
    bytes: built.bytes.byteLength,
    origin: inspection.origin,
    editSurface: inspection.editSurface,
    unsupported: inspection.unsupported,
    summary: pdfSummary(built.pageCount, []),
    qa: [],
  };
}

async function editPdfJob(request: ArtifactRequest): Promise<ArtifactResponse> {
  const bytes = readBytes(request.absolutePath);
  const inspection = await inspectPdf(bytes);
  const destination = requireDestination(request.absoluteOut ?? request.absolutePath);
  const result = await applyPdfOps({
    bytes,
    inspection,
    ops: request.ops ?? [],
    workspaceRoot: request.workspaceRoot,
    outDirectory: path.dirname(destination),
  });
  if (!result.ok) return { ok: false, kind: "validation", errors: result.errors };

  writeAtomically(destination, result.bytes);
  // `split` produces more than one file; the parts are written alongside the
  // destination and named in the summary, because a caller that only heard
  // about the first one would think the rest were lost.
  for (const part of result.extra ?? []) writeAtomically(part.absolutePath, part.bytes);

  const after = await inspectPdf(result.bytes);
  const parts = (result.extra ?? []).length;
  return {
    ok: true,
    path: request.out ?? request.path ?? destination,
    bytes: result.bytes.byteLength,
    origin: after.origin,
    editSurface: after.editSurface,
    unsupported: after.unsupported,
    summary:
      `${result.applied.length} op${result.applied.length === 1 ? "" : "s"} applied · `
      + `${pdfSummary(after.outline.pageCount, [])}`
      + (parts > 0 ? ` · ${parts} extra file${parts === 1 ? "" : "s"} written` : ""),
    qa: [],
  };
}

/**
 * How long the sidecar gets.
 *
 * The runner already bounded the whole job and will stop waiting on its own;
 * this is the inner bound, kept a little shorter so a hung sidecar is reported
 * as a spreadsheet failure rather than as a silent timeout upstream.
 */
function xlsxTimeoutMs(request: ArtifactRequest): number {
  const declared = request.options?.timeoutMs;
  const requested = typeof declared === "number" && declared > 0 ? declared : 120_000;
  return Math.max(5_000, Math.min(requested, 600_000) - 2_000);
}

function pdfSummary(pages: number, findings: QaFinding[]): string {
  const errors = findings.filter((finding) => finding.severity === "error").length;
  return `${pages} page${pages === 1 ? "" : "s"} · ${errors} error${errors === 1 ? "" : "s"}, ${findings.length - errors} warnings`;
}

function readBytes(absolutePath: string | undefined): Buffer {
  if (!absolutePath) throw new PackageError("no input path was supplied");
  const stats = fs.statSync(absolutePath);
  if (stats.size > maxInflatedBytes) {
    throw new PackageError(
      `the file is ${stats.size} bytes, past the ${maxInflatedBytes}-byte limit`,
      "too-large",
    );
  }
  return fs.readFileSync(absolutePath);
}

function docxSummary(blocks: number, words: number, findings: QaFinding[]): string {
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.length - errors;
  return `${blocks} block${blocks === 1 ? "" : "s"} · ${words} words · ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`;
}

/**
 * The findings that mean the file would not open, as opposed to would not read
 * well. Only these cancel a write.
 */
function isStructural(finding: QaFinding): boolean {
  return (
    finding.kind === "missing-content-type"
    || finding.kind === "malformed-xml"
    || finding.kind === "dangling-relationship"
    || finding.kind === "missing-relationships"
    || finding.kind === "shape-without-text-body"
    || finding.kind === "invalid-color"
  );
}

async function readPackage(
  absolutePath: string | undefined,
): Promise<{ pack: OoxmlPackage; bytes: number }> {
  if (!absolutePath) throw new PackageError("no input path was supplied");
  const stats = fs.statSync(absolutePath);
  if (stats.size > maxInflatedBytes) {
    throw new PackageError(
      `the file is ${stats.size} bytes, past the ${maxInflatedBytes}-byte limit`,
      "too-large",
    );
  }
  const bytes = fs.readFileSync(absolutePath);
  return { pack: await OoxmlPackage.read(bytes), bytes: bytes.byteLength };
}

function requireDestination(absoluteOut: string | undefined): string {
  if (!absoluteOut) throw new Error("no output path was supplied");
  return absoluteOut;
}

/**
 * Writes through a sibling temporary file and renames.
 *
 * A rename within a directory is atomic on every platform this ships to, so a
 * reader either sees the old file or the new one — never a partially written
 * zip, which is what a direct write produces if the process dies mid-flush.
 */
function writeAtomically(destination: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const staged = path.join(
    path.dirname(destination),
    `.umbratic-artifact-${process.pid}-${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(staged, bytes, { flag: "wx" });
    fs.renameSync(staged, destination);
  } catch (error) {
    try {
      fs.unlinkSync(staged);
    } catch {
      // The staged file may never have been created.
    }
    throw error;
  }
}

function summaryFor(inspection: Inspection, findings: QaFinding[]): string {
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.length - errors;
  const slides = inspection.outline.slideCount;
  return `${slides} slide${slides === 1 ? "" : "s"} · ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`;
}

function failureFor(error: unknown): ArtifactFailure {
  if (error instanceof PackageError) {
    return {
      ok: false,
      kind: error.kind === "encrypted" ? "unsupported" : "runtime",
      errors: [
        {
          path: "path",
          message:
            error.kind === "encrypted"
              ? `${error.message} editSurface is inspect-only; offer to build a new file instead.`
              : error.message,
        },
      ],
    };
  }
  return {
    ok: false,
    kind: "runtime",
    errors: [{ path: "", message: String(error instanceof Error ? error.message : error) }],
  };
}
