---
name: C/CMake
description: Use for C, C++, CMake, compiler diagnostics, native build setup, sanitizers, and C/C++ test verification.
---

# C/CMake

Use this skill when the task involves C, C++, CMake, native compiler errors, build systems, sanitizers, crashes, memory bugs, or files such as `CMakeLists.txt`, `CMakePresets.json`, `.c`, `.h`, `.cc`, `.cpp`, `.cxx`, or `.hpp`.

## Runtime Contract

- Treat CMake, compilers, build backends, and sanitizers as optional host capabilities. Detect what exists before choosing commands.
- Inspect the repository's own build path first: README files, `CMakePresets.json`, `CMakeUserPresets.json`, `CMakeLists.txt`, `Makefile`, build scripts, `compile_commands.json`, source files, headers, and tests.
- Use CMake when the project supports it and `cmake` is available. Prefer presets when they exist.
- When configuring manually, use an out-of-tree build under `.umbratic/build` and request `CMAKE_EXPORT_COMPILE_COMMANDS=ON`.
- Use `cmake --build .umbratic/build --parallel` or the matching preset, then run `ctest` when available.
- If CMake is not usable, use documented scripts, `make`, `ninja`, direct compiler checks, static/source inspection, or other project-native fallbacks.

## Platform Notes

- On Windows, detect Developer PowerShell/MSVC (`cl`), clang/LLVM, MinGW, Ninja, MSBuild, and CMake independently. Do not assume a POSIX shell.
- On macOS, use Xcode Command Line Tools clang when present and Homebrew tools when available.
- On Linux, use available gcc/clang plus make, ninja, or CMake as detected.
- Only give install commands when no available fallback can answer the user's request.

## Debugging Workflow

1. Start from the first real compiler, linker, sanitizer, or test diagnostic.
2. Inspect the referenced source, header, or build file before editing.
3. Make the smallest source or build-system fix that addresses the diagnostic.
4. Rebuild or rerun the relevant test. Iterate only while each attempt gives new evidence.
5. For syntax problems without compiler access, use source inspection and syntax-aware tools when available to locate mismatched braces, declarations, includes, prototypes, and preprocessor issues.

For security-oriented C tasks, prefer debug info and sanitizer builds when the project and installed compiler support them. If they are unavailable, use source review, compiler diagnostics, tests, or state the missing capability.
