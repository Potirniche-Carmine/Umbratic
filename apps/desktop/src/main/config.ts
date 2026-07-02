import { env } from "node:process";

import type { HarnessProfileId, LocalProviderId, ModelEndpointMode, ModelEndpointSoftware, TaskState } from "./types";

export type EndpointMtlsConfig = {
  caPath?: string;
  certPath?: string;
  keyPath?: string;
  pfxPath?: string;
  passphrase?: string;
  serverName?: string;
  pinnedServerCertificateSha256?: string;
};

const configuredEndpointBaseUrl =
  env.UMBRATIC_VEIL_BASE_URL ||
  env.UMBRATIC_MANAGED_MODEL_BASE_URL ||
  env.UMBRATIC_MODEL_BASE_URL ||
  env.OLLAMA_BASE_URL ||
  env.UMBRATIC_VLLM_BASE_URL ||
  env.VLLM_BASE_URL ||
  "";

export const defaultEndpointBaseUrl =
  configuredEndpointBaseUrl ||
  "http://127.0.0.1:8080";
export const defaultEndpointApiKey =
  env.UMBRATIC_VEIL_TOKEN || env.UMBRATIC_MODEL_API_KEY || env.OLLAMA_API_KEY || env.VLLM_API_KEY || "";
export const defaultEndpointModelId = "veil-managed";

export function isModelEndpointMode(value: unknown): value is ModelEndpointMode {
  return value === "local" || value === "server";
}

export function isModelEndpointSoftware(value: unknown): value is ModelEndpointSoftware {
  return value === "ollama" || value === "vllm";
}

export function defaultEndpointSoftware(mode: ModelEndpointMode, baseUrl = defaultEndpointBaseUrl): ModelEndpointSoftware {
  const normalized = baseUrl.toLowerCase();
  if (env.UMBRATIC_MANAGED_MODEL_SOFTWARE && isModelEndpointSoftware(env.UMBRATIC_MANAGED_MODEL_SOFTWARE)) {
    return env.UMBRATIC_MANAGED_MODEL_SOFTWARE;
  }
  if (env.UMBRATIC_MODEL_SOFTWARE && isModelEndpointSoftware(env.UMBRATIC_MODEL_SOFTWARE)) {
    return env.UMBRATIC_MODEL_SOFTWARE;
  }
  if (env.OLLAMA_BASE_URL || normalized.includes("11434") || normalized.includes("ollama")) return "ollama";
  if (env.UMBRATIC_VLLM_BASE_URL || env.VLLM_BASE_URL || normalized.includes("vllm") || normalized.includes("8000")) return "vllm";
  return mode === "local" ? "ollama" : "vllm";
}

export function managedModelEndpointDefaults():
  | {
      mode?: ModelEndpointMode;
      software?: ModelEndpointSoftware;
      baseUrl?: string;
      secret?: string;
    }
  | undefined {
  const mode = isModelEndpointMode(env.UMBRATIC_MANAGED_ENDPOINT_MODE) ? env.UMBRATIC_MANAGED_ENDPOINT_MODE : undefined;
  const software = isModelEndpointSoftware(env.UMBRATIC_MANAGED_MODEL_SOFTWARE) ? env.UMBRATIC_MANAGED_MODEL_SOFTWARE : undefined;
  const baseUrl = env.UMBRATIC_MANAGED_MODEL_BASE_URL?.trim();
  const secret = env.UMBRATIC_MANAGED_MODEL_API_KEY ?? undefined;
  const managed = {
    mode,
    software,
    baseUrl: baseUrl || undefined,
    secret,
  };
  return Object.values(managed).some((value) => value !== undefined) ? managed : undefined;
}

export function endpointEditingAllowed(): boolean {
  const value = env.UMBRATIC_ALLOW_ENDPOINT_EDIT?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export const defaultHarnessProfileId: HarnessProfileId = "engineering";

export function isHarnessProfileId(value: unknown): value is HarnessProfileId {
  return value === "marketing" || value === "sales" || value === "engineering";
}

export function defaultEndpointBaseUrlForSoftware(mode: ModelEndpointMode, software: ModelEndpointSoftware): string {
  void software;
  if (mode === "local") return "http://127.0.0.1:8080";
  if (configuredEndpointBaseUrl) return configuredEndpointBaseUrl;
  return "https://your-veil-server.example";
}

function optionalEnv(name: string): string | undefined {
  const value = env[name];
  return value && value.trim() ? value.trim() : undefined;
}

export const defaultEndpointMtlsConfig: EndpointMtlsConfig | undefined = (() => {
  const mtls: EndpointMtlsConfig = {
    caPath: optionalEnv("UMBRATIC_MODEL_MTLS_CA_PATH"),
    certPath: optionalEnv("UMBRATIC_MODEL_MTLS_CERT_PATH"),
    keyPath: optionalEnv("UMBRATIC_MODEL_MTLS_KEY_PATH"),
    pfxPath: optionalEnv("UMBRATIC_MODEL_MTLS_PFX_PATH"),
    passphrase: optionalEnv("UMBRATIC_MODEL_MTLS_PASSPHRASE"),
    serverName: optionalEnv("UMBRATIC_MODEL_TLS_SERVER_NAME"),
    pinnedServerCertificateSha256: optionalEnv("UMBRATIC_MODEL_TLS_PIN_SHA256"),
  };
  return Object.values(mtls).some(Boolean) ? mtls : undefined;
})();

export const workspaceContextVerificationPrompt = [
  "The workspace file list included with each request is a bounded preview, not a complete filesystem inventory.",
  "When the user asks about all, existing, current, or accurate files, folders, subfolders, or project structure, verify with workspace tools before answering: use the read tool to list known directories, including nested directory inventories, and the search tool for path or content matches.",
].join(" ");

export const workspaceToolchainSystemPrompt = [
  "Internal workspace tool policy: use the workspace tools available in this request. Prefer the read tool for known files and directories, including directory inventories, the search tool when searching through a folder or workspace for matching file paths/content, and file-changing tools for edits. Use shell commands for builds, tests, Git, and tasks that genuinely need a command.",
  "Do not treat provided workspace file previews as exhaustive. Do not start visible thinking or the answer by listing tools, and do not recommend a specific local binary unless tool output or the user's request makes it relevant.",
].join(" ");

export const cCmakeRuntimeSystemPrompt = [
  "C/CMake harness policy: C and CMake are an important workflow in Umbratic AI, but CMake, compilers, build backends, and sanitizers are optional host capabilities. Detect what exists in the workspace and on the current platform before choosing commands.",
  "Prefer the project's own build path first: inspect `README`, `CMakePresets.json`, `CMakeUserPresets.json`, `CMakeLists.txt`, `Makefile`, build scripts, `compile_commands.json`, source files, and tests before choosing commands. Use CMake when the project supports it and `cmake` exists; otherwise use the repo's documented scripts, direct compiler invocations, make/ninja/msbuild when available, or static/source inspection when no local build tool is present.",
  "When CMake is usable, configure out of tree under `.umbratic/build` and request `CMAKE_EXPORT_COMPILE_COMMANDS=ON` unless an existing preset already defines a build dir. Prefer `cmake --preset <name>` when presets exist; otherwise use `cmake -S . -B .umbratic/build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON` with `-G Ninja` only when `ninja` exists. Build with `cmake --build .umbratic/build --parallel` or `cmake --build --preset <name>`, then run tests with `ctest --test-dir .umbratic/build --output-on-failure` or the matching test preset.",
  "Platform selection: on Windows, detect Developer PowerShell/MSVC (`cl`), clang/LLVM, MinGW, Ninja, MSBuild, and CMake independently; never assume a POSIX shell. On macOS, use Xcode Command Line Tools clang when present and Homebrew tools when available. On Linux, use available gcc/clang plus make/ninja/cmake as detected.",
  "If a preferred dependency is missing, fall back to another available verification route. Only stop and give install commands when no available fallback can answer the user's request. Windows examples: `winget install Kitware.CMake Ninja-build.Ninja LLVM.LLVM Microsoft.VisualStudio.2022.BuildTools`; macOS examples: `xcode-select --install` and `brew install cmake ninja llvm`; Ubuntu/Debian examples: `sudo apt-get install -y build-essential cmake ninja-build clang`; Fedora examples: `sudo dnf install cmake ninja-build gcc clang`; Arch examples: `sudo pacman -S base-devel cmake ninja clang`.",
  "When compilation is possible and fails, read the first real compiler diagnostic, inspect the referenced source/header, make the smallest source or build-file fix, and rebuild. Keep iterating until it compiles and tests run, or until no local fallback remains. For syntax errors, use compiler output when available, otherwise use source inspection and tree-sitter when available to locate mismatched braces, declarations, includes, prototypes, and preprocessor problems.",
  "For security-oriented C tasks, prefer debug info and sanitizer builds when the project and installed compiler support them. Use source review, compiler diagnostics, sanitizers, tests, or explain the missing optional capability.",
].join(" ");

export const pythonRuntimeSystemPrompt =
  "Mandatory Python runtime policy: for every Python task, create or use a workspace `.venv` and run through `uv` whenever uv is available. Never verify by running bare `python`, `python3`, or `py`; those commands are not acceptable verification commands in Umbratic AI. Use up to three concrete runtime attempts before giving up, and summarize each failed attempt with the exact command and error. Attempt 1: run `uv --version`; if uv exists, run `uv python install 3.12` if Python is missing, then `uv venv .venv --python 3.12`, then verify with `uv run python <script.py>` or the direct `.venv` interpreter. Attempt 2: if dependencies are needed, install them into the uv environment with `uv add`, `uv pip install`, or `uv run --with <package> ...`, then rerun verification through uv or `.venv`. Attempt 3: if uv is unavailable, create `.venv` with an available managed interpreter or platform launcher, then run the `.venv` interpreter directly; do not rely on shell activation. Stop after three different runtime attempts and report the conclusion instead of looping indefinitely.";

export const markdownRuntimeSystemPrompt =
  "Markdown harness policy: for Markdown-only tasks, prefer repository-local documentation checks. Inspect nearby docs and config first, use markdownlint/remark/prettier only when already present or clearly available, and avoid introducing a documentation toolchain just to edit prose. Keep generated Markdown readable in plain text.";

export const localProviderCatalog: Array<{
  providerId: LocalProviderId;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  mtls?: EndpointMtlsConfig;
}> = [
  {
    providerId: "company-endpoint",
    providerName: "Umbratic Veil",
    baseUrl: defaultEndpointBaseUrl,
    apiKey: defaultEndpointApiKey,
    mtls: defaultEndpointMtlsConfig,
  },
];

export const taskStatesThatCanOpen = new Set<TaskState>(["running", "review_ready", "approving", "failed"]);
