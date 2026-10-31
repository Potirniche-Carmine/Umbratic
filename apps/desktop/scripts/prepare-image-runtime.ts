import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildImageRuntime, verifyImageRuntimeGgufBounds } from "./build-image-runtime.ts";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const destination = path.join(desktopRoot, ".package", "image-runtime");
const pin = JSON.parse(await fs.readFile(path.resolve(desktopRoot, "../../third_party/stable-diffusion.cpp.json"), "utf8"));
const target = `${process.platform}-${process.arch}`;
if (!pin.targets.includes(target)) {
  // No reviewed image runtime means Veil does not advertise image generation.
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, "unavailable.txt"), "Image generation is not available on this platform.\n");
  console.log("No reviewed image runtime is available on this platform.");
} else {
  await buildImageRuntime(pin.source, destination);
  await fs.copyFile(path.resolve(desktopRoot, "../../third_party/stable-diffusion-notices.txt"), path.join(destination, "third-party-notices.txt"));
  const executable = process.platform === "win32" ? "sd-cli.exe" : "sd-cli";
  const result = spawnSync(path.join(destination, executable), ["--help"], { encoding: "utf8", timeout: 15000 });
  if (result.status !== 0 || !`${result.stdout}${result.stderr}`.includes(pin.commit)) {
    throw new Error("The image runtime did not identify the reviewed revision.");
  }
  await verifyImageRuntimeGgufBounds(path.join(destination, executable));
  console.log("Image runtime verified.");
}
