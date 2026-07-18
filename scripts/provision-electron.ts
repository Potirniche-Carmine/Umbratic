import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import {
  electronPackageRoot,
  resolveInstalledElectron,
} from "../apps/desktop/scripts/electron-runtime.ts";

const root = process.cwd();
const desktopManifest = JSON.parse(
  fs.readFileSync(path.join(root, "apps/desktop/package.json"), "utf8"),
);
const packageRoot = electronPackageRoot();
const electronManifest = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
);
const expectedVersion = desktopManifest.devDependencies?.electron;

if (electronManifest.version !== expectedVersion) {
  throw new Error(
    `Installed Electron ${electronManifest.version} does not match the exact manifest version ${expectedVersion}. Run npm ci --ignore-scripts first.`,
  );
}

try {
  const executable = resolveInstalledElectron();
  console.log(`Electron ${expectedVersion} runtime is already provisioned at ${executable}.`);
  process.exit(0);
} catch {
  // The explicit provisioning step below is the only supported download path.
}

const installScript = path.join(packageRoot, "install.js");
if (!fs.existsSync(installScript)) {
  throw new Error(`Electron ${expectedVersion} install script is missing from the locked npm package.`);
}

console.log(`Provisioning the checksum-verified Electron ${expectedVersion} runtime...`);
const environment = { ...process.env };
delete environment.ELECTRON_SKIP_BINARY_DOWNLOAD;
delete environment.ELECTRON_SKIP_DOWNLOAD;
const result = spawnSync(process.execPath, [installScript], {
  cwd: packageRoot,
  env: environment,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error || result.status !== 0) {
  throw new Error(
    `Electron runtime provisioning failed: ${result.error?.message ?? `exit code ${result.status ?? "unknown"}`}`,
  );
}

console.log(`Electron ${expectedVersion} runtime verified at ${resolveInstalledElectron()}.`);
