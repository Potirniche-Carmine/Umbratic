import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const { load } = createRequire(import.meta.url)("js-yaml");

const configUrl = new URL("../electron-builder.yml", import.meta.url);
const preparePackageUrl = new URL("../scripts/prepare-package.ts", import.meta.url);
const installerIncludeUrl = new URL("../scripts/installer.nsh", import.meta.url);
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

test("packaged Electron flips security fuses and does not keep runAsNode", () => {
  const config = fs.readFileSync(configUrl, "utf8");
  const snapshot = fs.readFileSync(new URL("../src/main/workspaceSnapshot.ts", import.meta.url), "utf8");
  assert.match(config, /^electronFuses:\r?$/m);
  assert.match(config, /^  runAsNode: false$/m);
  assert.match(config, /^  enableNodeOptionsEnvironmentVariable: false$/m);
  assert.match(config, /^  enableNodeCliInspectArguments: false$/m);
  assert.match(config, /^  enableEmbeddedAsarIntegrityValidation: false$/m);
  assert.match(config, /^  onlyLoadAppFromAsar: true$/m);
  assert.match(config, /^  resetAdHocDarwinSignature: true$/m);
  assert.match(snapshot, /utilityProcess\.fork/);
  assert.doesNotMatch(snapshot, /ELECTRON_RUN_AS_NODE/);
});

test("release-mode native binaries are runnable before packaging", () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const executable = (name) => (process.platform === "win32" ? `${name}.exe` : name);
  const runner = path.join(repositoryRoot, "target", "release", executable("umbratic-runner"));
  const desktopCore = path.join(repositoryRoot, "target", "release", executable("umbratic-desktop-core"));
  const pdfInspector = path.join(repositoryRoot, "target", "release", executable("umbratic-pdf"));
  const artifacts = path.join(repositoryRoot, "target", "release", executable("umbratic-artifacts"));
  const codeIndex = path.join(repositoryRoot, "target", "release", executable("umbratic-code-index"));
  for (const binary of [runner, desktopCore, pdfInspector]) {
    assert.equal(fs.existsSync(binary), true, `missing release binary ${binary}`);
    const result = spawnSync(binary, [], { encoding: "utf8", timeout: 5_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage:|UmbraticRunner/);
  }
  assert.equal(fs.existsSync(artifacts), true, `missing release binary ${artifacts}`);
  const artifactsResult = spawnSync(artifacts, [], { encoding: "utf8", timeout: 5_000 });
  assert.equal(artifactsResult.error, undefined);
  assert.equal(artifactsResult.status, 1);
  assert.match(artifactsResult.stderr, /one JSON job on stdin/);

  assert.equal(fs.existsSync(codeIndex), true, `missing release binary ${codeIndex}`);
  const codeIndexResult = spawnSync(codeIndex, [], { encoding: "utf8", timeout: 5_000 });
  assert.equal(codeIndexResult.error, undefined);
  assert.equal(codeIndexResult.status, 1);
  assert.match(`${codeIndexResult.stdout}${codeIndexResult.stderr}`, /usage: umbratic-code-index/);
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
  assert.match(config, /- from: \.package\/artifacts\r?\n\s+to: artifacts/);
  assert.match(preparePackage, /process\.platform === "win32" \? "umbratic-artifacts\.exe" : "umbratic-artifacts"/);
  assert.match(config, /- from: \.package\/code-index\r?\n\s+to: code-index/);
  assert.match(preparePackage, /process\.platform === "win32" \? "umbratic-code-index\.exe" : "umbratic-code-index"/);
  assert.doesNotMatch(preparePackage, /umbratic-runner\.cjs|dist["'], ["']cli\.js/);
});

test("the packaged app ships no search credential", () => {
  const config = fs.readFileSync(configUrl, "utf8");
  const preparePackage = fs.readFileSync(preparePackageUrl, "utf8");
  const verifyPackage = fs.readFileSync(new URL("../scripts/verify-package.ts", import.meta.url), "utf8");

  // An installed app can be unpacked, so a search key placed in extraResources
  // is a key handed to every customer. Searching against a subscription is
  // Veil's job; nothing in the bundle needs a token to do it.
  for (const source of [config, preparePackage, verifyPackage]) {
    assert.doesNotMatch(source, /brave/i);
    assert.doesNotMatch(source, /SEARCH_API_KEY/);
  }
  assert.doesNotMatch(config, /- from: \.package\/web-search/);
});

test("the Windows uninstaller offers an explicit local-data removal option", () => {
  const config = fs.readFileSync(configUrl, "utf8");
  const include = fs.readFileSync(installerIncludeUrl, "utf8");

  assert.match(config, /^  include: scripts\/installer\.nsh$/m);
  assert.match(include, /Remove all local Umbratic data/);
  assert.match(include, /RMDir \/r "\$LOCALAPPDATA\\Umbratic"/);
  assert.match(include, /\$\{NSD_Uncheck\}/);
});

test("CI verifies every native platform on pull requests and main without release secrets", () => {
  const source = fs.readFileSync(verifyWorkflowUrl, "utf8");
  const workflow = load(source);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.on.pull_request.branches, ["main"]);
  assert.deepEqual(workflow.jobs.verify.strategy.matrix.os, ["macos-15", "windows-2025", "windows-11-arm"]);
  const commands = workflow.jobs.verify.steps.map((step) => step.run ?? "");
  assert.ok(commands.includes("npm run test:all"));
  assert.ok(commands.includes("npm run desktop:release -- --unsigned"));
  assert.ok(commands.includes("node scripts/check-release-version.ts"));
  assert.ok(commands.includes("node scripts/ci/verify-installer-artifacts.ts"));
  const vulkan = workflow.jobs.verify.steps.find((step) => step.run === "./scripts/ci/install-vulkan.ps1");
  assert.equal(vulkan.if, "matrix.os == 'windows-2025'");
  assert.ok(commands.includes("./scripts/ci/install-windows-signing.ps1"));
  assert.doesNotMatch(source, /UMBRATIC_LLAMA_CPU_ONLY/);
  assert.doesNotMatch(source, /secrets\./);
  assert.deepEqual(workflow.jobs.required.needs, ["verify", "audit"]);
  assert.equal(workflow.jobs.required.if, "always()");
});

test("CI installs locked dependencies without lifecycle scripts and retains vulnerability auditing", () => {
  const workflow = load(fs.readFileSync(verifyWorkflowUrl, "utf8"));
  for (const name of ["verify", "audit"]) {
    const commands = workflow.jobs[name].steps.map((step) => step.run ?? "");
    assert.ok(commands.includes("npm ci --ignore-scripts --omit=peer"));
  }
  assert.ok(workflow.jobs.audit.steps.some((step) => step.run === "npm run supply-chain:audit"));
  assert.ok(workflow.jobs.audit.steps.some((step) => step.run === "npm run supply-chain:sbom"));
  const linuxRace = workflow.jobs.audit.steps.find((step) => step.name === "Race-test both Go services on Linux");
  assert.equal(linuxRace.env.CGO_ENABLED, "1");
  assert.match(linuxRace.run, /go -C infrastructure\/veil test -race \.\/\.\.\./);
  assert.match(linuxRace.run, /go -C infrastructure\/veil-console test -race \.\/\.\.\./);
});

test("CI pins actions and stays read-only", () => {
  const workflow = load(fs.readFileSync(verifyWorkflowUrl, "utf8"));
  const actionReferences = Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])
    .map((step) => step.uses).filter(Boolean);
  assert.ok(actionReferences.length >= 2);
  assert.ok(actionReferences.every((reference) => /@[0-9a-f]{40}$/.test(reference)));
  assert.deepEqual(workflow.permissions, { contents: "read" });
  for (const job of Object.values(workflow.jobs)) assert.notEqual(job.permissions?.contents, "write");
});

test("release publication waits for every signed platform and scopes write access to publication", () => {
  const workflow = load(fs.readFileSync(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8"));
  assert.deepEqual(workflow.on.workflow_run.workflows, ["CI"]);
  assert.match(workflow.jobs.source.if, /workflow_run\.event == 'push'/);
  assert.match(workflow.jobs.source.if, /head_repository\.full_name == github\.repository/);
  assert.deepEqual(workflow.jobs.publish.needs, ["source", "package"]);
  assert.deepEqual(workflow.jobs.package.strategy.matrix.os, ["macos-15", "windows-2025", "windows-11-arm"]);
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.jobs.publish.permissions.contents, "write");
  for (const name of ["package", "publish"]) {
    const checkout = workflow.jobs[name].steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    assert.equal(checkout.with.ref, "${{ github.sha }}");
    for (const step of workflow.jobs[name].steps) {
      if (step.uses?.startsWith("actions/setup-node@")) assert.equal(step.with["package-manager-cache"], false);
      if (step.uses?.startsWith("actions/setup-go@")) assert.equal(step.with.cache, false);
    }
  }
  assert.ok(workflow.jobs.package.steps.some((step) => step.run === "node scripts/ci/verify-release.ts"));
  assert.ok(workflow.jobs.publish.steps.some((step) => step.run === "node scripts/ci/publish-release.ts"));
});
