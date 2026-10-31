import * as fs from "node:fs";

/** Read one regular file through the descriptor whose identity and size we check. */
export function readRegularFileSync(filePath: string, byteLimit: number): Buffer {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    const entry = fs.lstatSync(filePath);
    if (!stat.isFile() || entry.isSymbolicLink()) throw new Error("Expected a regular file.");
    if (stat.dev !== entry.dev || stat.ino !== entry.ino) throw new Error("The file changed while opening it.");
    if (stat.size > byteLimit) throw new Error("The file exceeds the byte limit.");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("The file changed while reading it.");
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw new Error("The file changed while reading it.");
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}
