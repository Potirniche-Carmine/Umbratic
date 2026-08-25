// Publishes the desktop package this machine just built to downloads.umbratic.ai.
//
//   npm run desktop:release          builds, signs, notarizes, verifies
//   npm run publish:release          uploads what that produced
//
// The feed is a Cloudflare R2 bucket behind the downloads host, and this
// script is the only writer to it. It talks S3's API directly with a SigV4
// signature over node:https — a hundred lines here rather than an SDK with a
// dependency tree, in a repository that treats every dependency as a
// supply-chain decision.
//
// Order matters more than speed. Installed apps read latest.yml first and then
// fetch the installer it names, so the installers and their blockmaps go up
// first and the channel file last: at no point does the feed name a file that
// is not there. Installers are immutable once published — a re-run skips what
// is already up and refuses to replace a same-named file with different bytes
// — and the channel file never moves backwards to an older release.
//
// Windows x64 and arm64 are separate builds, usually from separate machines,
// so each has its own channel file (latest.yml, latest-arm64.yml) and the app
// asks for the one matching its architecture. Neither publish can clobber or
// mis-serve the other, and an architecture with no release yet sees no update
// rather than the other architecture's installer.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import process from "node:process";

import { loadReleaseEnv, releaseEnvPath, requireReleaseEnv } from "./release-env.ts";

const root = path.resolve(import.meta.dirname, "..");
const releaseRoot = path.join(root, "target", "release", "desktop");
const feedPrefix = "releases";

const flags = new Set(process.argv.slice(2));
const dryRun = flags.has("--dry-run");
const allowUnsigned = flags.has("--allow-unsigned");
for (const flag of flags) {
  if (flag !== "--dry-run" && flag !== "--allow-unsigned") {
    console.error(`Unknown flag ${flag}. Usage: node scripts/publish-release.ts [--dry-run] [--allow-unsigned]`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// What is being published

const releaseVersion: string = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/**
 * A release is a tag, built from a clean checkout of it. Two machines publish
 * the same version, and this is what makes "the same version" mean the same
 * source on both.
 */
function requireReleaseCheckout() {
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) {
    throw new Error(`The working tree has uncommitted changes. Commit or stash them, then build and publish from the tag:\n${dirty}`);
  }
  const expectedTag = `v${releaseVersion}`;
  const tags = git(["tag", "--points-at", "HEAD"]).split(/\r?\n/).filter(Boolean);
  if (!tags.includes(expectedTag)) {
    throw new Error(
      `HEAD is not tagged ${expectedTag} (package.json says ${releaseVersion}).\n`
      + `  Tag the release commit first:  git tag ${expectedTag} && git push origin ${expectedTag}\n`
      + "  then rebuild with npm run desktop:release so the package comes from the tag.",
    );
  }
}

type Artifact = { file: string; key: string; contentType: string; cacheControl: string };

const immutable = "public, max-age=31536000, immutable";
const shortLived = "public, max-age=300";

function contentTypeFor(name: string): string {
  if (name.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (name.endsWith(".zip")) return "application/zip";
  if (name.endsWith(".exe")) return "application/vnd.microsoft.portable-executable";
  if (name.endsWith(".yml")) return "text/yaml; charset=utf-8";
  return "application/octet-stream";
}

/**
 * The channel file electron-builder wrote, and the installers it names.
 * Reading the file list from the channel file rather than globbing the output
 * directory means what is uploaded is exactly what the app will be told about.
 */
function ymlField(text: string, field: string): string | null {
  return text.match(new RegExp(`^${field}:\\s*(\\S+)\\s*$`, "m"))?.[1] ?? null;
}

function ymlUrls(text: string): string[] {
  return [...text.matchAll(/^\s+-\s+url:\s*(\S+)\s*$/gm)].map((match) => match[1]);
}

function releasePlan(): { channelFile: Artifact; files: Artifact[]; appPath: string } {
  const isMac = process.platform === "darwin";
  const arch = process.arch;
  if (!isMac && process.platform !== "win32") throw new Error("Releases are built on macOS or Windows.");
  const channelName = isMac ? "latest-mac.yml" : arch === "x64" ? "latest.yml" : `latest-${arch}.yml`;
  const channelPath = path.join(releaseRoot, isMac ? "latest-mac.yml" : "latest.yml");
  if (!fs.existsSync(channelPath)) {
    throw new Error(`${path.relative(root, channelPath)} is missing. Run npm run desktop:release first.`);
  }
  const channelText = fs.readFileSync(channelPath, "utf8");
  const channelVersion = ymlField(channelText, "version");
  if (channelVersion !== releaseVersion) {
    throw new Error(`${path.basename(channelPath)} describes ${channelVersion}, but package.json is ${releaseVersion}. Rebuild with npm run desktop:release.`);
  }
  const urls = ymlUrls(channelText);
  if (urls.length === 0) throw new Error(`${path.basename(channelPath)} names no files.`);
  for (const url of urls) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(url)) throw new Error(`Unexpected file name in the channel file: ${url}`);
    if (!isMac && !url.includes(`-${arch}.`)) {
      throw new Error(`${url} was not built for this machine's architecture (${arch}); its sidecars would not match. Publish it from a ${arch === "x64" ? "an arm64" : "an x64"} Windows machine.`);
    }
  }
  const files: Artifact[] = [];
  for (const url of urls) {
    const file = path.join(releaseRoot, url);
    if (!fs.existsSync(file)) throw new Error(`The channel file names ${url}, which is not in ${path.relative(root, releaseRoot)}.`);
    files.push({ file, key: `${feedPrefix}/${url}`, contentType: contentTypeFor(url), cacheControl: immutable });
    // Differential updates fetch the blockmap beside the file; not every
    // target has one (the DMG does not), and one that exists must go up.
    const blockmap = `${file}.blockmap`;
    if (fs.existsSync(blockmap)) {
      files.push({ file: blockmap, key: `${feedPrefix}/${url}.blockmap`, contentType: "application/octet-stream", cacheControl: immutable });
    }
  }
  // The unpacked app is what Gatekeeper is asked about; Windows checks the
  // installers themselves.
  const appPath = isMac ? path.join(releaseRoot, `mac-${arch}`, "Umbratic.app") : "";
  return {
    channelFile: { file: channelPath, key: `${feedPrefix}/${channelName}`, contentType: contentTypeFor(channelName), cacheControl: shortLived },
    files,
    appPath,
  };
}

// ---------------------------------------------------------------------------
// Signature checks. An unsigned build cannot update anyone: macOS refuses to
// swap in an app whose signature does not match, and the Windows updater
// verifies the installer's publisher before running it. Publishing one would
// strand every installed copy on it.

function requireSigned(plan: ReturnType<typeof releasePlan>) {
  const problems: string[] = [];
  if (process.platform === "darwin") {
    const codesign = spawnSync("codesign", ["--verify", "--deep", "--strict", plan.appPath], { encoding: "utf8" });
    if (codesign.status !== 0) problems.push(`codesign: ${codesign.stderr.trim() || "the app is not signed"}`);
    // Gatekeeper's own verdict, which is what users' Macs will reach: accepted
    // by way of a notarized Developer ID, or not.
    const spctl = spawnSync("spctl", ["--assess", "--type", "execute", "--verbose=2", plan.appPath], { encoding: "utf8" });
    const verdict = `${spctl.stdout}${spctl.stderr}`;
    if (spctl.status !== 0 || !/accepted/.test(verdict) || !/Notarized Developer ID/.test(verdict)) {
      problems.push(`spctl: ${verdict.trim() || "the app is not notarized"}`);
    }
  } else {
    for (const artifact of plan.files) {
      if (!artifact.file.endsWith(".exe")) continue;
      const check = spawnSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", `(Get-AuthenticodeSignature -LiteralPath '${artifact.file.replace(/'/g, "''")}').Status`],
        { encoding: "utf8", windowsHide: true },
      );
      const status = `${check.stdout}`.trim();
      if (check.status !== 0 || status !== "Valid") {
        problems.push(`${path.basename(artifact.file)}: Authenticode status ${status || check.stderr.trim() || "unknown"}`);
      }
    }
  }
  if (problems.length === 0) return;
  const detail = problems.map((problem) => `  ${problem}`).join("\n");
  if (!allowUnsigned) {
    throw new Error(`This build is not releasable:\n${detail}\n  Fix the signing setup in ${releaseEnvPath} and rebuild, or pass --allow-unsigned to publish it anyway (nobody's installed copy will update to it).`);
  }
  console.warn(`WARNING: publishing an unsigned build because --allow-unsigned was given:\n${detail}`);
}

// ---------------------------------------------------------------------------
// R2, through S3's API with a SigV4 signature.

type R2 = { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string };

function r2Config(): R2 {
  return {
    accountId: requireReleaseEnv("UMBRATIC_R2_ACCOUNT_ID"),
    accessKeyId: requireReleaseEnv("UMBRATIC_R2_ACCESS_KEY_ID"),
    secretAccessKey: requireReleaseEnv("UMBRATIC_R2_SECRET_ACCESS_KEY"),
    bucket: process.env.UMBRATIC_R2_BUCKET?.trim() || "umbratic-downloads",
  };
}

const emptyHash = crypto.createHash("sha256").update("").digest("hex");

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
  });
}

function hmac(key: Buffer | string, value: string): Buffer {
  return crypto.createHmac("sha256", key).update(value, "utf8").digest();
}

/** S3 wants each path segment URI-encoded the RFC 3986 way, slashes kept. */
function encodeKey(key: string): string {
  return key.split("/").map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
}

type Response = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

function s3Request(
  r2: R2,
  method: "GET" | "HEAD" | "PUT",
  key: string,
  extraHeaders: Record<string, string>,
  body: { file: string; size: number; sha256: string } | null,
): Promise<Response> {
  const host = `${r2.accountId}.r2.cloudflarestorage.com`;
  const canonicalPath = `/${encodeKey(`${r2.bucket}/${key}`)}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = body?.sha256 ?? emptyHash;
  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...Object.fromEntries(Object.entries(extraHeaders).map(([name, value]) => [name.toLowerCase(), value.trim()])),
  };
  if (body) headers["content-length"] = String(body.size);
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [method, canonicalPath, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, crypto.createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${r2.secretAccessKey}`, dateStamp), "auto"), "s3"), "aws4_request");
  const signature = hmac(signingKey, stringToSign).toString("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${r2.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return new Promise((resolve, reject) => {
    const request = https.request({ host, method, path: canonicalPath, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    request.on("error", reject);
    if (body) fs.createReadStream(body.file).on("error", reject).pipe(request);
    else request.end();
  });
}

function describe(response: Response): string {
  const detail = response.body.match(/<Message>([^<]*)<\/Message>/)?.[1] ?? response.body.slice(0, 200);
  return `HTTP ${response.status}${detail ? `: ${detail}` : ""}`;
}

async function remoteSize(r2: R2, key: string): Promise<number | null> {
  const response = await s3Request(r2, "HEAD", key, {}, null);
  if (response.status === 404) return null;
  if (response.status !== 200) throw new Error(`HEAD ${key} failed: ${describe(response)}`);
  return Number(response.headers["content-length"] ?? -1);
}

async function remoteText(r2: R2, key: string): Promise<string | null> {
  const response = await s3Request(r2, "GET", key, {}, null);
  if (response.status === 404) return null;
  if (response.status !== 200) throw new Error(`GET ${key} failed: ${describe(response)}`);
  return response.body;
}

async function upload(r2: R2, artifact: Artifact) {
  const size = fs.statSync(artifact.file).size;
  const response = await s3Request(
    r2,
    "PUT",
    artifact.key,
    { "content-type": artifact.contentType, "cache-control": artifact.cacheControl },
    { file: artifact.file, size, sha256: await sha256File(artifact.file) },
  );
  if (response.status !== 200) throw new Error(`Uploading ${artifact.key} failed: ${describe(response)}`);
}

// ---------------------------------------------------------------------------

function humanSize(bytes: number): string {
  return bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(2)} GB` : `${Math.round(bytes / (1 << 20))} MB`;
}

/** Semver order for the rollback guard: 0.0.10 comes after 0.0.9. */
function compareVersions(a: string, b: string): number {
  const parse = (value: string) => value.split("-")[0].split(".").map((part) => Number(part) || 0);
  const [left, right] = [parse(a), parse(b)];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function main() {
  const configured = loadReleaseEnv();
  if (!configured) throw new Error(`${releaseEnvPath} does not exist. Copy docs/release.env.example there and fill it in.`);
  requireReleaseCheckout();
  const plan = releasePlan();
  requireSigned(plan);
  const r2 = r2Config();

  console.log(`Publishing Umbratic ${releaseVersion} (${process.platform} ${process.arch}) to r2://${r2.bucket}/${feedPrefix}${dryRun ? " — dry run, nothing will be uploaded" : ""}`);

  // The rollback guard: the channel file must never point at an older release
  // than the one it points at now. Equal is a re-publish and fine.
  const live = await remoteText(r2, plan.channelFile.key);
  const liveVersion = live ? ymlField(live, "version") : null;
  if (liveVersion && compareVersions(liveVersion, releaseVersion) > 0) {
    throw new Error(`${path.basename(plan.channelFile.key)} already serves ${liveVersion}, which is newer than ${releaseVersion}. A release cannot move the feed backwards.`);
  }

  for (const artifact of plan.files) {
    const size = fs.statSync(artifact.file).size;
    const existing = await remoteSize(r2, artifact.key);
    if (existing !== null && existing !== size) {
      throw new Error(`${artifact.key} is already published with a different size (${existing} bytes here, ${size} local). Published installers are immutable: bump the version instead.`);
    }
    if (existing !== null) {
      console.log(`  = ${artifact.key} (already up)`);
      continue;
    }
    console.log(`  ^ ${artifact.key} (${humanSize(size)})`);
    if (!dryRun) await upload(r2, artifact);
  }
  console.log(`  ^ ${plan.channelFile.key}${liveVersion ? ` (was ${liveVersion})` : ""}`);
  if (!dryRun) await upload(r2, plan.channelFile);

  console.log(dryRun ? "Dry run complete." : `Published. Installed apps will pick up ${releaseVersion} on their next check.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
