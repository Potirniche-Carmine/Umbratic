import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = process.cwd();

function npmInvocation(args) {
  const npmCli = process.env.npm_execpath;
  if (npmCli && fs.existsSync(npmCli)) {
    return [process.execPath, [npmCli, ...args]];
  }
  return [process.platform === "win32" ? "npm.cmd" : "npm", args];
}

function run(label, command, args, cwd = root) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${label} failed: ${result.error?.message ?? `exit code ${result.status ?? "unknown"}`}`,
    );
  }
}

const [npmCommand, npmAuditArgs] = npmInvocation([
  "audit",
  "--package-lock-only",
  "--ignore-scripts",
  "--audit-level=low",
]);
run("npm vulnerability audit", npmCommand, npmAuditArgs);

const [npmSignatureCommand, npmSignatureArgs] = npmInvocation([
  "audit",
  "signatures",
  "--min-release-age=0",
]);
run("npm registry signature and provenance audit", npmSignatureCommand, npmSignatureArgs);

run("RustSec audit", "cargo", ["audit", "--deny", "warnings"]);
run(
  "Veil Go vulnerability audit",
  "govulncheck",
  ["./..."],
  path.join(root, "infrastructure/veil"),
);
run(
  "Veil Console Go vulnerability audit",
  "govulncheck",
  ["./..."],
  path.join(root, "infrastructure/veil-console"),
);

console.log("\nAll supply-chain vulnerability and provenance audits passed.");
