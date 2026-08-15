// Local verification gate: pinned toolchains, supply-chain audit and SBOM,
// then the full test suite. Releases are packaged on this machine afterwards
// (`npm run desktop:release` / `npm run publish:release`), not by GitHub.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const policy = JSON.parse(fs.readFileSync(path.join(root, "supply-chain-policy.json"), "utf8"));

const flags = new Set(process.argv.slice(2));
const skipInstall = flags.has("--skip-install");
for (const flag of flags) {
  if (flag !== "--skip-install") {
    console.error(`Unknown flag ${flag}. Usage: node scripts/verify-ci.ts [--skip-install]`);
    process.exit(2);
  }
}

function capture(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) return null;
  return `${result.stdout}${result.stderr}`.trim();
}

function npmInvocation(args) {
  const npmCli = process.env.npm_execpath;
  if (npmCli && fs.existsSync(npmCli)) return [process.execPath, [npmCli, ...args]];
  return [process.platform === "win32" ? "npm.cmd" : "npm", args];
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const preflightFailures = [];

function requireExactTool(label, actual, expected, remedy) {
  if (actual === null) {
    preflightFailures.push(`${label} is not installed. ${remedy}`);
    return;
  }
  if (actual !== expected) {
    preflightFailures.push(`${label} is ${actual}, but the repository pins ${expected}. ${remedy}`);
  }
}

function requireMinimumTool(label, actual, minimum, remedy) {
  if (actual === null) {
    preflightFailures.push(`${label} is not installed. ${remedy}`);
    return;
  }
  if (compareVersions(actual, minimum) < 0) {
    preflightFailures.push(`${label} is ${actual}, but the repository requires at least ${minimum}. ${remedy}`);
  }
}

console.log("==> Toolchain preflight");

requireExactTool(
  "Node.js",
  capture(process.execPath, ["--version"])?.replace(/^v/, "") ?? null,
  policy.nodeVersion,
  `Install Node.js ${policy.nodeVersion} (see .nvmrc).`,
);

const [npmVersionCommand, npmVersionArgs] = npmInvocation(["--version"]);
requireExactTool(
  "npm",
  capture(npmVersionCommand, npmVersionArgs),
  policy.npmVersion,
  `Run npm install -g npm@${policy.npmVersion}.`,
);

requireExactTool(
  "Rust",
  capture("rustc", ["--version"])?.match(/^rustc (\d+\.\d+\.\d+)/)?.[1] ?? null,
  policy.rustVersion,
  `Run rustup toolchain install ${policy.rustVersion} && rustup default ${policy.rustVersion}.`,
);

// Read the toolchain Go actually resolves inside the module, so an automatic
// toolchain switch is counted the same way a pinned go.mod would.
requireMinimumTool(
  "Go",
  capture("go", ["env", "GOVERSION"], path.join(root, "infrastructure/veil"))
    ?.match(/go(\d+\.\d+\.\d+)/)?.[1] ?? null,
  policy.minimumGoVersion,
  `Install Go ${policy.minimumGoVersion} or newer (see infrastructure/veil/go.mod).`,
);

requireExactTool(
  "cargo-audit",
  capture("cargo", ["audit", "--version"])?.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null,
  policy.cargoAuditVersion,
  `Run cargo install cargo-audit --locked --version ${policy.cargoAuditVersion}.`,
);

requireExactTool(
  "govulncheck",
  capture("govulncheck", ["-version"])?.match(/govulncheck@v(\d+\.\d+\.\d+)/)?.[1] ?? null,
  policy.govulncheckVersion,
  `Run go install golang.org/x/vuln/cmd/govulncheck@v${policy.govulncheckVersion}.`,
);

if (preflightFailures.length > 0) {
  console.error("\nLocal toolchain does not match the repository pins:");
  for (const failure of preflightFailures) console.error(`- ${failure}`);
  console.error("\nFix the above before running the rest of the suite.");
  process.exit(1);
}

console.log(`All pinned toolchains match ${policy.nodeVersion}/${policy.npmVersion}/${policy.rustVersion}/go>=${policy.minimumGoVersion}.`);

const steps = [];
if (!skipInstall) {
  const [command, args] = npmInvocation(["ci", "--ignore-scripts", "--omit=peer"]);
  steps.push({ label: "Install dependencies", command, args });
}
steps.push({ label: "Fetch locked Rust dependencies", command: "cargo", args: ["fetch", "--locked"] });
for (const script of ["supply-chain:audit", "supply-chain:sbom"]) {
  const [command, args] = npmInvocation(["run", script]);
  steps.push({ label: script, command, args });
}
const [testCommand, testArgs] = npmInvocation(["run", "test:all"]);
steps.push({
  label: "test:all",
  command: testCommand,
  args: testArgs,
  env: { CARGO_NET_OFFLINE: "true" },
});

const started = process.hrtime.bigint();
for (const [index, step] of steps.entries()) {
  console.log(`\n==> [${index + 1}/${steps.length}] ${step.label}`);
  const result = spawnSync(step.command, step.args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, ...step.env },
  });
  if (result.error || result.status !== 0) {
    console.error(
      `\n${step.label} failed: ${result.error?.message ?? `exit code ${result.status ?? "unknown"}`}`,
    );
    console.error("Fix this before releasing.");
    process.exit(result.status ?? 1);
  }
}

const minutes = (Number(process.hrtime.bigint() - started) / 60e9).toFixed(1);
console.log(`\nLocal verification passed on ${process.platform}/${process.arch} in ${minutes} min.`);
console.log("Packaging is still this machine's job: npm run desktop:release, then npm run publish:release.");
