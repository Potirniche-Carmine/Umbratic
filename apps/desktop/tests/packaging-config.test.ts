import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const configUrl = new URL("../electron-builder.yml", import.meta.url);
const preparePackageUrl = new URL("../scripts/prepare-package.ts", import.meta.url);
const installerIncludeUrl = new URL("../scripts/installer.nsh", import.meta.url);
const packageWorkflowUrl = new URL("../../../.github/workflows/package-desktop.yml", import.meta.url);
const verifyWorkflowUrl = new URL("../../../.github/workflows/verify.yml", import.meta.url);

test("desktop packages use the Umbratic product name without a version in Windows installed apps", () => {
  const config = fs.readFileSync(configUrl, "utf8");
  const nsis = config.slice(config.indexOf("\nnsis:"));

  assert.match(config, /^productName: Umbratic$/m);
  assert.match(config, /^mac:\r?$/m);
  assert.match(nsis, /^  shortcutName: Umbratic$/m);
  assert.match(nsis, /^  uninstallDisplayName: Umbratic$/m);
  assert.doesNotMatch(config, /^productName:.*\$\{version\}/m);
  assert.doesNotMatch(config, /^  uninstallDisplayName:.*\$\{version\}/m);
});

test("release-mode native binaries are runnable before packaging", () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const runner = path.join(repositoryRoot, "target", "release", process.platform === "win32" ? "umbratic-runner.exe" : "umbratic-runner");
  const desktopCore = path.join(repositoryRoot, "target", "release", process.platform === "win32" ? "umbratic-desktop-core.exe" : "umbratic-desktop-core");
  const pdfInspector = path.join(repositoryRoot, "target", "release", process.platform === "win32" ? "umbratic-pdf.exe" : "umbratic-pdf");
  for (const binary of [runner, desktopCore, pdfInspector]) {
    assert.equal(fs.existsSync(binary), true, `missing release binary ${binary}`);
    const result = spawnSync(binary, [], { encoding: "utf8", timeout: 5_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage:|UmbraticRunner/);
  }
});

test("desktop packages the Veil binary used by managed local mode", () => {
  const config = fs.readFileSync(configUrl, "utf8");
  const preparePackage = fs.readFileSync(preparePackageUrl, "utf8");

  assert.match(config, /- from: \.package\/veil\r?\n\s+to: veil/);
  assert.match(preparePackage, /spawnSync\("go", \["build", "-trimpath", "-o", veilBinary, "\.\/cmd\/veil"\]/);
  assert.match(preparePackage, /process\.platform === "win32" \? "veil\.exe" : "veil"/);
});

test("desktop builds llama-server from the pinned commit and packages it", () => {
  const config = fs.readFileSync(configUrl, "utf8");
  const preparePackage = fs.readFileSync(preparePackageUrl, "utf8");
  const verifyPackage = fs.readFileSync(new URL("../scripts/verify-package.ts", import.meta.url), "utf8");
  const pin = fs.readFileSync(new URL("../../../third_party/llama.cpp.pin", import.meta.url), "utf8");

  assert.match(pin, /^repository=https:\/\/github\.com\/ggml-org\/llama\.cpp\.git$/m);
  assert.match(pin, /^tag=b\d+$/m);
  assert.match(pin, /^commit=[0-9a-f]{40}$/m);

  assert.match(config, /- from: \.package\/llama-server\r?\n\s+to: llama-server/);
  // Cloning a tag is not enough: a tag can be moved, a commit cannot.
  assert.match(preparePackage, /head !== pin\.commit/);
  // No libcurl, and with it no `-hf` remote-download path.
  assert.match(preparePackage, /"-DLLAMA_CURL=OFF"/);
  // Never -march=native: a release binary must run on CPUs older than the one
  // that built it, and macOS older than the SDK that built it.
  assert.match(preparePackage, /"-DGGML_NATIVE=OFF"/);
  assert.match(preparePackage, /-DCMAKE_OSX_DEPLOYMENT_TARGET=12\.0/);
  // One build serves every machine because the backends are chosen on the
  // user's machine: a missing Vulkan loader is a skipped backend, not a
  // process that will not start.
  assert.match(preparePackage, /"-DGGML_BACKEND_DL=ON"/);
  assert.match(preparePackage, /"-DGGML_CPU_ALL_VARIANTS=ON"/);
  // Backend libraries are loaded, not linked, so a targeted build would leave
  // them unbuilt and ship an app with nothing to run on.
  assert.doesNotMatch(preparePackage, /"--target", "llama-server"/);
  assert.match(verifyPackage, /has no loadable ggml backend/);
  assert.match(verifyPackage, /has no CPU backend to fall back to/);
  // The packaged executable must report the commit the pin names. Not the
  // build number: llama.cpp derives that from tag history a shallow clone does
  // not have, so it self-reports "build 1" whichever release was checked out.
  assert.match(verifyPackage, /commit=\(\[0-9a-f\]\{40\}\)/);
  assert.match(verifyPackage, /commit \$\{commit\.slice\(0, 7\)\}/);
  assert.match(verifyPackage, /verifyLlamaServer\(path\.join\(resources, "llama-server"/);
});

test("desktop packages the native Rust runner instead of a Node launcher", () => {
  const config = fs.readFileSync(configUrl, "utf8");
  const preparePackage = fs.readFileSync(preparePackageUrl, "utf8");

  assert.match(config, /- from: \.package\/runner\r?\n\s+to: runner/);
  assert.match(preparePackage, /target\/release/);
  assert.match(preparePackage, /process\.platform === "win32" \? "umbratic-runner\.exe" : "umbratic-runner"/);
  assert.match(config, /- from: \.package\/desktop-core\r?\n\s+to: desktop-core/);
  assert.match(preparePackage, /process\.platform === "win32" \? "umbratic-desktop-core\.exe" : "umbratic-desktop-core"/);
  assert.match(config, /- from: \.package\/pdf\r?\n\s+to: pdf/);
  assert.match(preparePackage, /process\.platform === "win32" \? "umbratic-pdf\.exe" : "umbratic-pdf"/);
  assert.match(config, /- from: \.package\/code-index\r?\n\s+to: code-index/);
  assert.match(preparePackage, /process\.platform === "win32" \? "umbratic-code-index\.exe" : "umbratic-code-index"/);
  assert.doesNotMatch(preparePackage, /umbratic-runner\.cjs|dist["'], ["']cli\.js/);
});

test("desktop packaging jobs install Go and Rust before building native services", () => {
  const workflow = fs.readFileSync(packageWorkflowUrl, "utf8");
  const packageJob = workflow.slice(workflow.indexOf("\n  package:"), workflow.indexOf("\n  publish-release:"));

  assert.match(packageJob, /uses: actions\/setup-go@[0-9a-f]{40} # v7(?:\.\d+)?/);
  assert.match(packageJob, /rustup toolchain install 1\.96\.0/);
  assert.ok(packageJob.search(/uses: actions\/setup-go@[0-9a-f]{40}/) < packageJob.indexOf("npm --workspace @umbratic/desktop run package"));
  assert.ok(packageJob.indexOf("rustup toolchain install 1.96.0") < packageJob.indexOf("npm --workspace @umbratic\/desktop run package"));
  assert.ok(packageJob.indexOf("npm --workspace @umbratic/desktop run package") < packageJob.indexOf("npm --workspace @umbratic/desktop run verify:package"));
});

test("the Windows uninstaller offers an explicit local-data removal option", () => {
  const config = fs.readFileSync(configUrl, "utf8");
  const include = fs.readFileSync(installerIncludeUrl, "utf8");

  assert.match(config, /^  include: scripts\/installer\.nsh$/m);
  assert.match(include, /Remove all local Umbratic data/);
  assert.match(include, /RMDir \/r "\$LOCALAPPDATA\\Umbratic"/);
  assert.match(include, /\$\{NSD_Uncheck\}/);
});

test("desktop packaging runs only for version tags", () => {
  const packageWorkflow = fs.readFileSync(packageWorkflowUrl, "utf8");
  const verifyWorkflow = fs.readFileSync(verifyWorkflowUrl, "utf8");
  const packageTriggers = packageWorkflow.slice(
    packageWorkflow.indexOf("on:"),
    packageWorkflow.indexOf("\npermissions:"),
  );
  const verifyTriggers = verifyWorkflow.slice(
    verifyWorkflow.indexOf("on:"),
    verifyWorkflow.indexOf("\npermissions:"),
  );

  assert.match(packageTriggers, /tags:\r?\n\s+- "v\*"/);
  assert.doesNotMatch(packageTriggers, /branches:|pull_request:/);
  assert.match(verifyTriggers, /branches:\r?\n\s+- main/);
  assert.match(verifyTriggers, /pull_request:/);
  // Solo-developer CI: the audit runs on pull requests only. Merges to main
  // trigger nothing, and the full verification runs on tagged releases.
  assert.doesNotMatch(verifyTriggers, /push:/);
  assert.doesNotMatch(verifyWorkflow, /run package|electron-builder/);
  assert.doesNotMatch(verifyWorkflow, /test:all|release:check/);
});

test("desktop workflows omit the unused Squirrel peer dependency", () => {
  const packageWorkflow = fs.readFileSync(packageWorkflowUrl, "utf8");
  const verifyWorkflow = fs.readFileSync(verifyWorkflowUrl, "utf8");

  assert.doesNotMatch(packageWorkflow, /npm ci --ignore-scripts\s*$/m);
  assert.match(packageWorkflow, /npm ci --ignore-scripts --omit=peer/g);
  // The pull-request audit is lockfile-only: no npm ci at all, and the audit
  // itself skips peer dependencies the same way installs do.
  assert.doesNotMatch(verifyWorkflow, /npm ci/);
  assert.match(verifyWorkflow, /npm audit --package-lock-only --ignore-scripts --omit=peer/);
});

test("desktop release workflow pins actions and limits write permission to publishing", () => {
  const workflow = fs.readFileSync(packageWorkflowUrl, "utf8");
  const actionReferences = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  assert.ok(actionReferences.length >= 5);
  assert.ok(actionReferences.every((reference) => /@[0-9a-f]{40}$/.test(reference)));
  assert.match(workflow, /^permissions:\r?\n  contents: read$/m);
  const verifyJob = workflow.slice(workflow.indexOf("\n  verify:"), workflow.indexOf("\n  package:"));
  const packageJob = workflow.slice(workflow.indexOf("\n  package:"), workflow.indexOf("\n  publish-release:"));
  const publishJob = workflow.slice(workflow.indexOf("\n  publish-release:"));
  assert.match(verifyJob, /^\n  verify:/);
  assert.match(packageJob, /^\n  package:/);
  assert.doesNotMatch(verifyJob, /contents: write/);
  assert.doesNotMatch(packageJob, /contents: write/);
  assert.match(publishJob, /permissions:\r?\n      contents: write/);
  assert.doesNotMatch(publishJob, /delete-asset|--clobber/);
});
