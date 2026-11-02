// Exact native cache identity. Restored binaries still pass every normal probe.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { msvcEnvironment } from "../../apps/desktop/scripts/windows-build-environment.ts";

export const nativeCacheInputs = [
  "scripts/ci/build-cache.ts", "scripts/ci/install-vulkan.ps1",
  "apps/desktop/scripts/prepare-package.ts", "apps/desktop/scripts/prepare-image-runtime.ts",
  "apps/desktop/scripts/build-image-runtime.ts", "apps/desktop/scripts/llama-build-config.ts",
  "apps/desktop/scripts/windows-build-environment.ts", "apps/desktop/scripts/windows-dependencies.ts",
  "third_party/llama.cpp.pin", "third_party/llama.cpp-list-device-type.patch",
  "third_party/llama.cpp-disable-remote-downloads.patch", "third_party/stable-diffusion.cpp.json",
  "third_party/stable-diffusion-notices.txt", "third_party/apache-2.0.txt", "third_party/vulkan-sdk.json",
];

export function nativeCacheKey(repository: string, toolchain: Record<string, string>): string {
  const digest = crypto.createHash("sha256");
  // CMake trees contain absolute source/compiler paths. Never relocate one.
  digest.update(JSON.stringify({ repository: fs.realpathSync(repository),
    toolchain: Object.entries(toolchain).sort(([left], [right]) => left.localeCompare(right)) }));
  for (const input of nativeCacheInputs) {
    digest.update(JSON.stringify([input, fs.readFileSync(path.join(repository, input)).toString("base64")]));
  }
  return `umbratic-native-v1-${digest.digest("hex")}`;
}

export function nativeToolchain(): Record<string, string> {
  if (!((process.platform === "darwin" && process.arch === "arm64")
      || (process.platform === "win32" && ["x64", "arm64"].includes(process.arch)))) {
    throw new Error("Unsupported native CI cache target.");
  }
  if (process.env.GITHUB_ACTIONS === "true" && (!process.env.ImageVersion || process.env.RUNNER_ENVIRONMENT !== "github-hosted")) {
    throw new Error("Native CI caches require an identified GitHub-hosted image.");
  }
  const environment = msvcEnvironment();
  function version(command: string, args: string[]): string {
    const result = spawnSync(command, args, { env: environment, encoding: "utf8", timeout: 30_000,
      maxBuffer: 64 * 1024, windowsHide: true });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    if (result.error || result.status !== 0 || !output) throw new Error(`Unable to identify native cache tool: ${path.basename(command)}.`);
    return output.replaceAll("\r\n", "\n");
  }
  const identity: Record<string, string> = {
    platform: process.platform, architecture: process.arch, osRelease: os.release(),
    image: process.env.ImageVersion ?? "local", imageOS: process.env.ImageOS ?? "local",
    cmake: version("cmake", ["--version"]),
    generator: process.env.UMBRATIC_LLAMA_GENERATOR?.trim() || (process.platform === "win32" ? "Ninja" : "Unix Makefiles"),
  };
  // Include explicit compiler/search/build overrides without recording secrets
  // or the process environment as a whole. These values are hashed, not logged.
  for (const name of ["CC", "CXX", "CFLAGS", "CXXFLAGS", "CPPFLAGS", "LDFLAGS", "SDKROOT", "CMAKE_GENERATOR",
    "CMAKE_TOOLCHAIN_FILE", "CMAKE_PREFIX_PATH", "CPATH", "LIBRARY_PATH", "INCLUDE", "LIB", "LIBPATH", "CL", "_CL_",
    "VCToolsVersion", "WindowsSDKVersion", "VULKAN_SDK", "UMBRATIC_LLAMA_CPU_ONLY"]) {
    identity[name] = environment[name] ?? "";
  }
  if (process.platform === "darwin") {
    identity.compiler = version("xcrun", ["clang", "--version"]);
    identity.sdk = version("xcrun", ["--show-sdk-path"]) + "\n" + version("xcrun", ["--show-sdk-version"]);
    identity.make = version("make", ["--version"]);
    if (identity.generator === "Ninja" || environment.CMAKE_GENERATOR === "Ninja") identity.ninja = version("ninja", ["--version"]);
    if (identity.generator === "Xcode" || environment.CMAKE_GENERATOR === "Xcode") identity.xcode = version("xcodebuild", ["-version"]);
  } else {
    identity.compiler = process.arch === "arm64" ? version(environment.CXX!, ["--version"]) : version("cl.exe", ["/?"]);
    identity.ninja = version("ninja", ["--version"]);
    if (process.arch === "x64") {
      if (!environment.VULKAN_SDK) throw new Error("Install the reviewed Vulkan SDK before selecting its native cache.");
      identity.shaderCompiler = version(path.join(environment.VULKAN_SDK, "Bin", "glslc.exe"), ["--version"]);
    }
  }
  return identity;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.GITHUB_OUTPUT) throw new Error("Native cache identity requires GITHUB_OUTPUT.");
  const repository = path.resolve(import.meta.dirname, "../..");
  const key = nativeCacheKey(repository, nativeToolchain());
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `native-key=${key}\n`);
  console.log(`Selected exact native build cache ${key}.`);
}
