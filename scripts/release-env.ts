// The release machine's identity, kept outside the repository.
//
// Signing a build and publishing it need credentials — an Apple notarization
// key, an Azure sign-in, R2 access keys — and every one of them belongs to
// the machine that releases, not to the source tree. They live in one file in
// the user's home directory; both `desktop:release` and `publish:release` read
// it, so a release machine is set up exactly once and the repository never
// carries a secret. `docs/release.env.example` documents every key.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const releaseEnvPath = path.join(os.homedir(), ".umbratic", "release.env");

/**
 * Reads the release env file into `process.env`, without overriding anything
 * already exported: a value on the command line always wins over the file.
 * Returns whether the file was found. Missing is not an error — a machine
 * building an unsigned package for a look at the installer needs none of it.
 */
export function loadReleaseEnv(): boolean {
  let text: string;
  try {
    text = fs.readFileSync(releaseEnvPath, "utf8");
  } catch {
    return false;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`${releaseEnvPath}: expected KEY=value, got: ${line}`);
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    // Quotes are allowed around a value, and stripped, so a path with spaces
    // reads the way it would in a shell.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

/** A required key, named in the error so the fix is obvious. */
export function requireReleaseEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is not set. Add it to ${releaseEnvPath} (see docs/release.env.example).`);
  }
  return value;
}

/**
 * The Windows signing configuration, when this machine has one. All four
 * values are public identifiers of the Trusted Signing account; the secret is
 * the Azure sign-in itself, which the signing module takes from `az login` or
 * the AZURE_* variables.
 */
export function windowsSigningConfig(): {
  endpoint: string;
  codeSigningAccountName: string;
  certificateProfileName: string;
  publisherName: string;
} | null {
  const endpoint = process.env.UMBRATIC_WIN_SIGN_ENDPOINT?.trim();
  const codeSigningAccountName = process.env.UMBRATIC_WIN_SIGN_ACCOUNT?.trim();
  const certificateProfileName = process.env.UMBRATIC_WIN_SIGN_PROFILE?.trim();
  const publisherName = process.env.UMBRATIC_WIN_SIGN_PUBLISHER?.trim();
  const set = [endpoint, codeSigningAccountName, certificateProfileName, publisherName].filter(Boolean).length;
  if (set === 0) return null;
  if (set < 4) {
    throw new Error(
      "Windows signing needs all of UMBRATIC_WIN_SIGN_ENDPOINT, UMBRATIC_WIN_SIGN_ACCOUNT, "
      + `UMBRATIC_WIN_SIGN_PROFILE and UMBRATIC_WIN_SIGN_PUBLISHER in ${releaseEnvPath}.`,
    );
  }
  return { endpoint: endpoint!, codeSigningAccountName: codeSigningAccountName!, certificateProfileName: certificateProfileName!, publisherName: publisherName! };
}
