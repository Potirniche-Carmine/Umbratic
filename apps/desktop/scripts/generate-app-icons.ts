import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const maskPath = path.join(desktopRoot, "assets/brand/Umbratic/umbratic-icon-no-padding-transparent.png");
const brandDir = path.join(desktopRoot, "assets/brand/Umbratic");
const iconsDir = path.join(desktopRoot, "assets/icons");

// App chrome, not a generic black: the dock and installer tiles should read as
// the same surface as the window.
const background = { r: 11, g: 13, b: 16 };
// Same off-white as the title-bar mark (`--text` in the app chrome).
const steel = { r: 236, g: 239, b: 243 };
const masterSize = 1024;
const shieldHeightRatio = 0.729;
const icnsFrames = [
  { type: "icp4", size: 16 },
  { type: "icp5", size: 32 },
  { type: "ic11", size: 32 },
  { type: "icp6", size: 64 },
  { type: "ic12", size: 64 },
  { type: "ic07", size: 128 },
  { type: "ic08", size: 256 },
  { type: "ic13", size: 256 },
  { type: "ic09", size: 512 },
  { type: "ic14", size: 512 },
  { type: "ic10", size: 1024 },
] as const;
const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256] as const;

type RgbaImage = { width: number; height: number; pixels: Uint8Array };

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

function writePng(image: RgbaImage): Buffer {
  const { width, height, pixels } = image;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const chunks = [pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })), pngChunk("IEND", Buffer.alloc(0))];
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  const chunk = Buffer.alloc(4 + body.length + 4);
  chunk.writeUInt32BE(data.length, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(zlib.crc32(body), 4 + body.length);
  return chunk;
}

function sampleAlpha(image: RgbaImage, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return 0;
  return image.pixels[(y * image.width + x) * 4 + 3] ?? 0;
}

function sampleAlphaBilinear(image: RgbaImage, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const tx = x - x0;
  const ty = y - y0;
  const a00 = sampleAlpha(image, x0, y0);
  const a10 = sampleAlpha(image, x1, y0);
  const a01 = sampleAlpha(image, x0, y1);
  const a11 = sampleAlpha(image, x1, y1);
  return (a00 * (1 - tx) + a10 * tx) * (1 - ty) + (a01 * (1 - tx) + a11 * tx) * ty;
}

function composeMaster(mask: RgbaImage): RgbaImage {
  const pixels = new Uint8Array(masterSize * masterSize * 4);
  const targetHeight = Math.round(masterSize * shieldHeightRatio);
  const targetWidth = Math.round(targetHeight * (mask.width / mask.height));
  const offsetX = Math.round((masterSize - targetWidth) / 2);
  const offsetY = Math.round((masterSize - targetHeight) / 2);
  for (let y = 0; y < masterSize; y += 1) {
    for (let x = 0; x < masterSize; x += 1) {
      const i = (y * masterSize + x) * 4;
      let coverage = 0;
      if (x >= offsetX && x < offsetX + targetWidth && y >= offsetY && y < offsetY + targetHeight) {
        const u = ((x - offsetX + 0.5) * mask.width) / targetWidth - 0.5;
        const v = ((y - offsetY + 0.5) * mask.height) / targetHeight - 0.5;
        coverage = sampleAlphaBilinear(mask, u, v) / 255;
      }
      pixels[i] = Math.round(background.r + (steel.r - background.r) * coverage);
      pixels[i + 1] = Math.round(background.g + (steel.g - background.g) * coverage);
      pixels[i + 2] = Math.round(background.b + (steel.b - background.b) * coverage);
      pixels[i + 3] = 255;
    }
  }
  return { width: masterSize, height: masterSize, pixels };
}

function scaleOpaque(source: RgbaImage, size: number): RgbaImage {
  if (size === source.width && size === source.height) return source;
  const pixels = new Uint8Array(size * size * 4);
  const scale = source.width / size;
  for (let y = 0; y < size; y += 1) {
    const y0 = y * scale;
    const y1 = (y + 1) * scale;
    for (let x = 0; x < size; x += 1) {
      const x0 = x * scale;
      const x1 = (x + 1) * scale;
      let r = 0;
      let g = 0;
      let b = 0;
      let area = 0;
      const rowStart = Math.floor(y0);
      const rowEnd = Math.min(source.height - 1, Math.ceil(y1) - 1);
      const colStart = Math.floor(x0);
      const colEnd = Math.min(source.width - 1, Math.ceil(x1) - 1);
      for (let sy = rowStart; sy <= rowEnd; sy += 1) {
        const rowOverlap = Math.min(y1, sy + 1) - Math.max(y0, sy);
        for (let sx = colStart; sx <= colEnd; sx += 1) {
          const colOverlap = Math.min(x1, sx + 1) - Math.max(x0, sx);
          const weight = rowOverlap * colOverlap;
          const i = (sy * source.width + sx) * 4;
          r += (source.pixels[i] ?? 0) * weight;
          g += (source.pixels[i + 1] ?? 0) * weight;
          b += (source.pixels[i + 2] ?? 0) * weight;
          area += weight;
        }
      }
      const dest = (y * size + x) * 4;
      pixels[dest] = Math.round(r / area);
      pixels[dest + 1] = Math.round(g / area);
      pixels[dest + 2] = Math.round(b / area);
      pixels[dest + 3] = 255;
    }
  }
  return { width: size, height: size, pixels };
}

function writeIco(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  const blobs: Buffer[] = [header, entries];
  let offset = 6 + entries.length;
  images.forEach((image, index) => {
    const entry = entries.subarray(index * 16, (index + 1) * 16);
    entry[0] = image.size >= 256 ? 0 : image.size;
    entry[1] = image.size >= 256 ? 0 : image.size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    blobs.push(image.png);
    offset += image.png.length;
  });
  return Buffer.concat(blobs);
}

function writeIcns(master: RgbaImage): Buffer {
  const blocks = icnsFrames.map((frame) => {
    const png = writePng(scaleOpaque(master, frame.size));
    const block = Buffer.alloc(8 + png.length);
    block.write(frame.type, 0, 4, "ascii");
    block.writeUInt32BE(block.length, 4);
    png.copy(block, 8);
    return block;
  });
  const total = 8 + blocks.reduce((sum, block) => sum + block.length, 0);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(total, 4);
  return Buffer.concat([header, ...blocks]);
}

const mask = readPng(maskPath);
const master = composeMaster(mask);
fs.mkdirSync(brandDir, { recursive: true });
fs.mkdirSync(iconsDir, { recursive: true });
fs.writeFileSync(path.join(brandDir, "umbratic-icon-512.png"), writePng(scaleOpaque(master, 512)));
fs.writeFileSync(path.join(iconsDir, "icon.ico"), writeIco(icoSizes.map((size) => ({ size, png: writePng(scaleOpaque(master, size)) }))));
fs.writeFileSync(path.join(iconsDir, "icon.icns"), writeIcns(master));
process.stdout.write("Wrote filled Umbratic app icons for macOS, Windows, and the installers.\n");
