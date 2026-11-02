// Credential-free qualification of the actual three-stage builder protocol.
// This never calls SignPath. Its certificate is trusted only on this disposable
// runner and all fixture packages are removed before normal CI artifact upload.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { repository, requireProjectIdentity, sha256, stages, stampProjectMetadata, unsignedPeDigest } from "./windows-signing.ts";
import { cleanupWindowsFixture } from "./windows-fixture-cleanup.ts";
import { withWindowsArchiveTool } from "./windows-archive-tool.ts";
import { verifyNsisUninstaller } from "./nsis-archive.ts";

if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
  throw new Error("The fixture signing test requires a disposable GitHub-hosted Windows runner.");
}
const root = path.join(process.env.RUNNER_TEMP!, "umbratic-signpath-fixture");
const desktop = path.join(repository, "target/release/desktop");
const upload = path.join(repository, "target/release/upload");
const mode = process.argv[2];
if (mode !== undefined && !["cleanup", "preflight"].includes(mode)) throw new Error("Unknown Windows fixture operation.");
process.env.UMBRATIC_SIGNPATH_STAGING = path.join(root, "handoff");
function run(script: string, args: string[] = [], timeout = 65 * 60_000): void {
  execFileSync(process.execPath, [path.join(repository, "scripts/ci", script), ...args], { cwd: repository, stdio: "inherit", timeout });
}
function certificate(operation: string): void {
  execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(repository, "scripts/ci/windows-signing-fixture.ps1"),
    "-Operation", operation, "-Directory", root], { stdio: "inherit", timeout: 120_000 });
}
function cleanup(): void {
  cleanupWindowsFixture(root, desktop, upload, () => run("windows-signpath-build.ts", ["stop"], 60_000), () => certificate("cleanup"));
}
if (mode === "cleanup") {
  cleanup();
} else {
  if (fs.existsSync(root)) throw new Error("Stale fixture signing state; cleanup must succeed before retrying.");
  fs.mkdirSync(root, { recursive: true });
  const publisher = `Umbratic CI signing fixture ${crypto.randomUUID().replaceAll("-", "")}`;
  fs.writeFileSync(path.join(root, "identity.json"), JSON.stringify({ publisher }));
  try {
    // Exercise the same cancellation cleanup on a real parent/child process
    // tree before creating any certificate or starting the actual build.
    const handoff = process.env.UMBRATIC_SIGNPATH_STAGING!;
    fs.mkdirSync(handoff);
    const pids = path.join(handoff, "tree.json");
    const fixtureCode = 'const fs=require("node:fs");const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});fs.writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000)';
    const tree = spawn(process.execPath, ["-e", fixtureCode, pids], { stdio: "ignore", windowsHide: true });
    if (!tree.pid) throw new Error("Unable to launch the cleanup fixture.");
    fs.writeFileSync(path.join(handoff, "pid"), String(tree.pid));
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(pids)) {
      if (Date.now() > deadline) throw new Error("The process-tree fixture did not start.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const processes = JSON.parse(fs.readFileSync(pids, "utf8"));
    run("windows-signpath-build.ts", ["stop"], 60_000);
    for (const pid of processes) {
      let exists = true;
      for (let attempt = 0; attempt < 50; attempt++) {
        try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") { exists = false; break; } throw error; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (exists) throw new Error("A cancelled signing process survived cleanup.");
    }
    console.log("Verified cancellation removes the signing worker and its child process.");
    // This SDK tool is already in the locked electron-builder toolset graph:
    // v1.1.0 windows-kits-bundle-10_0_26100_0.zip SHA256
    // 284f18a2fde66e6ecfbefc3065926c9bfdf641761a9e6cd2bd26e18d1e328bf7.
    // No Trusted Signing client, .NET runtime or PowerShell package is used.
    if (["SIGNTOOL_PATH", "ELECTRON_BUILDER_WINDOWS_KITS_PATH", "USE_SYSTEM_SIGNCODE"].some((key) => process.env[key])) {
      throw new Error("Fixture signing must use the reviewed SDK archive, without local tool overrides.");
    }
    const { getSignToolPath, wincodesignChecksums } = createRequire(import.meta.url)("app-builder-lib/out/toolsets/windows");
    if (wincodesignChecksums["1.1.0"]["windows-kits-bundle-10_0_26100_0.zip"] !== "284f18a2fde66e6ecfbefc3065926c9bfdf641761a9e6cd2bd26e18d1e328bf7") {
      throw new Error("The reviewed fixture SignTool archive pin changed.");
    }
    const tool = (await getSignToolPath("1.1.0", true)).path;
    // The checksum pin authenticates the archive; also check Windows' trust
    // evaluation before executing its Microsoft-signed native utility.
    const { inspect } = await import("./windows-signing.ts");
    const identity = inspect([tool])[0];
    // Exact public leaf/executable tuples inspected in the reviewed SDK ZIP.
    // The ARM SDK uses a different Microsoft publisher from its x64 utility;
    // this exception belongs to this build-only tool, never runtime DLLs.
    const expected = {
      x64: { publisher: "Microsoft Corporation", thumbprint: "6ACE61BAE3F09F4DD2697806D73E022CBFE70EB4",
        sha256: "f72bda523e9a03f502386f8407e21fc06e9d21baccc9e14c17b0e22a19fbed38" },
      arm64: { publisher: "Microsoft Windows Kits Publisher", thumbprint: "5D61AA32E63982A575DB3307EE51024AFFFBD6F2",
        sha256: "904b5f913b7b3681cfea7a38fbbf73431e033c659f865a13d959e287438135a7" },
    }[process.arch];
    if (!expected || identity.status !== "Valid" || identity.publisher !== expected.publisher
        || identity.thumbprint !== expected.thumbprint || sha256(tool) !== expected.sha256
        || !identity.subject?.match(/(?:^|,\s*)O=Microsoft Corporation(?:,|$)/)) {
      throw new Error("Fixture SignTool is not a valid Microsoft utility: " + JSON.stringify({
        status: identity.status, publisher: identity.publisher, subject: identity.subject, thumbprint: identity.thumbprint,
      }).slice(0, 2000));
    }
    certificate("create");
    const fixture = JSON.parse(fs.readFileSync(path.join(root, "identity.json"), "utf8"));
    function sign(file: string): void {
      execFileSync(tool, ["sign", "/sha1", fixture.thumbprint, "/s", "My", "/fd", "SHA256", "/tr", "http://timestamp.digicert.com", "/td", "SHA256", file], {
        stdio: "inherit", timeout: 120_000,
      });
    }
    // Prove the key, root-only Authenticode trust and timestamp service before
    // compiling the real payload. This resource-only PE is never executed.
    const { NtExecutable } = createRequire(import.meta.url)("resedit");
    const executable = NtExecutable.createEmpty(false, false);
    executable.newHeader.fileHeader.machine = process.arch === "arm64" ? 0xaa64 : 0x8664;
    const probe = path.join(root, "trust-probe.exe");
    fs.writeFileSync(probe, Buffer.from(executable.generate()));
    const version = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8")).version;
    stampProjectMetadata(probe, version);
    const digest = unsignedPeDigest(fs.readFileSync(probe));
    sign(probe);
    requireProjectIdentity(inspect([probe])[0], publisher, version);
    if (unsignedPeDigest(fs.readFileSync(probe)) !== digest) throw new Error("Fixture signing changed PE contents.");
    console.log("Verified root-only trust, exact project identity, SHA256 signature, timestamp and unchanged PE contents.");
    // Exercise a real generated NSIS uninstaller and signed outer container
    // before the large build. Never execute the outer installer.
    if (process.env.ELECTRON_BUILDER_NSIS_DIR || /[$"\r\n]/.test(root) || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid reviewed NSIS fixture environment.");
    const nsis = await createRequire(import.meta.url)("app-builder-lib/out/toolsets/windows").getMakeNsisPath();
    const generator = path.join(root, "uninstaller-generator.exe");
    const uninstaller = path.join(root, "preflight-uninstaller.exe");
    const installer = path.join(root, "preflight-installer.exe");
    const appArchive = path.join(root, "app.7z");
    function compile(template: string, output: string): void {
      execFileSync(nsis.path, ["-V2", `-DOUT_FILE=${output}`, `-DUNINSTALLER_FILE=${uninstaller}`, `-DAPP_ARCHIVE=${appArchive}`,
        `-DRELEASE=${version}`, path.join(repository, "scripts/ci/fixtures", template)], {
        env: { ...process.env, ...nsis.env }, timeout: 30_000, stdio: "inherit", windowsHide: true,
      });
    }
    compile("nsis-uninstaller.nsi", generator);
    const { UninstallerReader } = createRequire(import.meta.url)("app-builder-lib/out/targets/nsis/nsisUtil");
    await UninstallerReader.exec(generator, uninstaller);
    sign(uninstaller);
    requireProjectIdentity(inspect([uninstaller])[0], publisher, version);
    await withWindowsArchiveTool((archiveTool) => {
      execFileSync(archiveTool, ["a", "-t7z", appArchive, probe], { timeout: 30_000, stdio: "inherit" });
      compile("nsis-installer.nsi", installer);
      sign(installer);
      requireProjectIdentity(inspect([installer])[0], publisher, version);
      execFileSync(archiveTool, ["t", "-tNsis", installer], { timeout: 30_000, stdio: "inherit" });
      verifyNsisUninstaller(archiveTool, installer, sha256(uninstaller));
    });
    console.log("Verified explicit outer NSIS integrity and exact embedded signed-uninstaller bytes with the native full-format tool.");
    if (mode === "preflight") {
      console.log("Preflight verified the pinned SDK utility, process-tree cancellation and ephemeral certificate/trust-store support.");
    } else {
      process.env.SIGNPATH_ORGANIZATION_ID = "00000000-0000-0000-0000-000000000000";
      process.env.SIGNPATH_PROJECT_SLUG = "ci-fixture";
      process.env.SIGNPATH_SIGNING_POLICY_SLUG = "ci-fixture";
      process.env.SIGNPATH_PUBLISHER = publisher;
      fs.renameSync(desktop, path.join(root, "unsigned-desktop"));
      if (fs.existsSync(upload)) fs.renameSync(upload, path.join(root, "unsigned-upload"));
      run("windows-signpath-build.ts", ["start"]);
      for (const stage of stages) {
        run("windows-signpath-build.ts", ["wait", stage]);
        const directory = path.join(root, "handoff", stage);
        const input = path.join(directory, "input");
        const output = path.join(directory, "signed");
        fs.mkdirSync(output);
        const files = fs.readdirSync(input);
        if (files.length !== (stage === "payload" ? 7 : 1)) throw new Error("Unexpected fixture signing batch.");
        for (const name of files) {
          const file = path.join(output, name);
          fs.copyFileSync(path.join(input, name), file);
          sign(file);
        }
        run("windows-signpath-build.ts", ["resume", stage]);
      }
      run("windows-signpath-build.ts", ["finish"]);
      run("verify-release.ts");
      run("verify-installer-artifacts.ts");
      for (const stage of stages) if (!fs.existsSync(path.join(root, "handoff", stage, "result.json"))) throw new Error(`Missing ${stage} transition.`);
      console.log("Qualified all three real Windows signing handoffs, strict signatures, native resources and final updater checksums with an ephemeral fixture certificate.");
    }
  } finally { cleanup(); }
}
