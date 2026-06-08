import { env } from "node:process";

import type { HarnessProfileId, LocalProviderId, ModelEndpointMode, ModelEndpointSoftware, ReasoningMode, TaskState } from "./types";

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
  env.UMBRATIC_MANAGED_MODEL_BASE_URL ||
  env.UMBRATIC_MODEL_BASE_URL ||
  env.OLLAMA_BASE_URL ||
  env.UMBRATIC_LMSTUDIO_BASE_URL ||
  env.LMSTUDIO_BASE_URL ||
  env.UMBRATIC_VLLM_BASE_URL ||
  env.VLLM_BASE_URL ||
  "";

export const defaultEndpointBaseUrl =
  configuredEndpointBaseUrl ||
  "http://127.0.0.1:11434";
export const defaultEndpointApiKey =
  env.UMBRATIC_MODEL_API_KEY || env.OLLAMA_API_KEY || env.LMSTUDIO_API_KEY || env.VLLM_API_KEY || "";
export const defaultEndpointModelId =
  env.UMBRATIC_MANAGED_MODEL_ID || env.UMBRATIC_MODEL_ID || env.OLLAMA_MODEL || env.LMSTUDIO_MODEL || env.VLLM_MODEL || "";

export function isModelEndpointMode(value: unknown): value is ModelEndpointMode {
  return value === "local" || value === "server";
}

export function isModelEndpointSoftware(value: unknown): value is ModelEndpointSoftware {
  return value === "ollama" || value === "lmstudio" || value === "vllm";
}

export function defaultEndpointSoftware(mode: ModelEndpointMode, baseUrl = defaultEndpointBaseUrl): ModelEndpointSoftware {
  const normalized = baseUrl.toLowerCase();
  if (env.UMBRATIC_MANAGED_MODEL_SOFTWARE && isModelEndpointSoftware(env.UMBRATIC_MANAGED_MODEL_SOFTWARE)) {
    return env.UMBRATIC_MANAGED_MODEL_SOFTWARE;
  }
  if (env.UMBRATIC_MODEL_SOFTWARE && isModelEndpointSoftware(env.UMBRATIC_MODEL_SOFTWARE)) {
    return env.UMBRATIC_MODEL_SOFTWARE;
  }
  if (env.LMSTUDIO_BASE_URL || normalized.includes("lmstudio")) return "lmstudio";
  if (env.OLLAMA_BASE_URL || normalized.includes("11434") || normalized.includes("ollama")) return "ollama";
  if (env.UMBRATIC_VLLM_BASE_URL || env.VLLM_BASE_URL || normalized.includes("vllm") || normalized.includes("8000")) return "vllm";
  return mode === "local" ? "ollama" : "vllm";
}

export function managedModelEndpointDefaults():
  | {
      mode?: ModelEndpointMode;
      software?: ModelEndpointSoftware;
      baseUrl?: string;
      modelId?: string;
      secret?: string;
    }
  | undefined {
  const mode = isModelEndpointMode(env.UMBRATIC_MANAGED_ENDPOINT_MODE) ? env.UMBRATIC_MANAGED_ENDPOINT_MODE : undefined;
  const software = isModelEndpointSoftware(env.UMBRATIC_MANAGED_MODEL_SOFTWARE) ? env.UMBRATIC_MANAGED_MODEL_SOFTWARE : undefined;
  const baseUrl = env.UMBRATIC_MANAGED_MODEL_BASE_URL?.trim();
  const modelId = env.UMBRATIC_MANAGED_MODEL_ID?.trim();
  const secret = env.UMBRATIC_MANAGED_MODEL_API_KEY ?? undefined;
  const managed = {
    mode,
    software,
    baseUrl: baseUrl || undefined,
    modelId: modelId || undefined,
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
  if (mode === "local") {
    if (software === "lmstudio") return "http://127.0.0.1:1234/v1";
    if (software === "vllm") return "http://127.0.0.1:8000/v1";
    return "http://127.0.0.1:11434";
  }
  if (configuredEndpointBaseUrl) return configuredEndpointBaseUrl;
  if (software === "ollama") return "https://your-ollama-server.example";
  if (software === "lmstudio") return "https://your-lm-studio-endpoint.example/v1";
  return "https://your-vllm-endpoint.example/v1";
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

export const workspaceToolchainSystemPrompt = [
  "Umbratic AI workspace tool policy: use fast local tools when available. Prefer `rg` for text search, `fd`/`fdfind` for path discovery, `tree-sitter` for syntax-aware structure when a grammar is available, `bat`/`batcat` for readable previews, `jq` for JSON, and `yq` for YAML. These are capability accelerators, not universal prerequisites. If a tool is missing, use the next available fallback and mention the exact command only when the missing capability prevents the requested verification.",
  "Install hints: Windows uses `winget`; macOS uses `xcode-select --install` plus Homebrew; Ubuntu/Debian uses `apt-get` with fd as `fdfind` and bat as `batcat`; Fedora uses `dnf`; Arch uses `pacman`.",
].join(" ");

export const cCmakeRuntimeSystemPrompt = [
  "C/CMake harness policy: C and CMake are an important workflow in Umbratic AI, but CMake, compilers, build backends, sanitizers, and debuggers are optional host capabilities. Detect what exists in the workspace and on the current platform before choosing commands.",
  "Prefer the project's own build path first: inspect `README`, `CMakePresets.json`, `CMakeUserPresets.json`, `CMakeLists.txt`, `Makefile`, build scripts, `compile_commands.json`, source files, and tests before choosing commands. Use CMake when the project supports it and `cmake` exists; otherwise use the repo's documented scripts, direct compiler invocations, make/ninja/msbuild when available, or static/source inspection when no local build tool is present.",
  "When CMake is usable, configure out of tree under `.umbratic/build` and request `CMAKE_EXPORT_COMPILE_COMMANDS=ON` unless an existing preset already defines a build dir. Prefer `cmake --preset <name>` when presets exist; otherwise use `cmake -S . -B .umbratic/build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON` with `-G Ninja` only when `ninja` exists. Build with `cmake --build .umbratic/build --parallel` or `cmake --build --preset <name>`, then run tests with `ctest --test-dir .umbratic/build --output-on-failure` or the matching test preset.",
  "Platform selection: on Windows, detect Developer PowerShell/MSVC (`cl`), clang/LLVM, MinGW, Ninja, MSBuild, and CMake independently; never assume a POSIX shell. On macOS, use Xcode Command Line Tools clang/lldb when present and Homebrew tools when available. On Linux, use available gcc/clang plus make/ninja/cmake as detected.",
  "If a preferred dependency is missing, fall back to another available verification route. Only stop and give install commands when no available fallback can answer the user's request. Windows examples: `winget install Kitware.CMake Ninja-build.Ninja LLVM.LLVM Microsoft.VisualStudio.2022.BuildTools`; macOS examples: `xcode-select --install` and `brew install cmake ninja llvm`; Ubuntu/Debian examples: `sudo apt-get install -y build-essential cmake ninja-build gdb lldb clang`; Fedora examples: `sudo dnf install cmake ninja-build gcc clang gdb lldb`; Arch examples: `sudo pacman -S base-devel cmake ninja clang gdb lldb`.",
  "When compilation is possible and fails, read the first real compiler diagnostic, inspect the referenced source/header, make the smallest source or build-file fix, and rebuild. Keep iterating until it compiles and tests run, or until no local fallback remains. For syntax errors, use compiler output when available, otherwise use source inspection and tree-sitter when available to locate mismatched braces, declarations, includes, prototypes, and preprocessor problems.",
  "For security-oriented C tasks, prefer debug info and sanitizer builds when the project and installed compiler support them. Use debugger inspection only when a supported debugger is installed and a workspace executable is available; otherwise use source review, compiler diagnostics, sanitizers, tests, or explain the missing optional capability.",
].join(" ");

export const pythonRuntimeSystemPrompt =
  "Mandatory Python runtime policy: for every Python task, create or use a workspace `.venv` and run through `uv` whenever uv is available. Never verify by running bare `python`, `python3`, or `py`; those commands are not acceptable verification commands in Umbratic AI. Use up to three concrete runtime attempts before giving up, and summarize each failed attempt with the exact command and error. Attempt 1: run `uv --version`; if uv exists, run `uv python install 3.12` if Python is missing, then `uv venv .venv --python 3.12`, then verify with `uv run python <script.py>` or the direct `.venv` interpreter. Attempt 2: if dependencies are needed, install them into the uv environment with `uv add`, `uv pip install`, or `uv run --with <package> ...`, then rerun verification through uv or `.venv`. Attempt 3: if uv is unavailable, create `.venv` with an available managed interpreter or platform launcher, then run the `.venv` interpreter directly; do not rely on shell activation. Stop after three different runtime attempts and report the conclusion instead of looping indefinitely.";

export const markdownRuntimeSystemPrompt =
  "Markdown harness policy: for Markdown-only tasks, prefer repository-local documentation checks. Inspect nearby docs and config first, use markdownlint/remark/prettier only when already present or clearly available, and avoid introducing a documentation toolchain just to edit prose. Keep generated Markdown readable in plain text.";

export const debuggerRuntimeSystemPrompt = [
  "Debugger policy: Umbratic AI exposes a lightweight `debugger` tool for workspace-built C/C++ executables. Use it when the user asks for security audit, pointer/memory analysis, crash diagnosis, segfaults, invalid frees, stack/register inspection, or debugger-specific analysis.",
  "The debugger tool is intentionally non-interactive and only runs executables inside the workspace. It should collect backtraces, locals, registers, and stack memory through gdb, lldb, or cdb. If no supported debugger is installed, report the missing debugger and platform install commands instead of inventing results.",
].join(" ");

export const gitRuntimeSystemPrompt = [
  "Git harness policy: use Git confidently when the selected workspace is a Git repository. Prefer read-only inspection before changing anything: `git status --short --branch`, `git diff`, `git diff --staged`, `git log --oneline --decorate --graph -n 20`, `git show <rev>`, `git branch --show-current`, `git branch --list`, `git remote -v`, `git worktree list`, and `git blame -L <range> -- <file>`.",
  "For user requests about branch cleanup, staging, restoring, worktrees, or history, use the precise Git command when it is safe to act and the permission prompt will mediate writes. Common write commands include `git switch <branch>`, `git switch -c <branch>`, `git branch -d <branch>`, `git branch -D <branch>`, `git restore --staged <path>`, `git restore --source <commit> -- <path>`, `git checkout <commit> -- <path>`, `git worktree add <path> <branch>`, and `git worktree remove <path>`.",
  "Treat history rewriting and broad deletion as destructive. Before running commands like `git reset --hard`, `git clean -fd`, `git branch -D`, `git push --force`, `git rebase`, `git cherry-pick`, or `git revert`, explain the intended effect in plain language and rely on the permission flow. If the user only asks how, provide the command and what it does instead of executing it.",
].join(" ");

export const runtimeHarnessSystemPrompt = [
  workspaceToolchainSystemPrompt,
  gitRuntimeSystemPrompt,
  cCmakeRuntimeSystemPrompt,
  pythonRuntimeSystemPrompt,
  markdownRuntimeSystemPrompt,
  debuggerRuntimeSystemPrompt,
].join(" ");

export function harnessProfileSystemPrompt(profileId: HarnessProfileId): string {
  if (profileId === "marketing") {
    return [
      "Harness profile: Marketing.",
      "Favor clear campaign, positioning, launch, copy, content, audience, and brand-context work.",
      "Use repository tools only when they help inspect or change relevant assets, docs, site copy, analytics wiring, or content workflows.",
      "Keep technical detail practical and avoid pulling in unrelated engineering harness guidance unless the task asks for implementation.",
    ].join(" ");
  }
  if (profileId === "sales") {
    return [
      "Harness profile: Sales.",
      "Favor customer-facing context: account research notes, CRM-style workflows, enablement material, demos, proposals, objection handling, and pipeline support.",
      "Use repository tools only when they help inspect or change relevant docs, app surfaces, integrations, or sales operations assets.",
      "Keep responses action-oriented and avoid unnecessary implementation depth unless the task needs it.",
    ].join(" ");
  }
  return [
    "Harness profile: Engineering.",
    "Favor codebase inspection, implementation, verification, debugging, tests, and precise repository changes.",
    "Use available runner tools to understand the workspace before making claims, and keep product or go-to-market assumptions lightweight unless requested.",
  ].join(" ");
}

export function reasoningSystemPrompt(mode: ReasoningMode): string {
  return mode === "reasoning"
    ? "Umbratic AI is using a reasoning-capable endpoint model for this task. Use deliberate reasoning for ambiguous or multi-step work. If the model/provider exposes reasoning parts or reasoning_content, Umbratic AI may display that stream live. Keep visible reasoning concise and incremental: do not restate the same branch list, command plan, or failure explanation after each tool result. When a command fails for the same structural reason twice, stop retrying that exact approach and either choose a materially different command or explain the blocker."
    : "The user disabled Think mode. Do not emit hidden reasoning, chain-of-thought, thinking-process text, or reasoning_content. Give direct answers and concise progress only.";
}

export const localProviderCatalog: Array<{
  providerId: LocalProviderId;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  mtls?: EndpointMtlsConfig;
}> = [
  {
    providerId: "company-endpoint",
    providerName: "Company private endpoint",
    baseUrl: defaultEndpointBaseUrl,
    apiKey: defaultEndpointApiKey,
    mtls: defaultEndpointMtlsConfig,
  },
];

export const taskStatesThatCanOpen = new Set<TaskState>(["running", "review_ready", "approving", "failed"]);
