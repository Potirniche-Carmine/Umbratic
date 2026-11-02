// Build-only NSIS verification uses a full decoder outside package-manager graphs.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

type Target = { url: string; sha256: string; bytes: number; files: Record<string, string> };
export type ArchiveToolPin = { version: string; release: string; source: { url: string; sha256: string }; targets: Record<string, Target> };
type Finding = { id: string; modified: string; sha256: string; reason: string };
type Review = { version: string; pinSha256: string; sourceCommit: string; records: Finding[] };
const nvdUrl = "https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=7-Zip&resultsPerPage=2000";
const digest = (bytes: Uint8Array | string) => crypto.createHash("sha256").update(bytes).digest("hex");
const hashPattern = /^[0-9a-f]{64}$/;

export function advisoryDigest(value: unknown): string {
  const canonical = (item: any): any => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])])) : item;
  return digest(JSON.stringify(canonical(value)));
}

export function verifyArchiveToolPin(pin: ArchiveToolPin, review: Review, source: Buffer): void {
  if (!/^\d{2}\.\d{2}$/.test(pin.version) || review.version !== pin.version || digest(source) !== review.pinSha256
      || !/^[0-9a-f]{40}$/.test(review.sourceCommit) || !Array.isArray(review.records) || !review.records.length
      || review.records.some((record) => !/^CVE-\d{4}-\d{4,}$/.test(record.id) || !hashPattern.test(record.sha256)
        || !Number.isFinite(Date.parse(record.modified)) || !record.reason?.trim())) throw new Error("The full archive tool pin requires security review.");
  const release = `https://github.com/ip7z/7zip/releases/tag/${pin.version}`;
  const base = `https://github.com/ip7z/7zip/releases/download/${pin.version}/7z${pin.version.replace(".", "")}`;
  if (pin.release !== release || pin.source.url !== `${base}-src.tar.xz` || !hashPattern.test(pin.source.sha256)
      || Object.keys(pin.targets).sort().join(",") !== "win32-arm64,win32-x64") throw new Error("Unreviewed full archive tool origin or target.");
  for (const [target, entry] of Object.entries(pin.targets)) {
    if (entry.url !== `${base}-${target.slice(6)}.exe` || !hashPattern.test(entry.sha256)
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > 2_000_000
        || Object.keys(entry.files).sort().join(",") !== "7z.dll,7z.exe,License.txt"
        || Object.values(entry.files).some((hash) => !hashPattern.test(hash))) throw new Error("Incomplete full archive tool payload pin.");
  }
}

export function reviewArchiveAdvisories(data: any, review: Pick<Review, "records">): void {
  if (!data || data.format !== "NVD_CVE" || data.version !== "2.0" || "error" in data || "errors" in data || "message" in data
      || data.startIndex !== 0 || !Array.isArray(data.vulnerabilities)
      || data.totalResults !== data.vulnerabilities.length || data.resultsPerPage !== data.vulnerabilities.length) {
    throw new Error("Incomplete or paginated archive-tool advisory response.");
  }
  const expected = new Map(review.records.map((record) => [record.id, record]));
  if (expected.size !== review.records.length || !expected.size) throw new Error("Incomplete archive-tool advisory review.");
  for (const entry of data.vulnerabilities) {
    const cve = entry?.cve;
    const record = expected.get(cve?.id);
    if (!/^CVE-\d{4}-\d{4,}$/.test(cve?.id ?? "") || !record || !record.reason?.trim() || !hashPattern.test(record.sha256)
        || record.modified !== cve.lastModified || record.sha256 !== advisoryDigest(cve)) {
      throw new Error(`New or changed archive-tool advisory requires review: ${cve?.id ?? "invalid record"}`);
    }
    expected.delete(record.id);
  }
  if (expected.size) throw new Error("Archive-tool advisory inventory changed; reconcile the review.");
}

async function json(url: string): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: "error", headers: { Accept: "application/json" } });
  const maximum = 16 * 1024 * 1024;
  if (!response.ok || !response.body || Number(response.headers.get("content-length") ?? 0) > maximum) throw new Error("Archive-tool provenance/advisory request failed.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) throw new Error("Archive-tool provenance/advisory response exceeds its bound.");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

async function main(): Promise<void> {
  const source = fs.readFileSync("third_party/7zip.json");
  const pin: ArchiveToolPin = JSON.parse(source.toString());
  const review: Review = JSON.parse(fs.readFileSync("third_party/7zip-security.json", "utf8"));
  verifyArchiveToolPin(pin, review, source);
  const api = "https://api.github.com/repos/ip7z/7zip";
  const release = await json(`${api}/releases/tags/${pin.version}`);
  if (release.tag_name !== pin.version || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) throw new Error("Invalid upstream archive-tool release.");
  for (const entry of [pin.source, ...Object.values(pin.targets)]) {
    const assets = release.assets.filter((asset: any) => asset.browser_download_url === entry.url);
    if (assets.length !== 1 || assets[0].digest !== `sha256:${entry.sha256}`
        || ("bytes" in entry && assets[0].size !== entry.bytes)) throw new Error("Official archive-tool asset identity changed.");
  }
  const ref = await json(`${api}/git/ref/tags/${pin.version}`);
  if (ref.object?.type !== "commit" || ref.object.sha !== review.sourceCommit) throw new Error("Official archive-tool source revision changed.");
  const upstream = await json(`${api}/security-advisories`);
  if (!Array.isArray(upstream) || upstream.length) throw new Error("New upstream archive-tool advisory requires review.");
  const advisories = await json(nvdUrl);
  reviewArchiveAdvisories(advisories, review);
  fs.mkdirSync("artifacts/supply-chain", { recursive: true });
  fs.writeFileSync("artifacts/supply-chain/7zip-review.json", JSON.stringify({ version: pin.version, sourceCommit: review.sourceCommit,
    checkedAt: new Date().toISOString(), nvd: nvdUrl, records: review.records }, null, 2) + "\n");
  console.log(`Full archive tool ${pin.version}: official source/assets verified; ${review.records.length} primary NVD records reviewed.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
