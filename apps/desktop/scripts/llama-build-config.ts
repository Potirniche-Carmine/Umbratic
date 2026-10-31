import fs from "node:fs";
import path from "node:path";

export function parseLlamaPin(contents: string): { repository: string; tag: string; commit: string } {
  const fields = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) throw new Error("Malformed llama.cpp pin: expected KEY=value.");
    const key = trimmed.slice(0, separator).trim();
    if (!["repository", "tag", "commit"].includes(key) || fields.has(key)) throw new Error("Malformed llama.cpp pin field.");
    fields.set(key, trimmed.slice(separator + 1).trim());
  }
  const repository = fields.get("repository") ?? "";
  const tag = fields.get("tag") ?? "";
  const commit = fields.get("commit") ?? "";
  if (repository !== "https://github.com/ggml-org/llama.cpp.git") throw new Error("llama.cpp pin must use its upstream GitHub repository.");
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)) throw new Error("llama.cpp pin must select a stable vX.Y.Z release tag.");
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("llama.cpp pin must set a full 40-character commit SHA.");
  return { repository, tag, commit };
}

export function llamaCpuBuildFlags(platform: NodeJS.Platform, arch: string): string[] {
  if (platform === "win32" && arch === "arm64") {
    // Upstream supports ARM Windows with Clang, but not its multi-variant
    // dispatcher. Use a portable NEON baseline rather than the build CPU.
    return [
      "-DGGML_NATIVE=OFF",
      "-DGGML_CPU_ALL_VARIANTS=OFF",
      "-DGGML_CPU_ARM_ARCH=armv8-a",
      "-DGGML_OPENMP=OFF",
      "-DCMAKE_C_COMPILER_TARGET=aarch64-pc-windows-msvc",
      "-DCMAKE_CXX_COMPILER_TARGET=aarch64-pc-windows-msvc",
    ];
  }
  return ["-DGGML_NATIVE=OFF", "-DGGML_CPU_ALL_VARIANTS=ON"];
}

export function windowsArmClangCompilers(visualStudio: string): { c: string; cxx: string } {
  for (const host of ["ARM64", "x64", ""]) {
    const directory = path.join(visualStudio, "VC", "Tools", "Llvm", host, "bin");
    const c = path.join(directory, "clang.exe");
    const cxx = path.join(directory, "clang++.exe");
    if (fs.statSync(c, { throwIfNoEntry: false })?.isFile() && fs.statSync(cxx, { throwIfNoEntry: false })?.isFile()) return { c, cxx };
  }
  throw new Error("Windows ARM packaging requires the Visual Studio C++ Clang compiler component.");
}

/** Keep heavy C++ translation units within the host's CPU and memory budget. */
export function llamaBuildJobs(availableCpus: number, memoryBytes: number): number {
  return Math.max(1, Math.min(availableCpus, Math.floor(memoryBytes / (4 * 1024 ** 3))));
}
