/**
 * Native PowerPoint charts.
 *
 * The data is written as literal caches (`c:strLit` / `c:numLit`) rather than
 * as references into an embedded workbook. That is a deliberate trade: a
 * reference needs a whole .xlsx part inside the .pptx, which would make the
 * PPTX engine depend on the XLSX engine, and the only thing the workbook buys
 * is the "Edit Data" button in PowerPoint. The chart renders identically, and
 * changing the numbers is what `setChartData` is for.
 */

import { element, serializeDocument, type XmlNode } from "../xml.js";
import type { ChartSpec } from "./spec.js";
import { drawingNamespace, officeRelationshipNamespace } from "./shapes.js";
import { normalizeHexColor, type ThemePalette } from "./theme.js";

const chartNamespace = "http://schemas.openxmlformats.org/drawingml/2006/chart";

/** Axis ids only have to be unique and stable within one chart part. */
const categoryAxisId = 111_111_111;
const valueAxisId = 222_222_222;

/** The series palette, derived from the theme so a deck stays one deck. */
function seriesColors(palette: ThemePalette): string[] {
  return [palette.accent, palette.muted, palette.heading, palette.line, "7A8B99", "C0563B"].map(
    (color) => normalizeHexColor(color) ?? "2F6FD0",
  );
}

export function chartXml(chart: ChartSpec, title: string | undefined, palette: ThemePalette): string {
  const colors = seriesColors(palette);
  const plot =
    chart.type === "pie"
      ? pieChart(chart, colors)
      : chart.type === "scatter"
        ? scatterChart(chart, colors)
        : chart.type === "line"
          ? lineChart(chart, colors)
          : barChart(chart, colors);
  const axes =
    chart.type === "pie"
      ? []
      : chart.type === "scatter"
        ? [valueAxis(categoryAxisId, valueAxisId, palette, "b"), valueAxis(valueAxisId, categoryAxisId, palette, "l")]
        : [categoryAxis(palette), valueAxis(valueAxisId, categoryAxisId, palette, "l")];

  return serializeDocument(
    element(
      "c:chartSpace",
      {
        "xmlns:c": chartNamespace,
        "xmlns:a": drawingNamespace,
        "xmlns:r": officeRelationshipNamespace,
      },
      [
        element("c:roundedCorners", { val: 0 }),
        element("c:chart", {}, [
          title
            ? element("c:title", {}, [
                element("c:tx", {}, [
                  element("c:rich", {}, [
                    element("a:bodyPr"),
                    element("a:lstStyle"),
                    element("a:p", {}, [
                      element("a:pPr", {}, [
                        element("a:defRPr", { sz: 1_400, b: 0 }, [
                          element("a:solidFill", {}, [
                            element("a:srgbClr", { val: normalizeHexColor(palette.heading) ?? "000000" }),
                          ]),
                        ]),
                      ]),
                      element("a:r", {}, [element("a:t", {}, [title])]),
                    ]),
                  ]),
                ]),
                element("c:overlay", { val: 0 }),
              ])
            : element("c:autoTitleDeleted", { val: 1 }),
          element("c:plotArea", {}, [element("c:layout"), plot, ...axes]),
          // One series needs no legend; more than one is unreadable without it.
          chart.series.length > 1 || chart.type === "pie"
            ? element("c:legend", {}, [
                element("c:legendPos", { val: "b" }),
                element("c:overlay", { val: 0 }),
                legendText(palette),
              ])
            : undefined,
          element("c:plotVisOnly", { val: 1 }),
          element("c:dispBlanksAs", { val: "gap" }),
        ]),
      ],
    ),
  );
}

function legendText(palette: ThemePalette): XmlNode {
  return element("c:txPr", {}, [
    element("a:bodyPr"),
    element("a:lstStyle"),
    element("a:p", {}, [
      element("a:pPr", {}, [
        element("a:defRPr", { sz: 1_100 }, [
          element("a:solidFill", {}, [
            element("a:srgbClr", { val: normalizeHexColor(palette.muted) ?? "666666" }),
          ]),
        ]),
      ]),
      element("a:endParaRPr", { lang: "en-US" }),
    ]),
  ]);
}

function solidSeriesFill(color: string): XmlNode {
  return element("c:spPr", {}, [
    element("a:solidFill", {}, [element("a:srgbClr", { val: color })]),
    element("a:ln", {}, [element("a:noFill")]),
  ]);
}

function lineSeriesStroke(color: string): XmlNode {
  return element("c:spPr", {}, [
    element("a:ln", { w: 28_575, cap: "rnd" }, [
      element("a:solidFill", {}, [element("a:srgbClr", { val: color })]),
      element("a:round"),
    ]),
    element("a:effectLst"),
  ]);
}

function categoryCache(categories: string[]): XmlNode {
  return element("c:cat", {}, [
    element("c:strLit", {}, [
      element("c:ptCount", { val: categories.length }),
      ...categories.map((label, index) =>
        element("c:pt", { idx: index }, [element("c:v", {}, [label])]),
      ),
    ]),
  ]);
}

function numberCache(name: "c:val" | "c:xVal" | "c:yVal", values: number[]): XmlNode {
  return element(name, {}, [
    element("c:numLit", {}, [
      element("c:formatCode", {}, ["General"]),
      element("c:ptCount", { val: values.length }),
      ...values.map((value, index) =>
        element("c:pt", { idx: index }, [element("c:v", {}, [String(value)])]),
      ),
    ]),
  ]);
}

function seriesHeader(index: number, name: string): XmlNode[] {
  return [
    element("c:idx", { val: index }),
    element("c:order", { val: index }),
    element("c:tx", {}, [element("c:v", {}, [name])]),
  ];
}

function barChart(chart: ChartSpec, colors: string[]): XmlNode {
  return element("c:barChart", {}, [
    element("c:barDir", { val: chart.type === "bar" ? "bar" : "col" }),
    element("c:grouping", { val: "clustered" }),
    element("c:varyColors", { val: 0 }),
    ...chart.series.map((series, index) =>
      element("c:ser", {}, [
        ...seriesHeader(index, series.name),
        solidSeriesFill(colors[index % colors.length]!),
        categoryCache(chart.categories),
        numberCache("c:val", series.values),
      ]),
    ),
    element("c:gapWidth", { val: 90 }),
    element("c:axId", { val: categoryAxisId }),
    element("c:axId", { val: valueAxisId }),
  ]);
}

function lineChart(chart: ChartSpec, colors: string[]): XmlNode {
  return element("c:lineChart", {}, [
    element("c:grouping", { val: "standard" }),
    element("c:varyColors", { val: 0 }),
    ...chart.series.map((series, index) =>
      element("c:ser", {}, [
        ...seriesHeader(index, series.name),
        lineSeriesStroke(colors[index % colors.length]!),
        element("c:marker", {}, [element("c:symbol", { val: "none" })]),
        categoryCache(chart.categories),
        numberCache("c:val", series.values),
        element("c:smooth", { val: 0 }),
      ]),
    ),
    element("c:marker", { val: 1 }),
    element("c:axId", { val: categoryAxisId }),
    element("c:axId", { val: valueAxisId }),
  ]);
}

function pieChart(chart: ChartSpec, colors: string[]): XmlNode {
  const series = chart.series[0]!;
  return element("c:pieChart", {}, [
    element("c:varyColors", { val: 1 }),
    element("c:ser", {}, [
      ...seriesHeader(0, series.name),
      // A pie varies colour per point rather than per series, so each slice
      // needs its own data point entry.
      ...chart.categories.map((_, index) =>
        element("c:dPt", {}, [
          element("c:idx", { val: index }),
          element("c:bubble3D", { val: 0 }),
          solidSeriesFill(colors[index % colors.length]!),
        ]),
      ),
      categoryCache(chart.categories),
      numberCache("c:val", series.values),
    ]),
    element("c:firstSliceAng", { val: 0 }),
  ]);
}

function scatterChart(chart: ChartSpec, colors: string[]): XmlNode {
  return element("c:scatterChart", {}, [
    element("c:scatterStyle", { val: "lineMarker" }),
    element("c:varyColors", { val: 0 }),
    ...chart.series.map((series, index) =>
      element("c:ser", {}, [
        ...seriesHeader(index, series.name),
        element("c:spPr", {}, [element("a:ln", { w: 19_050 }, [element("a:noFill")])]),
        element("c:marker", {}, [
          element("c:symbol", { val: "circle" }),
          element("c:size", { val: 6 }),
          solidSeriesFill(colors[index % colors.length]!),
        ]),
        // The category axis of a scatter is numeric: the labels are read as the
        // x values, and a non-numeric label becomes the point's ordinal.
        numberCache(
          "c:xVal",
          chart.categories.map((label, position) => {
            const parsed = Number(label);
            return Number.isFinite(parsed) ? parsed : position + 1;
          }),
        ),
        numberCache("c:yVal", series.values),
        element("c:smooth", { val: 0 }),
      ]),
    ),
    element("c:axId", { val: categoryAxisId }),
    element("c:axId", { val: valueAxisId }),
  ]);
}

function axisText(palette: ThemePalette): XmlNode {
  return element("c:txPr", {}, [
    element("a:bodyPr"),
    element("a:lstStyle"),
    element("a:p", {}, [
      element("a:pPr", {}, [
        element("a:defRPr", { sz: 1_100 }, [
          element("a:solidFill", {}, [
            element("a:srgbClr", { val: normalizeHexColor(palette.muted) ?? "666666" }),
          ]),
        ]),
      ]),
      element("a:endParaRPr", { lang: "en-US" }),
    ]),
  ]);
}

function axisLine(palette: ThemePalette): XmlNode {
  return element("c:spPr", {}, [
    element("a:ln", { w: 9_525 }, [
      element("a:solidFill", {}, [
        element("a:srgbClr", { val: normalizeHexColor(palette.line) ?? "CCCCCC" }),
      ]),
    ]),
  ]);
}

function categoryAxis(palette: ThemePalette): XmlNode {
  return element("c:catAx", {}, [
    element("c:axId", { val: categoryAxisId }),
    element("c:scaling", {}, [element("c:orientation", { val: "minMax" })]),
    element("c:delete", { val: 0 }),
    element("c:axPos", { val: "b" }),
    axisLine(palette),
    axisText(palette),
    element("c:crossAx", { val: valueAxisId }),
  ]);
}

function valueAxis(
  id: number,
  crossId: number,
  palette: ThemePalette,
  position: "b" | "l",
): XmlNode {
  return element("c:valAx", {}, [
    element("c:axId", { val: id }),
    element("c:scaling", {}, [element("c:orientation", { val: "minMax" })]),
    element("c:delete", { val: 0 }),
    element("c:axPos", { val: position }),
    element("c:majorGridlines", {}, [
      element("c:spPr", {}, [
        element("a:ln", { w: 9_525 }, [
          element("a:solidFill", {}, [
            element("a:srgbClr", { val: normalizeHexColor(palette.line) ?? "CCCCCC" }),
          ]),
        ]),
      ]),
    ]),
    element("c:numFmt", { formatCode: "General", sourceLinked: 1 }),
    axisLine(palette),
    axisText(palette),
    element("c:crossAx", { val: crossId }),
  ]);
}
