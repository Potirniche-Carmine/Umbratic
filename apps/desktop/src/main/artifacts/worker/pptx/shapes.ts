/**
 * The DrawingML shapes a slide is built from.
 *
 * Everything a layout can place goes through one of these builders, so there is
 * exactly one place that knows how a run of text, a table cell, or a picture
 * frame is spelled. The corruption rules the QA layer checks — a shape without
 * a `txBody`, an eight-digit colour — are rules about output this module
 * produces, so they are enforced here as well as checked there: the check
 * exists to catch a future change, not to compensate for this one.
 */

import { inlineRuns, type InlineRun } from "../inlineText.js";
import { element, type XmlNode } from "../xml.js";
import type { Box } from "./geometry.js";
import { textInset } from "./geometry.js";
import { normalizeHexColor, type ThemePalette } from "./theme.js";

export const presentationNamespace =
  "http://schemas.openxmlformats.org/presentationml/2006/main";
export const drawingNamespace = "http://schemas.openxmlformats.org/drawingml/2006/main";
export const officeRelationshipNamespace =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export type TextStyle = {
  /** Points. DrawingML stores hundredths, which this converts. */
  size: number;
  color: string;
  bold?: boolean;
  italic?: boolean;
  /** "+mj-lt" for the major theme face, "+mn-lt" for the minor one. */
  typeface?: string;
  align?: "l" | "ctr" | "r";
  /** Percentage of single spacing, so 90 is slightly tight. */
  lineSpacing?: number;
};

/** The text of a marked-up string as the reader will see it. */
export function plainText(value: string): string {
  return inlineRuns(value)
    .map((run) => run.text)
    .join("");
}

function runProperties(style: TextStyle, run: InlineRun): XmlNode {
  const color = normalizeHexColor(style.color) ?? "000000";
  const attributes: Record<string, string | number | undefined> = {
    lang: "en-US",
    sz: Math.round(style.size * 100),
    dirty: "0",
  };
  if (style.bold || run.bold) attributes.b = 1;
  if (style.italic || run.italic) attributes.i = 1;
  return element("a:rPr", attributes, [
    element("a:solidFill", {}, [element("a:srgbClr", { val: color })]),
    // A code run is the one place a specific face is named rather than a theme
    // slot: the point of the marker is that the text is monospaced.
    element("a:latin", { typeface: run.code ? "Consolas" : style.typeface ?? "+mn-lt" }),
  ]);
}

export type ParagraphOptions = {
  level?: number;
  bullet?: boolean;
  spaceBefore?: number;
};

export function paragraph(
  value: string,
  style: TextStyle,
  options: ParagraphOptions = {},
): XmlNode {
  const level = Math.max(0, Math.min(4, options.level ?? 0));
  const properties: Record<string, string | number | undefined> = {};
  if (level > 0) properties.lvl = level;
  if (style.align && style.align !== "l") properties.algn = style.align;
  if (options.bullet) {
    properties.marL = 285_750 * (level + 1);
    properties.indent = -285_750;
  }
  const paragraphChildren: XmlNode[] = [];
  if (options.spaceBefore) {
    paragraphChildren.push(
      element("a:spcBef", {}, [element("a:spcPts", { val: Math.round(options.spaceBefore * 100) })]),
    );
  }
  if (style.lineSpacing) {
    paragraphChildren.unshift(
      element("a:lnSpc", {}, [element("a:spcPct", { val: Math.round(style.lineSpacing * 1000) })]),
    );
  }
  if (options.bullet) {
    paragraphChildren.push(
      element("a:buClr", {}, [element("a:srgbClr", { val: normalizeHexColor(style.color) ?? "000000" })]),
      element("a:buChar", { char: level === 0 ? "•" : "–" }),
    );
  } else {
    paragraphChildren.push(element("a:buNone"));
  }
  const runs = inlineRuns(value).map((run) =>
    element("a:r", {}, [runProperties(style, run), element("a:t", {}, [run.text])]),
  );
  return element("a:p", {}, [
    element("a:pPr", properties, paragraphChildren),
    ...runs,
    element("a:endParaRPr", { lang: "en-US", sz: Math.round(style.size * 100) }),
  ]);
}

export type TextBoxOptions = {
  /** "t" | "ctr" | "b" — vertical anchor inside the box. */
  anchor?: "t" | "ctr" | "b";
  /** Shrinks type to fit rather than overflowing. Off by default. */
  autoFit?: boolean;
  fill?: string;
  outline?: string;
};

export function textBox(
  id: number,
  name: string,
  box: Box,
  paragraphs: XmlNode[],
  options: TextBoxOptions = {},
): XmlNode {
  // Never emit an empty txBody: a shape with no paragraph is one of the two
  // reliable ways to make PowerPoint declare a deck corrupt.
  const body = paragraphs.length > 0 ? paragraphs : [element("a:p", {}, [element("a:endParaRPr", { lang: "en-US" })])];
  const fill = normalizeHexColor(options.fill);
  const outline = normalizeHexColor(options.outline);
  return element("p:sp", {}, [
    element("p:nvSpPr", {}, [
      element("p:cNvPr", { id, name }),
      element("p:cNvSpPr", { txBox: 1 }),
      element("p:nvPr"),
    ]),
    element("p:spPr", {}, [
      frameTransform(box),
      element("a:prstGeom", { prst: "rect" }, [element("a:avLst")]),
      fill ? element("a:solidFill", {}, [element("a:srgbClr", { val: fill })]) : element("a:noFill"),
      outline
        ? element("a:ln", { w: 12_700 }, [
            element("a:solidFill", {}, [element("a:srgbClr", { val: outline })]),
          ])
        : element("a:ln", {}, [element("a:noFill")]),
    ]),
    element("p:txBody", {}, [
      element(
        "a:bodyPr",
        {
          lIns: textInset.left,
          rIns: textInset.right,
          tIns: textInset.top,
          bIns: textInset.bottom,
          anchor: options.anchor ?? "t",
          wrap: "square",
        },
        [options.autoFit ? element("a:normAutofit") : element("a:noAutofit")],
      ),
      element("a:lstStyle"),
      ...body,
    ]),
  ]);
}

function frameTransform(box: Box): XmlNode {
  return element("a:xfrm", {}, [
    element("a:off", { x: box.x, y: box.y }),
    element("a:ext", { cx: box.width, cy: box.height }),
  ]);
}

export function picture(
  id: number,
  name: string,
  relationshipId: string,
  box: Box,
  description: string,
): XmlNode {
  return element("p:pic", {}, [
    element("p:nvPicPr", {}, [
      // `descr` is the alt text. A generated deck with no alt text is a
      // generated deck no screen reader can use, so it is always written even
      // when the spec did not supply one.
      element("p:cNvPr", { id, name, descr: description || name }),
      element("p:cNvPicPr", {}, [element("a:picLocks", { noChangeAspect: 1 })]),
      element("p:nvPr"),
    ]),
    element("p:blipFill", {}, [
      element("a:blip", { "r:embed": relationshipId }),
      element("a:stretch", {}, [element("a:fillRect")]),
    ]),
    element("p:spPr", {}, [
      frameTransform(box),
      element("a:prstGeom", { prst: "rect" }, [element("a:avLst")]),
    ]),
  ]);
}

export function chartFrame(id: number, name: string, relationshipId: string, box: Box): XmlNode {
  return element("p:graphicFrame", {}, [
    element("p:nvGraphicFramePr", {}, [
      element("p:cNvPr", { id, name }),
      element("p:cNvGraphicFramePr"),
      element("p:nvPr"),
    ]),
    element("p:xfrm", {}, [
      element("a:off", { x: box.x, y: box.y }),
      element("a:ext", { cx: box.width, cy: box.height }),
    ]),
    element("a:graphic", {}, [
      element(
        "a:graphicData",
        { uri: "http://schemas.openxmlformats.org/drawingml/2006/chart" },
        [
          element("c:chart", {
            "xmlns:c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
            "xmlns:r": officeRelationshipNamespace,
            "r:id": relationshipId,
          }),
        ],
      ),
    ]),
  ]);
}

export type TableCell = { text: string; header?: boolean };

export function table(
  id: number,
  name: string,
  box: Box,
  columnWidths: number[],
  rows: TableCell[][],
  palette: ThemePalette,
  bodySize: number,
): XmlNode {
  const rowHeight = Math.max(1, Math.round(box.height / Math.max(1, rows.length)));
  const cellFill = (cell: TableCell) => (cell.header ? palette.surface : palette.background);
  return element("p:graphicFrame", {}, [
    element("p:nvGraphicFramePr", {}, [
      element("p:cNvPr", { id, name }),
      element("p:cNvGraphicFramePr", {}, [element("a:graphicFrameLocks", { noGrp: 1 })]),
      element("p:nvPr"),
    ]),
    element("p:xfrm", {}, [
      element("a:off", { x: box.x, y: box.y }),
      element("a:ext", { cx: box.width, cy: box.height }),
    ]),
    element("a:graphic", {}, [
      element(
        "a:graphicData",
        { uri: "http://schemas.openxmlformats.org/drawingml/2006/table" },
        [
          element("a:tbl", {}, [
            element("a:tblPr", { firstRow: 1, bandRow: 1 }),
            element(
              "a:tblGrid",
              {},
              columnWidths.map((width) => element("a:gridCol", { w: width })),
            ),
            ...rows.map((cells) =>
              element(
                "a:tr",
                { h: rowHeight },
                cells.map((cell) =>
                  element("a:tc", {}, [
                    element("a:txBody", {}, [
                      element("a:bodyPr", {
                        lIns: textInset.left,
                        rIns: textInset.right,
                        tIns: textInset.top,
                        bIns: textInset.bottom,
                        anchor: "ctr",
                      }),
                      element("a:lstStyle"),
                      paragraph(cell.text, {
                        size: bodySize,
                        color: cell.header ? palette.heading : palette.text,
                        bold: cell.header === true,
                      }),
                    ]),
                    element("a:tcPr", {}, [
                      element("a:solidFill", {}, [element("a:srgbClr", { val: cellFill(cell) })]),
                    ]),
                  ]),
                ),
              ),
            ),
          ]),
        ],
      ),
    ]),
  ]);
}

/** The `<p:spTree>` wrapper every slide, layout, and master needs. */
export function shapeTree(children: XmlNode[]): XmlNode {
  return element("p:spTree", {}, [
    element("p:nvGrpSpPr", {}, [
      element("p:cNvPr", { id: 1, name: "" }),
      element("p:cNvGrpSpPr"),
      element("p:nvPr"),
    ]),
    element("p:grpSpPr", {}, [
      element("a:xfrm", {}, [
        element("a:off", { x: 0, y: 0 }),
        element("a:ext", { cx: 0, cy: 0 }),
        element("a:chOff", { x: 0, y: 0 }),
        element("a:chExt", { cx: 0, cy: 0 }),
      ]),
    ]),
    ...children,
  ]);
}
