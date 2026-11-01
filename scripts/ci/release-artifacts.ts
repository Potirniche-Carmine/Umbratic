import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const { load } = createRequire(import.meta.url)("js-yaml");

export function verifyUpdaterPublisher(metadata: { publisherName?: unknown }, expected: string): void {
  const publishers = Array.isArray(metadata.publisherName) ? metadata.publisherName : [metadata.publisherName];
  if (!expected?.trim() || publishers.length !== 1 || publishers[0] !== expected) {
    throw new Error("Packaged updater publisher does not match the release signing identity.");
  }
}

export function verifyMacSigningTeam(description: string, expected: string): void {
  if (!/^[A-Z0-9]{10}$/.test(expected ?? "") || description.match(/^TeamIdentifier=(.+)$/m)?.[1] !== expected) {
    throw new Error("Packaged macOS app does not use the configured Developer ID team.");
  }
}

export function hashFile(file: string, algorithm: string, encoding: "hex" | "base64"): string {
  const hash = crypto.createHash(algorithm);
  const descriptor = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let length;
    while ((length = fs.readSync(descriptor, buffer, 0, buffer.length, null)) !== 0) hash.update(buffer.subarray(0, length));
    return hash.digest(encoding);
  } finally { fs.closeSync(descriptor); }
}

/** Validate the actual installer bytes named by one platform's updater file. */
export function verifyUpdateChannel(directory: string, version: string, channel: string, requiredInstaller: string): string[] {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid stable release version.");
  const prefix = `Umbratic-${version}`;
  const names = new Set([channel]);
  const metadata = load(fs.readFileSync(path.join(directory, channel), "utf8"));
  if (metadata?.version !== version || !Array.isArray(metadata.files) || metadata.files.length === 0) {
    throw new Error(`Invalid release metadata: ${channel}`);
  }
  let found = false;
  const permitted = new Set(channel === "latest-mac.yml" ? [`${prefix}.zip`, `${prefix}.dmg`] : [requiredInstaller]);
  for (const file of metadata.files) {
    const name = file.url;
    if (typeof name !== "string" || !name.startsWith(prefix) || path.basename(name) !== name || /[/\\?#%]/.test(name)) {
      throw new Error(`Unsafe release asset name in ${channel}.`);
    }
    if (!permitted.has(name)) throw new Error(`Wrong platform asset in ${channel}.`);
    if (name === requiredInstaller) found = true;
    const artifact = path.join(directory, name);
    if (!fs.statSync(artifact).isFile() || fs.statSync(artifact).size !== file.size
        || hashFile(artifact, "sha512", "base64") !== file.sha512) {
      throw new Error(`Release checksum or size mismatch: ${name}`);
    }
    names.add(name);
  }
  if (metadata.path !== undefined) {
    const selected = metadata.files.find((file) => file.url === metadata.path);
    if (!selected || metadata.sha512 !== selected.sha512) throw new Error(`Inconsistent updater checksum in ${channel}.`);
  }
  if (!found) throw new Error(`${channel} does not reference ${requiredInstaller}.`);
  return [...names];
}

/** Validate all platform payloads and return their exact expected asset names. */
export function releaseArtifactNames(directory: string, version: string): string[] {
  const prefix = `Umbratic-${version}`;
  const channels: [string, string][] = [
    ["latest-mac.yml", `${prefix}.zip`],
    ["latest.yml", `${prefix}-x64.exe`],
    ["latest-arm64.yml", `${prefix}-arm64.exe`],
  ];
  const expected = new Set([`${prefix}.dmg`]);
  for (const [channel, requiredInstaller] of channels) {
    for (const name of verifyUpdateChannel(directory, version, channel, requiredInstaller)) expected.add(name);
  }
  for (const name of [...expected]) {
    if (!fs.statSync(path.join(directory, name)).isFile()) throw new Error(`Missing release asset ${name}.`);
    if (fs.existsSync(path.join(directory, `${name}.blockmap`))) expected.add(`${name}.blockmap`);
  }
  return [...expected].sort();
}

/** Every expected file is required; links, directories and extra files fail. */
export function verifyExactAssetSet(directory: string, expected: readonly string[]): void {
  const names = new Set(expected);
  if (names.size !== expected.length) throw new Error("Duplicate release asset name.");
  for (const name of names) {
    if (path.basename(name) !== name || /[/\\?#%]/.test(name)
        || !fs.lstatSync(path.join(directory, name)).isFile()) {
      throw new Error(`Invalid release asset ${name}.`);
    }
  }
  for (const name of fs.readdirSync(directory)) {
    if (!names.has(name)) throw new Error(`Unexpected release asset ${name}.`);
  }
}

/** Verify the complete unsigned platform set and every updater checksum. */
export function verifyReleaseArtifacts(directory: string, version: string): string[] {
  const files = releaseArtifactNames(directory, version);
  verifyExactAssetSet(directory, files);
  return files;
}
