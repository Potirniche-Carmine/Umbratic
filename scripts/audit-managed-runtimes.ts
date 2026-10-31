import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

type Package = { ecosystem: "Go" | "PyPI"; name: string; version: string };
type Evidence = { joseSourceVerified: boolean; setuptoolsInstallVerified: boolean; openPgpImported: boolean };
const joseIds = new Set(["GHSA-4w3g-jfj2-cw2q", "GHSA-mgcc-cww5-fp2q", "GHSA-vvm8-gf78-28g4"]);
const setuptoolsIds = new Set(["GHSA-h35f-9h28-mq5c", "PYSEC-2026-3447", "GHSA-xmj3-9gf7-h52w"]);
const reviewedModified = new Map([
  ["GHSA-4w3g-jfj2-cw2q", "2026-10-28T21:30:06.790863Z"],
  ["GHSA-mgcc-cww5-fp2q", "2026-10-27T19:15:23.147827Z"],
  ["GHSA-vvm8-gf78-28g4", "2026-10-28T21:30:05.801821Z"],
  ["GHSA-h35f-9h28-mq5c", "2026-09-10T03:50:52.323347Z"],
  ["PYSEC-2026-3447", "2026-07-14T10:56:37.948360Z"],
  ["GHSA-xmj3-9gf7-h52w", "2026-10-23T22:00:03.739009Z"],
  ["GO-2026-5932", "2026-07-10T05:44:31.101996Z"],
]);
type Finding = { id: string; modified: string };

export function validateOsvBatch(data: unknown, expected: number): Finding[][] {
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  if (!object(data) || Object.keys(data).some((key) => key !== "results") || !Array.isArray(data.results) || data.results.length !== expected) {
    throw new Error("Runtime OSV query returned an incomplete or erroneous inventory.");
  }
  return data.results.map((result) => {
    if (!object(result) || Object.keys(result).some((key) => key !== "vulns")
        || ("vulns" in result && !Array.isArray(result.vulns))) {
      throw new Error("Runtime OSV query returned an erroneous, malformed or paginated result; a complete review is required.");
    }
    return ((result.vulns ?? []) as unknown[]).map((finding) => {
      if (!object(finding) || typeof finding.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{1,100}$/.test(finding.id)
          || typeof finding.modified !== "string" || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(finding.modified) || !Number.isFinite(Date.parse(finding.modified))) {
        throw new Error("Runtime OSV query returned invalid advisory metadata.");
      }
      const reviewed = reviewedModified.get(finding.id);
      if (reviewed && reviewed !== finding.modified) throw new Error(`Runtime advisory ${finding.id} changed and requires review (modified ${finding.modified}).`);
      return { id: finding.id, modified: finding.modified };
    });
  });
}

export function reviewedDisposition(pkg: Package, id: string, evidence: Evidence): string | undefined {
  if (pkg.ecosystem === "Go" && pkg.name === "github.com/go-jose/go-jose/v3" && pkg.version === "v3.0.5"
      && joseIds.has(id) && evidence.joseSourceVerified) return "Fixed by the checksum-verified upstream source backports";
  if (pkg.ecosystem === "PyPI" && pkg.name === "setuptools" && pkg.version === "78.1.1"
      && setuptoolsIds.has(id) && evidence.setuptoolsInstallVerified) return "Not affected: verified Mac-only offline wheel installation; no sdist build or Windows legacy installer";
  if (pkg.ecosystem === "Go" && pkg.name === "golang.org/x/crypto" && id === "GO-2026-5932"
      && !evidence.openPgpImported) return "Module notice only: OpenPGP is not imported by either compiled graph";
}

export function verifyControlFiles(proof: Record<string, string>, read: (name: string) => Buffer): void {
  const expected = [
    "infrastructure/veil-console/deploy/build-metal-kit.py",
    "infrastructure/veil-console/internal/deployment/host.go",
    "infrastructure/veil-console/internal/deployment/package.go",
  ];
  if (Object.keys(proof).length !== expected.length || expected.some((name) => !/^[0-9a-f]{64}$/.test(proof[name] ?? ""))) {
    throw new Error("Setuptools applicability requires the complete reviewed installation-control file set.");
  }
  for (const name of expected) {
    if (crypto.createHash("sha256").update(read(name)).digest("hex") !== proof[name]) {
      throw new Error(`Runtime applicability controls changed and require review: ${name}`);
    }
  }
}

async function main() {
  const root = process.cwd();
  const read = (name: string) => fs.readFileSync(path.join(root, name));
  const policy = JSON.parse(read("supply-chain-policy.json").toString());
  // The source checksum gate also verifies the actual Caddy module replacement.
  const integrity = spawnSync(process.execPath, ["scripts/check-supply-chain.ts"], { cwd: root, stdio: "inherit" });
  if (integrity.error || integrity.status !== 0) throw new Error("Runtime source identity verification failed.");
  const record = policy.reviewedVendoredGoPackages?.find((item) => item.name === "github.com/go-jose/go-jose/v3");
  const provenance = JSON.parse(read("third_party/go-jose-v3/PROVENANCE.json").toString());
  const fixedIds = provenance.changes.map((change) => change.advisory).filter(Boolean);
  const sourceVerified = record?.path === "third_party/go-jose-v3" && fixedIds.length === joseIds.size
    && new Set(fixedIds).size === joseIds.size && fixedIds.every((id) => joseIds.has(id));

  verifyControlFiles(policy.setuptoolsInstallControlSha256 ?? {}, read);
  const wheels = JSON.parse(read("infrastructure/veil-console/deploy/metal-wheels.lock.json").toString());
  const native = JSON.parse(read("infrastructure/veil-console/deploy/metal-native.lock.json").toString());
  const installer = read("infrastructure/veil-console/internal/deployment/host.go").toString();
  const config = read("infrastructure/veil-console/internal/deployment/package.go").toString();
  const builder = read("infrastructure/veil-console/deploy/build-metal-kit.py").toString();
  const python = native.find((item) => item.name === "python");
  const wheelOnly = wheels.every((wheel) => wheel.filename.endsWith(".whl") && !/git\+|win(?:32|_amd64|_arm64)/i.test(wheel.url + wheel.filename));
  const installVerified = wheelOnly && /aarch64-apple-darwin/.test(python?.url ?? "")
    && ["--no-index", "--only-binary=:all:", "--require-hashes"].every((flag) => installer.includes(`"${flag}"`))
    && /case "metal":\s*if c\.OS != "darwin"/.test(config)
    && builder.includes('not item["filename"].endswith(".whl")');
  if (!installVerified) throw new Error("The reviewed Mac-only offline wheel installation controls are not present.");

  const packages = new Map<string, Package>();
  for (const wheel of wheels) packages.set(`PyPI:${wheel.name}@${wheel.package_version}`, { ecosystem: "PyPI", name: wheel.name, version: wheel.package_version });
  let openPgpImported = false;
  let joseSeen = false;
  let joseReplacementVerified = true;
  for (const project of ["infrastructure/veil-console", "infrastructure/veil-console/deploy/caddy"]) {
    const format = "{{.ImportPath}}\t{{if .Module}}{{.Module.Path}}\t{{.Module.Version}}\t{{if .Module.Replace}}{{.Module.Replace.Path}}{{end}}{{end}}";
    const result = spawnSync("go", ["list", "-deps", "-mod=readonly", "-f", format, "./..."], {
      cwd: path.join(root, project), encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GOTOOLCHAIN: "go1.26.10", GOWORK: "off" },
    });
    if (result.error || result.status !== 0) throw new Error(`Unable to inspect actual runtime imports: ${result.error?.message ?? result.stderr.trim()}`);
    for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
      const [imported, name, version, replacement] = line.split("\t");
      if (imported === "golang.org/x/crypto/openpgp" || imported.startsWith("golang.org/x/crypto/openpgp/")) openPgpImported = true;
      if (!name || !version) continue;
      if (name === "github.com/go-jose/go-jose/v3") {
        joseSeen = true;
        joseReplacementVerified &&= replacement === "../../../../third_party/go-jose-v3";
      }
      packages.set(`Go:${name}@${version}`, { ecosystem: "Go", name, version });
    }
  }
  const inventory = [...packages.values()];
  const response = await fetch("https://api.osv.dev/v1/querybatch", {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({ queries: inventory.map((pkg) => ({ package: { ecosystem: pkg.ecosystem, name: pkg.name }, version: pkg.version })) }),
  });
  if (!response.ok || !response.body || Number(response.headers.get("content-length") ?? 0) > 16 * 1024 * 1024) throw new Error("Runtime OSV query failed.");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 16 * 1024 * 1024) throw new Error("Runtime OSV response exceeds its size bound.");
    chunks.push(Buffer.from(chunk));
  }
  const findings = validateOsvBatch(JSON.parse(Buffer.concat(chunks).toString("utf8")), inventory.length);
  const evidence = { joseSourceVerified: sourceVerified && joseSeen && joseReplacementVerified, setuptoolsInstallVerified: installVerified, openPgpImported };
  const matches = [];
  for (let index = 0; index < inventory.length; index++) {
    for (const finding of findings[index]) {
      const disposition = reviewedDisposition(inventory[index], finding.id, evidence);
      matches.push({ ...inventory[index], id: finding.id, modified: finding.modified, disposition: disposition ?? "Unreviewed finding" });
      console.log(`${inventory[index].name}@${inventory[index].version} ${finding.id}: ${disposition ?? "UNREVIEWED — audit fails"}`);
    }
  }
  fs.mkdirSync(path.join(root, "artifacts/supply-chain"), { recursive: true });
  fs.writeFileSync(path.join(root, "artifacts/supply-chain/runtime-osv-review.json"), JSON.stringify({ queried: inventory.length, matches }, null, 2) + "\n");
  if (matches.some((match) => match.disposition === "Unreviewed finding")) throw new Error("Runtime audit found an unreviewed advisory; inspect its primary source and actual applicability.");
  console.log(`Reviewed ${inventory.length} locked runtime packages against OSV; all raw matches and their verified dispositions are recorded.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
