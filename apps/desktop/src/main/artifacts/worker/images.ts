/**
 * Image intake for the document engines.
 *
 * Two jobs, and the second is the important one. Reading the intrinsic size
 * lets a picture be fitted into its box without distorting it. Refusing
 * anything that is not PNG, JPEG, or GIF is what keeps the engines out of the
 * territory where every image library has an unfixed denial-of-service — the
 * ICNS, JXL, and HEIF parsers — by never handing those bytes to a parser at
 * all. The check is on the magic bytes, not the extension, so renaming a file
 * does not get it past this.
 */

import { readRegularFileSync } from "../../readFile.js";

export type ImageFormat = "png" | "jpeg" | "gif";

export type LoadedImage = {
  bytes: Buffer;
  format: ImageFormat;
  /** Pixels. Zero when the header did not state it. */
  width: number;
  height: number;
};

export class ImageError extends Error {}

/** What a single embedded image may weigh. */
export const maxImageBytes = 12 * 1024 * 1024;

export function loadImage(absolutePath: string): LoadedImage {
  let bytes: Buffer;
  try {
    bytes = readRegularFileSync(absolutePath, maxImageBytes);
  } catch (error) {
    if (error instanceof ImageError) throw error;
    throw new ImageError(`could not be read (${String(error instanceof Error ? error.message : error)})`);
  }
  const format = detectFormat(bytes);
  if (!format) {
    throw new ImageError(
      "is not a PNG, JPEG, or GIF. Convert it first; other formats are not embedded.",
    );
  }
  const size = readSize(bytes, format);
  return { bytes, format, ...size };
}

function detectFormat(bytes: Buffer): ImageFormat | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 6 && bytes.toString("ascii", 0, 6).match(/^GIF8[79]a$/)) return "gif";
  return undefined;
}

function readSize(bytes: Buffer, format: ImageFormat): { width: number; height: number } {
  try {
    if (format === "png") {
      // IHDR is always the first chunk, at a fixed offset.
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (format === "gif") {
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }
    return readJpegSize(bytes);
  } catch {
    // A header this parser cannot read is not fatal: the image still embeds,
    // and the aspect check simply has nothing to say about it.
    return { width: 0, height: 0 };
  }
}

/**
 * Walks JPEG segments to the start-of-frame marker.
 *
 * The dimensions are not at a fixed offset in a JPEG — they live in whichever
 * SOFn segment the encoder wrote, after any number of application and quantise
 * segments.
 */
function readJpegSize(bytes: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    if (length < 2) break;
    offset += 2 + length;
  }
  return { width: 0, height: 0 };
}

/** Scales an image to sit inside a box without changing its aspect ratio. */
export function fitInside(
  image: { width: number; height: number },
  box: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  if (image.width <= 0 || image.height <= 0) return box;
  const scale = Math.min(box.width / image.width, box.height / image.height);
  const width = Math.round(image.width * scale);
  const height = Math.round(image.height * scale);
  return {
    x: box.x + Math.round((box.width - width) / 2),
    y: box.y + Math.round((box.height - height) / 2),
    width,
    height,
  };
}
