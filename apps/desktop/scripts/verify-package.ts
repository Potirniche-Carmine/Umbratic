import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { extractFile } from "@electron/asar";

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

function normalizeText(value: string) {
  return value.replace(/\r\n/g, "\n").trimEnd();
}

function verifyDocumentsSkill(appArchive: string) {
  const relativePath = path.join("dist-electron", "main", "system-skills", "umbratic-documents", "SKILL.md");
  const sourcePath = path.join(desktopRoot, "src", "main", "system-skills", "umbratic-documents", "SKILL.md");
  const source = fs.readFileSync(sourcePath, "utf8");
  const packaged = extractFile(appArchive, relativePath).toString("utf8");
  if (normalizeText(packaged) !== normalizeText(source)) {
    throw new Error("Packaged Documents skill differs from its bundled source.");
  }
  if (/In-App Review Snapshot|\.docx\.review\.json/.test(packaged)) {
    throw new Error("Packaged Documents skill retained removed review snapshot rules.");
  }
}

const resources = packagedResources();
const executable = (name: string) => process.platform === "win32" ? `${name}.exe` : name;
const appArchive = requireFile(path.join(resources, "app.asar"));
verifyDocumentsSkill(appArchive);
verifyBinary(path.join(resources, "runner", executable("umbratic-runner")), /UmbraticRunner/);
verifyBinary(path.join(resources, "desktop-core", executable("umbratic-desktop-core")), /usage: umbratic-desktop-core/);
verifyBinary(path.join(resources, "pdf", executable("umbratic-pdf")), /umbratic-pdf inspect/);
verifyBinary(
  path.join(resources, "veil", executable("veil")),
  /VEIL_AUTH_TOKEN is required/,
  { ...process.env, VEIL_AUTH_TOKEN: "" },
);
console.log(`Verified packaged desktop resources in ${path.relative(desktopRoot, resources)}.`);
