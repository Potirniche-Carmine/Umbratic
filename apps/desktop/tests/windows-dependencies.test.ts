import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { isWindowsOsDependency, parseWindowsDependents } from "../scripts/windows-dependencies.ts";

test("Windows import inspection includes normal and delay-loaded dependencies without accepting paths", () => {
  assert.deepEqual(parseWindowsDependents(`Dump of file C:\\build\\library.dll
  Image has the following dependencies:
        KERNEL32.dll
        VCRUNTIME140.dll
  Image has the following delay load dependencies:
        MSVCP140.dll
        kernel32.dll
  Summary
        1000 .text`), ["kernel32.dll", "vcruntime140.dll", "msvcp140.dll"]);
  for (const name of ["..\\evil.dll", "C:\\evil.dll", "../evil.dll", "name..dll"]) {
    assert.throws(() => parseWindowsDependents(`        ${name}`), /Unsafe Windows dependency/);
  }
});

test("Windows OS contracts never excuse toolchain or arbitrary host-installed runtime DLLs", () => {
  for (const name of ["KERNEL32.dll", "WS2_32.dll", "cryptui.dll", "pdh.dll", "tbs.dll", "uiautomationcore.dll", "wevtapi.dll", "winusb.dll",
    "ucrtbase.dll", "api-ms-win-crt-runtime-l1-1-0.dll", "ext-ms-win-ntuser-window-l1-1-0.dll"]) {
    assert.equal(isWindowsOsDependency(name), true);
  }
  for (const name of ["vcruntime140.dll", "msvcp140.dll", "vcomp140.dll", "libomp.dll", "vulkan-1.dll", "host-installed.dll", "../kernel32.dll"]) {
    assert.equal(isWindowsOsDependency(name), false);
  }
});

test("packaging verifies import closure and preserves only recorded original Microsoft redistributable signatures", () => {
  const prepare = fs.readFileSync(new URL("../scripts/prepare-package.ts", import.meta.url), "utf8");
  const verify = fs.readFileSync(new URL("../scripts/verify-package.ts", import.meta.url), "utf8");
  const signer = fs.readFileSync(new URL("../../../scripts/ci/sign-windows.ps1", import.meta.url), "utf8");
  const config = fs.readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
  assert.match(prepare, /prepareWindowsDependencies\(desktopRoot\)/);
  assert.match(verify, /verifyWindowsDependencies\(path.resolve\(resources, "\.\."\)\)/);
  assert.match(config, /win:\r?\n\s+extraFiles:\r?\n\s+- from: \.package\/windows-runtime/);
  for (const guard of ["provenance.json", "Get-FileHash", "sha256", "Thumbprint", "Unverified Microsoft redistributable"]) {
    assert.ok(signer.includes(guard));
  }
});

test("all redistributable trust paths accept only the two observed Microsoft identities and organization", () => {
  for (const file of ["inspect-msvc-redist.ps1", "sign-windows.ps1", "verify-windows-signatures.ps1"]) {
    const source = fs.readFileSync(new URL(`../../../scripts/ci/${file}`, import.meta.url), "utf8");
    const policies = [...source.matchAll(/Subject -notmatch '([^']+)'/g)].map((match) => new RegExp(match[1], "i"));
    assert.equal(policies.length, 2, file);
    const accepted = (subject: string) => policies.every((policy) => policy.test(subject));
    for (const commonName of ["Microsoft Corporation", "Microsoft Windows Software Compatibility Publisher"]) {
      assert.equal(accepted(`CN=${commonName}, O=Microsoft Corporation, C=US`), true, file);
      assert.equal(accepted(`CN=${commonName}, O=Other Corporation, C=US`), false, file);
    }
    for (const commonName of ["Other Publisher", "Microsoft Corporation Impostor", "Microsoft Windows Software Compatibility Publisher Impostor"]) {
      assert.equal(accepted(`CN=${commonName}, O=Microsoft Corporation, C=US`), false, file);
    }
    assert.equal(accepted("CN=Microsoft Corporation, O=Microsoft Corporation Impostor, C=US"), false, file);
    assert.match(source, /\$signature\.Status -ne 'Valid'/);
  }
});
