// Runs on each native release host before its artifacts can leave the job.
import fs from "node:fs";
import path from "node:path";
import { hashFile } from "./release-artifacts.ts";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const root = path.resolve("target/release/desktop");
function run(command: string, args: string[]) {
  execFileSync(command, args, { stdio: "inherit" });
}
function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const stage = path.resolve("target/release/upload");
fs.mkdirSync(stage, { recursive: true });
if (process.platform === "darwin") {
  const app = path.join(root, "mac-arm64/Umbratic.app");
  run("codesign", ["--verify", "--deep", "--strict", app]);
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
  // Check the installer AND all shipped native executables/libraries. A signed
  // wrapper around unsigned sidecars does not meet the release contract.
  const files = walk(root).filter((file) => /\.(exe|dll|node)$/i.test(file));
  if (files.length === 0) throw new Error("No Windows executables found.");
  const manifest = path.join(stage, "windows-signatures.json");
  fs.writeFileSync(manifest, JSON.stringify(files));
  try {
    run("pwsh", ["-NoProfile", "-File", "scripts/ci/verify-windows-signatures.ps1", "-Manifest", manifest,
      "-Publisher", process.env.UMBRATIC_WIN_SIGN_PUBLISHER!]);
  } finally { fs.rmSync(manifest, { force: true }); }
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
