// Runs on each native release host before its artifacts can leave the job.
import fs from "node:fs";
import path from "node:path";
import { hashFile, verifyMacSigningTeam, verifyUpdaterPublisher } from "./release-artifacts.ts";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { inspect, requireProjectIdentity, sha256, signingRoot, verifyInventory } from "./windows-signing.ts";
import { withWindowsArchiveTool } from "./windows-archive-tool.ts";
import { verifyNsisUninstaller } from "./nsis-archive.ts";

const root = path.resolve("target/release/desktop");
function run(command: string, args: string[]) {
  execFileSync(command, args, { stdio: "inherit" });
}
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const stage = path.resolve("target/release/upload");
fs.mkdirSync(stage, { recursive: true });
if (process.platform === "darwin") {
  const app = path.join(root, "mac-arm64/Umbratic.app");
  run("codesign", ["--verify", "--deep", "--strict", app]);
  const identity = spawnSync("codesign", ["--display", "--verbose=4", app], { encoding: "utf8" });
  if (identity.error || identity.status !== 0) throw new Error("Unable to read the macOS signing identity.");
  verifyMacSigningTeam(identity.stderr, process.env.APPLE_TEAM_ID!);
  run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
  run("xcrun", ["stapler", "validate", app]);
  const dmg = path.join(root, `Umbratic-${version}.dmg`);
  if (!process.env.UMBRATIC_NOTARY_PROFILE || !process.env.CSC_KEYCHAIN) throw new Error("Missing CI notarization profile.");
  const submission = JSON.parse(execFileSync("xcrun", ["notarytool", "submit", dmg, "--keychain-profile",
    process.env.UMBRATIC_NOTARY_PROFILE, "--keychain", process.env.CSC_KEYCHAIN, "--wait", "--timeout", "20m", "--output-format", "json"], { encoding: "utf8", timeout: 21 * 60 * 1000 }));
  if (submission.status !== "Accepted") throw new Error("The macOS disk image did not pass notarization.");
  run("xcrun", ["stapler", "staple", dmg]);
  run("xcrun", ["stapler", "validate", dmg]);
  run("codesign", ["--verify", "--strict", dmg]);
  run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", dmg]);
  fs.rmSync(`${dmg}.blockmap`, { force: true });
  // Stapling changes the disk-image bytes after electron-builder wrote hashes.
  const { load, dump } = createRequire(import.meta.url)("js-yaml");
  const channelPath = path.join(root, "latest-mac.yml");
  const metadata = load(fs.readFileSync(channelPath, "utf8"));
  for (const file of metadata.files) {
    if (file.url === path.basename(dmg)) {
      delete file.blockMapSize;
      file.size = fs.statSync(dmg).size;
      file.sha512 = hashFile(dmg, "sha512", "base64");
    }
  }
  if (metadata.path === path.basename(dmg)) metadata.sha512 = hashFile(dmg, "sha512", "base64");
  fs.writeFileSync(channelPath, dump(metadata));
} else if (process.platform === "win32") {
  const unpacked = process.arch === "x64" ? "win-unpacked" : "win-arm64-unpacked";
  const { load } = createRequire(import.meta.url)("js-yaml");
  const app = path.join(root, unpacked);
  const publisher = process.env.SIGNPATH_PUBLISHER!;
  verifyUpdaterPublisher(load(fs.readFileSync(path.join(app, "resources/app-update.yml"), "utf8")), publisher);
  const inventory = JSON.parse(fs.readFileSync(path.join(app, "resources/windows-signing-provenance.json"), "utf8"));
  verifyInventory(app, inventory, publisher);
  const installerName = `Umbratic-${version}-${process.arch}.exe`;
  const installer = path.join(root, installerName);
  requireProjectIdentity(inspect([installer])[0], publisher, version);
  const result = JSON.parse(fs.readFileSync(path.join(signingRoot(), "uninstaller/result.json"), "utf8"));
  if (result.length !== 1 || result[0].name !== `Umbratic-${version}-${process.arch}.__uninstaller.exe`) throw new Error("Missing signed uninstaller provenance.");
  requireProjectIdentity(result[0].identity, publisher, version);
  await withWindowsArchiveTool((tool) => verifyNsisUninstaller(tool, installer, result[0].sha256));
  fs.writeFileSync(path.join(stage, `Umbratic-${version}-${process.arch}-windows-provenance.json`), JSON.stringify({
    ...inventory, installer: { name: installerName, sha256: sha256(installer) }, uninstaller: result[0],
  }, null, 2) + "\n");
} else throw new Error("Unsupported release host.");
const channel = process.platform === "darwin" ? "latest-mac.yml" : "latest.yml";
const expected = process.platform === "darwin" ? [`.dmg`, `.zip`] : [`-${process.arch}.exe`];
for (const suffix of expected) {
  if (!fs.existsSync(path.join(root, `Umbratic-${version}${suffix}`))) throw new Error(`Missing release artifact ${suffix}.`);
}
if (!fs.existsSync(path.join(root, channel))) throw new Error(`Missing ${channel}.`);
for (const name of fs.readdirSync(root)) {
  if (name === channel || /^Umbratic-.*\.(?:exe|dmg|zip|blockmap)$/.test(name)) {
    const destination = name === "latest.yml" && process.arch === "arm64" ? "latest-arm64.yml" : name;
    fs.copyFileSync(path.join(root, name), path.join(stage, destination));
  }
}
console.log(`Verified signed ${process.platform}/${process.arch} release artifacts.`);
