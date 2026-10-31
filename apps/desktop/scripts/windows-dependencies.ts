import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { msvcEnvironment } from "./windows-build-environment.ts";
import { verifyPeArchitecture } from "./verify-pe.ts";

// Windows 10/11 OS components, rather than every DLL a build host happens to
// have installed. VC/OpenMP redistributables deliberately do not appear here.
// Electron's normal/delay imports additionally use Microsoft's documented
// CryptUI, performance counters, TPM, UI Automation, event log and WinUSB APIs.
const osLibraries = new Set(("advapi32 avrt bcrypt bcryptprimitives cfgmgr32 clbcatq combase comctl32 comdlg32 crypt32 cryptbase cryptsp cryptui "
  + "d3d9 d3d11 d3d12 dcomp dbghelp dhcpcsvc dhcpcsvc6 dnsapi dwrite dwmapi dxgi dxva2 esent gdi32 glu32 hid imm32 iphlpapi "
  + "kernel32 kernelbase mf mfplat mfreadwrite mfuuid mmdevapi msasn1 msctf msdmo msimg32 mswsock msvcrt ncrypt netapi32 nsi ntdll "
  + "ole32 oleacc oleaut32 opengl32 pdh powrprof profapi propsys psapi rpcrt4 rsaenh secur32 setupapi shell32 shcore shlwapi sspicli tbs "
  + "ucrtbase uiautomationcore urlmon user32 userenv usp10 uxtheme version wevtapi win32u windowscodecs winhttp wininet winmm winrnr winsta wintrust winusb wldap32 ws2_32 wtsapi32")
  .split(" ").map((name) => `${name}.dll`).concat("winspool.drv"));

export function isWindowsOsDependency(name: string): boolean {
  const lower = name.toLowerCase();
  return osLibraries.has(lower) || /^(?:api|ext)-ms-win-[a-z0-9-]+\.dll$/.test(lower);
}

export function parseWindowsDependents(output: string): string[] {
  const dependencies = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (!/^\s{4,}\S/.test(line)) continue;
    const name = line.trim();
    if (!/\.(?:dll|drv)$/i.test(name)) continue;
    if (!/^[a-z0-9_.-]+\.(?:dll|drv)$/i.test(name) || name.includes("..")) throw new Error("Unsafe Windows dependency name.");
    dependencies.add(name.toLowerCase());
  }
  return [...dependencies];
}

function dependencies(file: string): string[] {
  const result = spawnSync("dumpbin.exe", ["/NOLOGO", "/DEPENDENTS", file], {
    encoding: "utf8", windowsHide: true, env: msvcEnvironment(), timeout: 15_000,
  });
  if (result.error || result.status !== 0 || !/Image has the following dependencies|Summary/.test(result.stdout)) {
    throw new Error(`Unable to inspect Windows imports: ${file}`);
  }
  return parseWindowsDependents(result.stdout);
}

function nativeFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? nativeFiles(file) : /\.(?:exe|dll|node)$/i.test(entry.name) ? [file] : [];
  });
}

function beside(directory: string, name: string): string | undefined {
  const found = fs.readdirSync(directory).find((file) => file.toLowerCase() === name);
  return found ? path.join(directory, found) : undefined;
}

function optionalDriver(file: string, dependency: string): boolean {
  return path.basename(file).toLowerCase() === "ggml-vulkan.dll" && dependency === "vulkan-1.dll";
}

type Redist = { name: string; sha256: string; version: string; publisher: string; thumbprint: string; source: string };

function microsoftIdentity(file: string): Pick<Redist, "version" | "publisher" | "thumbprint"> {
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File",
    path.resolve(import.meta.dirname, "../../../scripts/ci/inspect-msvc-redist.ps1"), "-File", file], {
    encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  if (result.error || result.status !== 0) throw new Error(`Microsoft redistributable signature did not verify: ${path.basename(file)}`);
  return JSON.parse(result.stdout.trim());
}

export function prepareWindowsDependencies(desktop: string): void {
  if (process.platform !== "win32") return;
  const environment = msvcEnvironment();
  const redistRoot = Object.entries(environment).find(([key]) => key.toLowerCase() === "vctoolsredistdir")?.[1];
  if (!redistRoot) throw new Error("Visual Studio did not identify its matching VCToolsRedistDir.");
  const archRoot = path.join(redistRoot, process.arch);
  const sources = new Map<string, string>();
  for (const entry of fs.readdirSync(archRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^Microsoft\.VC\d+\.(?:CRT|OpenMP)$/.test(entry.name)) continue;
    for (const name of fs.readdirSync(path.join(archRoot, entry.name))) {
      if (/^(?:vcruntime|msvcp|concrt|vcomp)\d+(?:_[a-z0-9_]+)?\.dll$/i.test(name)) {
        const key = name.toLowerCase();
        if (sources.has(key)) throw new Error("Ambiguous toolchain redistributable.");
        sources.set(key, path.join(archRoot, entry.name, name));
      }
    }
  }
  const destination = path.join(desktop, ".package", "windows-runtime");
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  const provenance = new Map<string, Redist>();
  const verified = new Set<string>();
  const missing = new Set<string>();
  const collect = (file: string, output: string, local: string) => {
    const key = `${file}:${output}`;
    if (verified.has(key)) return;
    verified.add(key);
    verifyPeArchitecture(file, process.arch);
    for (const dependency of dependencies(file)) {
      if (isWindowsOsDependency(dependency) || optionalDriver(file, dependency)) continue;
      const source = sources.get(dependency);
      if (!source) {
        const bundled = beside(local, dependency);
        if (bundled) { collect(bundled, output, local); continue; }
        missing.add(`${dependency} imported by ${path.basename(file)}`);
        continue;
      }
      if (!provenance.has(dependency)) {
        verifyPeArchitecture(source, process.arch);
        const identity = microsoftIdentity(source);
        provenance.set(dependency, { name: dependency, sha256: crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex"),
          ...identity, source: path.relative(redistRoot, source) });
      }
      fs.copyFileSync(source, path.join(output, dependency));
      collect(path.join(output, dependency), output, output);
    }
  };
  const electron = path.resolve(desktop, "../../node_modules/electron/dist");
  const canvas = path.resolve(desktop, `../../node_modules/@napi-rs/canvas-win32-${process.arch}-msvc`);
  for (const file of [...nativeFiles(electron), ...nativeFiles(canvas)]) collect(file, destination, path.dirname(file));
  for (const name of ["runner", "desktop-core", "pdf", "artifacts", "code-index", "veil", "llama-server", "image-runtime"]) {
    const directory = path.join(desktop, ".package", name);
    if (fs.existsSync(directory)) {
      for (const name of fs.readdirSync(directory)) {
        if (sources.has(name.toLowerCase())) fs.rmSync(path.join(directory, name));
      }
    }
    for (const file of nativeFiles(directory)) collect(file, directory, path.dirname(file));
  }
  if (missing.size) throw new Error(`Unbundled Windows dependencies:\n${[...missing].sort().join("\n")}`);
  const installation = Object.entries(environment).find(([key]) => key.toLowerCase() === "vsinstalldir")?.[1];
  if (!installation) throw new Error("Visual Studio did not identify its licensing directory.");
  const licenseRoot = path.join(installation, "Licenses");
  if (!fs.existsSync(licenseRoot)) throw new Error("Visual Studio original license notices are missing.");
  fs.cpSync(licenseRoot, path.join(destination, "redistributable-notices"), { recursive: true });
  fs.writeFileSync(path.join(destination, "provenance.json"), JSON.stringify({ toolset: environment.VCToolsVersion,
    architecture: process.arch, files: [...provenance.values()],
    licenseSource: "Visual Studio/Licenses", redistribution: "https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files",
    optionalDriverImports: [{ file: "ggml-vulkan.dll", dependency: "vulkan-1.dll", reason: "Dynamic backend; CPU fallback when driver loader is absent." }] }, null, 2) + "\n");
}

export function verifyWindowsDependencies(app: string): void {
  const files = nativeFiles(app);
  const manifest = JSON.parse(fs.readFileSync(path.join(app, "provenance.json"), "utf8"));
  if (manifest.architecture !== process.arch || !manifest.toolset || !manifest.files?.length) throw new Error("Windows runtime provenance is incomplete.");
  const checked = new Set<string>();
  for (const file of files) {
    const name = path.basename(file).toLowerCase();
    if (/^(?:vcruntime|msvcp|concrt|vcomp)\d+(?:_[a-z0-9_]+)?\.dll$/i.test(name)) {
      const sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      const entries = manifest.files.filter((entry: Redist) => entry.name === name && entry.sha256 === sha256);
      if (entries.length !== 1) throw new Error(`Unrecorded Microsoft redistributable: ${name}`);
      if (!checked.has(sha256)) {
        const identity = microsoftIdentity(file);
        if (identity.thumbprint !== entries[0].thumbprint || identity.version !== entries[0].version) throw new Error(`Microsoft redistributable provenance changed: ${name}`);
        checked.add(sha256);
      }
    }
    for (const dependency of dependencies(file)) {
      if (isWindowsOsDependency(dependency) || optionalDriver(file, dependency)) continue;
      const found = beside(path.dirname(file), dependency)
        ?? (file.includes("app.asar.unpacked") ? beside(app, dependency) : undefined);
      if (!found) throw new Error(`Unbundled Windows dependency ${dependency} imported by ${path.relative(app, file)}.`);
      verifyPeArchitecture(found, process.arch);
    }
  }
  console.log(`Verified normal and delay-load import closure for ${files.length} Windows payloads.`);
}
