const path = require("node:path");
const { pathToFileURL } = require("node:url");

// The official SignPath action runs between workflow steps. A bounded local
// handoff pauses this same NSIS build, including its generated uninstaller.
exports.default = async function signWindows(configuration) {
  if (configuration.hash !== "sha256") throw new Error("Windows releases require SHA-256 signing.");
  const { signWindows } = await import(pathToFileURL(path.resolve(__dirname, "../../../scripts/ci/windows-signing.ts")).href);
  await signWindows(configuration.path);
};
