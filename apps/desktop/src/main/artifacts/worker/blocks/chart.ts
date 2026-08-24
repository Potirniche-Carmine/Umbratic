/**
 * Charts for the text formats.
 *
 * PPTX and XLSX get native charts, because their formats have one and a reader
 * expects to be able to click the numbers. DOCX and PDF do not: a native
 * DrawingML chart in a Word document drags in an embedded workbook, and a PDF
 * has no chart object at all. So here a chart is a picture.
 *
 * It is drawn once, at print resolution, and handed to whichever renderer asked
 * for it. When the rasteriser is unavailable the caller is told so rather than
 * left with a blank frame — the block falls back to a table of the same numbers,
 * which is worse to look at and exactly as true.
 */

import type { BlockPreset } from "./presets.js";

export type ChartData = {
  type: string;
  categories: string[];
  series: Array<{ name: string; values: number[] }>;
};

export type RenderedChart = {
  png: Buffer;
  /** Points, so the caller can place it without knowing the pixel density. */
  width: number;
  height: number;
};

/** Drawn at 3× and placed at 1×, so it stays sharp when printed. */
const scale = 3;

type Canvas2D = {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  fillRect(x: number, y: number, width: number, height: number): void;
  strokeRect(x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, radius: number, start: number, end: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
};

type CanvasModule = {
  createCanvas(width: number, height: number): {
    getContext(kind: "2d"): Canvas2D;
    toBuffer(mime: "image/png"): Buffer;
  };
};

let canvasModule: CanvasModule | null | undefined;

function loadCanvas(): CanvasModule | null {
  if (canvasModule !== undefined) return canvasModule;
  try {
    canvasModule = require("@napi-rs/canvas") as CanvasModule;
  } catch {
    canvasModule = null;
  }
  return canvasModule;
}

export function chartsAvailable(): boolean {
  return loadCanvas() !== null;
}

/**
 * Draws a chart at the given width in points.
 *
 * The height is derived rather than asked for: a chart whose proportions the
 * caller chose ends up either squashed or floating in whitespace, and the
 * shapes that read well are close to fixed.
 */
export function barChartSvg(chart: ChartData, preset: BlockPreset, widthPoints: number): RenderedChart {
  const module = loadCanvas();
  if (!module) throw new Error("chart rendering is not available in this build");

  const heightPoints = Math.round(widthPoints * (chart.type === "pie" ? 0.62 : 0.55));
  const canvas = module.createCanvas(
    Math.round(widthPoints * scale),
    Math.round(heightPoints * scale),
  );
  const context = canvas.getContext("2d");
  context.save();
  // Everything below is written in points; the scale makes it pixels.
  context.translate(0, 0);
  const unit = scale;

  const colors = seriesColors(preset);
  context.fillStyle = "#FFFFFF";
  context.fillRect(0, 0, widthPoints * unit, heightPoints * unit);
  context.font = `${Math.round(preset.small * unit)}px sans-serif`;
  context.textBaseline = "middle";

  if (chart.type === "pie") {
    drawPie(context, chart, colors, widthPoints * unit, heightPoints * unit, preset, unit);
  } else {
    drawAxisChart(context, chart, colors, widthPoints * unit, heightPoints * unit, preset, unit);
  }
  context.restore();
  return { png: canvas.toBuffer("image/png"), width: widthPoints, height: heightPoints };
}

function seriesColors(preset: BlockPreset): string[] {
  return [
    `#${preset.colors.accent}`,
    `#${preset.colors.muted}`,
    "#2E7D4F",
    "#B5661F",
    "#6B4E9E",
    "#7A8B99",
  ];
}

function drawAxisChart(
  context: Canvas2D,
  chart: ChartData,
  colors: string[],
  width: number,
  height: number,
  preset: BlockPreset,
  unit: number,
): void {
  const legendHeight = chart.series.length > 1 ? 18 * unit : 0;
  const padding = { top: 10 * unit, right: 10 * unit, bottom: 26 * unit + legendHeight, left: 42 * unit };
  const plot = {
    x: padding.left,
    y: padding.top,
    width: width - padding.left - padding.right,
    height: height - padding.top - padding.bottom,
  };
  const values = chart.series.flatMap((series) => series.values);
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const yFor = (value: number) => plot.y + plot.height - ((value - min) / span) * plot.height;

  // Four gridlines is enough to read a value off and few enough not to become
  // the loudest thing in the picture.
  context.strokeStyle = `#${preset.colors.rule}`;
  context.lineWidth = Math.max(1, unit * 0.4);
  context.fillStyle = `#${preset.colors.muted}`;
  context.textAlign = "right";
  for (let step = 0; step <= 4; step += 1) {
    const value = min + (span * step) / 4;
    const y = yFor(value);
    context.beginPath();
    context.moveTo(plot.x, y);
    context.lineTo(plot.x + plot.width, y);
    context.stroke();
    context.fillText(formatNumber(value), plot.x - 4 * unit, y);
  }

  const slotWidth = plot.width / Math.max(1, chart.categories.length);
  context.textAlign = "center";
  chart.categories.forEach((label, index) => {
    context.fillStyle = `#${preset.colors.muted}`;
    context.fillText(
      truncate(context, label, slotWidth * 0.95),
      plot.x + slotWidth * (index + 0.5),
      plot.y + plot.height + 10 * unit,
    );
  });

  if (chart.type === "line") {
    chart.series.forEach((series, seriesIndex) => {
      context.strokeStyle = colors[seriesIndex % colors.length]!;
      context.lineWidth = Math.max(1.5, unit * 0.8);
      context.beginPath();
      series.values.forEach((value, index) => {
        const x = plot.x + slotWidth * (index + 0.5);
        const y = yFor(value);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
    });
  } else {
    const groupWidth = slotWidth * 0.7;
    const barWidth = groupWidth / chart.series.length;
    chart.series.forEach((series, seriesIndex) => {
      context.fillStyle = colors[seriesIndex % colors.length]!;
      series.values.forEach((value, index) => {
        const x = plot.x + slotWidth * (index + 0.5) - groupWidth / 2 + barWidth * seriesIndex;
        const zero = yFor(0);
        const y = yFor(value);
        context.fillRect(x, Math.min(y, zero), barWidth * 0.9, Math.abs(zero - y));
      });
    });
  }

  if (chart.series.length > 1) {
    context.textAlign = "left";
    let x = plot.x;
    const y = height - 8 * unit;
    chart.series.forEach((series, index) => {
      context.fillStyle = colors[index % colors.length]!;
      context.fillRect(x, y - 4 * unit, 8 * unit, 8 * unit);
      context.fillStyle = `#${preset.colors.muted}`;
      context.fillText(series.name, x + 11 * unit, y);
      x += 11 * unit + context.measureText(series.name).width + 14 * unit;
    });
  }
}

function drawPie(
  context: Canvas2D,
  chart: ChartData,
  colors: string[],
  width: number,
  height: number,
  preset: BlockPreset,
  unit: number,
): void {
  const values = chart.series[0]?.values ?? [];
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0) || 1;
  const radius = Math.min(width * 0.3, height * 0.38);
  const centreX = width * 0.32;
  const centreY = height / 2;
  let angle = -Math.PI / 2;
  values.forEach((value, index) => {
    const sweep = (Math.max(0, value) / total) * Math.PI * 2;
    context.fillStyle = colors[index % colors.length]!;
    context.beginPath();
    context.moveTo(centreX, centreY);
    context.arc(centreX, centreY, radius, angle, angle + sweep);
    context.closePath();
    context.fill();
    angle += sweep;
  });

  // The legend carries the percentages: labels on the slices themselves stop
  // fitting the moment two slices are small.
  context.textAlign = "left";
  const legendX = width * 0.64;
  const lineHeight = 14 * unit;
  const top = centreY - (chart.categories.length * lineHeight) / 2;
  chart.categories.forEach((label, index) => {
    const y = top + index * lineHeight + lineHeight / 2;
    context.fillStyle = colors[index % colors.length]!;
    context.fillRect(legendX, y - 4 * unit, 8 * unit, 8 * unit);
    context.fillStyle = `#${preset.colors.text}`;
    const share = Math.round((Math.max(0, values[index] ?? 0) / total) * 100);
    context.fillText(
      truncate(context, `${label} · ${share}%`, width - legendX - 14 * unit),
      legendX + 11 * unit,
      y,
    );
  });
}

function formatNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(1);
}

function truncate(context: Canvas2D, text: string, maxWidth: number): string {
  if (context.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && context.measureText(`${cut}…`).width > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

/** The same numbers as a table, for when the rasteriser is not there. */
export function chartFallbackTable(chart: ChartData): { columns: string[]; rows: string[][] } {
  return {
    columns: ["", ...chart.series.map((series) => series.name)],
    rows: chart.categories.map((category, index) => [
      category,
      ...chart.series.map((series) => String(series.values[index] ?? "")),
    ]),
  };
}
