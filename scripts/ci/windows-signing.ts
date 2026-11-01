// SignPath signs only the declared Umbratic binaries. Upstream executables
// retain their original bytes and identities, including an explicit NotSigned
// state where the reviewed upstream has no Authenticode signature.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { verifyPeArchitecture } from "../../apps/desktop/scripts/verify-pe.ts";

const require = createRequire(import.meta.url);
export const repository = path.resolve(import.meta.dirname, "../..");
const desktop = path.join(repository, "apps/desktop");
const elevateSha256 = "9b1fbf0c11c520ae714af8aa9af12cfd48503eedecd7398d8992ee94d1b4dc37";
export const ownedPaths = ["Umbratic.exe", ...["runner", "desktop-core", "pdf", "artifacts", "code-index", "veil"]
  .map((name) => `resources/${name}/${name === "veil" ? "veil" : `umbratic-${name}`}.exe`)];
export const stages = ["payload", "uninstaller", "installer"] as const;
export type Stage = typeof stages[number];
export function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
export function nativeFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Signing inputs must not contain symbolic links.");
    return entry.isDirectory() ? nativeFiles(file) : /\.(?:exe|dll|node)$/i.test(entry.name) ? [file] : [];
  });
}

/** Compare all PE bytes except fields Authenticode is allowed to change. */
export function unsignedPeDigest(bytes: Buffer): string {
  if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ") throw new Error("Invalid PE signing input.");
  const pe = bytes.readUInt32LE(60);
  if (pe + 24 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550) throw new Error("Invalid PE header.");
  const optional = pe + 24;
  const magic = bytes.readUInt16LE(optional);
  const directory = optional + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : 0);
  if (directory === optional || directory + 40 > bytes.length) throw new Error("Invalid PE optional header.");
  const certificateEntry = directory + 32;
  const offset = bytes.readUInt32LE(certificateEntry);
  const size = bytes.readUInt32LE(certificateEntry + 4);
  if ((offset === 0) !== (size === 0) || (size && (offset % 8 || size < 8 || offset + size !== bytes.length || offset < certificateEntry + 8))) {
    throw new Error("Invalid PE certificate table.");
  }
  const content = Buffer.from(bytes.subarray(0, size ? offset : bytes.length));
  content.fill(0, optional + 64, optional + 68); // OptionalHeader.CheckSum
  content.fill(0, certificateEntry, certificateEntry + 8);
  // SignTool may align an unsigned image before appending WIN_CERTIFICATE.
  const padded = Buffer.alloc(Math.ceil(content.length / 8) * 8);
  content.copy(padded);
  return crypto.createHash("sha256").update(padded).digest("hex");
}

export type Identity = { status: string; publisher: string | null; subject: string | null; thumbprint: string | null;
  signatureType: string; osBinary: boolean; timestamp: boolean; sha256Signature: boolean; productName: string; productVersion: string };
export function inspect(files: string[]): Identity[] {
  const directory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? repository, "windows-identities-"));
  try {
    const manifest = path.join(directory, "files.json");
    fs.writeFileSync(manifest, JSON.stringify(files));
    const result = JSON.parse(execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File",
      path.join(repository, "scripts/ci/inspect-windows-signatures.ps1"), "-Manifest", manifest], {
      encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 120_000,
    }));
    if (!Array.isArray(result) || result.length !== files.length) throw new Error("Incomplete Windows identity inspection.");
    return result;
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
export function requireProjectIdentity(identity: Identity, publisher: string, version: string): void {
  if (!publisher || identity.status !== "Valid" || identity.publisher !== publisher || !identity.timestamp || !identity.sha256Signature
      || identity.productName !== "Umbratic" || identity.productVersion !== version) {
    throw new Error("Umbratic binary lacks its required publisher, timestamp or version metadata.");
  }
}

type Upstream = { component: string; version: string; source: string; sourceSha256: string; identity: Identity };
export type InventoryEntry = { path: string; sha256: string; role: "project"; identity: Identity }
  | ({ path: string; sha256: string; role: "upstream" } & Upstream);
export type Inventory = { sourceCommit: string; architecture: string; version: string; files: InventoryEntry[] };

function upstreamSource(relative: string, architecture: string): { file: string; component: string; version: string; source: string } {
  const electron = JSON.parse(fs.readFileSync(path.join(repository, "node_modules/electron/package.json"), "utf8"));
  if (!relative.includes("/") && relative !== "Umbratic.exe" && /\.(?:exe|dll)$/i.test(relative)) {
    return { file: path.join(repository, "node_modules/electron/dist", relative), component: "Electron", version: electron.version,
      source: `electron/electron@v${electron.version}:win32-${architecture} (checksum-verified dependencies:provision)` };
  }
  if (relative === "resources/elevate.exe") {
    const builder = JSON.parse(fs.readFileSync(path.join(repository, "node_modules/app-builder-lib/package.json"), "utf8"));
    return { file: path.join(signingRoot(), "elevate.exe"), component: "electron-builder NSIS elevate", version: builder.version,
      source: `electron-builder NSIS 3.0.4.1/elevate.exe;reviewed-sha256:${elevateSha256}` };
  }
  const canvas = `@napi-rs/canvas-win32-${architecture}-msvc`;
  const prefix = `resources/app.asar.unpacked/node_modules/${canvas}/`;
  if (relative === `${prefix}skia.win32-${architecture}-msvc.node`) {
    const manifest = JSON.parse(fs.readFileSync(path.join(repository, "node_modules", canvas, "package.json"), "utf8"));
    const lock = JSON.parse(fs.readFileSync(path.join(repository, "package-lock.json"), "utf8"));
    return { file: path.join(repository, "node_modules", canvas, path.basename(relative)), component: canvas, version: manifest.version,
      source: lock.packages[`node_modules/${canvas}`].integrity };
  }
  for (const [directory, component, permitted] of [
    ["llama-server", "llama.cpp", /^(?:llama-server\.exe|(?:llama|llama-common|llama-server-impl|mtmd|ggml(?:-[a-z0-9_-]+)?)\.dll)$/],
    ["image-runtime", "stable-diffusion.cpp", /^(?:sd-cli\.exe|stable-diffusion\.dll|ggml(?:-[a-z0-9_-]+)?\.dll)$/],
  ] as const) {
    if (relative.startsWith(`resources/${directory}/`) && permitted.test(path.basename(relative))
        && relative === `resources/${directory}/${path.basename(relative)}`) {
      const pin = fs.readFileSync(path.join(repository, "third_party", component === "llama.cpp" ? "llama.cpp.pin" : "stable-diffusion.cpp.json"));
      const patches = component === "llama.cpp" ? ["llama.cpp-list-device-type.patch", "llama.cpp-disable-remote-downloads.patch"] : [];
      const evidence = crypto.createHash("sha256").update(pin);
      for (const patch of patches) evidence.update(fs.readFileSync(path.join(repository, "third_party", patch)));
      const version = component === "llama.cpp" ? pin.toString().match(/^commit=(.+)$/m)![1] : JSON.parse(pin.toString()).commit;
      return { file: path.join(desktop, ".package", directory, path.basename(relative)), component, version,
        source: `source-build:${component}@${version};reviewed-pin-and-patches-sha256:${evidence.digest("hex")}` };
    }
  }
  throw new Error(`Unclassified Windows binary: ${relative}`);
}

export function upstreamIdentity(identity: Identity, component: string, file: string): void {
  const signedElectronDll = component === "Electron" && ["d3dcompiler_47.dll", "dxil.dll"].includes(file);
  if (identity.status === "NotSigned" && !signedElectronDll) return;
  const microsoftOrganization = identity.subject?.match(/(?:^|,\s*)O=Microsoft Corporation(?:,|$)/);
  const microsoft = microsoftOrganization
    && ["Microsoft Corporation", "Microsoft Windows Software Compatibility Publisher"].includes(identity.publisher ?? "");
  // Only these two signed DLLs in the checksum-verified Electron distribution
  // use this ARM leaf. Their original bytes are checked before this policy.
  const electronWindowsKit = signedElectronDll && microsoftOrganization && identity.publisher === "Microsoft Windows Kits Publisher"
    && identity.thumbprint === "F5359B80D22CA41C7469C884188557307FE06390";
  const electron = component === "Electron" && identity.publisher === "OpenJS Foundation";
  if (identity.status !== "Valid" || (!microsoft && !electron && !electronWindowsKit)) throw new Error(`Unapproved upstream signing identity: ${component} ` + JSON.stringify({
    file, status: identity.status, publisher: identity.publisher, subject: identity.subject, thumbprint: identity.thumbprint,
    signatureType: identity.signatureType, osBinary: identity.osBinary,
  }).slice(0, 2000));
}

export function createInventory(app: string, publisher: string): Inventory {
  const files = nativeFiles(app).sort();
  const identities = inspect(files);
  const version = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8")).version;
  const architecture = process.arch;
  const image = path.join(desktop, ".package/image-runtime");
  const imagePin = JSON.parse(fs.readFileSync(path.join(repository, "third_party/stable-diffusion.cpp.json"), "utf8"));
  if (!imagePin.targets.includes(`win32-${architecture}`)) {
    if (!isDeepStrictEqual(fs.readdirSync(image), ["unavailable.txt"])
        || fs.readFileSync(path.join(image, "unavailable.txt"), "utf8") !== "Image generation is not available on this platform.\n"
        || nativeFiles(path.join(app, "resources/image-runtime")).length !== 0) {
      throw new Error("Unsupported Windows image runtime must contain only its declared unavailable state.");
    }
  }
  const seen = new Set<string>();
  const entries = files.map((file, index): InventoryEntry => {
    const relative = path.relative(app, file).split(path.sep).join("/");
    const identity = identities[index];
    seen.add(relative);
    if (ownedPaths.includes(relative)) {
      requireProjectIdentity(identity, publisher, version);
      return { path: relative, sha256: sha256(file), role: "project", identity };
    }
    // Microsoft CRT/OpenMP are already pinned to the exact toolset, bytes and
    // certificate by windows-dependencies.ts; never accept a filename alone.
    if (/^(?:vcruntime|msvcp|concrt|vcomp)\d+(?:_[a-z0-9_]+)?\.dll$/i.test(path.basename(relative))) {
      const manifest = JSON.parse(fs.readFileSync(path.join(app, "provenance.json"), "utf8"));
      const matches = manifest.files.filter((entry: { name: string; sha256: string; thumbprint: string }) =>
        entry.name.toLowerCase() === path.basename(relative).toLowerCase() && entry.sha256 === sha256(file) && entry.thumbprint === identity.thumbprint);
      if (matches.length !== 1 || identity.status !== "Valid") throw new Error("Unrecorded Microsoft runtime binary.");
      upstreamIdentity(identity, "Microsoft runtime", relative);
      return { path: relative, sha256: sha256(file), role: "upstream", component: "Microsoft runtime", version: identity.productVersion,
        source: `Visual Studio ${manifest.toolset};${matches[0].source}`, sourceSha256: sha256(file), identity };
    }
    const source = upstreamSource(relative, architecture);
    if (!fs.existsSync(source.file) || sha256(file) !== sha256(source.file)) throw new Error(`Upstream Windows bytes changed: ${relative}`);
    upstreamIdentity(identity, source.component, relative);
    return { path: relative, sha256: sha256(file), role: "upstream", component: source.component, version: source.version,
      source: source.source, sourceSha256: sha256(source.file), identity };
  });
  if (ownedPaths.some((relative) => !seen.has(relative))) throw new Error("A required Umbratic Windows helper is missing.");
  // Every upstream input from the reviewed prepared components must appear,
  // including dynamically loaded backend libraries not found via imports.
  const expected = [
    "resources/elevate.exe",
    `resources/app.asar.unpacked/node_modules/@napi-rs/canvas-win32-${architecture}-msvc/skia.win32-${architecture}-msvc.node`,
    ...nativeFiles(path.join(repository, "node_modules/electron/dist")).filter((file) => path.basename(file) !== "electron.exe")
      .map((file) => path.relative(path.join(repository, "node_modules/electron/dist"), file).split(path.sep).join("/")),
    ...["llama-server", "image-runtime"].flatMap((directory) => nativeFiles(path.join(desktop, ".package", directory))
      .map((file) => `resources/${directory}/${path.relative(path.join(desktop, ".package", directory), file).split(path.sep).join("/")}`)),
  ];
  if (expected.some((relative) => !seen.has(relative))) throw new Error("A required upstream Windows binary is missing.");
  return { sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(), architecture, version, files: entries };
}

export function verifyInventory(app: string, inventory: Inventory, publisher: string): void {
  const actual = createInventory(app, publisher);
  if (!isDeepStrictEqual(actual, inventory)) throw new Error("Windows signing inventory changed after signing.");
}

export function signingRoot(): string {
  const root = process.env.UMBRATIC_SIGNPATH_STAGING;
  if (!root || !path.isAbsolute(root)) throw new Error("Windows releases must run through the SignPath release workflow.");
  return root;
}
export async function requestSignature(stage: Stage, files: string[]): Promise<void> {
  const root = signingRoot();
  const input = path.join(root, stage, "input");
  try { fs.mkdirSync(path.join(root, stage)); } catch (error) {
    if (error.code === "EEXIST") throw new Error("Signing stage already exists; refuse stale requests.");
    throw error;
  }
  fs.mkdirSync(input);
  const names = files.map((file) => path.basename(file));
  if (new Set(names).size !== names.length || names.some((name) => !/^[A-Za-z0-9_.-]+\.exe$/.test(name))) throw new Error("Ambiguous signing input filenames.");
  const manifest = files.map((file) => ({ file, name: path.basename(file), digest: unsignedPeDigest(fs.readFileSync(file)) }));
  for (const entry of manifest) fs.copyFileSync(entry.file, path.join(input, entry.name));
  fs.writeFileSync(path.join(root, stage, "request.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, stage, "ready"), "ready\n", { flag: "wx" });
  const deadline = Date.now() + 35 * 60_000;
  while (!fs.existsSync(path.join(root, stage, "resume"))) {
    if (Date.now() > deadline) throw new Error(`SignPath ${stage} approval timed out.`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  // resume is written only after the action's result has been checked and
  // imported. Recheck bytes and identities inside the paused builder too.
  const identities = inspect(files);
  const version = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8")).version;
  for (const [index, entry] of manifest.entries()) {
    if (unsignedPeDigest(fs.readFileSync(entry.file)) !== entry.digest) throw new Error("Signed PE contents changed.");
    requireProjectIdentity(identities[index], process.env.SIGNPATH_PUBLISHER!, version);
  }
}

export function applySigningResponse(stage: Stage): void {
  if (!stages.includes(stage)) throw new Error("Invalid SignPath stage.");
  const directory = path.join(signingRoot(), stage);
  if (!fs.existsSync(path.join(directory, "ready")) || fs.existsSync(path.join(directory, "resume"))) throw new Error("Signing stage is not awaiting a response.");
  const entries: { file: string; name: string; digest: string }[] = JSON.parse(fs.readFileSync(path.join(directory, "request.json"), "utf8"));
  const output = path.join(directory, "signed");
  const names = fs.readdirSync(output).sort();
  if (JSON.stringify(names) !== JSON.stringify(entries.map((entry) => entry.name).sort())
      || names.some((name) => !fs.lstatSync(path.join(output, name)).isFile())) throw new Error("SignPath returned an unexpected artifact set.");
  const identities = inspect(entries.map((entry) => path.join(output, entry.name)));
  const version = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8")).version;
  for (const [index, entry] of entries.entries()) {
    const signed = path.join(output, entry.name);
    if (unsignedPeDigest(fs.readFileSync(signed)) !== entry.digest
        || unsignedPeDigest(fs.readFileSync(entry.file)) !== entry.digest) throw new Error("Signing changed PE contents or the pending input changed.");
    requireProjectIdentity(identities[index], process.env.SIGNPATH_PUBLISHER!, version);
  }
  for (const entry of entries) fs.copyFileSync(path.join(output, entry.name), entry.file);
  fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify(entries.map((entry, index) => ({
    name: entry.name, sha256: sha256(entry.file), identity: identities[index],
  }))));
  fs.writeFileSync(path.join(directory, "resume"), "resume\n", { flag: "wx" });
}

export async function signWindows(file: string): Promise<void> {
  const name = path.basename(file);
  if (name === "Umbratic.exe") {
    const app = path.dirname(file);
    const version = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8")).version;
    const files = ownedPaths.map((relative) => path.join(app, relative));
    // NSIS normally adds this upstream helper after app signing. Include its
    // exact original bytes now so the embedded inventory also covers it.
    const { getNsisElevatePath } = require("app-builder-lib/out/toolsets/windows");
    const elevate = await getNsisElevatePath();
    if (sha256(elevate) !== elevateSha256) throw new Error("The reviewed NSIS elevation helper changed.");
    fs.copyFileSync(elevate, path.join(signingRoot(), "elevate.exe"));
    fs.copyFileSync(elevate, path.join(app, "resources/elevate.exe"));
    for (const helper of files) {
      verifyPeArchitecture(helper, process.arch);
      stampProjectMetadata(helper, version);
    }
    await requestSignature("payload", files);
    const inventory = createInventory(app, process.env.SIGNPATH_PUBLISHER!);
    fs.writeFileSync(path.join(app, "resources/windows-signing-provenance.json"), JSON.stringify(inventory, null, 2) + "\n");
  } else if (/^Umbratic-\d+\.\d+\.\d+-(?:x64|arm64)\.__uninstaller\.exe$/.test(name)) {
    await requestSignature("uninstaller", [file]);
  } else if (/^Umbratic-\d+\.\d+\.\d+-(?:x64|arm64)\.exe$/.test(name)) {
    await requestSignature("installer", [file]);
  }
  // Per-file builder hooks on extraResources run before the payload batch.
  // They never contact a signing API or sign upstream code. The complete
  // typed inventory is checked before any installer can be released.
}

export function stampProjectMetadata(file: string, version: string): void {
  const { NtExecutable, NtExecutableResource, Resource } = require("resedit");
  const executable = NtExecutable.from(fs.readFileSync(file));
  const resource = NtExecutableResource.from(executable);
  const info = Resource.VersionInfo.fromEntries(resource.entries)[0] ?? Resource.VersionInfo.createEmpty();
  const language = info.getAllLanguagesForStringValues()[0]?.lang ?? 1033;
  // Explicit selection prevents an empty Go PE from acquiring a neutral
  // table with normalized x.y.z.0 values alongside the intended x.y.z table.
  info.setFileVersion(version, language);
  info.setProductVersion(version, language);
  for (const language of info.getAllLanguagesForStringValues()) {
    info.setStringValues(language, { ProductName: "Umbratic", ProductVersion: version, FileVersion: version, CompanyName: "Umbratic" });
  }
  info.outputToResourceEntries(resource.entries);
  resource.outputResource(executable);
  fs.writeFileSync(file, Buffer.from(executable.generate()));
}
