// Runs electron-builder with this machine's release identity applied.
//
// electron-builder finds the macOS signing identity in the keychain and
// notarizes when the APPLE_* variables are present, so a Mac needs nothing
// beyond `~/.umbratic/release.env`. Windows signing has no equivalent
// discovery — Trusted Signing is named by four values — and those must not
// sit in electron-builder.yml, where every unsigned developer and CI package
// would try to sign and fail. They come from the same env file and are passed
// on the command line here, so one file describes the release machine on
// both platforms and the config stays valid for everyone else.
//
// Extra arguments pass straight through: `npm run package -- --win nsis --x64`.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";

import { loadReleaseEnv, windowsSigningConfig } from "../../../scripts/release-env.ts";

const require = createRequire(import.meta.url);

loadReleaseEnv();

const args = ["--config", "electron-builder.yml", "--publish", "never", ...process.argv.slice(2)];

if (process.platform === "win32") {
  const signing = windowsSigningConfig();
  if (signing) {
    args.push(
      `-c.win.azureSignOptions.endpoint=${signing.endpoint}`,
      `-c.win.azureSignOptions.codeSigningAccountName=${signing.codeSigningAccountName}`,
      `-c.win.azureSignOptions.certificateProfileName=${signing.certificateProfileName}`,
      `-c.win.azureSignOptions.publisherName=${signing.publisherName}`,
    );
    console.log(`Signing Windows binaries with Trusted Signing as "${signing.publisherName}".`);
  } else {
    console.warn("No Windows signing configuration in ~/.umbratic/release.env: this package is unsigned and cannot be released.");
  }
}

const child = spawn(process.execPath, [require.resolve("electron-builder/cli.js"), ...args], { stdio: "inherit" });
child.once("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`electron-builder stopped with ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
