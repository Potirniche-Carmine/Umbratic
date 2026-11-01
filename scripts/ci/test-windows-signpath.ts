// Credential-free qualification of the actual three-stage builder protocol.
// This never calls SignPath. Its certificate is trusted only on this disposable
// runner and all fixture packages are removed before normal CI artifact upload.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { repository, stages } from "./windows-signing.ts";

if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
  throw new Error("The fixture signing test requires a disposable GitHub-hosted Windows runner.");
}
const root = path.join(process.env.RUNNER_TEMP!, "umbratic-signpath-fixture");
const desktop = path.join(repository, "target/release/desktop");
const upload = path.join(repository, "target/release/upload");
process.env.UMBRATIC_SIGNPATH_STAGING = path.join(root, "handoff");
function run(script: string, args: string[] = [], timeout = 65 * 60_000): void {
  execFileSync(process.execPath, [path.join(repository, "scripts/ci", script), ...args], { cwd: repository, stdio: "inherit", timeout });
}
function certificate(operation: string): void {
  execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(repository, "scripts/ci/windows-signing-fixture.ps1"),
    "-Operation", operation, "-Directory", root], { stdio: "inherit", timeout: 120_000 });
}
function cleanup(): void {
  if (!fs.existsSync(root)) return;
  try { run("windows-signpath-build.ts", ["stop"], 60_000); }
  finally {
    if (fs.existsSync(path.join(root, "identity.json"))) certificate("cleanup");
    if (fs.existsSync(path.join(root, "unsigned-desktop"))) {
      fs.rmSync(desktop, { recursive: true, force: true });
      fs.renameSync(path.join(root, "unsigned-desktop"), desktop);
      fs.rmSync(upload, { recursive: true, force: true });
      if (fs.existsSync(path.join(root, "unsigned-upload"))) fs.renameSync(path.join(root, "unsigned-upload"), upload);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
if (process.argv[2] === "cleanup") {
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
    if (identity.status !== "Valid" || !["Microsoft Corporation", "Microsoft Windows Software Compatibility Publisher"].includes(identity.publisher ?? "")
        || !identity.subject?.match(/(?:^|,\s*)O=Microsoft Corporation(?:,|$)/)) throw new Error("Fixture SignTool is not a valid Microsoft utility.");
    certificate("create");
    const fixture = JSON.parse(fs.readFileSync(path.join(root, "identity.json"), "utf8"));
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
        execFileSync(tool, ["sign", "/sha1", fixture.thumbprint, "/s", "My", "/fd", "SHA256", "/tr", "http://timestamp.digicert.com", "/td", "SHA256", file], {
          stdio: "inherit", timeout: 120_000,
        });
      }
      run("windows-signpath-build.ts", ["resume", stage]);
    }
    run("windows-signpath-build.ts", ["finish"]);
    run("verify-release.ts");
    run("verify-installer-artifacts.ts");
    for (const stage of stages) if (!fs.existsSync(path.join(root, "handoff", stage, "result.json"))) throw new Error(`Missing ${stage} transition.`);
    console.log("Qualified all three real Windows signing handoffs, strict signatures, native resources and final updater checksums with an ephemeral fixture certificate.");
  } finally { cleanup(); }
}
