import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { extractFile } from "@electron/asar";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.resolve(desktopRoot, "../../target/release/desktop");

function packagedResources() {
  if (process.platform === "win32") {
    // x64 unpacks to win-unpacked; every other architecture carries its name,
    // as win-arm64-unpacked.
    const output = fs.readdirSync(releaseRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("win") && entry.name.endsWith("unpacked"))
      .map((entry) => path.join(releaseRoot, entry.name, "resources"))
      .find((candidate) => fs.existsSync(candidate));
    if (!output) throw new Error("Unable to find the unpacked Windows resources.");
    return output;
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

// llama-server answers --version and exits 0, unlike the Umbratic binaries
// above, and it prints the build number the pin names — which is what tells us
// the packaged executable came from this pin rather than a stale build cache.
//
// The backends are separate libraries loaded at run time, so a build that
// produced the executable but none of them would pass a file check and then
// fail on the user's machine with no backend to run on. Both are asserted, and
// the GPU backend this platform expects is named explicitly: a Vulkan library
// that silently stopped being built would otherwise ship as a CPU-only release
// that nobody notices until someone times a response.
function verifyLlamaServer(directory: string) {
  const file = path.join(directory, executable("llama-server"));
  requireFile(file);
  if (process.platform !== "win32" && (fs.statSync(file).mode & 0o111) === 0) {
    throw new Error(`Packaged binary is not executable: ${file}`);
  }
  const pin = fs.readFileSync(path.resolve(desktopRoot, "../../third_party/llama.cpp.pin"), "utf8");
  const commit = pin.match(/^commit=([0-9a-f]{40})\s*$/m)?.[1];
  if (!commit) throw new Error("third_party/llama.cpp.pin does not record a commit.");
  const result = spawnSync(file, ["--version"], { encoding: "utf8", timeout: 15_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error || result.status !== 0) {
    throw new Error(`Packaged llama-server did not answer --version: ${result.error?.message || output.trim() || `exit ${result.status}`}`);
  }
  // The commit, not the build number. llama.cpp derives its build number from
  // the tag history, which a shallow single-tag clone does not have, so it
  // self-reports "build 1" no matter which release was checked out. The commit
  // it prints is the thing the pin actually names, and prepare-package already
  // refused to build anything else.
  if (!output.includes(`commit ${commit.slice(0, 7)}`)) {
    throw new Error(
      `Packaged llama-server is not the pinned commit ${commit.slice(0, 7)}.\n`
      + `  It reports: ${output.trim().split(/\r?\n/)[0] ?? "(nothing)"}\n`
      + "  Delete apps/desktop/.llama-cache and repackage to rebuild from the pin.",
    );
  }

  const shipped = fs.readdirSync(directory);
  const backends = shipped.filter((name) => /ggml-(?:cpu|vulkan|metal|blas)/i.test(name));
  if (backends.length === 0) {
    throw new Error(`Packaged llama-server has no loadable ggml backend: ${shipped.join(", ")}`);
  }
  // Runtime CPU dispatch means several CPU variants, not one.
  if (!backends.some((name) => /ggml-cpu/i.test(name))) {
    throw new Error(`Packaged llama-server has no CPU backend to fall back to: ${backends.join(", ")}`);
  }
  const expectedGpuBackend = process.platform === "darwin"
    ? "metal"
    : process.platform === "win32" && process.arch === "x64" ? "vulkan" : "";
  if (expectedGpuBackend && !backends.some((name) => name.toLowerCase().includes(expectedGpuBackend))) {
    // The CPU-only escape hatch has to be asked for at both ends. A release
    // build never sets it, so a package that quietly lost its GPU backend still
    // fails here.
    if (process.env.UMBRATIC_LLAMA_CPU_ONLY !== "1") {
      throw new Error(
        `Packaged llama-server is missing its ${expectedGpuBackend} backend: ${backends.join(", ")}\n`
        + "  Install the Vulkan SDK and repackage, or set UMBRATIC_LLAMA_CPU_ONLY=1 to accept a CPU-only build.",
      );
    }
    console.warn(`UMBRATIC_LLAMA_CPU_ONLY=1: accepting a build with no ${expectedGpuBackend} backend. Do not release it.`);
  }
  if (process.platform === "darwin") {
    for (const name of shipped) {
      verifyMachOResolvesBesideItself(path.join(directory, name), new Set(shipped));
    }
  }
}

/**
 * Proves a packaged Mach-O file resolves every library from the package
 * itself, with no reach back into the machine that built it.
 *
 * Running the binary cannot prove this here: the build tree the binaries came
 * from still exists on the release machine, so an LC_RPATH pointing into
 * .llama-cache resolves during verification and then fails as "Library not
 * loaded" on every other Mac, at first model load. The load commands are the
 * ground truth, so they are what is checked: every rpath must be relative to
 * the binary, and every @rpath dependency must name a file that shipped.
 */
function verifyMachOResolvesBesideItself(file: string, shipped: Set<string>) {
  const name = path.basename(file);
  const loadCommands = spawnSync("otool", ["-l", file], { encoding: "utf8" });
  if (loadCommands.error || loadCommands.status !== 0) {
    throw new Error(`Unable to read load commands of packaged ${name}: ${loadCommands.error?.message || loadCommands.stderr}`);
  }
  const lines = loadCommands.stdout.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!/\bcmd LC_RPATH\b/.test(line)) return;
    const recorded = lines.slice(index + 1, index + 4)
      .map((candidate) => candidate.match(/^\s*path (.+) \(offset \d+\)$/)?.[1])
      .find((value) => value !== undefined);
    if (recorded && !recorded.startsWith("@loader_path") && !recorded.startsWith("@executable_path")) {
      throw new Error(
        `Packaged ${name} records the rpath ${recorded}, which only exists on the build machine.\n`
        + "  prepare-package rewrites rpaths to @loader_path; delete apps/desktop/.package and repackage.",
      );
    }
  });
  const dependencies = spawnSync("otool", ["-L", file], { encoding: "utf8" });
  if (dependencies.error || dependencies.status !== 0) {
    throw new Error(`Unable to read dependencies of packaged ${name}: ${dependencies.error?.message || dependencies.stderr}`);
  }
  for (const line of dependencies.stdout.split(/\r?\n/)) {
    const dependency = line.match(/^\s+@rpath\/(\S+)/)?.[1];
    if (dependency && !shipped.has(dependency)) {
      throw new Error(
        `Packaged ${name} needs @rpath/${dependency}, which is not in the package.\n`
        + "  The build tree covers that name with a symlink; the package must carry the file under it.",
      );
    }
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

function verifyMacCodeSignature(appBundle: string) {
  if (process.platform !== "darwin") return;
  const result = spawnSync("codesign", ["--verify", "--deep", appBundle], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `Packaged app failed codesign verification. Flipping Electron fuses on Apple Silicon `
      + `invalidates the ad-hoc signature unless electronFuses.resetAdHocDarwinSignature is true.\n`
      + (result.stderr || result.stdout || `exit ${result.status}`),
    );
  }
}

const resources = packagedResources();
const executable = (name: string) => process.platform === "win32" ? `${name}.exe` : name;
const appArchive = requireFile(path.join(resources, "app.asar"));
verifyMacCodeSignature(path.resolve(resources, "../.."));
verifyDocumentsSkill(appArchive);
verifyBinary(path.join(resources, "runner", executable("umbratic-runner")), /UmbraticRunner/);
verifyBinary(path.join(resources, "desktop-core", executable("umbratic-desktop-core")), /usage: umbratic-desktop-core/);
verifyBinary(path.join(resources, "pdf", executable("umbratic-pdf")), /umbratic-pdf inspect/);
verifyBinary(
  path.join(resources, "artifacts", executable("umbratic-artifacts")),
  /umbratic-artifacts .*one JSON job on stdin/,
);
verifyBinary(
  path.join(resources, "veil", executable("veil")),
  /VEIL_AUTH_TOKEN is required/,
  { ...process.env, VEIL_MODE: "local", VEIL_AUTH_TOKEN: "" },
);
verifyLlamaServer(path.join(resources, "llama-server"));
console.log(`Verified packaged desktop resources in ${path.relative(path.resolve(desktopRoot, "../.."), resources)}.`);
