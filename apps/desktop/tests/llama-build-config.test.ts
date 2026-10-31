import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { llamaBuildJobs, llamaCpuBuildFlags, windowsArmClangCompilers } from "../scripts/llama-build-config.ts";
import { verifyPeArchitecture } from "../scripts/verify-pe.ts";

test("Windows ARM uses the supported portable Clang target and other release platforms retain CPU variants", () => {
  const arm = llamaCpuBuildFlags("win32", "arm64");
  for (const flag of ["-DGGML_NATIVE=OFF", "-DGGML_CPU_ALL_VARIANTS=OFF", "-DGGML_CPU_ARM_ARCH=armv8-a", "-DGGML_OPENMP=OFF",
    "-DCMAKE_C_COMPILER_TARGET=aarch64-pc-windows-msvc", "-DCMAKE_CXX_COMPILER_TARGET=aarch64-pc-windows-msvc"]) assert.ok(arm.includes(flag));
  for (const [platform, arch] of [["win32", "x64"], ["darwin", "arm64"]]) {
    assert.deepEqual(llamaCpuBuildFlags(platform, arch), ["-DGGML_NATIVE=OFF", "-DGGML_CPU_ALL_VARIANTS=ON"]);
  }
});

test("ARM compiler discovery uses Visual Studio LLVM instead of an arbitrary PATH compiler", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-clang-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const untrusted = path.join(root, "untrusted-bin");
  fs.mkdirSync(untrusted);
  fs.writeFileSync(path.join(untrusted, "clang.exe"), "untrusted");
  assert.throws(() => windowsArmClangCompilers(path.join(root, "VisualStudio")), /Visual Studio C\+\+ Clang/);
  const directory = path.join(root, "VisualStudio", "VC", "Tools", "Llvm", "ARM64", "bin");
  fs.mkdirSync(directory, { recursive: true });
  const c = path.join(directory, "clang.exe");
  const cxx = path.join(directory, "clang++.exe");
  fs.writeFileSync(c, "reviewed installation");
  fs.writeFileSync(cxx, "reviewed installation");
  assert.deepEqual(windowsArmClangCompilers(path.join(root, "VisualStudio")), { c, cxx });
});

test("packaged Windows payloads must contain a valid PE header for their actual architecture", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-pe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "payload.exe");
  for (const [arch, machine, other] of [["arm64", 0xaa64, "x64"], ["x64", 0x8664, "arm64"]]) {
    const bytes = Buffer.alloc(256);
    bytes.write("MZ");
    bytes.writeUInt32LE(128, 0x3c);
    bytes.writeUInt32LE(0x00004550, 128);
    bytes.writeUInt16LE(machine, 132);
    fs.writeFileSync(file, bytes);
    assert.doesNotThrow(() => verifyPeArchitecture(file, arch));
    assert.throws(() => verifyPeArchitecture(file, other), /architecture does not match/);
    bytes.writeUInt32LE(0xffffffff, 0x3c);
    fs.writeFileSync(file, bytes);
    assert.throws(() => verifyPeArchitecture(file, arch), /architecture does not match/);
  }
  fs.writeFileSync(file, "not an executable");
  assert.throws(() => verifyPeArchitecture(file, "arm64"), /Invalid Windows executable/);
});

test("C++ build parallelism has explicit CPU and four-GiB memory bounds", () => {
  const gib = 1024 ** 3;
  for (const [cpus, memory, expected] of [[3, 7, 1], [8, 16, 4], [2, 64, 2], [32, 64, 16], [8, 2, 1], [0, 0, 1]]) {
    assert.equal(llamaBuildJobs(cpus, memory * gib), expected);
  }
});
