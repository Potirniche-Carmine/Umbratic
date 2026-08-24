/**
 * Deterministic checks on a finished .pptx.
 *
 * Pure functions over the package: no renderer, no screenshot, no second
 * opinion from an office suite. That constraint is what makes the results
 * trustworthy enough to loop on — every finding here is something the file
 * either does or does not contain, so a model that fixes an error and rebuilds
 * gets a different answer for a reason it can predict.
 *
 * Two severities, and the difference is whether we can prove it. An error is a
 * fact: this text needs 118% of its box, this relationship points at a part
 * that is not in the zip. A warning is a judgement: this is close to the edge,
 * this chart has a lot of slices. The repair loop fixes every error and decides
 * about warnings.
 */

import { OoxmlPackage, relationshipPartFor } from "../package.js";
import { contentTypeOf, readContentTypes, readRelationships, relationshipTarget } from "../opc.js";
import { measureText, metricsAvailable, wrapText } from "../text.js";
import {
  attribute,
  childElements,
  findElements,
  firstElement,
  localNameOf,
  parseXml,
  textOf,
} from "../xml.js";
import {
  boxIsOnSlide,
  boxesOverlap,
  emuToPoints,
  textHeightPoints,
  textWidthPoints,
  type Box,
} from "./geometry.js";
import { orderedSlideParts } from "./inspect.js";

export type QaFinding = {
  severity: "error" | "warning";
  where: string;
  kind: string;
  message: string;
  fix: string;
};

/** Line height as a multiple of type size, matching PowerPoint's default. */
const lineHeightRatio = 1.2;

export function checkPresentation(pack: OoxmlPackage): QaFinding[] {
  return [...structuralFindings(pack), ...geometryFindings(pack)];
}

/* --------------------------------- structural -------------------------------- */

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

  for (const part of orderedSlideParts(pack)) {
    if (!pack.has(relationshipPartFor(part))) {
      findings.push({
        severity: "error",
        where: part,
        kind: "missing-relationships",
        message: "the slide has no relationship part, so its layout cannot resolve",
        fix: "write the slide's .rels alongside it",
      });
    }
    findings.push(...corruptionFindings(pack, part));
  }
  return findings;
}

/**
 * The two shapes of invalid DrawingML that produce a "PowerPoint found a
 * problem" dialog rather than a visible defect.
 *
 * They are checked rather than merely avoided because avoiding them is a
 * property of today's writer, and this is what notices when that stops being
 * true.
 */
function corruptionFindings(pack: OoxmlPackage, part: string): QaFinding[] {
  const xml = pack.text(part);
  if (!xml) return [];
  const findings: QaFinding[] = [];
  let document: Document;
  try {
    document = parseXml(xml);
  } catch {
    return [];
  }
  const number = slideNumberOf(part);
  const tree = firstElement(document, "spTree");
  if (tree) {
    for (const node of childElements(tree)) {
      if (localNameOf(node) !== "sp") continue;
      const name = attribute(firstElement(node, "cNvPr"), "name") ?? "unnamed";
      if (!firstElement(node, "txBody")) {
        findings.push({
          severity: "error",
          where: `slide ${number} · ${name}`,
          kind: "shape-without-text-body",
          message: "a shape has no txBody, which PowerPoint reports as a corrupt file",
          fix: "give the shape a text body, even an empty paragraph",
        });
      }
    }
  }
  for (const node of findElements(document, "srgbClr")) {
    const value = attribute(node, "val") ?? "";
    if (!/^[0-9A-Fa-f]{6}$/.test(value)) {
      findings.push({
        severity: "error",
        where: `slide ${number}`,
        kind: "invalid-color",
        message: `srgbClr val is "${value}"; DrawingML takes exactly six hex digits with no alpha`,
        fix: "use a six-digit colour",
      });
    }
  }
  return findings;
}

function slideNumberOf(part: string): string {
  return /slide(\d+)\.xml$/.exec(part)?.[1] ?? part;
}

/* --------------------------------- geometry --------------------------------- */

function geometryFindings(pack: OoxmlPackage): QaFinding[] {
  const findings: QaFinding[] = [];
  // Without font metrics an overflow cannot be proved, only guessed at, so the
  // whole geometry pass drops to a single warning rather than producing errors
  // a model would loop on.
  const canMeasure = metricsAvailable();
  if (!canMeasure) {
    findings.push({
      severity: "warning",
      where: "package",
      kind: "no-font-metrics",
      message: "font metrics could not be read, so text fit was not checked",
      fix: "none; the file is still valid",
    });
  }

  orderedSlideParts(pack).forEach((part, index) => {
    const xml = pack.text(part);
    if (!xml) return;
    let document: Document;
    try {
      document = parseXml(xml);
    } catch {
      return;
    }
    const where = `slide ${index + 1}`;
    const tree = firstElement(document, "spTree");
    if (!tree) return;
    const placed: Array<{ name: string; box: Box }> = [];

    for (const node of childElements(tree)) {
      const tag = localNameOf(node);
      if (tag === "nvGrpSpPr" || tag === "grpSpPr") continue;
      const name = attribute(firstElement(node, "cNvPr"), "name") ?? "unnamed";
      const box = readBox(node);
      if (box) {
        placed.push({ name, box });
        if (!boxIsOnSlide(box)) {
          findings.push({
            severity: "error",
            where: `${where} · ${name}`,
            kind: "off-slide",
            message: "the shape extends past the slide edge",
            fix: "move or resize it",
          });
        }
      }
      if (canMeasure && tag === "sp" && box) {
        const overflow = textOverflow(node, box);
        if (overflow) {
          findings.push({
            severity: overflow.ratio > 1 ? "error" : "warning",
            where: `${where} · ${name}`,
            kind: "text-overflow",
            message: `the text needs ${Math.round(overflow.ratio * 100)}% of the box height`,
            fix: overflow.ratio > 1 ? "shorten the text or split the slide" : "consider shortening it",
          });
        }
      }
    }

    for (let left = 0; left < placed.length; left += 1) {
      for (let right = left + 1; right < placed.length; right += 1) {
        const a = placed[left]!;
        const b = placed[right]!;
        if (!boxesOverlap(a.box, b.box)) continue;
        findings.push({
          severity: "error",
          where: `${where} · ${a.name} and ${b.name}`,
          kind: "overlap",
          message: "two shapes occupy the same area",
          fix: "move one of them",
        });
      }
    }
  });

  findings.push(...chartFindings(pack));
  return findings;
}

function readBox(node: Element): Box | undefined {
  const transform = firstElement(node, "xfrm");
  const offset = transform ? firstElement(transform, "off") : undefined;
  const extent = transform ? firstElement(transform, "ext") : undefined;
  if (!offset || !extent) return undefined;
  const box = {
    x: Number(attribute(offset, "x") ?? 0),
    y: Number(attribute(offset, "y") ?? 0),
    width: Number(attribute(extent, "cx") ?? 0),
    height: Number(attribute(extent, "cy") ?? 0),
  };
  return Number.isFinite(box.width) && box.width > 0 ? box : undefined;
}

/**
 * Wraps every paragraph at the box width and sums the line heights.
 *
 * The size comes from each run's own `sz`, which is where the writer put it, so
 * this measures the file rather than re-deriving what the writer intended.
 */
function textOverflow(node: Element, box: Box): { ratio: number } | undefined {
  const body = firstElement(node, "txBody");
  if (!body) return undefined;
  // A box set to shrink text to fit will not overflow; it will just get small,
  // which is a judgement call rather than a defect.
  if (firstElement(body, "normAutofit")) return undefined;
  const width = textWidthPoints(box);
  const height = textHeightPoints(box);
  if (width <= 0 || height <= 0) return undefined;

  let used = 0;
  for (const paragraph of findElements(body, "p")) {
    const runs = findElements(paragraph, "r");
    const value = runs.map((run) => textOf(firstElement(run, "t"))).join("");
    const sizes = runs
      .map((run) => Number(attribute(firstElement(run, "rPr"), "sz") ?? 0) / 100)
      .filter((size) => size > 0);
    const size = sizes.length > 0 ? Math.max(...sizes) : 18;
    const bold = runs.some((run) => attribute(firstElement(run, "rPr"), "b") === "1");
    const spaceBefore =
      Number(attribute(firstElement(paragraph, "spcPts"), "val") ?? 0) / 100;
    const spacing =
      Number(attribute(firstElement(paragraph, "spcPct"), "val") ?? 0) / 1000 || 100;
    const lines = value.length === 0 ? 1 : wrapText(value, width, size, bold ? "bold" : "regular").length;
    used += spaceBefore + lines * size * lineHeightRatio * (spacing / 100);
  }
  const ratio = used / height;
  return ratio > 0.9 ? { ratio } : undefined;
}

function chartFindings(pack: OoxmlPackage): QaFinding[] {
  const findings: QaFinding[] = [];
  for (const part of pack.namesUnder("ppt/charts/chart")) {
    if (!part.endsWith(".xml")) continue;
    const xml = pack.text(part);
    if (!xml) continue;
    let document: Document;
    try {
      document = parseXml(xml);
    } catch {
      continue;
    }
    const where = part;
    const plot = firstElement(document, "plotArea");
    const plotKind = plot
      ? childElements(plot)
          .map((node) => localNameOf(node))
          .find((name) => name.endsWith("Chart"))
      : undefined;
    // Every chart except a pie needs two axis ids, and a chart that declares a
    // series against a missing axis renders as an empty frame.
    if (plotKind && plotKind !== "pieChart" && plot) {
      const axisIds = childElements(plot).filter((node) => localNameOf(node).endsWith("Ax")).length;
      if (axisIds < 2) {
        findings.push({
          severity: "error",
          where,
          kind: "chart-missing-axes",
          message: `${plotKind} declares ${axisIds} axes; it needs a category and a value axis`,
          fix: "write both axes",
        });
      }
    }
    for (const series of findElements(document, "ser")) {
      const counts = findElements(series, "ptCount").map((node) =>
        Number(attribute(node, "val") ?? 0),
      );
      if (counts.length >= 2 && counts.some((count) => count !== counts[0])) {
        findings.push({
          severity: "error",
          where,
          kind: "chart-series-mismatch",
          message: `a series has ${counts.join(" and ")} points across its category and value caches`,
          fix: "give every series one value per category",
        });
      }
    }
    if (plotKind === "pieChart") {
      const slices = Number(attribute(findElements(document, "ptCount")[0], "val") ?? 0);
      if (slices > 12) {
        findings.push({
          severity: "warning",
          where,
          kind: "too-many-slices",
          message: `${slices} slices is more than a pie reads at`,
          fix: 'group the tail into an "Other" slice',
        });
      }
    }
  }
  return findings;
}

/** Image aspect distortion, checked against the media the package embeds. */
export function imageAspectFindings(
  pack: OoxmlPackage,
  intrinsic: Map<string, { width: number; height: number }>,
): QaFinding[] {
  const findings: QaFinding[] = [];
  orderedSlideParts(pack).forEach((part, index) => {
    const xml = pack.text(part);
    if (!xml) return;
    let document: Document;
    try {
      document = parseXml(xml);
    } catch {
      return;
    }
    const relationships = new Map(readRelationships(pack, part).map((entry) => [entry.id, entry]));
    for (const node of findElements(document, "pic")) {
      const embed = firstElement(node, "blip")?.getAttribute("r:embed");
      const relationship = embed ? relationships.get(embed) : undefined;
      const target = relationship ? relationshipTarget(part, relationship) : undefined;
      const size = target ? intrinsic.get(target) : undefined;
      const box = readBox(node);
      if (!size || !box || size.width <= 0 || size.height <= 0) continue;
      const drawn = box.width / box.height;
      const natural = size.width / size.height;
      const skew = Math.abs(drawn - natural) / natural;
      if (skew > 0.02) {
        findings.push({
          severity: "warning",
          where: `slide ${index + 1} · ${attribute(firstElement(node, "cNvPr"), "name") ?? "picture"}`,
          kind: "image-aspect",
          message: `the picture is drawn at ${drawn.toFixed(2)}:1 but is ${natural.toFixed(2)}:1`,
          fix: "size the frame to the image's own ratio",
        });
      }
    }
  });
  return findings;
}

/** Sorts errors ahead of warnings without disturbing order within a severity. */
export function orderFindings(findings: QaFinding[]): QaFinding[] {
  return [...findings].sort(
    (left, right) => Number(left.severity !== "error") - Number(right.severity !== "error"),
  );
}

/** Only used by the geometry check; exported so the fit rule has one definition. */
export function linesForBox(value: string, box: Box, size: number): number {
  return wrapText(value, textWidthPoints(box), size).length;
}

/** The height one line of a given size occupies, in points. */
export function lineHeight(size: number): number {
  return size * lineHeightRatio;
}

/** Exposed so a caller can reason about a box in the same units as the checks. */
export function boxHeightPoints(box: Box): number {
  return emuToPoints(box.height);
}

/** Kept beside the checks so a caller can measure a candidate before writing it. */
export { measureText };
