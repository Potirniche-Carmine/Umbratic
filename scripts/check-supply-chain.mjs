import fs from "node:fs";
import path from "node:path";
import process from "node:process";

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
  ]);
  for (const [key, expected] of requiredSettings) {
    const pattern = new RegExp(`^${key}\\s*=\\s*${expected}\\s*$`, "m");
    if (!pattern.test(npmrc)) fail(`.npmrc must set ${key}=${expected}.`);
  }
}

const rootManifest = readJson("package.json");
const supplyChainPolicy = readJson("supply-chain-policy.json");
if (supplyChainPolicy.minimumReleaseAgeMinutes !== 1440) {
  fail("supply-chain-policy.json must set minimumReleaseAgeMinutes to 1440.");
}

const allowScripts = rootManifest.allowScripts ?? {};
if (typeof allowScripts !== "object" || Array.isArray(allowScripts)) {
  fail("package.json allowScripts must be an object.");
} else {
  const entries = Object.entries(allowScripts);
  if (entries.length > 5) fail("package.json allowScripts should stay small; maximum is 5 entries.");
  for (const [name, allowed] of entries) {
    if (!/^[a-z0-9@._/-]+@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/i.test(name) || allowed !== true) {
      fail(`package.json allowScripts entry ${JSON.stringify(name)} must be exact package@version with value true.`);
    }
  }
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

if (failures.length) {
  console.error("Supply-chain check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Supply-chain check passed.");
