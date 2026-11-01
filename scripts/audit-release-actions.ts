// These external action bundles are outside the application npm lock graph.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { validateOsvBatch } from "./audit-managed-runtimes.ts";

type Package = { name: string; version: string };
type Finding = { package: string; version: string; id: string; modified: string; reason: string };
type Action = { repository: string; commit: string; blobs: Record<string, string>; embeddedPackages?: Package[]; findings: Finding[] };
type Review = { controls: Record<string, string>; actions: Action[] };
const repositories = new Map([
  ["actions/attest", ["action.yml", "dist/index.js", "package-lock.json"]],
  ["signpath/github-action-submit-signing-request", ["action.yml", "index.js"]],
]);
const controls = [
  ".github/workflows/release.yml", ".github/workflows/verify.yml",
  "scripts/ci/release-attestations.ts", "scripts/ci/verify-ci-attestation.ts",
  "scripts/ci/windows-signing.ts", "scripts/ci/windows-signpath-build.ts",
];
const digest = (bytes: Uint8Array) => crypto.createHash("sha256").update(bytes).digest("hex");

export function verifyActionControls(review: Review, read: (name: string) => Buffer): void {
  if (Object.keys(review.controls).length !== controls.length || review.actions.length !== repositories.size
      || new Set(review.actions.map((action) => action.repository)).size !== repositories.size) throw new Error("Incomplete release-action review.");
  for (const name of controls) {
    if (!/^[0-9a-f]{64}$/.test(review.controls[name] ?? "") || digest(read(name)) !== review.controls[name]) {
      throw new Error(`Release-action applicability control changed and requires review: ${name}`);
    }
  }
  const workflows = [read(controls[0]).toString(), read(controls[1]).toString()].join("\n");
  for (const action of review.actions) {
    const expected = repositories.get(action.repository);
    if (!expected || !/^[0-9a-f]{40}$/.test(action.commit)
        || Object.keys(action.blobs).sort().join("\n") !== [...expected].sort().join("\n")
        || Object.values(action.blobs).some((hash) => !/^[0-9a-f]{64}$/.test(hash))) throw new Error("Invalid reviewed action source identity.");
    const refs = [...workflows.matchAll(new RegExp(`uses:\\s*${action.repository.replaceAll(".", "\\.")}@([^\\s#]+)`, "g"))];
    if (refs.length === 0 || refs.some((match) => match[1] !== action.commit)) throw new Error(`Unreviewed action revision: ${action.repository}`);
  }
}

export function verifyActionBlob(action: Action, name: string, bytes: Buffer): void {
  if (!Object.hasOwn(action.blobs, name) || digest(bytes) !== action.blobs[name]) throw new Error(`Reviewed action blob changed: ${action.repository}/${name}`);
}

export function actionPackages(action: Action, sources: Record<string, Buffer>): Package[] {
  if (action.repository === "actions/attest") {
    const lock = JSON.parse(sources["package-lock.json"].toString());
    const packages = new Map<string, Package>();
    for (const [location, entry] of Object.entries(lock.packages) as [string, { name?: string; version: string; dev?: boolean }][]) {
      if (!location || entry.dev === true) continue;
      const name = entry.name ?? location.split("node_modules/").at(-1)!;
      if (!/^[A-Za-z0-9@/_.-]+$/.test(name) || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(entry.version)) throw new Error("Invalid action lock inventory.");
      packages.set(`${name}@${entry.version}`, { name, version: entry.version });
    }
    if (packages.size === 0) throw new Error("Empty action lock inventory.");
    return [...packages.values()];
  }
  // SignPath publishes only a bundled entrypoint, without a release lockfile.
  // Audit the two version-identifiable dependencies; do not invent a full SBOM.
  const packages = action.embeddedPackages;
  const source = sources["index.js"].toString();
  if (packages?.length !== 2
      || packages[0].name !== "axios" || !source.includes(`const VERSION = "${packages[0].version}";`)
      || packages[1].name !== "moment" || !source.includes(`hooks.version = '${packages[1].version}';`)) throw new Error("SignPath embedded dependency identity changed.");
  return packages;
}

export function reviewActionFindings(action: Action, packages: Package[], findings: { id: string; modified: string }[][]): Finding[] {
  const key = (item: Finding) => `${item.package}@${item.version}:${item.id}`;
  const expected = new Map(action.findings.map((item) => [key(item), item]));
  if (expected.size !== action.findings.length || action.findings.some((item) => !item.reason?.trim())) throw new Error("Incomplete action advisory dispositions.");
  const matches: Finding[] = [];
  for (const [index, pkg] of packages.entries()) {
    for (const found of findings[index]) {
      const id = `${pkg.name}@${pkg.version}:${found.id}`;
      const approved = expected.get(id);
      if (!approved || approved.modified !== found.modified) throw new Error(`New or changed action advisory requires review: ${id}`);
      matches.push(approved);
      expected.delete(id);
    }
  }
  if (expected.size !== 0) throw new Error("Action advisory inventory changed; reconcile the reviewed records.");
  return matches;
}

async function boundedFetch(url: string, init: RequestInit = {}): Promise<Buffer> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000), redirect: "error" });
  const maximum = 8 * 1024 * 1024;
  if (!response.ok || !response.body || Number(response.headers.get("content-length") ?? 0) > maximum) throw new Error("Release-action source/advisory download failed.");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maximum) throw new Error("Release-action source/advisory response exceeds its bound.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function main() {
  const read = (name: string) => fs.readFileSync(path.resolve(name));
  const review: Review = JSON.parse(read("third_party/release-actions-security.json").toString());
  verifyActionControls(review, read);
  const results = [];
  for (const action of review.actions) {
    const sources: Record<string, Buffer> = {};
    for (const name of Object.keys(action.blobs)) {
      const bytes = await boundedFetch(`https://raw.githubusercontent.com/${action.repository}/${action.commit}/${name}`);
      verifyActionBlob(action, name, bytes);
      sources[name] = bytes;
    }
    const packages = actionPackages(action, sources);
    const response = await boundedFetch("https://api.osv.dev/v1/querybatch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queries: packages.map((pkg) => ({ package: { ecosystem: "npm", name: pkg.name }, version: pkg.version })) }),
    });
    const findings = validateOsvBatch(JSON.parse(response.toString()), packages.length);
    const matches = reviewActionFindings(action, packages, findings);
    results.push({ repository: action.repository, commit: action.commit, queried: packages.length, matches });
    console.log(`${action.repository}@${action.commit}: ${packages.length} package versions checked; ${matches.length} conditional advisory matches reviewed.`);
  }
  fs.mkdirSync("artifacts/supply-chain", { recursive: true });
  fs.writeFileSync("artifacts/supply-chain/release-actions-osv-review.json", JSON.stringify(results, null, 2) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
