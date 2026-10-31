const { spawnSync } = require("node:child_process");
const path = require("node:path");

// electron-builder's Azure manager installs unpinned PowerShell modules.
// A custom hook uses only the reviewed, checksum-verified Microsoft tools.
exports.default = async function signWindows(configuration) {
  if (configuration.hash !== "sha256") throw new Error("Windows releases require SHA-256 signing.");
  const script = path.resolve(__dirname, "../../../scripts/ci/sign-windows.ps1");
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", script, "-File", configuration.path], {
    stdio: "inherit", windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error("Windows Trusted Signing failed.");
};
