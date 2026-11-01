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
  "--omit=peer",
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
run(
  "Caddy source and patched JOSE vulnerability audit",
  "govulncheck",
  ["./..."],
  path.join(root, "infrastructure/veil-console/deploy/caddy"),
);
run("Locked Python and native-server module OSV audit", process.execPath, ["scripts/audit-managed-runtimes.ts"]);
run("Pinned release-action source and advisory audit", process.execPath, ["scripts/audit-release-actions.ts"]);

// govulncheck reports these under Module Results with no called or imported
// symbols. Listing them here keeps a reviewed, unreachable advisory from
// reading as a regression on a later run.
const policy = JSON.parse(fs.readFileSync(path.join(root, "supply-chain-policy.json"), "utf8"));
const accepted = policy.acceptedGoModuleAdvisories ?? [];
if (accepted.length > 0) {
  console.log("\n==> Accepted module-scoped Go advisories (unreachable, reviewed)");
  for (const advisory of accepted) {
    console.log(`  ${advisory.id}  ${advisory.package}  fixed in: ${advisory.fixedIn ?? "N/A"}`);
    console.log(`    ${advisory.reason}`);
  }
}

console.log("\nAll supply-chain vulnerability and provenance audits passed.");
