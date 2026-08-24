/**
 * Text measurement from real font metrics.
 *
 * The geometry checks — does this bullet list fit its box, is this column
 * narrower than its longest word — are only worth running if the width they
 * compute is close to what PowerPoint will compute. A character count is not:
 * "IIIIIIIIII" and "MMMMMMMMMM" differ by more than a factor of three, and a
 * count-based check either passes everything or fails everything.
 *
 * So this reads the advance widths out of the TrueType tables directly. The
 * fonts are the Liberation family, which is metric-compatible with Arial and
 * ships with `pdfjs-dist` — already a dependency of this app, already OFL
 * licensed, and already inside the package. No second font bundle, and no
 * canvas or renderer in the measuring path.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type FontWeight = "regular" | "bold";

type FontMetrics = {
  unitsPerEm: number;
  /** Glyph advance widths in font units, indexed by glyph id. */
  advances: number[];
  /** Code point → glyph id. */
  glyphs: Map<number, number>;
  /** What an unmapped code point costs. */
  fallbackAdvance: number;
};

const loaded = new Map<FontWeight, FontMetrics | null>();

/**
 * Where the Liberation faces live.
 *
 * The resolver is asked first, because in a packaged build the dependency is
 * inside the asar and only the resolver knows where it landed. The walk up from
 * this file is the fallback for the two contexts where `require.resolve` is not
 * the real one: the test sandbox, and any future bundling step that rewrites
 * requires.
 */
function fontFile(weight: FontWeight): string | undefined {
  const file = weight === "bold" ? "LiberationSans-Bold.ttf" : "LiberationSans-Regular.ttf";
  const suffix = path.join("pdfjs-dist", "standard_fonts", file);
  try {
    const manifest = require.resolve("pdfjs-dist/package.json");
    const candidate = path.join(path.dirname(manifest), "standard_fonts", file);
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // Fall through to the directory walk.
  }
  let directory = __dirname;
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = path.join(directory, "node_modules", suffix);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

function metricsFor(weight: FontWeight): FontMetrics | null {
  const cached = loaded.get(weight);
  if (cached !== undefined) return cached;
  let parsed: FontMetrics | null = null;
  const file = fontFile(weight);
  if (file) {
    try {
      parsed = parseTrueType(fs.readFileSync(file));
    } catch {
      parsed = null;
    }
  }
  loaded.set(weight, parsed);
  return parsed;
}

/**
 * The width of one line, in points, at the given size.
 *
 * When the font cannot be read the estimate falls back to a flat ratio. That is
 * worse, but it is worse in a stated way: `metricsAvailable` reports it, and
 * the QA layer downgrades geometry findings to warnings rather than claiming an
 * overflow it cannot actually prove.
 */
export function measureText(value: string, fontSizePt: number, weight: FontWeight = "regular"): number {
  const metrics = metricsFor(weight);
  if (!metrics) return value.length * fontSizePt * 0.5;
  let units = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 32;
    const glyph = metrics.glyphs.get(codePoint);
    const advance =
      glyph !== undefined ? metrics.advances[glyph] ?? metrics.fallbackAdvance : metrics.fallbackAdvance;
    units += advance;
  }
  return (units / metrics.unitsPerEm) * fontSizePt;
}

export function metricsAvailable(): boolean {
  return metricsFor("regular") !== null;
}

/**
 * Greedy line breaking at spaces, the way a text box wraps.
 *
 * A word longer than the box does not disappear and does not silently overflow
 * the count: it takes a line of its own and the caller sees a line wider than
 * the box, which is exactly the condition the column-width check looks for.
 */
export function wrapText(
  value: string,
  widthPt: number,
  fontSizePt: number,
  weight: FontWeight = "regular",
): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    const words = paragraph.split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && measureText(candidate, fontSizePt, weight) > widthPt) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines;
}

/** The longest single word, which is the narrowest a column can ever be. */
export function longestWordWidth(value: string, fontSizePt: number, weight: FontWeight = "regular"): number {
  return value
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .reduce((widest, word) => Math.max(widest, measureText(word, fontSizePt, weight)), 0);
}

function parseTrueType(bytes: Buffer): FontMetrics {
  const tables = new Map<string, { offset: number; length: number }>();
  const tableCount = bytes.readUInt16BE(4);
  for (let index = 0; index < tableCount; index += 1) {
    const record = 12 + index * 16;
    if (record + 16 > bytes.length) break;
    tables.set(bytes.toString("ascii", record, record + 4), {
      offset: bytes.readUInt32BE(record + 8),
      length: bytes.readUInt32BE(record + 12),
    });
  }
  const head = tables.get("head");
  const hhea = tables.get("hhea");
  const hmtx = tables.get("hmtx");
  const cmap = tables.get("cmap");
  if (!head || !hhea || !hmtx || !cmap) throw new Error("Font is missing a required table.");

  const unitsPerEm = bytes.readUInt16BE(head.offset + 18);
  const metricCount = bytes.readUInt16BE(hhea.offset + 34);
  const advances: number[] = [];
  for (let index = 0; index < metricCount; index += 1) {
    const at = hmtx.offset + index * 4;
    if (at + 2 > bytes.length) break;
    advances.push(bytes.readUInt16BE(at));
  }
  if (advances.length === 0) throw new Error("Font declares no horizontal metrics.");

  const glyphs = parseCharacterMap(bytes, cmap.offset);
  const space = glyphs.get(32);
  return {
    unitsPerEm: unitsPerEm || 1000,
    advances,
    glyphs,
    // An unmapped code point is most often CJK or an emoji, both of which are
    // wider than a space. Charging the width of a space would under-measure the
    // one case where overflow is most likely.
    fallbackAdvance: space !== undefined ? (advances[space] ?? unitsPerEm / 2) * 2 : unitsPerEm / 2,
  };
}

function parseCharacterMap(bytes: Buffer, cmapOffset: number): Map<number, number> {
  const glyphs = new Map<number, number>();
  const subtableCount = bytes.readUInt16BE(cmapOffset + 2);
  let best: { offset: number; score: number } | undefined;
  for (let index = 0; index < subtableCount; index += 1) {
    const record = cmapOffset + 4 + index * 8;
    if (record + 8 > bytes.length) break;
    const platform = bytes.readUInt16BE(record);
    const encoding = bytes.readUInt16BE(record + 2);
    const offset = cmapOffset + bytes.readUInt32BE(record + 4);
    // Prefer a full Unicode table over the BMP one, and either over a Mac
    // legacy table that only covers Latin-1.
    const score =
      platform === 3 && encoding === 10 ? 4 : platform === 3 && encoding === 1 ? 3 : platform === 0 ? 2 : 1;
    if (!best || score > best.score) best = { offset, score };
  }
  if (!best) return glyphs;
  const format = bytes.readUInt16BE(best.offset);
  if (format === 4) parseCmapFormat4(bytes, best.offset, glyphs);
  else if (format === 12) parseCmapFormat12(bytes, best.offset, glyphs);
  return glyphs;
}

function parseCmapFormat4(bytes: Buffer, offset: number, glyphs: Map<number, number>): void {
  const segmentCount = bytes.readUInt16BE(offset + 6) / 2;
  const endCodes = offset + 14;
  const startCodes = endCodes + segmentCount * 2 + 2;
  const deltas = startCodes + segmentCount * 2;
  const rangeOffsets = deltas + segmentCount * 2;
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const end = bytes.readUInt16BE(endCodes + segment * 2);
    const start = bytes.readUInt16BE(startCodes + segment * 2);
    if (start > end) continue;
    const delta = bytes.readInt16BE(deltas + segment * 2);
    const rangeOffset = bytes.readUInt16BE(rangeOffsets + segment * 2);
    for (let code = start; code <= end && code !== 0xffff; code += 1) {
      let glyph: number;
      if (rangeOffset === 0) {
        glyph = (code + delta) & 0xffff;
      } else {
        const at = rangeOffsets + segment * 2 + rangeOffset + (code - start) * 2;
        if (at + 2 > bytes.length) continue;
        const raw = bytes.readUInt16BE(at);
        if (raw === 0) continue;
        glyph = (raw + delta) & 0xffff;
      }
      if (glyph !== 0) glyphs.set(code, glyph);
    }
  }
}

function parseCmapFormat12(bytes: Buffer, offset: number, glyphs: Map<number, number>): void {
  const groupCount = bytes.readUInt32BE(offset + 12);
  for (let index = 0; index < groupCount; index += 1) {
    const group = offset + 16 + index * 12;
    if (group + 12 > bytes.length) break;
    const start = bytes.readUInt32BE(group);
    const end = bytes.readUInt32BE(group + 4);
    const startGlyph = bytes.readUInt32BE(group + 8);
    // A format 12 font can legally declare enormous ranges. Only the range that
    // real document text draws from is worth materialising.
    const limit = Math.min(end, start + 0xffff);
    for (let code = start; code <= limit; code += 1) {
      glyphs.set(code, startGlyph + (code - start));
    }
  }
}
