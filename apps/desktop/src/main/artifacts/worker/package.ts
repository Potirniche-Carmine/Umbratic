/**
 * An OOXML package held in memory as named parts.
 *
 * Every engine reads a file into this shape, works on it, and writes it back.
 * The reason it is a plain map of path → bytes rather than a live JSZip handle
 * is the byte-identity rule: an edit that did not target a part has to write
 * that part out unchanged, and the only way to be sure of that is to never
 * decode it. Parts arrive as `Buffer`, and only the ones an op actually touches
 * are turned into text and back.
 */

import JSZip from "jszip";

/** What an engine will open, inflated. Beyond this a zip is refused unread. */
export const maxInflatedBytes = 64 * 1024 * 1024;
/** A single part that dwarfs the others is the shape a zip bomb takes. */
const maxPartBytes = 32 * 1024 * 1024;

export class PackageError extends Error {
  constructor(
    message: string,
    readonly kind: "encrypted" | "corrupt" | "too-large" = "corrupt",
  ) {
    super(message);
  }
}

function readPart(entry: JSZip.JSZipObject, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const stream = entry.nodeStream("nodebuffer");
    const fail = (error: PackageError) => {
      failed = true;
      stream.pause();
      chunks.length = 0;
      reject(error);
    };
    stream.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        // Pause before retaining the chunk. Backpressure stops the inflater;
        // checking after entry.async() already allocated the entire zip bomb.
        fail(new PackageError(`Part ${entry.name} exceeds the remaining ${limit}-byte limit.`, "too-large"));
        return;
      }
      chunks.push(chunk);
    });
    stream.once("error", (error) => fail(new PackageError(`Part ${entry.name} could not be read: ${error.message}`)));
    stream.once("end", () => { if (!failed) resolve(Buffer.concat(chunks, size)); });
  });
}

export class OoxmlPackage {
  private constructor(private readonly parts: Map<string, Buffer>) {}

  static empty(): OoxmlPackage {
    return new OoxmlPackage(new Map());
  }

  static async read(bytes: Buffer): Promise<OoxmlPackage> {
    // An OLE compound file starts with this signature. Both a legacy .ppt and
    // an encrypted .pptx look like this, and neither is a zip, so the failure
    // has to be named here rather than surfacing as "corrupt zip".
    if (bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
      throw new PackageError(
        "The file is an OLE compound document: either encrypted, or a legacy binary format.",
        "encrypted",
      );
    }
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch (error) {
      throw new PackageError(
        `The file could not be opened as an OOXML package: ${String(
          error instanceof Error ? error.message : error,
        )}`,
      );
    }
    const parts = new Map<string, Buffer>();
    let inflated = 0;
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      // A zip entry may name any path it likes, including one that walks out of
      // the extraction root. Nothing here writes entries to disk, but the names
      // become part identifiers and relationship targets, so a traversal is
      // refused rather than normalised into something that looks legitimate.
      const originalName = entry.unsafeOriginalName ?? name;
      if ([name, originalName].some((value) => value.includes("..") || value.startsWith("/") || value.includes("\\"))) {
        throw new PackageError(`The package contains an unsafe entry name: ${name}`);
      }
      const content = await readPart(entry, Math.min(maxPartBytes, maxInflatedBytes - inflated));
      inflated += content.byteLength;
      parts.set(name, content);
    }
    if (parts.size === 0) throw new PackageError("The package contains no parts.");
    return new OoxmlPackage(parts);
  }

  has(path: string): boolean {
    return this.parts.has(path);
  }

  names(): string[] {
    return [...this.parts.keys()].sort();
  }

  /** Part names under a directory, numerically ordered where they are numbered. */
  namesUnder(prefix: string): string[] {
    return this.names()
      .filter((name) => name.startsWith(prefix))
      .sort((left, right) => numericSuffix(left) - numericSuffix(right));
  }

  bytes(path: string): Buffer | undefined {
    return this.parts.get(path);
  }

  text(path: string): string | undefined {
    const bytes = this.parts.get(path);
    return bytes ? stripBom(bytes.toString("utf8")) : undefined;
  }

  set(path: string, content: string | Buffer): void {
    this.parts.set(path, typeof content === "string" ? Buffer.from(content, "utf8") : content);
  }

  delete(path: string): void {
    this.parts.delete(path);
  }

  clone(): OoxmlPackage {
    return new OoxmlPackage(new Map(this.parts));
  }

  async write(): Promise<Buffer> {
    const zip = new JSZip();
    // [Content_Types].xml must be the first entry for some consumers; JSZip
    // preserves insertion order, so it is added first rather than sorted into
    // place by luck.
    const ordered = this.names().sort((left, right) => {
      if (left === "[Content_Types].xml") return -1;
      if (right === "[Content_Types].xml") return 1;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    for (const name of ordered) {
      // A fixed date keeps the output byte-reproducible: two identical specs
      // must produce two identical files, or the golden tests are testing the
      // clock.
      // OOXML needs file paths, not directory records. Implicit directories
      // would otherwise receive JSZip's current-clock timestamp.
      zip.file(name, this.parts.get(name) as Buffer, { date: new Date(0), createFolders: false });
    }
    return zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
  }
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function numericSuffix(name: string): number {
  const match = /(\d+)\.[a-z]+$/i.exec(name);
  return match ? Number(match[1]) : 0;
}

/** `ppt/slides/slide1.xml` → `ppt/slides/_rels/slide1.xml.rels`. */
export function relationshipPartFor(partName: string): string {
  const slash = partName.lastIndexOf("/");
  const directory = slash === -1 ? "" : partName.slice(0, slash + 1);
  const file = slash === -1 ? partName : partName.slice(slash + 1);
  return `${directory}_rels/${file}.rels`;
}

/** Resolves a relationship target, which is relative to the part's directory. */
export function resolveRelativePart(fromPart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const segments = fromPart.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}
