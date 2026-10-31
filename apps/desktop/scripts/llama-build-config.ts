import fs from "node:fs";
import path from "node:path";

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
