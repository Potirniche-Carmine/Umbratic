/**
 * Deterministic checks on a finished .docx.
 *
 * A word processor reflows, so there is no fixed box for text to overflow —
 * which removes the PPTX engine's main geometry check and replaces it with the
 * failures a reflowing document actually has: a table column narrower than the
 * longest word it must hold, a heading with nothing under it, a table of
 * contents with no headings to list, a comment or a revision whose parts do not
 * agree.
 */

import { OoxmlPackage } from "../package.js";
import { contentTypeOf, readContentTypes, readRelationships, relationshipTarget } from "../opc.js";
import { longestWordWidth, metricsAvailable } from "../text.js";
import {
  attribute,
  childElements,
  findElements,
  firstElement,
  localNameOf,
  parseXml,
  textOf,
} from "../xml.js";
import { pageDimensions, presetFor } from "../blocks/presets.js";
import type { PresetName } from "../blocks/spec.js";
import { paragraphText } from "./inspect.js";

export type QaFinding = {
  severity: "error" | "warning";
  where: string;
  kind: string;
  message: string;
  fix: string;
};

export function checkDocument(pack: OoxmlPackage, preset: PresetName): QaFinding[] {
  return [...structuralFindings(pack), ...layoutFindings(pack, preset)];
}

function structuralFindings(pack: OoxmlPackage): QaFinding[] {
  const findings: QaFinding[] = [];
  const types = readContentTypes(pack);
  for (const name of pack.names()) {
    if (name === "[Content_Types].xml") continue;
    if (!name.endsWith(".rels") && !contentTypeOf(types, name)) {
      findings.push({
        severity: "error",
        where: name,
        kind: "missing-content-type",
        message: "the part has no content type, so the package will not open",
        fix: "declare an Override or a Default for this extension",
      });
    }
    if (name.endsWith(".xml") || name.endsWith(".rels")) {
      const xml = pack.text(name);
      if (xml === undefined) continue;
      try {
        parseXml(xml);
      } catch (error) {
        findings.push({
          severity: "error",
          where: name,
          kind: "malformed-xml",
          message: String(error instanceof Error ? error.message : error),
          fix: "rebuild the part",
        });
      }
    }
  }
  for (const name of pack.names()) {
    if (!name.endsWith(".rels")) continue;
    const owner = name === "_rels/.rels" ? "" : name.replace("_rels/", "").replace(/\.rels$/, "");
    for (const relationship of readRelationships(pack, owner || "[root]")) {
      const target = relationshipTarget(owner, relationship);
      if (!target || pack.has(target)) continue;
      findings.push({
        severity: "error",
        where: `${owner || "package"} · ${relationship.id}`,
        kind: "dangling-relationship",
        message: `points at ${target}, which is not in the package`,
        fix: "add the part or drop the relationship",
      });
    }
  }
  findings.push(...commentFindings(pack));
  findings.push(...revisionFindings(pack));
  return findings;
}

/**
 * A comment needs its body, its range, and its reference.
 *
 * Any one of them missing is a document Word offers to repair, and the op that
 * writes them is the most likely place for that to go wrong.
 */
function commentFindings(pack: OoxmlPackage): QaFinding[] {
  const commentsXml = pack.text("word/comments.xml");
  const documentXml = pack.text("word/document.xml");
  if (!commentsXml || !documentXml) return [];
  let bodies: string[];
  let starts: string[];
  let references: string[];
  try {
    bodies = findElements(parseXml(commentsXml), "comment").map((node) => attribute(node, "id") ?? "");
    const document = parseXml(documentXml);
    starts = findElements(document, "commentRangeStart").map((node) => attribute(node, "id") ?? "");
    references = findElements(document, "commentReference").map((node) => attribute(node, "id") ?? "");
  } catch {
    return [];
  }
  const findings: QaFinding[] = [];
  for (const id of bodies) {
    if (!starts.includes(id) || !references.includes(id)) {
      findings.push({
        severity: "error",
        where: `comment ${id}`,
        kind: "orphan-comment",
        message: "the comment has no anchor in the document body",
        fix: "write the range start, range end, and reference alongside the comment",
      });
    }
  }
  for (const id of starts) {
    if (!bodies.includes(id)) {
      findings.push({
        severity: "error",
        where: `comment range ${id}`,
        kind: "orphan-comment-range",
        message: "the document anchors a comment that has no body",
        fix: "add the comment to comments.xml or drop the anchor",
      });
    }
  }
  return findings;
}

/** A tracked deletion that still carries `w:t` shows as text that is not there. */
function revisionFindings(pack: OoxmlPackage): QaFinding[] {
  const xml = pack.text("word/document.xml");
  if (!xml) return [];
  let document: Document;
  try {
    document = parseXml(xml);
  } catch {
    return [];
  }
  const findings: QaFinding[] = [];
  for (const deletion of findElements(document, "del")) {
    if (findElements(deletion, "t").length > 0) {
      findings.push({
        severity: "error",
        where: `revision ${attribute(deletion, "id") ?? ""}`,
        kind: "deletion-keeps-text",
        message: "a tracked deletion contains w:t, so Word will show the deleted words as present",
        fix: "write w:delText inside a w:del",
      });
    }
    if (!attribute(deletion, "author")) {
      findings.push({
        severity: "warning",
        where: `revision ${attribute(deletion, "id") ?? ""}`,
        kind: "revision-without-author",
        message: "a revision has no author, so the margin shows it as anonymous",
        fix: "set options.author",
      });
    }
  }
  return findings;
}

function layoutFindings(pack: OoxmlPackage, presetName: PresetName): QaFinding[] {
  const xml = pack.text("word/document.xml");
  if (!xml) return [];
  let document: Document;
  try {
    document = parseXml(xml);
  } catch {
    return [];
  }
  const preset = presetFor(presetName);
  const findings: QaFinding[] = [];
  const body = firstElement(document, "body");
  const blocks = body ? childElements(body).filter((node) => localNameOf(node) !== "sectPr") : [];

  const section = firstElement(document, "sectPr");
  const pageSize = firstElement(section ?? document.documentElement as unknown as Element, "pgSz");
  const pageWidthPoints = pageSize
    ? Number(attribute(pageSize, "w") ?? 0) / 20
    : pageDimensions("Letter", "portrait").width;
  const usableWidth = Math.max(72, pageWidthPoints - preset.margin * 2);

  blocks.forEach((node, index) => {
    if (localNameOf(node) !== "tbl") return;
    findings.push(...tableFindings(node, index + 1, usableWidth, preset.body));
  });

  // A heading with no content under it is a section the model announced and
  // then did not write.
  blocks.forEach((node, index) => {
    if (localNameOf(node) !== "p") return;
    const style = attribute(firstElement(node, "pStyle"), "val") ?? "";
    if (!style.startsWith("Heading")) return;
    const next = blocks[index + 1];
    const nextStyle = next && localNameOf(next) === "p"
      ? attribute(firstElement(next, "pStyle"), "val") ?? ""
      : "";
    const empty = !next || (nextStyle.startsWith("Heading") && localNameOf(next) === "p");
    if (empty) {
      findings.push({
        severity: "warning",
        where: `"${paragraphText(node).slice(0, 60)}"`,
        kind: "empty-section",
        message: "the heading is followed by another heading with nothing between them",
        fix: "write the section or drop the heading",
      });
    }
  });

  if (/TOC \\o/.test(xml) && !blocks.some((node) =>
    (attribute(firstElement(node, "pStyle"), "val") ?? "").startsWith("Heading"),
  )) {
    findings.push({
      severity: "error",
      where: "table of contents",
      kind: "toc-without-headings",
      message: "the document asks Word to build a table of contents but has no headings",
      fix: "add headings or set toc to false",
    });
  }

  const total = blocks.length;
  if (total === 0) {
    findings.push({
      severity: "error",
      where: "document",
      kind: "empty-document",
      message: "the document body has no blocks",
      fix: "write at least one block",
    });
  }
  return findings;
}

/**
 * A column narrower than its longest word.
 *
 * Word will not break inside a word, so this column will silently widen and
 * push the table past the margin — the one table failure that looks like a
 * rendering bug rather than a content problem.
 */
function tableFindings(
  table: Element,
  position: number,
  usableWidth: number,
  bodySize: number,
): QaFinding[] {
  if (!metricsAvailable()) return [];
  const findings: QaFinding[] = [];
  const grid = findElements(table, "gridCol").map((node) => Number(attribute(node, "w") ?? 0));
  const totalUnits = grid.reduce((sum, width) => sum + width, 0) || 5_000;
  const rows = findElements(table, "tr");
  const columnWidths = grid.map((width) => (width / totalUnits) * usableWidth);

  rows.forEach((row) => {
    findElements(row, "tc").forEach((cell, columnIndex) => {
      const width = columnWidths[columnIndex];
      if (!width) return;
      const text = paragraphText(cell);
      if (!text) return;
      // Cell padding is small but real; measuring against the full column width
      // would report a column as fine when it is one character short.
      const available = width - 8;
      const longest = longestWordWidth(text, bodySize);
      if (longest > available) {
        findings.push({
          severity: "warning",
          where: `table ${position} · column ${columnIndex + 1}`,
          kind: "narrow-column",
          message: `the longest word needs ${Math.round(longest)}pt but the column is ${Math.round(available)}pt`,
          fix: "widen the column, shorten the value, or drop a column",
        });
      }
    });
  });
  return dedupe(findings);
}

/** One finding per column, however many rows tripped it. */
function dedupe(findings: QaFinding[]): QaFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.kind}:${finding.where}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function orderFindings(findings: QaFinding[]): QaFinding[] {
  return [...findings].sort(
    (left, right) => Number(left.severity !== "error") - Number(right.severity !== "error"),
  );
}

/** Findings that mean the file would not open, as opposed to would not read well. */
export function isStructural(finding: QaFinding): boolean {
  return (
    finding.kind === "missing-content-type"
    || finding.kind === "malformed-xml"
    || finding.kind === "dangling-relationship"
    || finding.kind === "orphan-comment"
    || finding.kind === "orphan-comment-range"
    || finding.kind === "deletion-keeps-text"
    || finding.kind === "empty-document"
  );
}

/** Exposed so a caller can count words the same way inspect does. */
export function documentText(pack: OoxmlPackage): string {
  const xml = pack.text("word/document.xml");
  if (!xml) return "";
  try {
    return findElements(parseXml(xml), "p")
      .map((node) => paragraphText(node))
      .filter(Boolean)
      .join("\n");
  } catch {
    return "";
  }
}

/** Kept beside the checks so a caller can measure before writing. */
export { textOf };
