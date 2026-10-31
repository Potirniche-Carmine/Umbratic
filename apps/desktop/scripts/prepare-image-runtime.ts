import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import JSZip from "jszip";
import { buildMacImageRuntime } from "./build-image-runtime.ts";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const destination = path.join(desktopRoot, ".package", "image-runtime");
const pin = JSON.parse(await fs.readFile(path.resolve(desktopRoot, "../../third_party/stable-diffusion.cpp.json"), "utf8"));
const asset = pin.assets[`${process.platform}-${process.arch}`];
const receipt = path.join(destination, "sha256");
const executable = process.platform === "win32" ? "sd-cli.exe" : "sd-cli";

function verifyExecutable() {
  const result = spawnSync(path.join(destination, executable), ["--help"], { encoding: "utf8", timeout: 15000 });
  if (result.status !== 0 || !`${result.stdout}${result.stderr}`.includes(pin.commit)) {
    throw new Error("The image runtime did not identify the reviewed revision.");
  }
}

if (process.platform === "darwin") {
  await buildMacImageRuntime(pin.macSource, destination);
  await fs.copyFile(path.resolve(desktopRoot, "../../third_party/stable-diffusion-notices.txt"), path.join(destination, "third-party-notices.txt"));
  verifyExecutable();
} else if (!asset) {
  // Keep the desktop build available on platforms without a reviewed runtime.
  // No executable means Veil does not advertise image generation there.
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, "unavailable.txt"), "Image generation is not available on this platform.\n");
  console.log("No reviewed image runtime is available on this platform.");
} else if (await fs.readFile(receipt, "utf8").catch(() => "") === asset.sha256) {
  verifyExecutable();
} else {
  const url = new URL(asset.url);
  if (url.origin !== "https://github.com" || !url.pathname.startsWith("/leejet/stable-diffusion.cpp/releases/download/")) throw new Error("Unreviewed image runtime origin.");
  console.log(`Preparing image runtime ${pin.release}…`);
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Image runtime download failed (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== asset.bytes || crypto.createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error("Image runtime checksum mismatch.");
  const zip = await JSZip.loadAsync(bytes);
  await fs.mkdir(destination, { recursive: true });
  // Closed file set: do not unpack servers, nested paths, or executable extras.
  const entries = Object.values(zip.files).filter((file) => !file.dir && file.name === path.basename(file.name)
    && (file.name === executable || /\.(dylib|dll|so|txt)(\.\d+)*$/.test(file.name)));
  if (!entries.some((file) => file.name === executable)) throw new Error("The image runtime archive has no CLI.");
  for (const file of entries) {
    const target = path.join(destination, file.name);
    await fs.writeFile(target, await file.async("nodebuffer"), { mode: 0o755 });
  }
  verifyExecutable();
  await fs.writeFile(receipt, asset.sha256);
}
if (asset || process.platform === "darwin") console.log("Image runtime verified.");
