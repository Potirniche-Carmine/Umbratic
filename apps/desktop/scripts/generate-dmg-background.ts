import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const maskPath = path.join(desktopRoot, "assets/brand/Umbratic/umbratic-icon-no-padding-transparent.png");
const outPath = path.join(desktopRoot, "assets/dmg/background.tiff");

// Same surface as the app icon tile and the NSIS wizard: the drag-to-install
// window should read as the app it installs, not as Finder's stock gray.
const background = { r: 11, g: 13, b: 16 };
const steel = { r: 236, g: 239, b: 243 };
// A faint steel-tinted lift behind the mark, so the shield sits in a glow
// rather than floating on flat black.
const glowColor = { r: 30, g: 34, b: 41 };

// Logical geometry, in the window's point coordinates. The window size and the
// icon drop points must agree with the dmg section of electron-builder.yml:
// the arrow below is drawn between the two icons Finder will pin there.
const window = { width: 540, height: 380 };
const iconY = 220;
const appIconX = 140;
const applicationsX = 400;
const shieldTop = 36;
const shieldHeight = 84;
// Rendered at 4x and box-reduced, so every edge lands anti-aliased without a
// separate coverage pass; 2x and 1x are successive halvings of the same frame.
const master = 4;

type RgbaImage = { width: number; height: number; pixels: Uint8Array };
type FloatImage = { width: number; height: number; rgb: Float32Array };

function readPng(filePath: string): RgbaImage {
  return decodePng(fs.readFileSync(filePath), filePath);
}

function decodePng(data: Buffer, label: string): RgbaImage {
  if (data.subarray(0, 8).toString("binary") !== "\x89PNG\r\n\x1a\n") {
    throw new Error(`${label} is not a PNG`);
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString("ascii");
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8] ?? 0;
      colorType = chunk[9] ?? 0;
    } else if (type === "IDAT") {
      idat.push(chunk);
    } else if (type === "IEND") {
      break;
    }
  }
  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`${label} must be 8-bit RGBA`);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const row = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    if (filter === 1) {
      for (let i = 0; i < stride; i += 1) row[i] = ((row[i] ?? 0) + (i >= 4 ? (row[i - 4] ?? 0) : 0)) & 255;
    } else if (filter === 2) {
      for (let i = 0; i < stride; i += 1) row[i] = ((row[i] ?? 0) + (prev[i] ?? 0)) & 255;
    } else if (filter === 3) {
      for (let i = 0; i < stride; i += 1) {
        const left = i >= 4 ? (row[i - 4] ?? 0) : 0;
        row[i] = ((row[i] ?? 0) + Math.floor((left + (prev[i] ?? 0)) / 2)) & 255;
      }
    } else if (filter === 4) {
      for (let i = 0; i < stride; i += 1) {
        const a = i >= 4 ? (row[i - 4] ?? 0) : 0;
        const b = prev[i] ?? 0;
        const c = i >= 4 ? (prev[i - 4] ?? 0) : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        row[i] = ((row[i] ?? 0) + pr) & 255;
      }
    } else if (filter !== 0) {
      throw new Error(`${label} uses unsupported PNG filter ${filter}`);
    }
    pixels.set(row, y * stride);
    prev = row;
  }
  return { width, height, pixels };
}

function sampleAlpha(image: RgbaImage, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return 0;
  return image.pixels[(y * image.width + x) * 4 + 3] ?? 0;
}

function sampleAlphaBilinear(image: RgbaImage, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const a00 = sampleAlpha(image, x0, y0);
  const a10 = sampleAlpha(image, x0 + 1, y0);
  const a01 = sampleAlpha(image, x0, y0 + 1);
  const a11 = sampleAlpha(image, x0 + 1, y0 + 1);
  return (a00 * (1 - tx) + a10 * tx) * (1 - ty) + (a01 * (1 - tx) + a11 * tx) * ty;
}

function capsuleDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const t = Math.min(Math.max(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby), 0), 1);
  return Math.hypot(px - ax - abx * t, py - ay - aby * t);
}

/**
 * Coverage of the drag arrow at a master pixel: a dashed shaft between the two
 * icon drop points and a chevron head pointing at Applications. Everything is
 * a rounded stroke, so coverage is distance to a capsule.
 */
function arrowCoverage(x: number, y: number): number {
  const halfThickness = 2 * master;
  const dash = 14 * master;
  const gap = 10 * master;
  const shaftStart = 214 * master;
  const shaftEnd = 312 * master;
  const tipX = 330 * master;
  const centerY = iconY * master;
  let distance = Infinity;
  for (let start = shaftStart; start < shaftEnd; start += dash + gap) {
    const end = Math.min(start + dash, shaftEnd);
    distance = Math.min(distance, capsuleDistance(x, y, start, centerY, end, centerY));
  }
  distance = Math.min(distance, capsuleDistance(x, y, tipX, centerY, tipX - 18 * master, centerY - 12 * master));
  distance = Math.min(distance, capsuleDistance(x, y, tipX, centerY, tipX - 18 * master, centerY + 12 * master));
  return Math.min(Math.max(halfThickness + 0.5 - distance, 0), 1);
}

function renderMaster(mask: RgbaImage): FloatImage {
  const width = window.width * master;
  const height = window.height * master;
  const rgb = new Float32Array(width * height * 3);
  const shieldTargetHeight = shieldHeight * master;
  const shieldTargetWidth = (shieldTargetHeight * mask.width) / mask.height;
  const shieldLeft = (width - shieldTargetWidth) / 2;
  const shieldTopPx = shieldTop * master;
  const glowCenterX = width / 2;
  const glowCenterY = (shieldTop + shieldHeight / 2) * master;
  const glowRadius = 150 * master;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const glow = 0.35 * Math.exp(-((x - glowCenterX) ** 2 + (y - glowCenterY) ** 2) / (glowRadius * glowRadius));
      let r = background.r + (glowColor.r - background.r) * glow;
      let g = background.g + (glowColor.g - background.g) * glow;
      let b = background.b + (glowColor.b - background.b) * glow;
      let shield = 0;
      if (x >= shieldLeft && x < shieldLeft + shieldTargetWidth && y >= shieldTopPx && y < shieldTopPx + shieldTargetHeight) {
        const u = ((x - shieldLeft + 0.5) * mask.width) / shieldTargetWidth - 0.5;
        const v = ((y - shieldTopPx + 0.5) * mask.height) / shieldTargetHeight - 0.5;
        shield = sampleAlphaBilinear(mask, u, v) / 255;
      }
      // The arrow stays a hint rather than a signpost: half-strength steel.
      const ink = Math.min(shield + arrowCoverage(x, y) * 0.5, 1);
      r += (steel.r - r) * ink;
      g += (steel.g - g) * ink;
      b += (steel.b - b) * ink;
      const i = (y * width + x) * 3;
      rgb[i] = r;
      rgb[i + 1] = g;
      rgb[i + 2] = b;
    }
  }
  return { width, height, rgb };
}

function halve(image: FloatImage): FloatImage {
  const width = image.width / 2;
  const height = image.height / 2;
  const rgb = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let c = 0; c < 3; c += 1) {
        const a = image.rgb[((y * 2) * image.width + x * 2) * 3 + c] ?? 0;
        const b = image.rgb[((y * 2) * image.width + x * 2 + 1) * 3 + c] ?? 0;
        const d = image.rgb[((y * 2 + 1) * image.width + x * 2) * 3 + c] ?? 0;
        const e = image.rgb[((y * 2 + 1) * image.width + x * 2 + 1) * 3 + c] ?? 0;
        rgb[(y * width + x) * 3 + c] = (a + b + d + e) / 4;
      }
    }
  }
  return { width, height, rgb };
}

/**
 * Deterministic per-pixel noise in [-0.5, 0.5), so the glow quantizes without
 * banding and the file still builds byte-identical every run.
 */
function ditherNoise(x: number, y: number, channel: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(channel, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) / 4294967296 - 0.5;
}

function quantize(image: FloatImage): Uint8Array {
  const bytes = new Uint8Array(image.width * image.height * 3);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      for (let c = 0; c < 3; c += 1) {
        const i = (y * image.width + x) * 3 + c;
        const value = Math.round((image.rgb[i] ?? 0) + ditherNoise(x, y, c));
        bytes[i] = Math.min(Math.max(value, 0), 255);
      }
    }
  }
  return bytes;
}

type TiffPage = { width: number; height: number; rgb: Uint8Array; dpi: number };

/**
 * A multi-representation TIFF, which is how Finder is told about Retina: one
 * file, a 72dpi page and a 144dpi page, and Finder picks by screen. Pages are
 * deflate-compressed with horizontal differencing — both understood by
 * ImageIO, which is the only consumer this file will ever have.
 */
function writeTiff(pages: TiffPage[]): Buffer {
  const entryCount = 13;
  const parts = pages.map((page) => {
    const stride = page.width * 3;
    const raw = Buffer.from(page.rgb);
    for (let y = 0; y < page.height; y += 1) {
      for (let i = stride - 1; i >= 3; i -= 1) {
        raw[y * stride + i] = ((raw[y * stride + i] ?? 0) - (raw[y * stride + i - 3] ?? 0)) & 255;
      }
    }
    const data = zlib.deflateSync(raw, { level: 9 });
    return { page, data };
  });
  let cursor = 8;
  const layout = parts.map(({ data }) => {
    const extrasOffset = cursor;
    const dataOffset = extrasOffset + 22;
    const ifdOffset = dataOffset + data.length + (data.length % 2);
    cursor = ifdOffset + 2 + entryCount * 12 + 4;
    return { extrasOffset, dataOffset, ifdOffset };
  });
  const file = Buffer.alloc(cursor);
  file.write("II", 0, "ascii");
  file.writeUInt16LE(42, 2);
  file.writeUInt32LE(layout[0]?.ifdOffset ?? 0, 4);
  parts.forEach(({ page, data }, index) => {
    const { extrasOffset, dataOffset, ifdOffset } = layout[index] ?? { extrasOffset: 0, dataOffset: 0, ifdOffset: 0 };
    file.writeUInt16LE(8, extrasOffset);
    file.writeUInt16LE(8, extrasOffset + 2);
    file.writeUInt16LE(8, extrasOffset + 4);
    file.writeUInt32LE(page.dpi, extrasOffset + 6);
    file.writeUInt32LE(1, extrasOffset + 10);
    file.writeUInt32LE(page.dpi, extrasOffset + 14);
    file.writeUInt32LE(1, extrasOffset + 18);
    data.copy(file, dataOffset);
    const entries: [number, number, number, number][] = [
      [256, 4, 1, page.width],
      [257, 4, 1, page.height],
      [258, 3, 3, extrasOffset],
      [259, 3, 1, 8],
      [262, 3, 1, 2],
      [273, 4, 1, dataOffset],
      [277, 3, 1, 3],
      [278, 4, 1, page.height],
      [279, 4, 1, data.length],
      [282, 5, 1, extrasOffset + 6],
      [283, 5, 1, extrasOffset + 14],
      [296, 3, 1, 2],
      [317, 3, 1, 2],
    ];
    file.writeUInt16LE(entries.length, ifdOffset);
    entries.forEach(([tag, type, count, value], entry) => {
      const at = ifdOffset + 2 + entry * 12;
      file.writeUInt16LE(tag, at);
      file.writeUInt16LE(type, at + 2);
      file.writeUInt32LE(count, at + 4);
      if (type === 3 && count === 1) {
        file.writeUInt16LE(value, at + 8);
      } else {
        file.writeUInt32LE(value, at + 8);
      }
    });
    const next = layout[index + 1]?.ifdOffset ?? 0;
    file.writeUInt32LE(next, ifdOffset + 2 + entries.length * 12);
  });
  return file;
}

const mask = readPng(maskPath);
const retina = halve(renderMaster(mask));
const base = halve(retina);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(
  outPath,
  writeTiff([
    { width: base.width, height: base.height, rgb: quantize(base), dpi: 72 },
    { width: retina.width, height: retina.height, rgb: quantize(retina), dpi: 144 },
  ]),
);
process.stdout.write(`Wrote the ${window.width}x${window.height} DMG background (1x and 2x) to ${path.relative(desktopRoot, outPath)}.\n`);
