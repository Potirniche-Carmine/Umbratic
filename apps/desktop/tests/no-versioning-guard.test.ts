import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Enforcement for the plan's fixed decision: no versioning in any internal
// contract. A contract is defined by its exact shape, so no producer may emit
// and no consumer may gate on a version field, a schema version, or the
// deleted `contextState` key.
//
// This scans source, not prose: the plan document itself names the banned
// tokens, and package manifests legitimately carry release versions.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const scannedRoots = ["apps/desktop/src", "apps/desktop/tests", "packages/runner/src", "infrastructure/veil", "infrastructure/veil-console", "scripts"];
const scannedExtensions = new Set([".ts", ".tsx", ".rs", ".go", ".json", ".js"]);
const skippedDirectories = new Set(["node_modules", "target", "dist", "assets", ".git"]);
const skippedFiles = new Set(["package.json", "package-lock.json", "go.mod", "go.sum", "Cargo.toml", "Cargo.lock"]);

// Field names that must never appear as a key in an internal payload.
const bannedFields = ["schemaVersion", "schema_version", "contextState", "contractVersion", "wireVersion"];

// `version` as a standalone key. Descriptive identity strings (runnerVersion,
// policyVersion, versionFamily) name what is running; they gate nothing.
const bareVersionKey = /(?:^|[^A-Za-z_])(?:"version"|'version'|\bversion)\s*:/;

// Files exempt from the bare-`version` rule only. Both categories describe
// *software* rather than gate a payload shape: shapes we do not own (the
// signed entitlement document, the Language Server Protocol, SBOM output),
// and probe or catalog records reporting a detected tool or skill version.
const descriptiveVersionFiles = new Set([
  "infrastructure/veil/internal/entitlement/entitlement.go",
  "infrastructure/veil/internal/entitlement/entitlement_test.go",
  "infrastructure/veil-console/internal/entitlement/entitlement.go",
  "infrastructure/veil-console/internal/entitlement/entitlement_test.go",
  "infrastructure/veil/internal/http/server_test.go",
  "infrastructure/veil/internal/templates/templates.go",
  "infrastructure/veil/internal/templates/templates_test.go",
  "packages/runner/src/lsp/mod.rs",
  "scripts/generate-sbom.ts",
  "apps/desktop/src/main/capabilities.ts",
  "apps/desktop/src/main/remoteHost.ts",
  "packages/runner/src/conversation_state.rs",
  "apps/desktop/src/renderer/previewEnvironment.ts",
  "apps/desktop/src/renderer/previewCapabilities.ts",
  "apps/desktop/tests/main-capabilities.test.ts",
  "apps/desktop/tests/main-ocr-runtime.test.ts",
  // electron-updater's UpdateInfo, a shape we do not own, describing a release.
  "apps/desktop/tests/main-app-updates.test.ts",
  "apps/desktop/tests/release-artifacts.test.ts",
  "apps/desktop/tests/release-publish.test.ts",
  "apps/desktop/tests/release-version.test.ts",
  // Software advisory/version inventory and a native dependency build pin.
  "apps/desktop/tests/runtime-audit.test.ts",
  "scripts/audit-managed-runtimes.ts",
  "infrastructure/veil-console/deploy/metal-wheels.lock.json",
  "scripts/ci/release-artifacts.ts",
  // Public signed software/component inventory, not an internal wire shape.
  "scripts/ci/windows-signing.ts",
  "scripts/audit-release-actions.ts",
  "apps/desktop/tests/release-actions-audit.test.ts",
  "apps/desktop/tests/no-versioning-guard.test.ts",
]);

// Tests whose whole purpose is to assert that a versioned payload is rejected.
const rejectionAssertionFiles = new Set([
  "packages/runner/src/conversation_state.rs",
  "packages/runner/src/workspace_graph.rs",
  "apps/desktop/tests/no-versioning-guard.test.ts",
]);

function* sourceFiles(directory: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) yield* sourceFiles(full);
      continue;
    }
    if (!entry.isFile() || skippedFiles.has(entry.name)) continue;
    if (scannedExtensions.has(path.extname(entry.name))) yield full;
  }
}

function scan(): string[] {
  const offences: string[] = [];
  for (const root of scannedRoots) {
    for (const file of sourceFiles(path.join(repoRoot, root))) {
      const relative = path.relative(repoRoot, file).split(path.sep).join("/");
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((raw, index) => {
        // Comments explain the rule; they do not implement a contract. Strip
        // them so prose like "not a version" is not read as a field.
        const line = raw.replace(/^\s*(\/\/+|#|\*)\s?.*$/, "");
        if (!rejectionAssertionFiles.has(relative)) {
          for (const field of bannedFields) {
            if (line.includes(field)) offences.push(`${relative}:${index + 1} ${field}`);
          }
        }
        if (!descriptiveVersionFiles.has(relative) && bareVersionKey.test(line)) {
          offences.push(`${relative}:${index + 1} version`);
        }
      });
    }
  }
  return offences;
}

test("no internal contract carries a version, schema version, or contextState field", () => {
  const offences = scan();
  assert.deepEqual(offences, [], `Versioned internal contract fields found:\n${offences.join("\n")}`);
});
