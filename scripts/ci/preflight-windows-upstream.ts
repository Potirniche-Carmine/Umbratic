// The provisioning step verifies the official Electron archive checksum first.
// Run the same upstream policy before any costly native runtime compilation.
import path from "node:path";
import { inspect, nativeFiles, repository, upstreamIdentity } from "./windows-signing.ts";

if (process.platform !== "win32") throw new Error("Windows upstream preflight requires Windows.");
const directory = path.join(repository, "node_modules/electron/dist");
const files = nativeFiles(directory).filter((file) => path.basename(file) !== "electron.exe");
if (["d3dcompiler_47.dll", "dxil.dll"].some((name) => !files.includes(path.join(directory, name)))) throw new Error("A required signed Electron DLL is missing.");
const identities = inspect(files);
for (const [index, file] of files.entries()) {
  const relative = path.relative(directory, file).split(path.sep).join("/");
  const identity = identities[index];
  upstreamIdentity(identity, "Electron", relative);
  console.log(JSON.stringify({ file: relative, status: identity.status, publisher: identity.publisher, thumbprint: identity.thumbprint }));
}
console.log("Verified all upstream Electron PE signing identities before native compilation.");
