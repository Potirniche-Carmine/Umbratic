import "./prepare-image-runtime.ts";
import { llamaBuildJobs, llamaCpuBuildFlags, windowsArmClangCompilers } from "./llama-build-config.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(desktopRoot, ".package", "runner");
const runnerBinaryName = process.platform === "win32" ? "umbratic-runner.exe" : "umbratic-runner";
const runnerBinary = path.resolve(desktopRoot, "../../target/release", runnerBinaryName);
const desktopCoreTarget = path.join(desktopRoot, ".package", "desktop-core");
const desktopCoreBinaryName = process.platform === "win32" ? "umbratic-desktop-core.exe" : "umbratic-desktop-core";
const desktopCoreBinary = path.resolve(desktopRoot, "../../target/release", desktopCoreBinaryName);
const pdfTarget = path.join(desktopRoot, ".package", "pdf");
const pdfBinaryName = process.platform === "win32" ? "umbratic-pdf.exe" : "umbratic-pdf";
const pdfBinary = path.resolve(desktopRoot, "../../target/release", pdfBinaryName);
const artifactsTarget = path.join(desktopRoot, ".package", "artifacts");
const artifactsBinaryName = process.platform === "win32" ? "umbratic-artifacts.exe" : "umbratic-artifacts";
const artifactsBinary = path.resolve(desktopRoot, "../../target/release", artifactsBinaryName);
const codeIndexTarget = path.join(desktopRoot, ".package", "code-index");
const codeIndexBinaryName = process.platform === "win32" ? "umbratic-code-index.exe" : "umbratic-code-index";
const codeIndexBinary = path.resolve(desktopRoot, "../../target/release", codeIndexBinaryName);
const veilRoot = path.resolve(desktopRoot, "../../infrastructure/veil");
const veilTarget = path.join(desktopRoot, ".package", "veil");
const llamaPinFile = path.resolve(desktopRoot, "../../third_party/llama.cpp.pin");
const llamaTarget = path.join(desktopRoot, ".package", "llama-server");
// Sources and object files live outside .package so electron-builder never sees
// them, and so a repeat packaging run at the same pin skips the whole build.
const llamaCacheRoot = path.join(desktopRoot, ".llama-cache");
const llamaServerBinaryName = process.platform === "win32" ? "llama-server.exe" : "llama-server";

type LlamaPin = { repository: string; tag: string; commit: string };

function parseLlamaPin(contents: string): LlamaPin {
  const fields = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) throw new Error(`Malformed llama.cpp pin line: ${trimmed}`);
    fields.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim());
  }
  const repository = fields.get("repository") ?? "";
  const tag = fields.get("tag") ?? "";
  const commit = fields.get("commit") ?? "";
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(repository)) {
    throw new Error("llama.cpp pin must set repository to an https GitHub clone URL.");
  }
  if (!/^b\d+$/.test(tag)) throw new Error("llama.cpp pin must set tag to a llama.cpp build tag such as b10419.");
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("llama.cpp pin must set commit to a full 40-character SHA.");
  return { repository, tag, commit };
}

function run(command: string, args: string[], cwd: string, what: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr.trim() || result.stdout.trim();
    throw new Error(`${what} failed${detail ? `: ${detail}` : "."}`);
  }
  return result.stdout;
}

function humanDuration(ms: number) {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * Runs a step that takes minutes, and says so while it does.
 *
 * Compiling llama.cpp is by far the longest thing in packaging — several
 * minutes of silence on a first build, which is indistinguishable from a hang.
 * The child's output is still captured rather than streamed, because it is
 * thousands of compiler lines that bury everything else; what reaches the
 * terminal is the file count and elapsed time. Set UMBRATIC_LLAMA_VERBOSE=1 to
 * watch the real thing instead.
 */
function runLong(command: string, args: string[], cwd: string, what: string, env = process.env): Promise<void> {
  const verbose = process.env.UMBRATIC_LLAMA_VERBOSE === "1";
  const startedAt = Date.now();
  process.stdout.write(`${what}...\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", verbose ? "inherit" : "pipe", verbose ? "inherit" : "pipe"],
      windowsHide: true,
    });
    let captured = "";
    let startedSteps = 0;
    let partialLine = "";
    let latestPhase = "";
    const absorb = (chunk: Buffer | string) => {
      const text = chunk.toString();
      // Keep only the tail: a failing build's message is at the end, and the
      // whole log is tens of megabytes.
      captured = `${captured}${text}`.slice(-16000);
      // CMake reports an object build before the compiler finishes. Count
      // started steps, and retain the phase so a slow link is not called idle.
      const lines = `${partialLine}${text}`.split(/\r?\n/);
      partialLine = (lines.pop() ?? "").slice(-16000);
      for (const line of lines) {
        if (/\bBuilding [A-Z][A-Z0-9_]* object\b/.test(line)) startedSteps += 1;
        const clean = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
        if (/\b(?:Building|Linking|Generating|Built target)\b/.test(clean)) latestPhase = clean.slice(-220);
      }
    };
    child.stdout?.on("data", absorb);
    child.stderr?.on("data", absorb);

    const heartbeat = setInterval(() => {
      const detail = startedSteps > 0 ? `${startedSteps} compile steps started` : "working";
      const phase = latestPhase ? ` — ${latestPhase}` : "";
      process.stdout.write(`  ${humanDuration(Date.now() - startedAt)} elapsed, ${detail}${phase}\n`);
    }, 20_000);
    heartbeat.unref?.();

    const finish = (error?: Error) => {
      clearInterval(heartbeat);
      if (error) reject(error);
      else {
        process.stdout.write(`${what} finished in ${humanDuration(Date.now() - startedAt)}\n`);
        resolve();
      }
    };
    child.once("error", (error) => finish(new Error(`${what} failed: ${error.message}`)));
    child.once("exit", (code) => {
      if (code === 0) finish();
      else finish(new Error(`${what} failed${captured.trim() ? `: ${captured.trim()}` : "."}`));
    });
  });
}

/**
 * Building a CPU-only runtime, for iterating on packaging without the Vulkan
 * SDK installed. It produces an app that runs, slowly, on any machine — and one
 * that must never be released, so `verify:package` demands the same variable
 * before it will accept a build with no GPU backend, and a release build
 * never sets it.
 */
const llamaCpuOnly = process.env.UMBRATIC_LLAMA_CPU_ONLY === "1";

/**
 * The CMake generator for the llama.cpp build, chosen per platform.
 *
 * Ninja on Windows, and only there: llama.cpp builds vulkan-shaders-gen as a
 * nested ExternalProject, and the .tlog files the default MSBuild generator
 * writes under that prefix push its compiler probe past the 260-character
 * MAX_PATH limit for any checkout more than a few directories deep. That
 * surfaces as "the C compiler is broken", which is not what went wrong. Ninja
 * writes no .tlog files, and leaves the longest path comfortably clear.
 *
 * Everywhere else, null: CMake's platform default (Unix Makefiles) builds the
 * same thing with the make the Xcode Command Line Tools already provide,
 * without asking for another tool. Set UMBRATIC_LLAMA_GENERATOR to override
 * either choice — for example to use an installed Ninja on a Mac.
 */
const llamaGenerator = process.env.UMBRATIC_LLAMA_GENERATOR?.trim()
  || (process.platform === "win32" ? "Ninja" : null);

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
function msvcEnvironment(): NodeJS.ProcessEnv {
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

/**
 * Checks the toolchain before CMake does, because CMake's own failure for a
 * missing dependency is twenty lines of module backtrace with the actionable
 * part — a package to install — nowhere in it.
 */
function requireLlamaBuildTools(wantsVulkan: boolean) {
  const mac = process.platform === "darwin";
  if (spawnSync("cmake", ["--version"], { stdio: "ignore" }).error) {
    throw new Error(
      "CMake is required to build the bundled model runtime, and is not on PATH.\n"
      + (mac
        ? "  Install it with:  brew install cmake\n"
        : "  Install it with:  winget install Kitware.CMake\n")
      + "  then open a new terminal so PATH picks it up.",
    );
  }
  // See llamaGenerator for why this is Ninja on Windows and CMake's own
  // default elsewhere.
  if (llamaGenerator === "Ninja" && spawnSync("ninja", ["--version"], { stdio: "ignore" }).error) {
    throw new Error(
      "Ninja is required to build the bundled model runtime, and is not on PATH.\n"
      + (mac
        ? "  Install it with:  brew install ninja\n"
        : "  Install it with:  winget install Ninja-build.Ninja\n")
      + "  then open a new terminal so PATH picks it up.",
    );
  }
  if (mac) {
    // Compiler and make both come from the Command Line Tools; this is the
    // standard check for them that cannot pop the GUI install dialog.
    if (spawnSync("xcode-select", ["-p"], { stdio: "ignore" }).status !== 0) {
      throw new Error(
        "The Xcode Command Line Tools are required to build the bundled model runtime.\n"
        + "  Install them with:  xcode-select --install",
      );
    }
  }
  if (!wantsVulkan) return;
  // FindVulkan needs the headers, the loader import library, and glslc, all of
  // which come from the SDK. VULKAN_SDK is how it finds them.
  const hasSdk = !!process.env.VULKAN_SDK?.trim() && fs.existsSync(process.env.VULKAN_SDK.trim());
  if (hasSdk) return;
  throw new Error(
    "The Vulkan SDK is required to build the GPU backend on Windows, and VULKAN_SDK is not set.\n"
    + "  Install it with:  winget install KhronosGroup.VulkanSDK\n"
    + "  then open a new terminal so VULKAN_SDK is set.\n"
    + "  To package a CPU-only build for local testing instead, set UMBRATIC_LLAMA_CPU_ONLY=1.\n"
    + "  That build is not releasable: verify:package refuses it unless the same variable is set.",
  );
}

// llama.cpp is built from source at a pinned commit rather than pulled from a
// release page: the release archives are unsigned, and building here is what
// lets us turn off the -hf download path the app never uses.
/**
 * Local changes to the pinned llama.cpp, applied to the checkout before it is
 * built.
 *
 * Kept as patch files under third_party rather than a fork, so that what
 * Umbratic changes about the runtime it ships is a few readable lines next to
 * the pin, and bumping the pin surfaces any that no longer apply as a failure
 * rather than a silent drift.
 */
const llamaPatchDir = path.resolve(desktopRoot, "../../third_party");
const llamaPatchFiles = ["llama.cpp-list-device-type.patch"];

/** Whether anything changed, which is what makes a cached build tree stale. */
function applyLlamaPatches(sourceDir: string): boolean {
  const patches = llamaPatchFiles.map((name) => {
    const file = path.join(llamaPatchDir, name);
    if (!fs.existsSync(file)) throw new Error(`Missing llama.cpp patch: ${file}`);
    return { name, file };
  });

  // A cached checkout is already patched. `--reverse --check` is how git
  // answers "would undoing this apply cleanly", which is true exactly when it
  // is already in place, and leaves the tree untouched either way.
  const inPlace = patches.every(({ file }) => spawnSync("git", ["apply", "--reverse", "--check", file], {
    cwd: sourceDir,
    stdio: "ignore",
    windowsHide: true,
  }).status === 0);
  if (inPlace) return false;

  // All of them, from the pinned commit, whenever any one of them is out of
  // date: an edited patch leaves the checkout holding a version that neither
  // applies nor reverses, and patches after it in the list would be undone by
  // resetting for it. Starting clean makes the result the patch files as they
  // read now rather than as they read when the cache was filled.
  run("git", ["checkout", "--", "."], sourceDir, "Resetting the llama.cpp checkout");
  for (const { name, file } of patches) {
    run("git", ["apply", file], sourceDir, `Applying ${name}`);
  }
  return true;
}

async function buildLlamaServer() {
  const pin = parseLlamaPin(fs.readFileSync(llamaPinFile, "utf8"));
  fs.mkdirSync(llamaCacheRoot, { recursive: true });
  const sourceDir = path.join(llamaCacheRoot, pin.tag, "src");
  const buildDir = path.join(llamaCacheRoot, pin.tag, "build");

  if (!fs.existsSync(path.join(sourceDir, "CMakeLists.txt"))) {
    fs.rmSync(sourceDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(sourceDir), { recursive: true });
    run("git", ["clone", "--depth", "1", "--branch", pin.tag, pin.repository, sourceDir], llamaCacheRoot, `Cloning llama.cpp ${pin.tag}`);
  }
  const head = run("git", ["rev-parse", "HEAD"], sourceDir, "Reading the llama.cpp checkout").trim();
  if (head !== pin.commit) {
    throw new Error(`llama.cpp ${pin.tag} resolved to ${head}, but third_party/llama.cpp.pin records ${pin.commit}.`);
  }
  // After the commit check, never before: the pin identifies what was reviewed,
  // and the patches are reviewed alongside it as their own files. A cached
  // build of the sources as they were before a patch changed is not a build of
  // what is about to ship, so it is dropped rather than reused.
  if (applyLlamaPatches(sourceDir)) {
    fs.rmSync(buildDir, { recursive: true, force: true });
  }

  if (!findLlamaServerBinDir(buildDir)) {
    // Only a run that will actually compile needs the toolchain. A repeat
    // packaging run reuses the cache and copies files, which asking for CMake
    // would block for no reason.
    requireLlamaBuildTools(process.platform === "win32" && process.arch === "x64" && !llamaCpuOnly);
    if (llamaCpuOnly) {
      console.warn("UMBRATIC_LLAMA_CPU_ONLY=1: building llama-server without a GPU backend. Do not release this build.");
    }
    const configure = [
      // See llamaGenerator for the per-platform choice. Ninja and the Unix
      // Makefiles default are both single-config, so CMAKE_BUILD_TYPE below is
      // what selects Release, rather than a --config flag on the build step.
      ...(llamaGenerator ? ["-G", llamaGenerator] : []),
      "-S", sourceDir,
      "-B", buildDir,
      "-DCMAKE_BUILD_TYPE=Release",
      // Backends ship as separate libraries that ggml loads at run time, which
      // is what lets one build serve every machine: the Vulkan backend is
      // skipped on a box with no loader instead of failing the process at
      // start, and the CPU backend picks the variant matching the CPU actually
      // present. GGML_BACKEND_DL requires shared libraries, so the single-file
      // property is traded for that.
      "-DBUILD_SHARED_LIBS=ON",
      "-DGGML_BACKEND_DL=ON",
      // Keep CPU code portable: native tuning is off everywhere. Upstream's
      // runtime CPU variants are supported on macOS and x64; Windows ARM uses
      // its supported Clang build with an explicit ARMv8 baseline instead.
      ...llamaCpuBuildFlags(process.platform, process.arch),
      // Drops libcurl and with it the `-hf` remote-download path. Umbratic
      // downloads weights itself, from a revision-pinned URL it can checksum.
      "-DLLAMA_CURL=OFF",
      "-DLLAMA_BUILD_TESTS=OFF",
      "-DLLAMA_BUILD_EXAMPLES=OFF",
      "-DLLAMA_BUILD_SERVER=ON",
    ];
    // Vulkan reaches every desktop GPU vendor with one backend, through the
    // vulkan-1.dll the user's display driver installs. Left off on Windows ARM,
    // where the Adreno Vulkan path is not dependable enough to ship: those
    // machines run on the portable ARM CPU backend instead.
    if (process.platform === "win32" && process.arch === "x64" && !llamaCpuOnly) {
      configure.push("-DGGML_VULKAN=ON");
    }
    if (process.platform === "darwin") {
      // Metal is always present on the Macs this ships to. Embedding the shader
      // library keeps it inside the backend rather than as a loose .metallib
      // that would have to be found, signed, and notarized separately.
      configure.push("-DGGML_METAL=ON", "-DGGML_METAL_EMBED_LIBRARY=ON");
      // Match Electron's own floor. Left unset, CMake targets the SDK the build
      // machine happens to have, and the binary refuses to load on any older
      // macOS the app otherwise supports.
      configure.push("-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0");
      // Build for the architecture being packaged rather than the one that
      // happens to be compiling, so the sidecar cannot disagree with the app
      // it ships inside.
      configure.push(`-DCMAKE_OSX_ARCHITECTURES=${process.arch === "x64" ? "x86_64" : "arm64"}`);
    }
    console.log(
      `Building llama.cpp ${pin.tag} from source. The first build takes several minutes;`
      + " later packaging runs reuse apps/desktop/.llama-cache and skip it.",
    );
    const parallelJobs = llamaBuildJobs(os.availableParallelism(), os.totalmem());
    const buildEnv: NodeJS.ProcessEnv = { ...msvcEnvironment(), CMAKE_BUILD_PARALLEL_LEVEL: String(parallelJobs) };
    if (process.platform === "win32" && process.arch === "arm64") {
      configure.push(`-DCMAKE_C_COMPILER=${buildEnv.CC}`, `-DCMAKE_CXX_COMPILER=${buildEnv.CXX}`);
    }
    await runLong("cmake", configure, llamaCacheRoot, `Configuring llama.cpp ${pin.tag}`, buildEnv);
    // No --target: the backend libraries are loaded by ggml at run time rather
    // than linked, so building only llama-server would leave every one of them
    // unbuilt and the packaged app with nothing to run on.
    await runLong(
      "cmake",
      ["--build", buildDir, "--parallel", String(parallelJobs)],
      llamaCacheRoot,
      `Building llama-server ${pin.tag}`,
      buildEnv,
    );
  }

  const binDir = findLlamaServerBinDir(buildDir);
  if (!binDir) throw new Error(`llama-server ${pin.tag} built without producing ${llamaServerBinaryName}.`);

  fs.rmSync(llamaTarget, { recursive: true, force: true });
  fs.mkdirSync(llamaTarget, { recursive: true });
  // The executable and the libraries it dynamically loads, and nothing else:
  // the build tree also holds llama.cpp's other tools, which Umbratic never
  // runs and must not ship.
  const shipped = fs.readdirSync(binDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name === llamaServerBinaryName || (isLoadableLibrary(name) && !isOtherToolLibrary(name)));
  for (const name of shipped) {
    const source = path.join(binDir, name);
    // Under the name dyld will ask for, not the name the build tree used: on
    // macOS those differ, and the difference is covered there by symlinks that
    // a plain file copy leaves behind.
    const packaged = path.join(llamaTarget, process.platform === "darwin" ? machOShippedName(source) : name);
    fs.copyFileSync(source, packaged);
    if (process.platform !== "win32") fs.chmodSync(packaged, 0o755);
    if (process.platform === "darwin") relocateMachO(packaged);
  }
  if (!shipped.includes(llamaServerBinaryName)) {
    throw new Error(`llama-server ${pin.tag} built without producing ${llamaServerBinaryName}.`);
  }
  const backends = shipped.filter((name) => /ggml-(cpu|vulkan|metal|blas)/i.test(name));
  if (backends.length === 0) {
    throw new Error(`llama-server ${pin.tag} built without any loadable ggml backend.`);
  }
  console.log(
    `Prepared packaged llama-server ${pin.tag} at ${path.relative(desktopRoot, llamaTarget)}`
    + ` (${backends.length} backends: ${backends.join(", ")})`,
  );
}

function isLoadableLibrary(name: string): boolean {
  return /\.(?:dll|dylib)$/i.test(name) || /\.so(?:\.\d+)*$/.test(name);
}

/**
 * The name a macOS library must ship under: the basename of its install name.
 *
 * CMake writes versioned dylibs — libllama.0.1.0.dylib — whose recorded
 * install name is the SONAME, libllama.0.dylib, and bridges the difference
 * with symlinks in the build tree. Every load command in llama-server names
 * the SONAME, so that is the filename the package carries: one real file per
 * library, rather than a symlink chain that the copy, the archive, and
 * signing would each have to preserve intact.
 */
function machOShippedName(file: string): string {
  const name = path.basename(file);
  // Executables and dlopen'd .so modules are found by their own names.
  if (!/\.dylib$/i.test(name)) return name;
  const output = run("otool", ["-D", file], path.dirname(file), `Reading the install name of ${name}`);
  const installName = output.trim().split(/\r?\n/).pop()?.trim() ?? "";
  return installName.startsWith("@rpath/") ? path.basename(installName) : name;
}

/** Every LC_RPATH recorded in a Mach-O file. */
function machORpaths(file: string): string[] {
  const lines = run("otool", ["-l", file], path.dirname(file), `Reading the rpaths of ${path.basename(file)}`)
    .split(/\r?\n/);
  const rpaths: string[] = [];
  lines.forEach((line, index) => {
    if (!/\bcmd LC_RPATH\b/.test(line)) return;
    for (const candidate of lines.slice(index + 1, index + 4)) {
      const match = candidate.match(/^\s*path (.+) \(offset \d+\)$/);
      if (match) {
        rpaths.push(match[1]);
        return;
      }
    }
  });
  return rpaths;
}

/**
 * Points a copied Mach-O file at the libraries beside it, and at nothing else.
 *
 * The build tree's binaries carry an LC_RPATH naming the absolute build
 * directory under .llama-cache. On the machine that built them the path
 * exists, so the packaged runtime passes every local test — and on any other
 * machine dyld reports "Library not loaded" and the process dies at spawn,
 * which the app can only report as a runtime that failed to start. Replacing
 * the recorded paths with @loader_path makes the package the only place the
 * runtime ever looks.
 */
function relocateMachO(file: string) {
  const name = path.basename(file);
  const edits: string[] = [];
  for (const rpath of new Set(machORpaths(file))) edits.push("-delete_rpath", rpath);
  edits.push("-add_rpath", "@loader_path");
  run("install_name_tool", [...edits, file], path.dirname(file), `Relocating ${name}`);
  // Editing load commands invalidates the code signature, and arm64 macOS
  // refuses to run an invalidly signed binary even locally. Ad hoc is enough
  // here; release signing replaces it.
  run("codesign", ["--force", "--sign", "-", file], path.dirname(file), `Re-signing ${name}`);
}

/**
 * llama.cpp builds one implementation library per tool — cli, bench,
 * perplexity, quantize — and Umbratic runs only the server. Shipping the rest
 * puts code in the install that nothing can ever call, which is the opposite of
 * knowing what is on the machine. A wrong exclusion here cannot go unnoticed:
 * a missing import fails at process load, and verify:package runs the binary.
 */
function isOtherToolLibrary(name: string): boolean {
  // With or without the "lib" prefix: Windows names these llama-cli-impl.dll,
  // macOS libllama-cli-impl.dylib.
  return /^(?:lib)?llama-.*-impl\.(?:dll|dylib|so)/i.test(name) && !/^(?:lib)?llama-server-impl\./i.test(name);
}

// Single-config generators put the output in bin/; MSVC adds a per-config level.
function findLlamaServerBinDir(buildDir: string): string | null {
  const candidates = [path.join(buildDir, "bin"), path.join(buildDir, "bin", "Release")];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, llamaServerBinaryName))) ?? null;
}

const requiredFiles = [
  runnerBinary,
  desktopCoreBinary,
  pdfBinary,
];

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) {
    throw new Error(`Missing packaged runner input: ${file}. Run npm run desktop:release first.`);
  }
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
const packagedRunnerBinary = path.join(target, runnerBinaryName);
fs.copyFileSync(runnerBinary, packagedRunnerBinary);
if (process.platform !== "win32") fs.chmodSync(packagedRunnerBinary, 0o755);

console.log(`Prepared packaged runner at ${path.relative(desktopRoot, target)}`);

fs.rmSync(desktopCoreTarget, { recursive: true, force: true });
fs.mkdirSync(desktopCoreTarget, { recursive: true });
const packagedDesktopCore = path.join(desktopCoreTarget, desktopCoreBinaryName);
fs.copyFileSync(desktopCoreBinary, packagedDesktopCore);
if (process.platform !== "win32") fs.chmodSync(packagedDesktopCore, 0o755);
console.log(`Prepared packaged desktop core at ${path.relative(desktopRoot, packagedDesktopCore)}`);

fs.rmSync(pdfTarget, { recursive: true, force: true });
fs.mkdirSync(pdfTarget, { recursive: true });
const packagedPdfBinary = path.join(pdfTarget, pdfBinaryName);
fs.copyFileSync(pdfBinary, packagedPdfBinary);
if (process.platform !== "win32") fs.chmodSync(packagedPdfBinary, 0o755);
console.log(`Prepared packaged PDF inspector at ${path.relative(desktopRoot, packagedPdfBinary)}`);

fs.rmSync(artifactsTarget, { recursive: true, force: true });
fs.mkdirSync(artifactsTarget, { recursive: true });
const packagedArtifactsBinary = path.join(artifactsTarget, artifactsBinaryName);
fs.copyFileSync(artifactsBinary, packagedArtifactsBinary);
if (process.platform !== "win32") fs.chmodSync(packagedArtifactsBinary, 0o755);
console.log(`Prepared packaged artifacts sidecar at ${path.relative(desktopRoot, packagedArtifactsBinary)}`);

fs.rmSync(codeIndexTarget, { recursive: true, force: true });
fs.mkdirSync(codeIndexTarget, { recursive: true });
const packagedCodeIndexBinary = path.join(codeIndexTarget, codeIndexBinaryName);
fs.copyFileSync(codeIndexBinary, packagedCodeIndexBinary);
if (process.platform !== "win32") fs.chmodSync(packagedCodeIndexBinary, 0o755);
console.log(`Prepared packaged code index at ${path.relative(desktopRoot, packagedCodeIndexBinary)}`);

fs.rmSync(veilTarget, { recursive: true, force: true });
fs.mkdirSync(veilTarget, { recursive: true });
const veilBinary = path.join(veilTarget, process.platform === "win32" ? "veil.exe" : "veil");
const veilBuild = spawnSync("go", ["build", "-trimpath", "-o", veilBinary, "./cmd/veil"], {
  cwd: veilRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (veilBuild.error || veilBuild.status !== 0) {
  const detail = veilBuild.error?.message || veilBuild.stderr.trim() || veilBuild.stdout.trim();
  throw new Error(`Unable to build packaged Veil${detail ? `: ${detail}` : "."}`);
}
console.log(`Prepared packaged Veil at ${path.relative(desktopRoot, veilBinary)}`);

await buildLlamaServer();

