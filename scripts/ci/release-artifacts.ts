import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const { load } = createRequire(import.meta.url)("js-yaml");

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

/** Verify the complete platform set and every updater checksum before publishing. */
export function verifyReleaseArtifacts(directory: string, version: string): string[] {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid stable release version.");
  const prefix = `Umbratic-${version}`;
  const channels: [string, string][] = [
    ["latest-mac.yml", `${prefix}.zip`],
    ["latest.yml", `${prefix}-x64.exe`],
    ["latest-arm64.yml", `${prefix}-arm64.exe`],
  ];
  const expected = new Set([`${prefix}.dmg`, ...channels.flat()]);
  for (const [channel, requiredInstaller] of channels) {
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
      expected.add(name);
    }
    if (metadata.path !== undefined) {
      const selected = metadata.files.find((file) => file.url === metadata.path);
      if (!selected || metadata.sha512 !== selected.sha512) throw new Error(`Inconsistent updater checksum in ${channel}.`);
    }
    if (!found) throw new Error(`${channel} does not reference ${requiredInstaller}.`);
  }
  for (const name of [...expected]) {
    if (!fs.statSync(path.join(directory, name)).isFile()) throw new Error(`Missing release asset ${name}.`);
    if (fs.existsSync(path.join(directory, `${name}.blockmap`))) expected.add(`${name}.blockmap`);
  }
  for (const name of fs.readdirSync(directory)) {
    if (!expected.has(name)) throw new Error(`Unexpected release asset ${name}.`);
  }
  return [...expected].sort();
}
