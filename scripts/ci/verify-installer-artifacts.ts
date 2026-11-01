// Exercise archive generation and updater metadata without release credentials.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { verifyUpdateChannel } from "./release-artifacts.ts";
import { withWindowsArchiveTool } from "./windows-archive-tool.ts";

const root = path.resolve("target/release/desktop");
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const prefix = `Umbratic-${version}`;
if (process.platform !== "darwin" && process.platform !== "win32") throw new Error("Unsupported installer host.");
const channel = process.platform === "darwin" ? "latest-mac.yml" : "latest.yml";
const installer = process.platform === "darwin" ? `${prefix}.zip` : `${prefix}-${process.arch}.exe`;
const files = verifyUpdateChannel(root, version, channel, installer);
const { getPath7za } = createRequire(import.meta.url)("app-builder-lib/out/toolsets/7zip");
function verifyArchives(archiveTool: string): void {
  for (const name of files.filter((file) => /\.(exe|zip)$/.test(file))) {
    execFileSync(archiveTool, ["t", ...(process.platform === "win32" ? ["-tNsis"] : []), path.join(root, name)], { encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  }
}
if (process.platform === "win32") await withWindowsArchiveTool(verifyArchives);
else verifyArchives(await getPath7za());
if (process.platform === "darwin") {
  const dmg = `${prefix}.dmg`;
  if (!files.includes(dmg)) throw new Error("The macOS updater metadata must include the disk image.");
  execFileSync("hdiutil", ["verify", path.join(root, dmg)], { encoding: "utf8", timeout: 120_000 });
}
console.log(`Verified installer archives and updater checksums for ${process.platform}/${process.arch}.`);
