// Preserve the original signing identities of checksum-verified upstream PE files.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const repository = path.resolve(import.meta.dirname, "../..");
export function nativeFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Upstream inputs must not contain symbolic links.");
    return entry.isDirectory() ? nativeFiles(file) : /\.(?:exe|dll|node)$/i.test(entry.name) ? [file] : [];
  });
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
  // Windows prefers a matching OS catalog over the DLL's embedded signature.
  // Only the two original Electron DLLs above may use this OS-release identity;
  // record the catalog leaf rather than pinning a rotating runner-image leaf.
  const electronCatalog = signedElectronDll && microsoftOrganization && identity.publisher === "Microsoft Windows"
    && /(?:^|,\s*)CN=Microsoft Windows(?:,|$)/.test(identity.subject ?? "")
    && identity.signatureType === "Catalog" && identity.osBinary === true;
  const electron = component === "Electron" && identity.publisher === "OpenJS Foundation";
  if (identity.status !== "Valid" || (!microsoft && !electron && !electronWindowsKit && !electronCatalog)) throw new Error(`Unapproved upstream signing identity: ${component} ` + JSON.stringify({
    file, status: identity.status, publisher: identity.publisher, subject: identity.subject, thumbprint: identity.thumbprint,
    signatureType: identity.signatureType, osBinary: identity.osBinary,
  }).slice(0, 2000));
}

