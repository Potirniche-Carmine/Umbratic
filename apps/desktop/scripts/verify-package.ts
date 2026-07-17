import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(desktopRoot, "release");

function packagedResources() {
  if (process.platform === "win32") {
    return path.join(releaseRoot, "win-unpacked", "resources");
  }
  const output = fs.readdirSync(releaseRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("mac"))
    .map((entry) => path.join(releaseRoot, entry.name, "Umbratic.app", "Contents", "Resources"))
    .find((candidate) => fs.existsSync(candidate));
  if (!output) throw new Error("Unable to find the unpacked macOS Umbratic.app resources.");
  return output;
}

function requireFile(file: string) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size === 0) throw new Error(`Missing or empty packaged file: ${file}`);
  return file;
}

function verifyBinary(file: string, expected: RegExp, env = process.env) {
  requireFile(file);
  if (process.platform !== "win32" && (fs.statSync(file).mode & 0o111) === 0) {
    throw new Error(`Packaged binary is not executable: ${file}`);
  }
  const result = spawnSync(file, [], { encoding: "utf8", env, timeout: 5_000 });
  if (result.error || result.status !== 1 || !expected.test(result.stderr)) {
    throw new Error(`Packaged binary smoke test failed for ${file}: ${result.error?.message || result.stderr || `exit ${result.status}`}`);
  }
}

const resources = packagedResources();
const executable = (name: string) => process.platform === "win32" ? `${name}.exe` : name;
requireFile(path.join(resources, "app.asar"));
verifyBinary(path.join(resources, "runner", executable("umbratic-runner")), /UmbraticRunner/);
verifyBinary(path.join(resources, "desktop-core", executable("umbratic-desktop-core")), /usage: umbratic-desktop-core/);
verifyBinary(
  path.join(resources, "veil", executable("veil")),
  /VEIL_AUTH_TOKEN is required/,
  { ...process.env, VEIL_AUTH_TOKEN: "" },
);
console.log(`Verified packaged desktop resources in ${path.relative(desktopRoot, resources)}.`);
