import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runnerRoot = path.resolve(desktopRoot, "../../packages/runner");
const target = path.join(desktopRoot, ".package", "runner");
const veilRoot = path.resolve(desktopRoot, "../../infrastructure/veil");
const veilTarget = path.join(desktopRoot, ".package", "veil");

const requiredFiles = [
  path.join(runnerRoot, "package.json"),
  path.join(runnerRoot, "bin", "umbratic-runner.cjs"),
  path.join(runnerRoot, "dist", "cli.js"),
];

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) {
    throw new Error(`Missing packaged runner input: ${file}. Run npm run build first.`);
  }
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
fs.copyFileSync(path.join(runnerRoot, "package.json"), path.join(target, "package.json"));
fs.cpSync(path.join(runnerRoot, "bin"), path.join(target, "bin"), { recursive: true });
fs.cpSync(path.join(runnerRoot, "dist"), path.join(target, "dist"), { recursive: true });

console.log(`Prepared packaged runner at ${path.relative(desktopRoot, target)}`);

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
