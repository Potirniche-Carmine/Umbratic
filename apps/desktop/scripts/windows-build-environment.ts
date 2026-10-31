import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { windowsArmClangCompilers } from "./llama-build-config.ts";

/**
 * The environment MSVC needs, as vcvarsall.bat would leave it.
 *
 * The Visual Studio generator locates the toolchain itself; Ninja does not, and
 * wants cl.exe on PATH with INCLUDE and LIB already set. Rather than require
 * that packaging be started from a Developer Command Prompt — easy to forget,
 * and reported as "no CMAKE_C_COMPILER could be found" when it is — the batch
 * file is run here and the environment it produces is captured for CMake.
 *
 * Returns process.env unchanged off Windows, where none of this applies.
 */
let msvcEnvironmentCache: NodeJS.ProcessEnv | null = null;
export function msvcEnvironment(): NodeJS.ProcessEnv {
  if (process.platform !== "win32") return process.env;
  if (msvcEnvironmentCache) return msvcEnvironmentCache;

  // vswhere ships with the Visual Studio Installer at a fixed location, which
  // is the documented way to find an installation without guessing at edition
  // or year in Program Files.
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const vswhere = path.join(programFilesX86, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  const missingToolset = new Error(
    "The MSVC C++ toolset is required to build the bundled model runtime, and was not found.\n"
    + "  Install it with:  winget install Microsoft.VisualStudio.2022.BuildTools"
    + " --override \"--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended\"\n"
    + "  An existing Visual Studio with the \"Desktop development with C++\" workload also works.",
  );
  if (!fs.existsSync(vswhere)) throw missingToolset;

  const found = spawnSync(vswhere, [
    "-latest",
    "-products", "*",
    "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property", "installationPath",
  ], { encoding: "utf8", windowsHide: true });
  const installPath = found.stdout?.trim().split(/\r?\n/)[0] ?? "";
  if (!installPath) throw missingToolset;

  const vcvarsall = path.join(installPath, "VC", "Auxiliary", "Build", "vcvarsall.bat");
  if (!fs.existsSync(vcvarsall)) throw missingToolset;

  // A marker rather than parsing from the first line: vcvarsall prints its own
  // banner, and on some installs a line of it looks enough like KEY=VALUE to be
  // picked up as a variable.
  const marker = "__umbratic_vcvars__";
  const hostArch = process.arch === "arm64" ? "arm64" : "amd64";
  const dumped = spawnSync(
    "cmd.exe",
    ["/d", "/s", "/c", `""${vcvarsall}" ${hostArch} >nul && echo ${marker} && set"`],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      // The doubled quotes above are the /s form, which cmd strips to reach a
      // batch path containing spaces. Node's own argument quoting rewrites them
      // into something cmd parses as a UNC path instead, and the whole thing
      // fails as "the network path was not found"; verbatim leaves them alone.
      windowsVerbatimArguments: true,
    },
  );
  const output = dumped.stdout ?? "";
  const markerAt = output.indexOf(marker);
  if (dumped.status !== 0 || markerAt < 0) {
    throw new Error(
      `Setting up the MSVC environment failed: ${vcvarsall} ${hostArch}\n`
      + `  ${(dumped.stderr || output).trim().split(/\r?\n/).slice(-5).join("\n  ")}`,
    );
  }

  const environment: NodeJS.ProcessEnv = {};
  for (const line of output.slice(markerAt + marker.length).split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) environment[line.slice(0, separator)] = line.slice(separator + 1);
  }
  if (process.arch === "arm64") {
    const clang = windowsArmClangCompilers(installPath);
    environment.CC = clang.c;
    environment.CXX = clang.cxx;
  }
  msvcEnvironmentCache = environment;
  return environment;
}

