/**
 * The two bookkeeping parts every OOXML package has: `[Content_Types].xml` and
 * the `.rels` files.
 *
 * They are handled together because they fail together. A part added without a
 * content-type override, or referenced without a relationship, produces the
 * same symptom — PowerPoint offers to repair the file — and the structural
 * check that catches it has to read both.
 */

import { OoxmlPackage, relationshipPartFor, resolveRelativePart } from "./package.js";
import { attribute, element, findElements, parseXml, serializeDocument } from "./xml.js";

export const relationshipNamespace =
  "http://schemas.openxmlformats.org/package/2006/relationships";

export type Relationship = {
  id: string;
  type: string;
  target: string;
  /** Present and "External" for hyperlinks and linked media. */
  targetMode?: string;
};

export const relationshipTypes = {
  officeDocument:
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  coreProperties:
    "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
  extendedProperties:
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties",
  customProperties:
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties",
  slide: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide",
  slideMaster: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster",
  slideLayout: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout",
  notesSlide: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide",
  notesMaster: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster",
  theme: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme",
  image: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
  chart: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart",
  hyperlink: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
} as const;

export function readRelationships(pack: OoxmlPackage, partName: string): Relationship[] {
  const xml = pack.text(relationshipPartFor(partName));
  if (!xml) return [];
  return findElements(parseXml(xml), "Relationship").map((node) => {
    const targetMode = attribute(node, "TargetMode");
    return {
      id: attribute(node, "Id") ?? "",
      type: attribute(node, "Type") ?? "",
      target: attribute(node, "Target") ?? "",
      ...(targetMode ? { targetMode } : {}),
    };
  });
}

export function writeRelationships(
  pack: OoxmlPackage,
  partName: string,
  relationships: Relationship[],
): void {
  const root = element(
    "Relationships",
    { xmlns: relationshipNamespace },
    relationships.map((relationship) =>
      element("Relationship", {
        Id: relationship.id,
        Type: relationship.type,
        Target: relationship.target,
        ...(relationship.targetMode ? { TargetMode: relationship.targetMode } : {}),
      }),
    ),
  );
  pack.set(relationshipPartFor(partName), serializeDocument(root));
}

/** The next free `rIdN` for a part, so an added relationship cannot collide. */
export function nextRelationshipId(relationships: Relationship[]): string {
  let highest = 0;
  for (const relationship of relationships) {
    const match = /^rId(\d+)$/.exec(relationship.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `rId${highest + 1}`;
}

/** The package part a relationship points at, or undefined when external. */
export function relationshipTarget(
  fromPart: string,
  relationship: Relationship,
): string | undefined {
  if (relationship.targetMode === "External") return undefined;
  return resolveRelativePart(fromPart, relationship.target);
}

export type ContentTypes = {
  /** Extension (lowercase, no dot) → content type. */
  defaults: Map<string, string>;
  /** Absolute part name with leading slash → content type. */
  overrides: Map<string, string>;
};

export function readContentTypes(pack: OoxmlPackage): ContentTypes {
  const xml = pack.text("[Content_Types].xml");
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  if (!xml) return { defaults, overrides };
  const document = parseXml(xml);
  for (const node of findElements(document, "Default")) {
    const extension = attribute(node, "Extension")?.toLowerCase();
    const type = attribute(node, "ContentType");
    if (extension && type) defaults.set(extension, type);
  }
  for (const node of findElements(document, "Override")) {
    const partName = attribute(node, "PartName");
    const type = attribute(node, "ContentType");
    if (partName && type) overrides.set(partName, type);
  }
  return { defaults, overrides };
}

export function writeContentTypes(pack: OoxmlPackage, types: ContentTypes): void {
  const root = element(
    "Types",
    { xmlns: "http://schemas.openxmlformats.org/package/2006/content-types" },
    [
      ...[...types.defaults.entries()]
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([extension, type]) =>
          element("Default", { Extension: extension, ContentType: type }),
        ),
      ...[...types.overrides.entries()]
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([partName, type]) =>
          element("Override", { PartName: partName, ContentType: type }),
        ),
    ],
  );
  pack.set("[Content_Types].xml", serializeDocument(root));
}

/** The content type a part resolves to, override first, then extension. */
export function contentTypeOf(types: ContentTypes, partName: string): string | undefined {
  const override = types.overrides.get(`/${partName}`);
  if (override) return override;
  const extension = partName.includes(".")
    ? partName.slice(partName.lastIndexOf(".") + 1).toLowerCase()
    : "";
  return types.defaults.get(extension);
}
