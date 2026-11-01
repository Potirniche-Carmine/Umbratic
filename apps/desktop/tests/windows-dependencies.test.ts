import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { isWindowsOsDependency, parseWindowsDependents } from "../scripts/windows-dependencies.ts";
import { upstreamIdentity } from "../../../scripts/ci/windows-signing.ts";

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
  const signer = fs.readFileSync(new URL("../../../scripts/ci/windows-signing.ts", import.meta.url), "utf8");
  const config = fs.readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
  assert.match(prepare, /prepareWindowsDependencies\(desktopRoot\)/);
  assert.match(verify, /verifyWindowsDependencies\(path.resolve\(resources, "\.\."\)\)/);
  assert.match(config, /win:\r?\n\s+extraFiles:\r?\n\s+- from: \.package\/windows-runtime/);
  for (const guard of ["provenance.json", "entry.sha256 === sha256(file)", "entry.thumbprint === identity.thumbprint", 'identity.status !== "Valid"', "Unrecorded Microsoft runtime binary"]) {
    assert.ok(signer.includes(guard));
  }
});

test("all redistributable trust paths accept only the two observed Microsoft identities and organization", () => {
  for (const file of ["inspect-msvc-redist.ps1"]) {
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
  const identity = { status: "Valid", publisher: "", subject: "", thumbprint: "ABCD", timestamp: true, sha256Signature: true,
    signatureType: "Authenticode", osBinary: false, productName: "", productVersion: "" };
  for (const publisher of ["Microsoft Corporation", "Microsoft Windows Software Compatibility Publisher"]) {
    assert.doesNotThrow(() => upstreamIdentity({ ...identity, publisher, subject: `CN=${publisher}, O=Microsoft Corporation, C=US` }, "Microsoft runtime", "vcruntime140.dll"));
    for (const subject of [`CN=${publisher}, O=Other Corporation, C=US`, `CN=${publisher}, O=Microsoft Corporation Impostor, C=US`]) {
      assert.throws(() => upstreamIdentity({ ...identity, publisher, subject }, "Microsoft runtime", "vcruntime140.dll"), /Unapproved upstream/);
    }
  }
  for (const publisher of ["Other Publisher", "Microsoft Corporation Impostor", "Microsoft Windows Software Compatibility Publisher Impostor"]) {
    assert.throws(() => upstreamIdentity({ ...identity, publisher, subject: `CN=${publisher}, O=Microsoft Corporation, C=US` }, "Microsoft runtime", "vcruntime140.dll"), /Unapproved upstream/);
  }
  assert.throws(() => upstreamIdentity({ ...identity, status: "HashMismatch", publisher: "Microsoft Corporation", subject: "CN=Microsoft Corporation, O=Microsoft Corporation" }, "Microsoft runtime", "vcruntime140.dll"), /"file":"vcruntime140.dll","status":"HashMismatch"/);
});

test("Electron Kits Publisher trust is restricted to its two original signed DLLs and exact leaf", () => {
  const identity = { status: "Valid", publisher: "Microsoft Windows Kits Publisher", subject: "CN=Microsoft Windows Kits Publisher, O=Microsoft Corporation, C=US",
    thumbprint: "F5359B80D22CA41C7469C884188557307FE06390", timestamp: true, sha256Signature: true,
    signatureType: "Authenticode", osBinary: false, productName: "", productVersion: "" };
  for (const file of ["d3dcompiler_47.dll", "dxil.dll"]) {
    assert.doesNotThrow(() => upstreamIdentity(identity, "Electron", file));
    for (const changed of [{ status: "NotSigned" }, { status: "HashMismatch" }, { status: "NotTrusted" }, { thumbprint: "OTHER" },
      { publisher: "Microsoft Windows Kits Publisher Impostor" }, { subject: "CN=Microsoft Windows Kits Publisher, O=Other Corporation, C=US" }]) {
      assert.throws(() => upstreamIdentity({ ...identity, ...changed }, "Electron", file), /Unapproved upstream/);
    }
    for (const component of ["Microsoft runtime", "llama.cpp"]) assert.throws(() => upstreamIdentity(identity, component, file), /Unapproved upstream/);
  }
  for (const file of ["ffmpeg.dll", "resources/dxil.dll", "../dxil.dll"]) assert.throws(() => upstreamIdentity(identity, "Electron", file), /Unapproved upstream/);
  assert.doesNotThrow(() => upstreamIdentity({ ...identity, status: "NotSigned" }, "Electron", "ffmpeg.dll"));
});
