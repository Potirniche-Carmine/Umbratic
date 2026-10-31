import fs from "node:fs";

/** Check the actual compiled payload, independently of its artifact filename. */
export function verifyPeArchitecture(file: string, arch: string): void {
  const expected = arch === "arm64" ? 0xaa64 : arch === "x64" ? 0x8664 : null;
  if (expected === null) throw new Error("Unsupported Windows payload architecture.");
  const fd = fs.openSync(file, "r");
  try {
    const dos = Buffer.alloc(64);
    if (fs.readSync(fd, dos, 0, dos.length, 0) !== dos.length || dos.toString("ascii", 0, 2) !== "MZ") throw new Error(`Invalid Windows executable: ${file}`);
    const offset = dos.readUInt32LE(0x3c);
    const header = Buffer.alloc(6);
    if (offset > fs.fstatSync(fd).size - header.length || fs.readSync(fd, header, 0, header.length, offset) !== header.length
        || header.readUInt32LE(0) !== 0x00004550 || header.readUInt16LE(4) !== expected) {
      throw new Error(`Windows executable architecture does not match ${arch}: ${file}`);
    }
  } finally { fs.closeSync(fd); }
}
