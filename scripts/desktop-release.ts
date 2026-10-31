// Builds, packages, and verifies the desktop app.
//
// This was a shell chain in package.json, but npm appends extra arguments to
// the last command of a chain — the verifier — and the packaging step is the
// one that takes flags. A script owns the chain, so
// `npm run desktop:release -- --unsigned` lands where it is meant to, and so
// does a pass-through like `npm run desktop:release -- --win nsis --x64`.

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

// npm names itself in npm_execpath for every script it runs. Spawning that
// through the current node keeps the same npm on every platform, without a
// shell in the middle for Windows' npm.cmd.
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this through npm: npm run desktop:release");

function run(title: string, command: string[]) {
  const result = spawnSync(process.execPath, command, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`${title} failed.`);
    process.exit(result.status ?? 1);
  }
}

run("Checking release versions", [path.join(root, "scripts", "check-release-version.ts")]);
run("Building Go services", [path.join(root, "scripts", "build-go-services.ts")]);
run("Packaging", [npm, "--workspace", "@umbratic/desktop", "run", "package", "--", ...args]);
run("Verifying the package", [npm, "--workspace", "@umbratic/desktop", "run", "verify:package"]);
