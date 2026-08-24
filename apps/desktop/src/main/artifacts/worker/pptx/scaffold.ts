/**
 * The parts of a .pptx that are not slides: content types, the presentation
 * part, one slide master, the layouts slides point at, and the document
 * properties that carry the origin stamp.
 *
 * These are written once per create and never varied by content. A deck's
 * character comes from the theme and the fixed layout geometry; nothing in here
 * is a knob the model can reach.
 */

import { OoxmlPackage } from "../package.js";
import { relationshipTypes, writeRelationships, type ContentTypes } from "../opc.js";
import { element, serializeDocument, type XmlNode } from "../xml.js";
import { slideHeight, slideWidth } from "./geometry.js";
import { drawingNamespace, presentationNamespace, shapeTree } from "./shapes.js";
import { themeXml, type ThemePalette } from "./theme.js";

/** The custom document property that says we made this file. */
export const originPropertyName = "UmbraticArtifact";

/**
 * The layouts a created deck declares.
 *
 * Slides carry explicit geometry rather than inheriting from placeholders, so
 * these exist to satisfy the format and to give a human editing the deck
 * afterwards something sane to pick from — not to position anything.
 */
export const layoutDefinitions = [
  { name: "Title Slide", type: "title" },
  { name: "Title and Content", type: "obj" },
  { name: "Section Header", type: "secHead" },
  { name: "Two Content", type: "twoObj" },
  { name: "Blank", type: "blank" },
] as const;

export type LayoutName = (typeof layoutDefinitions)[number]["name"];

const namespaces = {
  "xmlns:a": drawingNamespace,
  "xmlns:r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "xmlns:p": presentationNamespace,
};

export function baseContentTypes(): ContentTypes {
  return {
    defaults: new Map([
      ["rels", "application/vnd.openxmlformats-package.relationships+xml"],
      ["xml", "application/xml"],
      ["png", "image/png"],
      ["jpeg", "image/jpeg"],
      ["jpg", "image/jpeg"],
      ["gif", "image/gif"],
    ]),
    overrides: new Map([
      ["/ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"],
      ["/ppt/slideMasters/slideMaster1.xml", "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"],
      ["/ppt/theme/theme1.xml", "application/vnd.openxmlformats-officedocument.theme+xml"],
      ["/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"],
      ["/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml"],
      ["/docProps/custom.xml", "application/vnd.openxmlformats-officedocument.custom-properties+xml"],
    ]),
  };
}

export const slideContentType =
  "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
export const slideLayoutContentType =
  "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml";
export const notesSlideContentType =
  "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml";
export const chartContentType =
  "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";

export type ScaffoldOptions = {
  palette: ThemePalette;
  title: string;
  author: string;
  slideCount: number;
  /** ISO timestamp. Supplied rather than read from the clock so two identical
   *  specs produce two identical files. */
  createdAt: string;
};

export function writeScaffold(pack: OoxmlPackage, options: ScaffoldOptions): void {
  pack.set(
    "_rels/.rels",
    serializeDocument(
      element("Relationships", { xmlns: "http://schemas.openxmlformats.org/package/2006/relationships" }, [
        element("Relationship", {
          Id: "rId1",
          Type: relationshipTypes.officeDocument,
          Target: "ppt/presentation.xml",
        }),
        element("Relationship", {
          Id: "rId2",
          Type: relationshipTypes.coreProperties,
          Target: "docProps/core.xml",
        }),
        element("Relationship", {
          Id: "rId3",
          Type: relationshipTypes.extendedProperties,
          Target: "docProps/app.xml",
        }),
        element("Relationship", {
          Id: "rId4",
          Type: relationshipTypes.customProperties,
          Target: "docProps/custom.xml",
        }),
      ]),
    ),
  );

  pack.set("ppt/theme/theme1.xml", themeXml(options.palette));
  pack.set("ppt/slideMasters/slideMaster1.xml", slideMasterXml(options.palette));
  writeRelationships(pack, "ppt/slideMasters/slideMaster1.xml", [
    ...layoutDefinitions.map((_, index) => ({
      id: `rId${index + 1}`,
      type: relationshipTypes.slideLayout,
      target: `../slideLayouts/slideLayout${index + 1}.xml`,
    })),
    {
      id: `rId${layoutDefinitions.length + 1}`,
      type: relationshipTypes.theme,
      target: "../theme/theme1.xml",
    },
  ]);

  layoutDefinitions.forEach((layout, index) => {
    pack.set(`ppt/slideLayouts/slideLayout${index + 1}.xml`, slideLayoutXml(layout.name, layout.type));
    writeRelationships(pack, `ppt/slideLayouts/slideLayout${index + 1}.xml`, [
      {
        id: "rId1",
        type: relationshipTypes.slideMaster,
        target: "../slideMasters/slideMaster1.xml",
      },
    ]);
  });

  pack.set("docProps/core.xml", corePropertiesXml(options));
  pack.set("docProps/app.xml", extendedPropertiesXml(options));
  pack.set("docProps/custom.xml", customPropertiesXml());
}

/**
 * `presentation.xml` and its relationships, written after the slides exist.
 *
 * The slide id list and the relationship ids have to agree exactly, and they
 * are the single most common thing to get wrong when slides are added or
 * removed, so both are generated from the same array in one pass.
 */
export function writePresentation(pack: OoxmlPackage, slideParts: string[]): void {
  const masterRelationshipId = "rId1";
  const slideRelationships = slideParts.map((part, index) => ({
    id: `rId${index + 2}`,
    type: relationshipTypes.slide,
    target: part.replace(/^ppt\//, ""),
  }));
  writeRelationships(pack, "ppt/presentation.xml", [
    {
      id: masterRelationshipId,
      type: relationshipTypes.slideMaster,
      target: "slideMasters/slideMaster1.xml",
    },
    ...slideRelationships,
    {
      id: `rId${slideParts.length + 2}`,
      type: relationshipTypes.theme,
      target: "theme/theme1.xml",
    },
  ]);
  pack.set(
    "ppt/presentation.xml",
    serializeDocument(
      element("p:presentation", { ...namespaces, saveSubsetFonts: "1" }, [
        element("p:sldMasterIdLst", {}, [
          element("p:sldMasterId", { id: 2_147_483_648, "r:id": masterRelationshipId }),
        ]),
        element(
          "p:sldIdLst",
          {},
          slideRelationships.map((relationship, index) =>
            // Slide ids must be at least 256 and unique; PowerPoint rejects the
            // file outright when they are not.
            element("p:sldId", { id: 256 + index, "r:id": relationship.id }),
          ),
        ),
        element("p:sldSz", { cx: slideWidth, cy: slideHeight }),
        element("p:notesSz", { cx: slideHeight, cy: slideWidth }),
      ]),
    ),
  );
}

function slideMasterXml(palette: ThemePalette): string {
  return serializeDocument(
    element("p:sldMaster", namespaces, [
      element("p:cSld", {}, [
        element("p:bg", {}, [
          element("p:bgPr", {}, [
            element("a:solidFill", {}, [element("a:srgbClr", { val: palette.background })]),
            element("a:effectLst"),
          ]),
        ]),
        shapeTree([]),
      ]),
      // The colour map wires the theme's dk1/lt1 pair to "text" and
      // "background". Swapping these two is how a dark theme ends up with black
      // text on a black slide.
      element("p:clrMap", {
        bg1: "lt1",
        tx1: "dk1",
        bg2: "lt2",
        tx2: "dk2",
        accent1: "accent1",
        accent2: "accent2",
        accent3: "accent3",
        accent4: "accent4",
        accent5: "accent5",
        accent6: "accent6",
        hlink: "hlink",
        folHlink: "folHlink",
      }),
      element(
        "p:sldLayoutIdLst",
        {},
        layoutDefinitions.map((_, index) =>
          element("p:sldLayoutId", { id: 2_147_483_649 + index, "r:id": `rId${index + 1}` }),
        ),
      ),
      element("p:txStyles", {}, [
        element("p:titleStyle", {}, [textStyleLevel(palette.heading, 3_200, "+mj-lt")]),
        element("p:bodyStyle", {}, [textStyleLevel(palette.text, 1_800, "+mn-lt")]),
        element("p:otherStyle", {}, [textStyleLevel(palette.text, 1_800, "+mn-lt")]),
      ]),
    ]),
  );
}

function textStyleLevel(color: string, size: number, typeface: string): XmlNode {
  return element("a:lvl1pPr", { algn: "l" }, [
    element("a:defRPr", { sz: size }, [
      element("a:solidFill", {}, [element("a:srgbClr", { val: color })]),
      element("a:latin", { typeface }),
    ]),
  ]);
}

function slideLayoutXml(name: string, type: string): string {
  return serializeDocument(
    element("p:sldLayout", { ...namespaces, type, preserve: "1" }, [
      element("p:cSld", { name }, [shapeTree([])]),
      element("p:clrMapOvr", {}, [element("a:masterClrMapping")]),
    ]),
  );
}

function corePropertiesXml(options: ScaffoldOptions): string {
  return serializeDocument(
    element(
      "cp:coreProperties",
      {
        "xmlns:cp": "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
        "xmlns:dc": "http://purl.org/dc/elements/1.1/",
        "xmlns:dcterms": "http://purl.org/dc/terms/",
        "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
      },
      [
        element("dc:title", {}, [options.title]),
        element("dc:creator", {}, [options.author]),
        element("cp:lastModifiedBy", {}, [options.author]),
        element("dcterms:created", { "xsi:type": "dcterms:W3CDTF" }, [options.createdAt]),
        element("dcterms:modified", { "xsi:type": "dcterms:W3CDTF" }, [options.createdAt]),
      ],
    ),
  );
}

function extendedPropertiesXml(options: ScaffoldOptions): string {
  return serializeDocument(
    element(
      "Properties",
      {
        xmlns: "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties",
        "xmlns:vt": "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes",
      },
      [
        element("Application", {}, ["Umbratic"]),
        element("Slides", {}, [String(options.slideCount)]),
        element("TitlesOfParts", {}, [
          element("vt:vector", { size: 1, baseType: "lpstr" }, [
            element("vt:lpstr", {}, [options.title]),
          ]),
        ]),
      ],
    ),
  );
}

/**
 * The origin stamp.
 *
 * One custom property, checked on every inspect. Its presence is what lets the
 * tool say "I made this, the full op set applies" rather than treating every
 * file as a stranger's and refusing everything but surgical edits.
 */
function customPropertiesXml(): string {
  return serializeDocument(
    element(
      "Properties",
      {
        xmlns: "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties",
        "xmlns:vt": "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes",
      },
      [
        element(
          "property",
          { fmtid: "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}", pid: 2, name: originPropertyName },
          [element("vt:lpwstr", {}, ["1"])],
        ),
      ],
    ),
  );
}
