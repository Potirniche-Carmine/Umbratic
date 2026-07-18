import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const outputPath = path.resolve(
  root,
  process.argv[2] ?? "artifacts/supply-chain/umbratic-sbom.cdx.json",
);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function npmPackageName(location) {
  return location.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/)?.[1];
}

function licenseEntry(expression) {
  return expression ? [{ expression }] : undefined;
}

function npmComponents() {
  const lock = readJson("package-lock.json");
  const components = new Map();
  for (const [location, entry] of Object.entries(lock.packages ?? {})) {
    const name = npmPackageName(location);
    if (!name || !entry.version || entry.link) continue;
    const encodedName = encodeURIComponent(name);
    const purl = `pkg:npm/${encodedName}@${entry.version}`;
    if (components.has(purl)) continue;
    const integrity = typeof entry.integrity === "string"
      ? entry.integrity.match(/^sha512-(.+)$/)?.[1]
      : undefined;
    components.set(purl, {
      type: "library",
      "bom-ref": purl,
      name,
      version: entry.version,
      purl,
      ...(integrity
        ? { hashes: [{ alg: "SHA-512", content: Buffer.from(integrity, "base64").toString("hex") }] }
        : {}),
      ...(entry.license ? { licenses: licenseEntry(entry.license) } : {}),
      properties: [
        { name: "umbratic:npm:development", value: String(entry.dev === true) },
        { name: "umbratic:npm:optional", value: String(entry.optional === true) },
      ],
    });
  }
  return [...components.values()];
}

function cargoChecksums() {
  const checksums = new Map();
  const lock = fs.readFileSync(path.join(root, "Cargo.lock"), "utf8");
  for (const block of lock.split("[[package]]").slice(1)) {
    const name = block.match(/^name = "([^"]+)"$/m)?.[1];
    const version = block.match(/^version = "([^"]+)"$/m)?.[1];
    const checksum = block.match(/^checksum = "([0-9a-f]{64})"$/m)?.[1];
    if (name && version && checksum) checksums.set(`${name}@${version}`, checksum);
  }
  return checksums;
}

function cargoComponents() {
  const result = spawnSync(
    "cargo",
    ["metadata", "--locked", "--offline", "--format-version", "1"],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Unable to generate locked Cargo metadata offline: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  const metadata = JSON.parse(result.stdout);
  const checksums = cargoChecksums();
  return metadata.packages
    .filter((entry) => entry.source)
    .map((entry) => {
      const purl = `pkg:cargo/${encodeURIComponent(entry.name)}@${entry.version}`;
      const checksum = checksums.get(`${entry.name}@${entry.version}`);
      return {
        type: "library",
        "bom-ref": purl,
        name: entry.name,
        version: entry.version,
        purl,
        ...(checksum ? { hashes: [{ alg: "SHA-256", content: checksum }] } : {}),
        ...(entry.license ? { licenses: licenseEntry(entry.license) } : {}),
        ...(entry.repository
          ? { externalReferences: [{ type: "vcs", url: entry.repository }] }
          : {}),
      };
    });
}

const rootManifest = readJson("package.json");
const components = [...npmComponents(), ...cargoComponents()].sort((left, right) =>
  left["bom-ref"].localeCompare(right["bom-ref"]),
);
const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  version: 1,
  metadata: {
    component: {
      type: "application",
      "bom-ref": `pkg:generic/umbratic@${rootManifest.version}`,
      name: "Umbratic",
      version: rootManifest.version,
    },
    properties: [
      { name: "umbratic:source:cargo", value: "Cargo.lock" },
      { name: "umbratic:source:npm", value: "package-lock.json" },
      { name: "umbratic:source:go", value: "infrastructure/veil/go.mod (standard library only)" },
    ],
  },
  components,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(sbom, null, 2)}\n`, { flag: "w" });
console.log(`Wrote ${components.length} locked components to ${outputPath}.`);
