// Runs electron-builder with this machine's release identity applied.
//
// electron-builder finds the macOS signing identity in the keychain and
// notarizes when the APPLE_* variables are present, so a Mac needs nothing
// beyond its ignored release-work/release.env. Windows signing has no equivalent
// discovery — Trusted Signing is named by four values — and those must not
// sit in electron-builder.yml, where every unsigned developer package
// would try to sign and fail. They come from the same env file and are passed
// on the command line here, so one file describes the release machine on
// both platforms and the config stays valid for everyone else.
//
// Extra arguments pass straight through: `npm run package -- --win nsis --x64`.
// `--unsigned` is ours, not electron-builder's: it skips signing and Apple's
// notarization queue for a package that is only being looked at.

import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";

import { loadReleaseEnv, requireSigningEnvironment, windowsSigningConfig } from "../../../scripts/release-env.ts";

const require = createRequire(import.meta.url);

const forwarded = process.argv.slice(2).filter((argument) => argument !== "--unsigned");
const unsigned = forwarded.length < process.argv.length - 2;

if (unsigned) {
  // The release identity stays untouched in the keychain; electron-builder is
  // told not to go looking for it, and notarization is switched off below
  // rather than left to whatever APPLE_* variables the shell carries. The
  // fuse flip still re-signs ad hoc, so the package runs on this machine —
  // it just must never be published.
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  for (const key of ["CSC_NAME", "CSC_LINK", "CSC_KEY_PASSWORD", "CSC_KEYCHAIN", "WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"]) delete process.env[key];
  console.log("Unsigned package: skipping signing and notarization. For local iteration only.");
} else {
  loadReleaseEnv();
  requireSigningEnvironment();
}

const args = ["--config", "electron-builder.yml", "--publish", "never", ...forwarded];

if (unsigned) {
  args.push("-c.mac.notarize=false", "-c.mac.forceCodeSigning=false", "-c.dmg.sign=false", "-c.win.forceCodeSigning=false");
} else if (process.platform === "darwin") {
  args.push("-c.mac.notarize=true");
} else if (process.platform === "win32") {
  if (!process.env.UMBRATIC_SIGNING_TOOLS) {
    process.env.UMBRATIC_SIGNING_TOOLS = path.join(os.tmpdir(), "umbratic-windows-signing");
    const provision = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File",
      path.resolve(import.meta.dirname, "../../../scripts/ci/install-windows-signing.ps1")], { stdio: "inherit" });
    if (provision.error || provision.status !== 0) throw new Error("Unable to provision reviewed Windows signing tools.");
  }
  process.env.DOTNET_ROOT_X64 = path.join(process.env.UMBRATIC_SIGNING_TOOLS, "dotnet");
  const signing = windowsSigningConfig();
  if (signing) {
    args.push(
      "-c.win.signtoolOptions.sign=scripts/sign-windows.cjs",
      `-c.win.signtoolOptions.publisherName=${signing.publisherName}`,
    );
    console.log(`Signing Windows binaries with Trusted Signing as "${signing.publisherName}".`);
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
