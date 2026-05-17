import { env } from "node:process";

import type { LocalProviderId, ReasoningMode, TaskState } from "./types";

export const defaultEndpointBaseUrl =
  env.AEGIS_MODEL_BASE_URL ||
  env.OPENAI_BASE_URL ||
  env.AEGIS_LMSTUDIO_BASE_URL ||
  env.LMSTUDIO_BASE_URL ||
  "http://127.0.0.1:1234/v1";
export const defaultEndpointApiKey =
  env.AEGIS_MODEL_API_KEY || env.OPENAI_API_KEY || env.LMSTUDIO_API_KEY || "local";
export const defaultEndpointModelId =
  env.AEGIS_MODEL_ID || env.OPENAI_MODEL || env.LMSTUDIO_MODEL || "google/gemma-4-e2b";

export const workspaceToolchainSystemPrompt = [
  "Aegis workspace tool policy: use fast local tools when available. Prefer `rg` for text search, `fd`/`fdfind` for path discovery, `tree-sitter` for syntax-aware structure when a grammar is available, `bat`/`batcat` for readable previews, `jq` for JSON, and `yq` for YAML. These are capability accelerators, not universal prerequisites. If a tool is missing, use the next available fallback and mention the exact command only when the missing capability prevents the requested verification.",
  "Install hints: Windows uses `winget`; macOS uses `xcode-select --install` plus Homebrew; Ubuntu/Debian uses `apt-get` with fd as `fdfind` and bat as `batcat`; Fedora uses `dnf`; Arch uses `pacman`.",
].join(" ");

export const cCmakeRuntimeSystemPrompt = [
  "C/CMake harness policy: C and CMake are an important workflow in Aegis, but CMake, compilers, build backends, sanitizers, and debuggers are optional host capabilities. Detect what exists in the workspace and on the current platform before choosing commands.",
  "Prefer the project's own build path first: inspect `README`, `CMakePresets.json`, `CMakeUserPresets.json`, `CMakeLists.txt`, `Makefile`, build scripts, `compile_commands.json`, source files, and tests before choosing commands. Use CMake when the project supports it and `cmake` exists; otherwise use the repo's documented scripts, direct compiler invocations, make/ninja/msbuild when available, or static/source inspection when no local build tool is present.",
  "When CMake is usable, configure out of tree under `.aegis/build` and request `CMAKE_EXPORT_COMPILE_COMMANDS=ON` unless an existing preset already defines a build dir. Prefer `cmake --preset <name>` when presets exist; otherwise use `cmake -S . -B .aegis/build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON` with `-G Ninja` only when `ninja` exists. Build with `cmake --build .aegis/build --parallel` or `cmake --build --preset <name>`, then run tests with `ctest --test-dir .aegis/build --output-on-failure` or the matching test preset.",
  "Platform selection: on Windows, detect Developer PowerShell/MSVC (`cl`), clang/LLVM, MinGW, Ninja, MSBuild, and CMake independently; never assume a POSIX shell. On macOS, use Xcode Command Line Tools clang/lldb when present and Homebrew tools when available. On Linux, use available gcc/clang plus make/ninja/cmake as detected.",
  "If a preferred dependency is missing, fall back to another available verification route. Only stop and give install commands when no available fallback can answer the user's request. Windows examples: `winget install Kitware.CMake Ninja-build.Ninja LLVM.LLVM Microsoft.VisualStudio.2022.BuildTools`; macOS examples: `xcode-select --install` and `brew install cmake ninja llvm`; Ubuntu/Debian examples: `sudo apt-get install -y build-essential cmake ninja-build gdb lldb clang`; Fedora examples: `sudo dnf install cmake ninja-build gcc clang gdb lldb`; Arch examples: `sudo pacman -S base-devel cmake ninja clang gdb lldb`.",
  "When compilation is possible and fails, read the first real compiler diagnostic, inspect the referenced source/header, make the smallest source or build-file fix, and rebuild. Keep iterating until it compiles and tests run, or until no local fallback remains. For syntax errors, use compiler output when available, otherwise use source inspection and tree-sitter when available to locate mismatched braces, declarations, includes, prototypes, and preprocessor problems.",
  "For security-oriented C tasks, prefer debug info and sanitizer builds when the project and installed compiler support them. Use debugger inspection only when a supported debugger is installed and a workspace executable is available; otherwise use source review, compiler diagnostics, sanitizers, tests, or explain the missing optional capability.",
].join(" ");

export const pythonRuntimeSystemPrompt =
  "Mandatory Python runtime policy: for every Python task, create or use a workspace `.venv` and run through `uv` whenever uv is available. Never verify by running bare `python`, `python3`, or `py`; those commands are not acceptable verification commands in Aegis. Use up to three concrete runtime attempts before giving up, and summarize each failed attempt with the exact command and error. Attempt 1: run `uv --version`; if uv exists, run `uv python install 3.12` if Python is missing, then `uv venv .venv --python 3.12`, then verify with `uv run python <script.py>` or the direct `.venv` interpreter. Attempt 2: if dependencies are needed, install them into the uv environment with `uv add`, `uv pip install`, or `uv run --with <package> ...`, then rerun verification through uv or `.venv`. Attempt 3: if uv is unavailable, create `.venv` with an available managed interpreter or platform launcher, then run the `.venv` interpreter directly; do not rely on shell activation. Stop after three different runtime attempts and report the conclusion instead of looping indefinitely.";

export const markdownRuntimeSystemPrompt =
  "Markdown harness policy: for Markdown-only tasks, prefer repository-local documentation checks. Inspect nearby docs and config first, use markdownlint/remark/prettier only when already present or clearly available, and avoid introducing a documentation toolchain just to edit prose. Keep generated Markdown readable in plain text.";

export const debuggerRuntimeSystemPrompt = [
  "Debugger policy: Aegis exposes a lightweight `debugger` tool for workspace-built C/C++ executables. Use it when the user asks for security audit, pointer/memory analysis, crash diagnosis, segfaults, invalid frees, stack/register inspection, or debugger-specific analysis.",
  "The debugger tool is intentionally non-interactive and only runs executables inside the workspace. It should collect backtraces, locals, registers, and stack memory through gdb, lldb, or cdb. If no supported debugger is installed, report the missing debugger and platform install commands instead of inventing results.",
].join(" ");

export const runtimeHarnessSystemPrompt = [
  workspaceToolchainSystemPrompt,
  cCmakeRuntimeSystemPrompt,
  pythonRuntimeSystemPrompt,
  markdownRuntimeSystemPrompt,
  debuggerRuntimeSystemPrompt,
].join(" ");

export function reasoningSystemPrompt(mode: ReasoningMode): string {
  return mode === "reasoning"
    ? "Aegis is using a reasoning-capable endpoint model for this task. Use deliberate reasoning for ambiguous or multi-step work. If the model/provider exposes reasoning parts or reasoning_content, Aegis may display that stream live. Keep visible reasoning concise and incremental: do not restate the same branch list, command plan, or failure explanation after each tool result. When a command fails for the same structural reason twice, stop retrying that exact approach and either choose a materially different command or explain the blocker."
    : "The user disabled Think mode. Do not emit hidden reasoning, chain-of-thought, thinking-process text, or reasoning_content. Give direct answers and concise progress only.";
}

export const localProviderCatalog: Array<{
  providerId: LocalProviderId;
  providerName: string;
  baseUrl: string;
  apiKey: string;
}> = [
  {
    providerId: "local-endpoint",
    providerName: "OpenAI-compatible endpoint",
    baseUrl: defaultEndpointBaseUrl,
    apiKey: defaultEndpointApiKey,
  },
];

export const defaultDisabledProviders = [
  "openai",
  "anthropic",
  "google",
  "gemini",
  "openrouter",
  "xai",
  "azure",
  "amazon-bedrock",
  "groq",
  "mistral",
  "cohere",
  "together",
  "perplexity",
];

export const taskStatesThatCanOpen = new Set<TaskState>(["running", "review_ready", "approving", "failed"]);

