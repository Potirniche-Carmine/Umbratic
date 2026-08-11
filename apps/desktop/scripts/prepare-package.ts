import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(desktopRoot, ".package", "runner");
const runnerBinaryName = process.platform === "win32" ? "umbratic-runner.exe" : "umbratic-runner";
const runnerBinary = path.resolve(desktopRoot, "../../target/release", runnerBinaryName);
const desktopCoreTarget = path.join(desktopRoot, ".package", "desktop-core");
const desktopCoreBinaryName = process.platform === "win32" ? "umbratic-desktop-core.exe" : "umbratic-desktop-core";
const desktopCoreBinary = path.resolve(desktopRoot, "../../target/release", desktopCoreBinaryName);
const pdfTarget = path.join(desktopRoot, ".package", "pdf");
const pdfBinaryName = process.platform === "win32" ? "umbratic-pdf.exe" : "umbratic-pdf";
const pdfBinary = path.resolve(desktopRoot, "../../target/release", pdfBinaryName);
const codeIndexTarget = path.join(desktopRoot, ".package", "code-index");
const codeIndexBinaryName = process.platform === "win32" ? "umbratic-code-index.exe" : "umbratic-code-index";
const codeIndexBinary = path.resolve(desktopRoot, "../../target/release", codeIndexBinaryName);
const veilRoot = path.resolve(desktopRoot, "../../infrastructure/veil");
const veilTarget = path.join(desktopRoot, ".package", "veil");

const requiredFiles = [
  runnerBinary,
  desktopCoreBinary,
  pdfBinary,
];

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) {
    throw new Error(`Missing packaged runner input: ${file}. Run npm run desktop:release first.`);
  }
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
const packagedRunnerBinary = path.join(target, runnerBinaryName);
fs.copyFileSync(runnerBinary, packagedRunnerBinary);
if (process.platform !== "win32") fs.chmodSync(packagedRunnerBinary, 0o755);

console.log(`Prepared packaged runner at ${path.relative(desktopRoot, target)}`);

fs.rmSync(desktopCoreTarget, { recursive: true, force: true });
fs.mkdirSync(desktopCoreTarget, { recursive: true });
const packagedDesktopCore = path.join(desktopCoreTarget, desktopCoreBinaryName);
fs.copyFileSync(desktopCoreBinary, packagedDesktopCore);
if (process.platform !== "win32") fs.chmodSync(packagedDesktopCore, 0o755);
console.log(`Prepared packaged desktop core at ${path.relative(desktopRoot, packagedDesktopCore)}`);

fs.rmSync(pdfTarget, { recursive: true, force: true });
fs.mkdirSync(pdfTarget, { recursive: true });
const packagedPdfBinary = path.join(pdfTarget, pdfBinaryName);
fs.copyFileSync(pdfBinary, packagedPdfBinary);
if (process.platform !== "win32") fs.chmodSync(packagedPdfBinary, 0o755);
console.log(`Prepared packaged PDF inspector at ${path.relative(desktopRoot, packagedPdfBinary)}`);

fs.rmSync(codeIndexTarget, { recursive: true, force: true });
fs.mkdirSync(codeIndexTarget, { recursive: true });
const packagedCodeIndexBinary = path.join(codeIndexTarget, codeIndexBinaryName);
fs.copyFileSync(codeIndexBinary, packagedCodeIndexBinary);
if (process.platform !== "win32") fs.chmodSync(packagedCodeIndexBinary, 0o755);
console.log(`Prepared packaged code index at ${path.relative(desktopRoot, packagedCodeIndexBinary)}`);

fs.rmSync(veilTarget, { recursive: true, force: true });
fs.mkdirSync(veilTarget, { recursive: true });
const veilBinary = path.join(veilTarget, process.platform === "win32" ? "veil.exe" : "veil");
const veilBuild = spawnSync("go", ["build", "-trimpath", "-o", veilBinary, "./cmd/veil"], {
  cwd: veilRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (veilBuild.error || veilBuild.status !== 0) {
  const detail = veilBuild.error?.message || veilBuild.stderr.trim() || veilBuild.stdout.trim();
  throw new Error(`Unable to build packaged Veil${detail ? `: ${detail}` : "."}`);
}
console.log(`Prepared packaged Veil at ${path.relative(desktopRoot, veilBinary)}`);

