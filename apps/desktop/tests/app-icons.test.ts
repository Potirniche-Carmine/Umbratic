import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import zlib from "node:zlib";

const png512 = new URL("../assets/brand/Umbratic/umbratic-icon-512.png", import.meta.url);
const icnsUrl = new URL("../assets/icons/icon.icns", import.meta.url);
const icoUrl = new URL("../assets/icons/icon.ico", import.meta.url);
const configUrl = new URL("../electron-builder.yml", import.meta.url);

type RgbaImage = { width: number; height: number; pixels: Buffer };

function decodePng(data: Buffer, label: string): RgbaImage {
  assert.equal(data.subarray(0, 8).toString("binary"), "\x89PNG\r\n\x1a\n", label);
  let width = 0;
  let height = 0;
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
      assert.equal(chunk[8], 8, label);
      assert.equal(chunk[9], 6, label);
    } else if (type === "IDAT") {
      idat.push(chunk);
    } else if (type === "IEND") {
      break;
    }
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * (stride + 1)], 0, `${label} filter`);
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }
  return { width, height, pixels };
}

/** Matches `cornerRadiusRatio` in scripts/generate-app-icons.ts. */
const cornerRadiusRatio = 0.2237;

function alphaAt(image: RgbaImage, x: number, y: number): number {
  return image.pixels[(y * image.width + x) * 4 + 3] ?? 0;
}

function tileMetrics(image: RgbaImage) {
  let minX = image.width;
  let minY = image.height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const i = (y * image.width + x) * 4;
      // The rounded corner is the only transparency in the tile, and it is
      // background rather than mark, so it says nothing about where the shield
      // reaches.
      if ((image.pixels[i + 3] ?? 0) === 0) continue;
      const r = image.pixels[i] ?? 0;
      const g = image.pixels[i + 1] ?? 0;
      const b = image.pixels[i + 2] ?? 0;
      if (Math.abs(r - 11) + Math.abs(g - 13) + Math.abs(b - 16) > 30) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return {
    widthRatio: (maxX - minX + 1) / image.width,
    heightRatio: (maxY - minY + 1) / image.height,
  };
}

/**
 * The tile is app-coloured, carries a large shield, and is rounded at exactly
 * the radius the generator claims.
 *
 * The radius is measured rather than eyeballed: on the top row, the first fully
 * opaque pixel sits one corner radius in from the edge, which is a property of
 * the rounded rectangle and pins the shape rather than merely observing that
 * the corner pixel is clear.
 */
function assertRoundedTile(image: RgbaImage, label: string) {
  const metrics = tileMetrics(image);
  assert.ok(metrics.heightRatio >= 0.64, `${label} height ${metrics.heightRatio}`);
  assert.ok(metrics.widthRatio >= 0.5, `${label} width ${metrics.widthRatio}`);

  // Clear at the corner, solid app colour halfway along the edge.
  assert.equal(alphaAt(image, 0, 0), 0, `${label} corner should be cut away`);
  const middle = Math.floor(image.width / 2);
  assert.deepEqual(
    [image.pixels[middle * 4], image.pixels[middle * 4 + 1], image.pixels[middle * 4 + 2], image.pixels[middle * 4 + 3]],
    [11, 13, 16, 255],
    `${label} edge midpoint should be opaque app colour`,
  );

  let firstOpaque = 0;
  while (firstOpaque < image.width && alphaAt(image, firstOpaque, 0) < 255) firstOpaque += 1;
  const expected = image.width * cornerRadiusRatio;
  assert.ok(
    Math.abs(firstOpaque - expected) <= Math.max(1, image.width * 0.02),
    `${label} corner radius reads as ${firstOpaque}px, expected about ${expected.toFixed(1)}px`,
  );
}

function icnsPng(data: Buffer, type: string): Buffer {
  assert.equal(data.subarray(0, 4).toString("ascii"), "icns");
  let offset = 8;
  while (offset + 8 <= data.length) {
    const ostype = data.subarray(offset, offset + 4).toString("ascii");
    const size = data.readUInt32BE(offset + 4);
    if (ostype === type) return data.subarray(offset + 8, offset + size);
    offset += size;
  }
  throw new Error(`missing ${type} in icon.icns`);
}

function icoPng(data: Buffer, size: number): Buffer {
  assert.equal(data.readUInt16LE(0), 0);
  assert.equal(data.readUInt16LE(2), 1);
  const count = data.readUInt16LE(4);
  for (let i = 0; i < count; i += 1) {
    const entry = data.subarray(6 + i * 16, 6 + (i + 1) * 16);
    const width = entry[0] === 0 ? 256 : entry[0];
    const bytes = entry.readUInt32LE(8);
    const offset = entry.readUInt32LE(12);
    if (width === size) return data.subarray(offset, offset + bytes);
  }
  throw new Error(`missing ${size}px frame in icon.ico`);
}

test("the dock PNG is a round-cornered app-colored tile with a large shield", () => {
  const image = decodePng(fs.readFileSync(png512), "512");
  assert.equal(image.width, 512);
  assert.equal(image.height, 512);
  assertRoundedTile(image, "512");
});

test("the macOS icns and Windows ico share the rounded tile, including installer frames", () => {
  const icns = fs.readFileSync(icnsUrl);
  const ico = fs.readFileSync(icoUrl);
  assertRoundedTile(decodePng(icnsPng(icns, "ic10"), "icns-1024"), "icns-1024");
  assertRoundedTile(decodePng(icoPng(ico, 256), "ico-256"), "ico-256");

  // The smallest frame is where rounding is easiest to lose: four pixels of
  // radius, and a reduction that has to carry alpha rather than force it solid.
  const small = decodePng(icoPng(ico, 16), "ico-16");
  assert.equal(small.width, 16);
  assert.equal(small.pixels[3], 0, "the 16px corner should be cut away too");
  const middle = 8 * 4;
  assert.deepEqual(
    [small.pixels[middle], small.pixels[middle + 1], small.pixels[middle + 2], small.pixels[middle + 3]],
    [11, 13, 16, 255],
  );
});

test("the DMG and both Windows installers are wired to the filled icons", () => {
  const config = fs.readFileSync(configUrl, "utf8");
  const mac = config.slice(config.indexOf("\nmac:"), config.indexOf("\ndmg:"));
  const dmg = config.slice(config.indexOf("\ndmg:"), config.indexOf("\nwin:"));
  const win = config.slice(config.indexOf("\nwin:"), config.indexOf("\nnsis:"));
  const nsis = config.slice(config.indexOf("\nnsis:"));
  assert.match(mac, /^  icon: assets\/icons\/icon\.icns$/m);
  assert.match(dmg, /^  icon: assets\/icons\/icon\.icns$/m);
  assert.match(win, /^  icon: assets\/icons\/icon\.ico$/m);
  assert.match(nsis, /^  installerIcon: assets\/icons\/icon\.ico$/m);
  assert.match(nsis, /^  uninstallerIcon: assets\/icons\/icon\.ico$/m);
});
