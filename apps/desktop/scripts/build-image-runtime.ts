import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import JSZip from "jszip";

export type SourceArchive = { repository: string; commit: string; sha256: string; bytes: number };
export type MacImageSource = { runtime: SourceArchive; ggml: SourceArchive; deploymentTarget: string };

export function sourceArchiveUrl(pin: SourceArchive): string {
  if (!/^leejet\/(?:stable-diffusion\.cpp|ggml)$/.test(pin.repository) || !/^[0-9a-f]{40}$/.test(pin.commit)
      || !/^[0-9a-f]{64}$/.test(pin.sha256) || !Number.isSafeInteger(pin.bytes) || pin.bytes < 1 || pin.bytes > 150 * 1024 * 1024) {
    throw new Error("Invalid image-runtime source pin.");
  }
  return `https://codeload.github.com/${pin.repository}/zip/${pin.commit}`;
}

export function imageRuntimeCmakeArgs(source: string, build: string, pin: MacImageSource, arch: string): string[] {
  if (!["arm64", "x64"].includes(arch) || pin.deploymentTarget !== "12.0") throw new Error("Unsupported image-runtime build target.");
  return ["-S", source, "-B", build, "-DCMAKE_BUILD_TYPE=Release", `-DCMAKE_OSX_ARCHITECTURES=${arch === "x64" ? "x86_64" : arch}`,
    `-DCMAKE_OSX_DEPLOYMENT_TARGET=${pin.deploymentTarget}`, `-DGGML_METAL_MACOSX_VERSION_MIN=${pin.deploymentTarget}`,
    "-DSD_METAL=ON", "-DGGML_METAL_EMBED_LIBRARY=ON", "-DSD_BUILD_SHARED_LIBS=OFF", "-DBUILD_SHARED_LIBS=OFF",
    "-DSD_BUILD_EXAMPLES=ON", "-DSD_SERVER_BUILD_FRONTEND=OFF", "-DSD_WEBP=OFF", "-DSD_WEBM=OFF", "-DGGML_NATIVE=OFF",
    "-DGGML_OPENMP=OFF", "-DGGML_BLAS=OFF", "-DGGML_CPU_KLEIDIAI=OFF", "-DGGML_BUILD_TESTS=OFF", "-DGGML_BUILD_EXAMPLES=OFF",
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
    const child = spawn(command, args, { cwd, env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: "12.0" }, stdio: "inherit" });
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

export async function buildMacImageRuntime(pin: MacImageSource, destination: string): Promise<void> {
  const desktop = path.resolve(import.meta.dirname, "..");
  const cache = path.join(desktop, ".llama-cache", "image-runtime");
  const identity = crypto.createHash("sha256").update(JSON.stringify({ pin, arch: process.arch, revision: 1 })).digest("hex");
  const receipt = path.join(destination, "sha256");
  if (await fs.readFile(receipt, "utf8").catch(() => "") === identity) {
    verifyMacImageRuntime(path.join(destination, "sd-cli"), pin.deploymentTarget);
    return;
  }
  const source = path.join(cache, identity, "source");
  const build = path.join(cache, identity, "build");
  const binary = path.join(build, "bin", "sd-cli");
  if (!await fs.stat(binary).then((stat) => stat.isFile()).catch(() => false)) {
    console.log("Building the pinned image runtime for macOS 12 and later…");
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
    await run("cmake", imageRuntimeCmakeArgs(source, build, pin, process.arch), desktop);
    await run("cmake", ["--build", build, "--target", "sd-cli", "--parallel", String(Math.min(4, os.availableParallelism()))], desktop);
  }
  verifyMacImageRuntime(binary, pin.deploymentTarget);
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  await fs.copyFile(binary, path.join(destination, "sd-cli"));
  await fs.chmod(path.join(destination, "sd-cli"), 0o755);
  for (const [from, name] of [["LICENSE", "stable-diffusion.cpp.txt"], ["ggml/LICENSE", "ggml.txt"],
    ["thirdparty/oniguruma/COPYING", "oniguruma.txt"], ["thirdparty/utf8proc/LICENSE.md", "utf8proc.txt"]]) {
    await fs.copyFile(path.join(source, from), path.join(destination, name));
  }
  await fs.writeFile(receipt, identity);
}
