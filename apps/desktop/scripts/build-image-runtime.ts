import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import JSZip from "jszip";
import { llamaBuildJobs } from "./llama-build-config.ts";
import { msvcEnvironment } from "./windows-build-environment.ts";

export type SourceArchive = { repository: string; commit: string; sha256: string; bytes: number };
export type ImageSource = { runtime: SourceArchive; ggml: SourceArchive; deploymentTarget: string };

export function sourceArchiveUrl(pin: SourceArchive): string {
  if (!/^leejet\/(?:stable-diffusion\.cpp|ggml)$/.test(pin.repository) || !/^[0-9a-f]{40}$/.test(pin.commit)
      || !/^[0-9a-f]{64}$/.test(pin.sha256) || !Number.isSafeInteger(pin.bytes) || pin.bytes < 1 || pin.bytes > 150 * 1024 * 1024) {
    throw new Error("Invalid image-runtime source pin.");
  }
  return `https://codeload.github.com/${pin.repository}/zip/${pin.commit}`;
}

export function imageRuntimeCmakeArgs(source: string, build: string, pin: ImageSource, arch: string, platform: string): string[] {
  if (pin.deploymentTarget !== "12.0" || !(platform === "darwin" && ["arm64", "x64"].includes(arch)
    || ["win32", "linux"].includes(platform) && arch === "x64")) throw new Error("Unsupported image-runtime build target.");
  const mac = platform === "darwin";
  return ["-S", source, "-B", build, "-DCMAKE_BUILD_TYPE=Release",
    ...(platform === "win32" ? ["-G", "Ninja"] : []),
    ...(mac ? [`-DCMAKE_OSX_ARCHITECTURES=${arch === "x64" ? "x86_64" : arch}`, `-DCMAKE_OSX_DEPLOYMENT_TARGET=${pin.deploymentTarget}`,
      `-DGGML_METAL_MACOSX_VERSION_MIN=${pin.deploymentTarget}`, "-DSD_METAL=ON", "-DGGML_METAL_EMBED_LIBRARY=ON",
      "-DSD_BUILD_SHARED_LIBS=OFF", "-DBUILD_SHARED_LIBS=OFF"]
      : ["-DSD_METAL=OFF", "-DSD_BUILD_SHARED_LIBS=ON", "-DSD_BUILD_SHARED_GGML_LIB=ON", "-DBUILD_SHARED_LIBS=ON",
        "-DGGML_BACKEND_DL=ON", "-DGGML_CPU_ALL_VARIANTS=ON", "-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON", "-DCMAKE_INSTALL_RPATH=$ORIGIN"]),
    "-DSD_BUILD_EXAMPLES=ON", "-DSD_SERVER_BUILD_FRONTEND=OFF", "-DSD_WEBP=OFF", "-DSD_WEBM=OFF", "-DGGML_NATIVE=OFF",
    "-DGGML_OPENMP=OFF", "-DGGML_BLAS=OFF", "-DGGML_CPU_KLEIDIAI=OFF", "-DGGML_RPC=OFF", "-DSD_VULKAN=OFF",
    "-DGGML_BUILD_TESTS=OFF", "-DGGML_BUILD_EXAMPLES=OFF",
    "-DFETCHCONTENT_FULLY_DISCONNECTED=ON", "-DGGML_CCACHE=OFF", `-DSDCPP_BUILD_COMMIT=${pin.runtime.commit}`,
    "-DSDCPP_BUILD_VERSION=umbratic", `-DGGML_BUILD_COMMIT=${pin.ggml.commit}`];
}

async function archiveBytes(pin: SourceArchive, cache: string): Promise<Buffer> {
  const url = sourceArchiveUrl(pin);
  const file = path.join(cache, `${pin.sha256}.zip`);
  const valid = (bytes: Buffer) => bytes.length === pin.bytes && crypto.createHash("sha256").update(bytes).digest("hex") === pin.sha256;
  const cached = await fs.readFile(file).catch(() => null);
  if (cached && valid(cached)) return cached;
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || Number(response.headers.get("content-length") ?? pin.bytes) > pin.bytes) throw new Error("Image-runtime source download failed.");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of response.body!) {
    length += chunk.length;
    if (length > pin.bytes) throw new Error("Image-runtime source archive exceeds its pinned size.");
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  if (!valid(bytes)) throw new Error("Image-runtime source checksum mismatch.");
  await fs.mkdir(cache, { recursive: true });
  await fs.writeFile(file, bytes);
  return bytes;
}

export async function extractImageSource(bytes: Buffer, destination: string, pin: SourceArchive): Promise<void> {
  const zip = await JSZip.loadAsync(bytes);
  let total = 0;
  for (const file of Object.values(zip.files)) {
    const name = file.unsafeOriginalName ?? file.name;
    const slash = name.indexOf("/");
    const relative = name.slice(slash + 1);
    if (!relative || file.dir) continue;
    if (name.slice(0, slash) !== `${pin.repository.split("/")[1]}-${pin.commit}` || relative.includes("\\") || relative.split("/").some((part) => part === ".." || part === "") || path.isAbsolute(relative)) throw new Error("Unsafe image source archive entry.");
    if (relative.startsWith(".")) continue;
    if ((Number(file.unixPermissions ?? 0) & 0o170000) === 0o120000) throw new Error("Unsafe image source archive link.");
    // The CLI uses bundled tokenizer/image helpers and ggml. Server frontend,
    // model assets, docs, and optional video codecs are outside this build.
    if (pin.repository.endsWith("stable-diffusion.cpp") && /^(?:assets|docs|docker|\.github|scripts)\//.test(relative)) continue;
    const data = await file.async("nodebuffer");
    total += data.length;
    if (total > 200 * 1024 * 1024) throw new Error("Image source extraction exceeds its byte limit.");
    const target = path.join(destination, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data, { flag: "wx", mode: 0o600 });
  }
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...msvcEnvironment(), MACOSX_DEPLOYMENT_TARGET: "12.0",
      CMAKE_BUILD_PARALLEL_LEVEL: String(llamaBuildJobs(os.availableParallelism(), os.totalmem())) }, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed (${code}).`)));
  });
}

export function verifyMacImageRuntime(binary: string, target: string): void {
  const result = spawnSync("otool", ["-l", binary], { encoding: "utf8" });
  const minima = [...(result.stdout ?? "").matchAll(/^\s*minos\s+(\d+\.\d+)(?:\.\d+)?/gm)].map((match) => Number(match[1]));
  if (result.status !== 0 || minima.length === 0 || minima.some((version) => version > Number(target))) {
    throw new Error(`Image runtime requires a newer macOS than ${target}.`);
  }
  const linked = spawnSync("otool", ["-L", binary], { encoding: "utf8" });
  if (linked.status !== 0 || linked.stdout.split("\n").slice(1).some((line) => line.trim() && !/^\s*\/(?:System\/Library|usr\/lib)\//.test(line))) {
    throw new Error("Image runtime has a non-system dynamic dependency.");
  }
}

export async function verifyImageRuntimeGgufBounds(binary: string): Promise<void> {
  // Conversion reaches the same GGUF reader without loading weights. The CLI
  // still registers backends for system information before conversion, so hide
  // Metal devices from this parser-only probe to avoid initializing a GPU.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "umbratic-image-gguf-"));
  try {
    for (const [name, dimensions, type, expected] of [
      ["shape", [2n ** 31n, 2n ** 31n, 4n, 1n], 0, "may cause overflow errors"],
      ["padding", [2n ** 63n - 1n, 1n, 1n, 1n], 1, "overflows after padding"],
    ] as const) {
      const bytes = Buffer.alloc(96);
      bytes.write("GGUF"); bytes.writeUInt32LE(3, 4);
      bytes.writeBigUInt64LE(1n, 8); // one tensor, no metadata
      bytes.writeBigUInt64LE(1n, 24); bytes.write("x", 32);
      bytes.writeUInt32LE(4, 33);
      dimensions.forEach((dimension, index) => bytes.writeBigUInt64LE(dimension, 37 + index * 8));
      bytes.writeUInt32LE(type, 69); // f32 for shape overflow; f16 for padding overflow
      const file = path.join(directory, `${name}.gguf`);
      await fs.writeFile(file, bytes);
      const result = spawnSync(binary, ["--mode", "convert", "--backend", "cpu", "-m", file, "-o", path.join(directory, "output.gguf")], {
        encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024, windowsHide: true,
        env: { ...process.env, GGML_METAL_DEVICES: "0" },
      });
      if (result.error || result.status !== 1 || !`${result.stdout}${result.stderr}`.includes(expected)) {
        const details = JSON.stringify({ status: result.status, signal: result.signal,
          error: result.error ? { code: result.error.code, message: result.error.message.slice(0, 256) } : null,
          stdout: (result.stdout ?? "").slice(-2048), stderr: (result.stderr ?? "").slice(-2048) });
        throw new Error(`Image runtime did not safely reject the GGUF ${name} overflow fixture. ${details}`);
      }
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function buildImageRuntime(pin: ImageSource, destination: string): Promise<void> {
  const desktop = path.resolve(import.meta.dirname, "..");
  const cache = path.join(desktop, ".llama-cache", "image-runtime");
  const identity = crypto.createHash("sha256").update(JSON.stringify({ pin, platform: process.platform, arch: process.arch, revision: 2 })).digest("hex");
  const executable = process.platform === "win32" ? "sd-cli.exe" : "sd-cli";
  const receipt = path.join(destination, "sha256");
  if (await fs.readFile(receipt, "utf8").catch(() => "") === identity
      && await fs.stat(path.join(destination, "licenses", "APACHE-2.0.txt")).then((stat) => stat.isFile()).catch(() => false)
      && await fs.stat(path.join(destination, "licenses", "ggml-cpu-ops.cpp")).then((stat) => stat.isFile()).catch(() => false)) {
    if (process.platform === "darwin") verifyMacImageRuntime(path.join(destination, executable), pin.deploymentTarget);
    return;
  }
  const source = path.join(cache, identity, "source");
  const build = path.join(cache, identity, "build");
  const binary = path.join(build, "bin", executable);
  if (!await fs.stat(binary).then((stat) => stat.isFile()).catch(() => false)) {
    console.log(`Building the pinned image runtime for ${process.platform}/${process.arch}…`);
    await fs.rm(source, { recursive: true, force: true });
    await fs.mkdir(source, { recursive: true });
    await extractImageSource(await archiveBytes(pin.runtime, path.join(cache, "downloads")), source, pin.runtime);
    await extractImageSource(await archiveBytes(pin.ggml, path.join(cache, "downloads")), path.join(source, "ggml"), pin.ggml);
    // Source archives have no Git metadata. Preserve the pinned identities and
    // prevent upstream from discovering the enclosing Umbratic checkout.
    for (const file of ["CMakeLists.txt", "ggml/CMakeLists.txt"]) {
      const input = path.join(source, file);
      const text = await fs.readFile(input, "utf8");
      const variable = file.startsWith("ggml/") ? "GGML_BUILD_COMMIT" : "SDCPP_BUILD_COMMIT";
      if (!text.includes("if(GIT_EXE)")) throw new Error("Image runtime Git identity configuration changed.");
      await fs.writeFile(input, text.replace("if(GIT_EXE)", `if(GIT_EXE AND NOT ${variable})`));
    }
    await run("cmake", imageRuntimeCmakeArgs(source, build, pin, process.arch, process.platform), desktop);
    await run("cmake", ["--build", build, ...(process.platform === "darwin" ? ["--target", "sd-cli"] : []),
      "--parallel", String(llamaBuildJobs(os.availableParallelism(), os.totalmem()))], desktop);
  }
  if (process.platform === "darwin") verifyMacImageRuntime(binary, pin.deploymentTarget);
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(path.dirname(binary), { withFileTypes: true })) {
    if (!(entry.isFile() || entry.isSymbolicLink()) || !(entry.name === executable || /\.(?:dll|so)(?:\.\d+)*$/.test(entry.name))) continue;
    await fs.copyFile(path.join(path.dirname(binary), entry.name), path.join(destination, entry.name));
    await fs.chmod(path.join(destination, entry.name), 0o755);
  }
  for (const [from, name] of [["LICENSE", "stable-diffusion.cpp.txt"], ["ggml/LICENSE", "ggml.txt"],
    ["thirdparty/oniguruma/COPYING", "oniguruma.txt"], ["thirdparty/utf8proc/LICENSE.md", "utf8proc.txt"]]) {
    await fs.copyFile(path.join(source, from), path.join(destination, name));
  }
  // Retain nested copyright/license notices verbatim, including those inside
  // the bundled JSON, image, ZIP, HTTP and tokenizer headers.
  const licenses = path.join(destination, "licenses");
  await fs.mkdir(licenses, { recursive: true });
  await fs.copyFile(path.join(source, "ggml/src/ggml-cpu/ops.cpp"), path.join(licenses, "ggml-cpu-ops.cpp"));
  for (const entry of await fs.readdir(path.join(source, "thirdparty"), { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === "CMakeLists.txt") continue;
    await fs.copyFile(path.join(source, "thirdparty", entry.name), path.join(licenses, entry.name));
  }
  await fs.copyFile(path.resolve(desktop, "../../third_party/apache-2.0.txt"), path.join(licenses, "APACHE-2.0.txt"));
  await fs.writeFile(receipt, identity);
}
