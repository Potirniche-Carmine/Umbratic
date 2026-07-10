import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const configUrl = new URL("../electron-builder.yml", import.meta.url);
const preparePackageUrl = new URL("../scripts/prepare-package.mjs", import.meta.url);

test("desktop packages use the Umbratic product name without a version in Windows installed apps", () => {
  const config = fs.readFileSync(configUrl, "utf8");

  assert.match(config, /^productName: Umbratic$/m);
  assert.match(config, /^mac:\r?$/m);
  assert.match(config, /^  shortcutName: Umbratic$/m);
  assert.match(config, /^  uninstallDisplayName: Umbratic$/m);
  assert.doesNotMatch(config, /^productName:.*\$\{version\}/m);
  assert.doesNotMatch(config, /^  uninstallDisplayName:.*\$\{version\}/m);
});

test("desktop packages the Veil binary used by managed local mode", () => {
  const config = fs.readFileSync(configUrl, "utf8");
  const preparePackage = fs.readFileSync(preparePackageUrl, "utf8");

  assert.match(config, /- from: \.package\/veil\r?\n\s+to: veil/);
  assert.match(preparePackage, /spawnSync\("go", \["build", "-trimpath", "-o", veilBinary, "\.\/cmd\/veil"\]/);
  assert.match(preparePackage, /process\.platform === "win32" \? "veil\.exe" : "veil"/);
});
