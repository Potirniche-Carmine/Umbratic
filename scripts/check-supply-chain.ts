import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const manifestPaths = [
  "package.json",
  "apps/desktop/package.json",
  "packages/pdf/package.json",
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

function npmPackageName(location) {
  return location.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/)?.[1];
}

function compareExactSet(label, actualValues, allowedValues) {
  const actual = new Set(actualValues);
  const allowed = new Set(allowedValues ?? []);
  for (const value of [...actual].sort()) {
    if (!allowed.has(value)) fail(`${label} ${value} is not reviewed in supply-chain-policy.json.`);
  }
  for (const value of [...allowed].sort()) {
    if (!actual.has(value)) fail(`${label} allowlist contains stale entry ${value}.`);
  }
}

const rootManifest = readJson("package.json");
const supplyChainPolicy = readJson("supply-chain-policy.json");

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
    ["min-release-age", String(supplyChainPolicy.minimumReleaseAgeDays)],
    // Without this the engines pins are advisory outside CI: npm warns and installs anyway.
    ["engine-strict", "true"],
  ]);
  for (const [key, expected] of requiredSettings) {
    const pattern = new RegExp(`^${key}\\s*=\\s*${expected}\\s*$`, "m");
    if (!pattern.test(npmrc)) fail(`.npmrc must set ${key}=${expected}.`);
  }
}

if (!Number.isInteger(supplyChainPolicy.minimumReleaseAgeDays) || supplyChainPolicy.minimumReleaseAgeDays < 7) {
  fail("supply-chain-policy.json minimumReleaseAgeDays must be at least 7.");
}
if (rootManifest.packageManager !== `npm@${supplyChainPolicy.npmVersion}`) {
  fail(`package.json must pin packageManager to npm@${supplyChainPolicy.npmVersion}.`);
}
if (rootManifest.engines?.node !== supplyChainPolicy.nodeVersion) {
  fail(`package.json engines.node must pin ${supplyChainPolicy.nodeVersion}.`);
}
if (rootManifest.engines?.npm !== supplyChainPolicy.npmVersion) {
  fail(`package.json engines.npm must pin ${supplyChainPolicy.npmVersion}.`);
}
const nvmVersion = fs.readFileSync(path.join(root, ".nvmrc"), "utf8").trim();
if (nvmVersion !== supplyChainPolicy.nodeVersion) {
  fail(`.nvmrc must pin Node.js ${supplyChainPolicy.nodeVersion}.`);
}
const rustToolchain = fs.readFileSync(path.join(root, "rust-toolchain.toml"), "utf8");
if (!new RegExp(`^channel\\s*=\\s*"${supplyChainPolicy.rustVersion.replaceAll(".", "\\.")}"\\s*$`, "m").test(rustToolchain)) {
  fail(`rust-toolchain.toml must pin Rust ${supplyChainPolicy.rustVersion}.`);
}
for (const goModPath of ["infrastructure/veil/go.mod", "infrastructure/veil-console/go.mod"]) {
  const goMod = fs.readFileSync(path.join(root, goModPath), "utf8");
  if (!new RegExp(`^go\\s+${supplyChainPolicy.minimumGoVersion.replaceAll(".", "\\.")}\\s*$`, "m").test(goMod)) {
    fail(`${goModPath} must require Go ${supplyChainPolicy.minimumGoVersion}.`);
  }
}

if (Object.hasOwn(rootManifest, "allowScripts")) {
  fail("package.json must not declare allowScripts while npm install scripts are globally disabled.");
}
if (JSON.stringify(rootManifest.overrides ?? {}) !== JSON.stringify(supplyChainPolicy.reviewedNpmOverrides ?? {})) {
  fail("package.json overrides must match the reviewed npm overrides in supply-chain-policy.json.");
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
const npmInstallScriptPackages = [];
const npmPlatformPackages = [];
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
  const name = npmPackageName(location);
  if (name && entry.hasInstallScript) npmInstallScriptPackages.push(`${name}@${entry.version}`);
  if (name && (entry.cpu || entry.os)) npmPlatformPackages.push(`${name}@${entry.version}`);
}
compareExactSet(
  "npm lifecycle-script package",
  npmInstallScriptPackages,
  supplyChainPolicy.allowedNpmInstallScriptPackages,
);
compareExactSet(
  "npm native/platform package",
  npmPlatformPackages,
  supplyChainPolicy.allowedNpmPlatformPackages,
);

const cargoLock = fs.readFileSync(path.join(root, "Cargo.lock"), "utf8");
for (const source of cargoLock.matchAll(/^source = "([^"]+)"$/gm)) {
  if (source[1] !== "registry+https://github.com/rust-lang/crates.io-index") {
    fail(`Cargo.lock contains a non-approved package source: ${source[1]}.`);
  }
}
for (const block of cargoLock.split("[[package]]").slice(1)) {
  const source = block.match(/^source = "([^"]+)"$/m)?.[1];
  if (!source) continue;
  const name = block.match(/^name = "([^"]+)"$/m)?.[1] ?? "unknown";
  const version = block.match(/^version = "([^"]+)"$/m)?.[1] ?? "unknown";
  if (!/^checksum = "[0-9a-f]{64}"$/m.test(block)) {
    fail(`Cargo.lock registry package ${name}@${version} must have a SHA-256 checksum.`);
  }
}

const cargoMetadata = spawnSync(
  "cargo",
  ["metadata", "--locked", "--format-version", "1"],
  // The tree-sitter grammar crates pushed this output past Node's 1 MB default,
  // which surfaced as an opaque ENOBUFS rather than a supply-chain finding.
  { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
if (cargoMetadata.error || cargoMetadata.status !== 0) {
  fail(`Unable to validate locked Cargo metadata: ${cargoMetadata.error?.message ?? cargoMetadata.stderr.trim()}`);
} else {
  const metadata = JSON.parse(cargoMetadata.stdout);
  const allowedLicenses = new Set(supplyChainPolicy.allowedCargoLicenseExpressions ?? []);
  for (const packageMetadata of metadata.packages ?? []) {
    if (!packageMetadata.source) continue;
    if (!allowedLicenses.has(packageMetadata.license)) {
      fail(`Cargo package ${packageMetadata.name}@${packageMetadata.version} has an unapproved license expression: ${JSON.stringify(packageMetadata.license)}.`);
    }
  }
  const externalPackages = metadata.packages.filter((entry) => entry.source);
  compareExactSet(
    "Cargo build-script package",
    externalPackages
      .filter((entry) => entry.targets.some((target) => target.kind.includes("custom-build")))
      .map((entry) => `${entry.name}@${entry.version}`),
    supplyChainPolicy.allowedCargoBuildScriptPackages,
  );
  compareExactSet(
    "Cargo proc-macro package",
    externalPackages
      .filter((entry) => entry.targets.some((target) => target.kind.includes("proc-macro")))
      .map((entry) => `${entry.name}@${entry.version}`),
    supplyChainPolicy.allowedCargoProcMacroPackages,
  );
}

if (fs.existsSync(path.join(root, "node_modules"))) {
  for (const [location, entry] of Object.entries(lock.packages ?? {})) {
    if (!location.startsWith("node_modules/") || entry.link || !entry.version) continue;
    const installedManifestPath = path.join(root, location, "package.json");
    if (!fs.existsSync(installedManifestPath)) continue;
    const installedManifest = JSON.parse(fs.readFileSync(installedManifestPath, "utf8"));
    if (installedManifest.version !== entry.version) {
      fail(
        `Installed npm package ${location} is ${installedManifest.version ?? "unversioned"}, but package-lock.json pins ${entry.version}; run npm ci --ignore-scripts.`,
      );
    }
  }
  const npmCliPath = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  ].find((candidate) => candidate && fs.existsSync(candidate));
  if (process.platform === "win32" && !npmCliPath) {
    fail("Unable to locate npm-cli.js for installed-tree validation on Windows; run the check through npm run supply-chain:check.");
  } else {
    const npmCommand = npmCliPath ? process.execPath : "npm";
    const npmArgs = npmCliPath
      ? [npmCliPath, "ls", "--all", "--json", "--omit=peer"]
      : ["ls", "--all", "--json", "--omit=peer"];
    const npmTree = spawnSync(npmCommand, npmArgs, {
      cwd: root,
      encoding: "utf8",
    });
    if (npmTree.error) {
      fail(`Unable to inspect the installed npm tree: ${npmTree.error.message}`);
    } else {
      try {
        const parsed = JSON.parse(npmTree.stdout);
        const reviewedOverrides = supplyChainPolicy.reviewedNpmOverrides ?? {};
        const omittedPeers = new Set(supplyChainPolicy.omittedNpmPeerPackages ?? []);
        const unexpectedProblems = (parsed.problems ?? []).filter((problem) => {
          const invalid = problem.match(/^invalid: (.+)@([^ ]+) /);
          if (invalid && reviewedOverrides[invalid[1]] === invalid[2]) return false;
          const missing = problem.match(/^missing: (.+?@[^,]+), required by /);
          if (missing && omittedPeers.has(missing[1])) return false;
          return true;
        });
        if (unexpectedProblems.length > 0) {
          fail(`Installed npm tree does not match package-lock.json: ${unexpectedProblems.join("; ")}`);
        }
      } catch {
        fail(`Unable to parse the installed npm tree: ${npmTree.stderr.trim()}`);
      }
    }
  }
}

const workflowsDir = path.join(root, ".github/workflows");
for (const name of fs.readdirSync(workflowsDir).sort()) {
  if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
  const workflow = fs.readFileSync(path.join(workflowsDir, name), "utf8");
  const label = `.github/workflows/${name}`;
  for (const match of workflow.matchAll(/^\s*runs-on:\s*([^\s#]+)(?:\s+#.*)?$/gm)) {
    if (match[1].endsWith("-latest")) {
      fail(`${label}: GitHub runner ${match[1]} must use an explicit operating-system image.`);
    }
  }
  for (const match of workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)) {
    const reference = match[1];
    if (!/@[0-9a-f]{40}$/.test(reference)) {
      fail(`${label}: GitHub Action ${reference} must be pinned to a full commit SHA.`);
    }
  }
}

// llama.cpp is vendored by source build, not by a package manager, so its pin is
// checked here rather than through a lockfile.
const llamaPin = fs.readFileSync(path.join(root, "third_party/llama.cpp.pin"), "utf8");
const llamaFields = new Map(
  llamaPin
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()]),
);
if (llamaFields.get("repository") !== "https://github.com/ggml-org/llama.cpp.git") {
  fail("third_party/llama.cpp.pin must clone llama.cpp from its upstream GitHub repository.");
}
if (!/^b\d+$/.test(llamaFields.get("tag") ?? "")) {
  fail("third_party/llama.cpp.pin must pin a llama.cpp build tag such as b10419.");
}
if (!/^[0-9a-f]{40}$/.test(llamaFields.get("commit") ?? "")) {
  fail("third_party/llama.cpp.pin must pin a full 40-character commit SHA.");
}
const preparePackageScript = fs.readFileSync(path.join(root, "apps/desktop/scripts/prepare-package.ts"), "utf8");
for (const requiredFlag of [
  "-DLLAMA_CURL=OFF",
  // Never -march=native in a build somebody else runs.
  "-DGGML_NATIVE=OFF",
  // Backends are selected on the user's machine, not on the build machine.
  "-DGGML_BACKEND_DL=ON",
  "-DGGML_CPU_ALL_VARIANTS=ON",
]) {
  if (!preparePackageScript.includes(requiredFlag)) {
    fail(`Packaged llama-server must be configured with ${requiredFlag}.`);
  }
}
if (!preparePackageScript.includes("pin.commit")) {
  fail("Packaged llama-server must verify the cloned checkout against the pinned commit SHA.");
}

const desktopDevScript = fs.readFileSync(path.join(root, "apps/desktop/scripts/dev.ts"), "utf8");
if (!/spawn\("cargo", \["build", "--locked",/.test(desktopDevScript)) {
  fail("Desktop development Cargo builds must pass --locked.");
}
if (/require\(["']electron["']\)/.test(desktopDevScript)) {
  fail("Desktop development must not trigger Electron's implicit runtime download path.");
}
const electronBuilderConfig = fs.readFileSync(path.join(root, "apps/desktop/electron-builder.yml"), "utf8");
if (!/^electronDist:\s+\.\.\/\.\.\/node_modules\/electron\/dist\s*$/m.test(electronBuilderConfig)) {
  fail("Electron Builder must use the explicitly provisioned local Electron distribution.");
}

if (failures.length) {
  console.error("Supply-chain check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Supply-chain check passed.");
