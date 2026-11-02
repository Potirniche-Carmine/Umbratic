import crypto from "node:crypto";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Explicitly decode the outer NSIS container. Reduced 7za can otherwise find
// only the nested application 7z and falsely appear to verify the installer.
export function verifyNsisUninstaller(tool: string, installer: string, expectedSha256: string): void {
  const listing = execFileSync(tool, ["l", "-slt", "-tNsis", installer], { encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  const types = [...listing.matchAll(/^Type = (.+)\r?$/gm)].map((match) => match[1].trim());
  const names = [...listing.matchAll(/^Path = (.+)\r?$/gm)].map((match) => match[1].trim());
  const uninstallers = names.filter((name) => path.posix.basename(name.replaceAll("\\", "/")) === "Uninstall Umbratic.exe");
  if (types.length !== 1 || types[0] !== "Nsis" || uninstallers.length !== 1) {
    throw new Error("Installer must embed exactly one signed Umbratic uninstaller in its outer NSIS container: "
      + JSON.stringify({ types, names }).slice(0, 8000));
  }
  const embedded = execFileSync(tool, ["e", "-so", "-tNsis", installer, uninstallers[0]], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (crypto.createHash("sha256").update(embedded).digest("hex") !== expectedSha256) throw new Error("The embedded uninstaller differs from the approved signed bytes.");
}
