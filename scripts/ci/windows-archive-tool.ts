// The builder's Windows 7za cannot decode NSIS. Provision the full vendor tool
// in a private directory, without executing its installer or accepting PATH.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { verifyPeArchitecture } from "../../apps/desktop/scripts/verify-pe.ts";

export async function withWindowsArchiveTool<T>(operation: (tool: string) => T | Promise<T>): Promise<T> {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) throw new Error("Unsupported full Windows archive tool target.");
  if (process.env.ELECTRON_BUILDER_7ZIP_PATH) throw new Error("Windows archive verification requires the reviewed toolset without overrides.");
  const pin = JSON.parse(fs.readFileSync(new URL("../../third_party/7zip.json", import.meta.url), "utf8"));
  const target = pin.targets[`win32-${process.arch}`];
  const names = ["7z.exe", "7z.dll", "License.txt"];
  if (!/^\d{2}\.\d{2}$/.test(pin.version) || target.url !== `https://github.com/ip7z/7zip/releases/download/${pin.version}/7z${pin.version.replace(".", "")}-${process.arch}.exe`
      || !Number.isSafeInteger(target.bytes) || target.bytes <= 0 || target.bytes > 2_000_000 || !/^[0-9a-f]{64}$/.test(target.sha256)
      || JSON.stringify(Object.keys(target.files).sort()) !== JSON.stringify([...names].sort())
      || names.some((name) => !/^[0-9a-f]{64}$/.test(target.files[name]))) throw new Error("Invalid reviewed Windows archive tool pin.");
  const directory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), "umbratic-7zip-"));
  const digest = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
  try {
    const response = await fetch(target.url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok || !response.body) throw new Error("Unable to download the reviewed Windows archive tool.");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > target.bytes) throw new Error("Windows archive tool download exceeded its reviewed size.");
      chunks.push(Buffer.from(chunk));
    }
    const archive = Buffer.concat(chunks);
    if (size !== target.bytes || digest(archive) !== target.sha256) throw new Error("Windows archive tool archive checksum mismatch.");
    const input = path.join(directory, "vendor.exe");
    fs.writeFileSync(input, archive, { flag: "wx" });
    const bootstrap = await createRequire(import.meta.url)("app-builder-lib/out/toolsets/7zip").getPath7za();
    for (const name of names) {
      const bytes = execFileSync(bootstrap, ["e", "-so", "-t7z", input, name], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
      if (digest(bytes) !== target.files[name]) throw new Error(`Windows archive tool member checksum mismatch: ${name}`);
      const file = path.join(directory, name);
      fs.writeFileSync(file, bytes, { flag: "wx" });
      if (name !== "License.txt") verifyPeArchitecture(file, process.arch);
    }
    fs.rmSync(input);
    return await operation(path.join(directory, "7z.exe"));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
