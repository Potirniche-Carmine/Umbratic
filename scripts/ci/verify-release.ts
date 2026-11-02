// Verify signed macOS artifacts before they can leave the release job.
import fs from "node:fs";
import path from "node:path";
import { hashFile, verifyMacSigningTeam } from "./release-artifacts.ts";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";

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
  // Apple ticket delivery can fail after notarization has already succeeded.
  // Retry only transient transport/service failures; every gate below still runs.
  for (let attempt = 1; ; attempt++) {
    const result = spawnSync("xcrun", ["stapler", "staple", dmg], {
      encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024,
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (output.trim()) console.log(output.trim());
    if (!result.error && result.status === 0) break;
    const transient = /NSURLErrorDomain Code=-(?:1001|1005|1009)\b|network connection was lost|request timed out|service unavailable|HTTP[^\n]*\b(?:502|503|504)\b/i.test(output);
    if (attempt >= 3 || result.error || !transient) throw new Error(`Disk image stapling failed (exit ${result.status}).`, { cause: result.error });
    console.log(`Retrying Apple ticket delivery after transient failure (${attempt}/3).`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 15_000));
  }
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
} else throw new Error("Unsupported release host.");
const channel = "latest-mac.yml";
const expected = [".dmg", ".zip"];
for (const suffix of expected) {
  if (!fs.existsSync(path.join(root, `Umbratic-${version}${suffix}`))) throw new Error(`Missing release artifact ${suffix}.`);
}
if (!fs.existsSync(path.join(root, channel))) throw new Error(`Missing ${channel}.`);
for (const name of fs.readdirSync(root)) {
  if (name === channel || /^Umbratic-.*\.(?:exe|dmg|zip|blockmap)$/.test(name)) {
    fs.copyFileSync(path.join(root, name), path.join(stage, name));
  }
}
console.log(`Verified signed ${process.platform}/${process.arch} release artifacts.`);
