// Release-machine identity. Mac release work lives in the repository's ignored
// artifacts/release-work directory; credentials must never be committed.
// docs/release.env.example documents every key.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const releaseDirectory = process.platform === "darwin"
  ? path.resolve(import.meta.dirname, "../artifacts/release-work")
  : path.join(os.homedir(), "umbratic-release");
export const releaseEnvPath = process.platform === "darwin"
  ? path.join(releaseDirectory, "release.env")
  : path.join(os.homedir(), ".umbratic", "release.env");

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
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`${releaseEnvPath}:${index + 1}: expected KEY=value`);
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
 * Public identity of the approved SignPath project. The API token belongs only
 * to the official GitHub action, never to the packaging process.
 */
export function windowsSigningConfig(): {
  organizationId: string;
  projectSlug: string;
  signingPolicySlug: string;
  publisherName: string;
} | null {
  const organizationId = process.env.SIGNPATH_ORGANIZATION_ID?.trim();
  const projectSlug = process.env.SIGNPATH_PROJECT_SLUG?.trim();
  const signingPolicySlug = process.env.SIGNPATH_SIGNING_POLICY_SLUG?.trim();
  const publisherName = process.env.SIGNPATH_PUBLISHER?.trim();
  const set = [organizationId, projectSlug, signingPolicySlug, publisherName].filter(Boolean).length;
  if (set === 0) return null;
  if (set < 4) {
    throw new Error(
      "Windows signing needs SIGNPATH_ORGANIZATION_ID, SIGNPATH_PROJECT_SLUG, "
      + "SIGNPATH_SIGNING_POLICY_SLUG and SIGNPATH_PUBLISHER.",
    );
  }
  if (!/^[0-9a-fA-F-]{36}$/.test(organizationId!) || !/^[A-Za-z0-9_-]+$/.test(projectSlug!)
      || !/^[A-Za-z0-9_-]+$/.test(signingPolicySlug!) || /[\r\n\0]/.test(publisherName!)) throw new Error("Invalid SignPath project identity.");
  return { organizationId: organizationId!, projectSlug: projectSlug!, signingPolicySlug: signingPolicySlug!, publisherName: publisherName! };
}

/** Signed builds must never silently fall back to an unsigned or unnotarized app. */
export function requireSigningEnvironment(platform = process.platform): void {
  if (process.env.UMBRATIC_LLAMA_CPU_ONLY === "1") {
    throw new Error("CPU-only development packages cannot be released.");
  }
  if (platform === "win32") {
    if (!windowsSigningConfig()) throw new Error("Windows release signing is required. Configure the approved SIGNPATH_* project identity.");
    return;
  }
  if (platform !== "darwin") throw new Error("Desktop releases support macOS and Windows only.");
  const apiKey = ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"].every((key) => process.env[key]?.trim());
  const appleId = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"].every((key) => process.env[key]?.trim());
  if (!apiKey && !appleId) throw new Error("macOS releases require complete Apple notarization credentials. Use --unsigned for local testing.");
}
