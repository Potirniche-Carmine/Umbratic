import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { parseLlamaPin } from "../apps/desktop/scripts/llama-build-config.ts";

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
    { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Unable to generate locked Cargo metadata offline: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  const metadata = JSON.parse(result.stdout);
  const checksums = cargoChecksums();
  return metadata.packages
    .filter((entry) => entry.source || entry.name === "umya-spreadsheet")
    .map((entry) => {
      const purl = `pkg:cargo/${encodeURIComponent(entry.name)}@${entry.version}`;
      const checksum = checksums.get(`${entry.name}@${entry.version}`);
      return {
        type: "library",
        "bom-ref": purl,
        name: entry.name,
        version: entry.version,
        purl,
        ...(!entry.source ? { properties: [
          { name: "umbratic:source:vendored", value: "third_party/umya-spreadsheet/PROVENANCE.json" },
          { name: "umbratic:source:patch", value: "Preserve both data-validation formula bounds" },
        ] } : {}),
        ...(checksum ? { hashes: [{ alg: "SHA-256", content: checksum }] } : {}),
        ...(entry.license ? { licenses: licenseEntry(entry.license) } : {}),
        ...(entry.repository
          ? { externalReferences: [{ type: "vcs", url: entry.repository }] }
          : {}),
      };
    });
}

function goComponents() {
  const environment = { ...process.env, GOTOOLCHAIN: "local", GOWORK: "off", GOPROXY: "off", GOSUMDB: "off" };
  const host = spawnSync("go", ["env", "-json", "GOVERSION", "GOROOT", "GOMODCACHE", "GOHOSTOS", "GOHOSTARCH"], {
    encoding: "utf8", env: environment,
  });
  if (host.error || host.status !== 0) throw new Error("Unable to locate the installed Go toolchain for offline SBOM generation.");
  const installed = JSON.parse(host.stdout);
  const executable = installed.GOVERSION === "go1.26.10"
    ? path.join(installed.GOROOT, "bin", installed.GOHOSTOS === "windows" ? "go.exe" : "go")
    : path.join(installed.GOMODCACHE, `golang.org/toolchain@v0.0.1-go1.26.10.${installed.GOHOSTOS}-${installed.GOHOSTARCH}`, "bin", installed.GOHOSTOS === "windows" ? "go.exe" : "go");
  if (!fs.existsSync(executable)) throw new Error("Install the pinned Go 1.26.10 toolchain before generating the offline SBOM.");
  const components = new Map();
  for (const directory of ["infrastructure/veil", "infrastructure/veil-console", "infrastructure/veil-console/deploy/caddy"]) {
    const format = "{{if .Module}}{{if not .Module.Main}}{{.Module.Path}}\t{{.Module.Version}}\t{{.Module.Sum}}\t{{if .Module.Replace}}{{.Module.Replace.Path}}{{end}}{{end}}{{end}}";
    const result = spawnSync(executable, ["list", "-deps", "-mod=readonly", "-f", format, "./..."], {
      cwd: path.join(root, directory), encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      env: environment,
    });
    if (result.error || result.status !== 0) throw new Error(`Unable to read locked Go modules offline for ${directory}: ${result.error?.message ?? result.stderr.trim()}`);
    for (const line of result.stdout.split(/\r?\n/).filter((value) => value.trim())) {
      const [Path, Version, Sum, replacement] = line.split("\t");
      const entry = { Path, Version, Sum, Replace: replacement || undefined };
      const purl = `pkg:golang/${entry.Path}@${entry.Version}`;
      components.set(purl, {
        type: "library", "bom-ref": purl, name: entry.Path, version: entry.Version, purl,
        properties: [
          ...(entry.Sum ? [{ name: "umbratic:go:module-sum", value: entry.Sum }] : []),
          ...(entry.Replace ? [
            { name: "umbratic:source:vendored", value: "third_party/go-jose-v3/PROVENANCE.json" },
            { name: "umbratic:source:patch", value: "CBC padding, bounded JSON recursion and untrusted RSA/JWK validation" },
          ] : []),
        ],
      });
    }
  }
  return [...components.values()];
}

function metalWheelComponents() {
  return readJson("infrastructure/veil-console/deploy/metal-wheels.lock.json").map((wheel) => ({
    type: "library", name: wheel.name, version: wheel.package_version,
    "bom-ref": `pkg:pypi/${encodeURIComponent(wheel.name)}@${encodeURIComponent(wheel.package_version)}`,
    purl: `pkg:pypi/${encodeURIComponent(wheel.name)}@${encodeURIComponent(wheel.package_version)}`,
    ...(!wheel.native_patch ? { hashes: [{ alg: "SHA-256", content: wheel.metadata_patch?.wheel_sha256 ?? wheel.sha256 }] } : {}),
    externalReferences: [{ type: "distribution", url: wheel.url, hashes: [{ alg: "SHA-256", content: wheel.sha256 }] }],
    properties: [
      { name: "umbratic:platform", value: "darwin-arm64-server" },
      { name: "umbratic:wheel", value: wheel.metadata_patch?.filename ?? wheel.filename },
      ...(wheel.metadata_patch ? [
        { name: "umbratic:wheel:metadata-patch", value: `infrastructure/veil-console/deploy/${wheel.metadata_patch.path}` },
        { name: "umbratic:wheel:metadata-patch-sha256", value: wheel.metadata_patch.sha256 },
      ] : []),
      ...(wheel.native_patch ? [
        { name: "umbratic:wheel:native-patch", value: JSON.stringify(wheel.native_patch) },
        { name: "umbratic:wheel:artifact-hash", value: "Recorded in the sealed server-kit manifest after native relinking and RECORD regeneration" },
      ] : []),
    ],
  }));
}

function metalNativeComponents() {
  const components = readJson("infrastructure/veil-console/deploy/metal-native.lock.json").map((entry) => ({
    type: entry.build ? "library" : "application", name: entry.name, version: entry.release,
    "bom-ref": `pkg:generic/${entry.name}@${encodeURIComponent(entry.release)}?platform=darwin-arm64-server`,
    hashes: [{ alg: "SHA-256", content: entry.sha256 }],
    externalReferences: [{ type: "distribution", url: entry.url }],
    properties: [
      { name: "umbratic:platform", value: "darwin-arm64-server" },
      { name: "umbratic:artifact:hash-scope", value: entry.build ? "Reviewed source archive; compiled bytes are hashed in the sealed kit manifest" : "Upstream distribution archive" },
      { name: "umbratic:development", value: String(entry.name === "pkgconf") },
    ],
  }));
  const caddyBuild = fs.readFileSync(path.join(root, "infrastructure/veil-console/deploy/build-caddy.py"), "utf8");
  const version = caddyBuild.match(/^VERSION = "([^"]+)"$/m)?.[1];
  if (!version) throw new Error("Caddy source builder does not record its reviewed version.");
  const files = ["main.go", "go.mod", "go.sum"].map((name) => ({
    name: `umbratic:source:${name}:sha256`,
    value: crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "infrastructure/veil-console/deploy/caddy", name))).digest("hex"),
  }));
  components.push({
    type: "application", name: "caddy", version,
    "bom-ref": `pkg:generic/caddy@${encodeURIComponent(version)}?platform=darwin-arm64-server`,
    properties: [
      { name: "umbratic:platform", value: "darwin-arm64-server" },
      { name: "umbratic:source:build", value: "infrastructure/veil-console/deploy/build-caddy.py; exact binary/modules recorded in caddy.build.json" },
      ...files,
    ],
  });
  components.push({ type: "library", name: "Go standard library", version: "1.26.10", "bom-ref": "pkg:golang/stdlib@1.26.10", properties: [] });
  return components;
}

function llamaRuntimeComponents() {
  const pin = parseLlamaPin(fs.readFileSync(path.join(root, "third_party/llama.cpp.pin"), "utf8"));
  const patches = ["llama.cpp-list-device-type.patch", "llama.cpp-disable-remote-downloads.patch"];
  return [{
    type: "application",
    "bom-ref": `pkg:github/ggml-org/llama.cpp@${pin.commit}`,
    name: "llama.cpp",
    version: pin.tag,
    externalReferences: [{ type: "vcs", url: `https://github.com/ggml-org/llama.cpp/tree/${pin.commit}` }],
    properties: [
      { name: "umbratic:source:commit", value: pin.commit },
      ...patches.map((name) => ({
        name: `umbratic:patch:${name}:sha256`,
        value: crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "third_party", name))).digest("hex"),
      })),
    ],
  }];
}

function imageRuntimeComponents() {
  const pin = readJson("third_party/stable-diffusion.cpp.json");
  return [pin.source.runtime, pin.source.ggml].map((source) => ({
    type: "library",
    "bom-ref": `pkg:github/${source.repository}@${source.commit}`,
    name: source.repository,
    version: source.commit,
    hashes: [{ alg: "SHA-256", content: source.sha256 }],
    externalReferences: [
      { type: "vcs", url: `https://github.com/${source.repository}/tree/${source.commit}` },
      { type: "distribution", url: `https://codeload.github.com/${source.repository}/zip/${source.commit}` },
    ],
    properties: [
      { name: "umbratic:platforms", value: pin.targets.join(",") },
      { name: "umbratic:archive-bytes", value: String(source.bytes) },
      { name: "umbratic:macos-deployment-target", value: pin.source.deploymentTarget },
    ],
  }));
}

const rootManifest = readJson("package.json");
const components = [...npmComponents(), ...cargoComponents(), ...goComponents(), ...metalWheelComponents(), ...metalNativeComponents(), ...llamaRuntimeComponents(), ...imageRuntimeComponents()].sort((left, right) =>
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
      { name: "umbratic:source:go", value: "Host-compiled module dependencies from Veil, Console and the Caddy source build; exact Caddy artifact modules are also recorded in caddy.build.json" },
    ],
  },
  components,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(sbom, null, 2)}\n`, { flag: "w" });
console.log(`Wrote ${components.length} locked components to ${outputPath}.`);
