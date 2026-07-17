import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const manifestPaths = [
  "package.json",
  "apps/desktop/package.json",
  "packages/runner/package.json",
];
const dependencySections = ["dependencies", "devDependencies", "optionalDependencies"];
const exactVersionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const localSpecPattern = /^(?:file|workspace|link):/;
const failures = [];

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function fail(message) {
  failures.push(message);
}

function workspacePackageKey(relativePath) {
  if (relativePath === "package.json") return "";
  return relativePath.replace(/\/package\.json$/, "").replace(/\\/g, "/");
}

function isExactDependencySpec(spec) {
  return exactVersionPattern.test(spec) || localSpecPattern.test(spec);
}

for (const manifestPath of manifestPaths) {
  const manifest = readJson(manifestPath);
  for (const section of dependencySections) {
    const dependencies = manifest[section] ?? {};
    for (const [name, spec] of Object.entries(dependencies)) {
      if (typeof spec !== "string" || !isExactDependencySpec(spec)) {
        fail(`${manifestPath} ${section}.${name} must use an exact version or local workspace spec; found ${JSON.stringify(spec)}.`);
      }
    }
  }
}

const npmrcPath = path.join(root, ".npmrc");
if (!fs.existsSync(npmrcPath)) {
  fail(".npmrc is required for install guardrails.");
} else {
  const npmrc = fs.readFileSync(npmrcPath, "utf8");
  const requiredSettings = new Map([
    ["save-exact", "true"],
    ["ignore-scripts", "true"],
    ["min-release-age", "1"],
  ]);
  for (const [key, expected] of requiredSettings) {
    const pattern = new RegExp(`^${key}\\s*=\\s*${expected}\\s*$`, "m");
    if (!pattern.test(npmrc)) fail(`.npmrc must set ${key}=${expected}.`);
  }
}

const rootManifest = readJson("package.json");
const supplyChainPolicy = readJson("supply-chain-policy.json");
if (supplyChainPolicy.minimumReleaseAgeDays !== 1) {
  fail("supply-chain-policy.json must set minimumReleaseAgeDays to 1.");
}
const goMod = fs.readFileSync(path.join(root, "infrastructure/veil/go.mod"), "utf8");
if (!new RegExp(`^go\\s+${supplyChainPolicy.minimumGoVersion.replaceAll(".", "\\.")}\\s*$`, "m").test(goMod)) {
  fail(`infrastructure/veil/go.mod must require Go ${supplyChainPolicy.minimumGoVersion}.`);
}

if (Object.hasOwn(rootManifest, "allowScripts")) {
  fail("package.json must not declare allowScripts while npm install scripts are globally disabled.");
}

const lock = readJson("package-lock.json");
for (const manifestPath of manifestPaths) {
  const manifest = readJson(manifestPath);
  const lockPackage = lock.packages?.[workspacePackageKey(manifestPath)];
  if (!lockPackage) {
    fail(`package-lock.json is missing package entry for ${manifestPath}.`);
    continue;
  }
  for (const section of dependencySections) {
    const dependencies = manifest[section] ?? {};
    const lockedDependencies = lockPackage[section] ?? {};
    for (const [name, spec] of Object.entries(dependencies)) {
      if (lockedDependencies[name] !== spec) {
        fail(`package-lock.json ${workspacePackageKey(manifestPath) || "."} ${section}.${name} must match ${manifestPath}; found ${JSON.stringify(lockedDependencies[name])}, expected ${JSON.stringify(spec)}.`);
      }
    }
  }
}

const allowedNpmLicenses = new Set(supplyChainPolicy.allowedNpmLicenses ?? []);
for (const [location, entry] of Object.entries(lock.packages ?? {})) {
  if (!location.startsWith("node_modules/") || entry.link) continue;
  if (typeof entry.resolved !== "string" || !entry.resolved.startsWith("https://registry.npmjs.org/")) {
    fail(`package-lock.json ${location} must resolve from the npm registry.`);
  }
  if (typeof entry.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)) {
    fail(`package-lock.json ${location} must have SHA-512 integrity metadata.`);
  }
  if (!allowedNpmLicenses.has(entry.license)) {
    fail(`npm package ${location} has an unapproved license expression: ${JSON.stringify(entry.license)}.`);
  }
}

const cargoLock = fs.readFileSync(path.join(root, "Cargo.lock"), "utf8");
for (const source of cargoLock.matchAll(/^source = "([^"]+)"$/gm)) {
  if (source[1] !== "registry+https://github.com/rust-lang/crates.io-index") {
    fail(`Cargo.lock contains a non-approved package source: ${source[1]}.`);
  }
}

const cargoMetadata = spawnSync(
  "cargo",
  ["metadata", "--locked", "--offline", "--format-version", "1"],
  { cwd: root, encoding: "utf8" },
);
if (cargoMetadata.error || cargoMetadata.status !== 0) {
  fail(`Unable to validate locked Cargo metadata offline: ${cargoMetadata.error?.message ?? cargoMetadata.stderr.trim()}`);
} else {
  const metadata = JSON.parse(cargoMetadata.stdout);
  const allowedLicenses = new Set(supplyChainPolicy.allowedCargoLicenseExpressions ?? []);
  for (const packageMetadata of metadata.packages ?? []) {
    if (!packageMetadata.source) continue;
    if (!allowedLicenses.has(packageMetadata.license)) {
      fail(`Cargo package ${packageMetadata.name}@${packageMetadata.version} has an unapproved license expression: ${JSON.stringify(packageMetadata.license)}.`);
    }
  }
}

if (fs.existsSync(path.join(root, "node_modules"))) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const npmTree = spawnSync(npmCommand, ["ls", "--all", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  if (npmTree.error || npmTree.status !== 0) {
    let detail = npmTree.error?.message ?? npmTree.stderr.trim();
    try {
      const parsed = JSON.parse(npmTree.stdout);
      detail = parsed.problems?.join("; ") || detail;
    } catch {
      // Keep npm's stderr when its output is not JSON.
    }
    fail(`Installed npm tree does not match package-lock.json: ${detail}`);
  }
}

const workflow = fs.readFileSync(path.join(root, ".github/workflows/package-desktop.yml"), "utf8");
for (const match of workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)) {
  const reference = match[1];
  if (!/@[0-9a-f]{40}$/.test(reference)) {
    fail(`GitHub Action ${reference} must be pinned to a full commit SHA.`);
  }
}

if (failures.length) {
  console.error("Supply-chain check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Supply-chain check passed.");
