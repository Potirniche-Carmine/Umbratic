import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createRequire } from "node:module";
import * as artifacts from "../../../scripts/ci/release-artifacts.ts";
import { requireProjectIdentity, sha256 } from "../../../scripts/ci/windows-signing.ts";

const entry = new URL("../../../scripts/ci/verify-release.ts", import.meta.url);
// Execute the real asynchronous entry point, including its platform dispatch.
// The common synchronous module helper cannot execute top-level await.
const code = ts.transpileModule(fs.readFileSync(entry, "utf8"), {
  compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText.replaceAll("import.meta.url", JSON.stringify(entry.href));
const yaml = createRequire(import.meta.url)("js-yaml");
const version = "0.0.1", publisher = "Umbratic fixture", team = "ABCDEFGHIJ";

function fixture(t, platform, architecture = "arm64", failure = "") {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-verifier-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const desktop = path.join(temporary, "desktop"), stage = path.join(temporary, "upload"), handoff = path.join(temporary, "handoff");
  fs.mkdirSync(desktop);
  const prefix = `Umbratic-${version}`, checks = [], commands = [];
  const identity = { status: "Valid", publisher, timestamp: true, sha256Signature: true, productName: "Umbratic", productVersion: version };
  if (platform === "win32") {
    const app = path.join(desktop, architecture === "x64" ? "win-unpacked" : "win-arm64-unpacked");
    fs.mkdirSync(path.join(app, "resources"), { recursive: true });
    fs.writeFileSync(path.join(app, "resources/app-update.yml"), JSON.stringify({ publisherName: failure === "publisher" ? "other" : publisher }));
    fs.writeFileSync(path.join(app, "resources/windows-signing-provenance.json"), JSON.stringify({ sourceCommit: "a".repeat(40), architecture, version, files: [] }));
    const name = `${prefix}-${architecture}.exe`;
    fs.writeFileSync(path.join(desktop, name), "fixture installer");
    fs.writeFileSync(path.join(desktop, `${name}.blockmap`), "fixture blockmap");
    fs.writeFileSync(path.join(desktop, "latest.yml"), "fixture channel");
    fs.mkdirSync(path.join(handoff, "uninstaller"), { recursive: true });
    fs.writeFileSync(path.join(handoff, "uninstaller/result.json"), JSON.stringify([{
      name: `${prefix}-${architecture}.__uninstaller.exe`, sha256: "b".repeat(64),
      identity: { ...identity, timestamp: failure !== "uninstaller" },
    }]));
  } else {
    const dmg = path.join(desktop, `${prefix}.dmg`);
    fs.writeFileSync(dmg, "disk image before stapling");
    fs.writeFileSync(`${dmg}.blockmap`, "stale blockmap");
    fs.writeFileSync(path.join(desktop, `${prefix}.zip`), "signed app archive");
    fs.writeFileSync(path.join(desktop, "latest-mac.yml"), JSON.stringify({ version, path: `${prefix}.dmg`, sha512: "old",
      files: [{ url: `${prefix}.dmg`, sha512: "old", size: 1, blockMapSize: 1 }] }));
  }
  const mocks = {
    "node:fs": { ...fs, readFileSync: (file, ...options) => file === "package.json" ? JSON.stringify({ version }) : fs.readFileSync(file, ...options) },
    "node:path": { ...path, resolve: (...parts) => parts[0] === "target/release/desktop" ? desktop
      : parts[0] === "target/release/upload" ? stage : path.resolve(...parts) },
    "node:module": { createRequire: () => () => yaml },
    "./release-artifacts.ts": { ...artifacts, verifyUpdaterPublisher(metadata, expected) {
      checks.push("publisher"); artifacts.verifyUpdaterPublisher(metadata, expected);
    } },
    "node:child_process": {
      execFileSync(command, args) {
        assert.equal(platform, "darwin", "Windows verification must use its dedicated signature/archive checks");
        commands.push([command, ...args]);
        if (command === "xcrun" && args[0] === "notarytool") return JSON.stringify({ status: failure === "notary" ? "Rejected" : "Accepted" });
        if (command === "xcrun" && args[0] === "stapler" && args[1] === "staple") fs.appendFileSync(args[2], "stapled bytes");
        return "";
      },
      spawnSync() { return { status: 0, stderr: `TeamIdentifier=${failure === "team" ? "OTHERTEAM1" : team}\n` }; },
    },
    "./windows-signing.ts": {
      inspect(files) {
        assert.deepEqual(Array.from(files), [path.join(desktop, `${prefix}-${architecture}.exe`)]);
        return [{ ...identity, publisher: failure === "installer" ? "other" : publisher }];
      },
      requireProjectIdentity(value, expected, releaseVersion) {
        checks.push(checks.includes("installer") ? "uninstaller" : "installer");
        requireProjectIdentity(value, expected, releaseVersion);
      },
      verifyInventory(app, inventory, expected) {
        checks.push("inventory");
        assert.equal(app, path.join(desktop, architecture === "x64" ? "win-unpacked" : "win-arm64-unpacked"));
        assert.equal(inventory.architecture, architecture);
        assert.equal(expected, publisher);
        if (failure === "inventory") throw new Error("Invalid signed payload inventory");
      },
      sha256, signingRoot: () => handoff,
    },
    "./windows-archive-tool.ts": { withWindowsArchiveTool: async (callback) => callback("fixture-7zip") },
    "./nsis-archive.ts": { verifyNsisUninstaller(tool, installer, hash) {
      checks.push("embedded");
      assert.equal(tool, "fixture-7zip");
      assert.equal(installer, path.join(desktop, `${prefix}-${architecture}.exe`));
      assert.equal(hash, "b".repeat(64));
      if (failure === "embedded") throw new Error("Embedded signed uninstaller digest mismatch");
    } },
  };
  const execute = () => vm.runInNewContext(`(async () => { ${code}\n})()`, {
    require(name) { assert.ok(Object.hasOwn(mocks, name), `Unexpected verifier dependency ${name}`); return mocks[name]; },
    exports: {}, process: { platform, arch: architecture, env: { SIGNPATH_PUBLISHER: publisher, APPLE_TEAM_ID: team,
      UMBRATIC_NOTARY_PROFILE: "fixture-profile", CSC_KEYCHAIN: "fixture-keychain" } }, console: { log() {} },
  }, { filename: entry.pathname });
  return { execute, desktop, stage, checks, commands, prefix };
}

test("the native signing-fixture verifier executes strict Windows checks before staging either architecture", async (t) => {
  for (const architecture of ["x64", "arm64"]) {
    const result = fixture(t, "win32", architecture);
    await result.execute();
    assert.deepEqual(result.checks, ["publisher", "inventory", "installer", "uninstaller", "embedded"]);
    const name = `${result.prefix}-${architecture}.exe`;
    assert.deepEqual(fs.readdirSync(result.stage).sort(), [name, `${name}.blockmap`,
      `${result.prefix}-${architecture}-windows-provenance.json`, architecture === "x64" ? "latest.yml" : "latest-arm64.yml"].sort());
    const provenance = JSON.parse(fs.readFileSync(path.join(result.stage, `${result.prefix}-${architecture}-windows-provenance.json`), "utf8"));
    assert.equal(provenance.installer.sha256, sha256(path.join(result.desktop, name)));
    assert.equal(provenance.uninstaller.sha256, "b".repeat(64));
  }
});

test("invalid publisher, payload, signatures, or embedded uninstaller prevent Windows staging", async (t) => {
  for (const failure of ["publisher", "inventory", "installer", "uninstaller", "embedded"]) {
    const result = fixture(t, "win32", "arm64", failure);
    await assert.rejects(result.execute, /publisher|payload inventory|uninstaller digest/);
    assert.deepEqual(fs.readdirSync(result.stage), []);
  }
});

test("macOS verification retains signing, notarization, Gatekeeper checks and post-staple updater digests", async (t) => {
  const result = fixture(t, "darwin");
  await result.execute();
  assert.ok(result.commands.some(([tool, ...args]) => tool === "codesign" && args.includes("--verify")));
  assert.ok(result.commands.some(([tool, ...args]) => tool === "spctl" && args.includes("--assess")));
  assert.ok(result.commands.some(([tool, ...args]) => tool === "xcrun" && args.includes("notarytool") && args.includes("submit")));
  const metadata = yaml.load(fs.readFileSync(path.join(result.stage, "latest-mac.yml"), "utf8"));
  const dmg = path.join(result.stage, `${result.prefix}.dmg`);
  assert.equal(metadata.sha512, artifacts.hashFile(dmg, "sha512", "base64"));
  assert.equal(metadata.files[0].size, fs.statSync(dmg).size);
  assert.equal(fs.existsSync(`${dmg}.blockmap`), false);
  for (const failure of ["team", "notary"]) {
    const invalid = fixture(t, "darwin", "arm64", failure);
    await assert.rejects(invalid.execute, /Developer ID team|notarization/);
    assert.deepEqual(fs.readdirSync(invalid.stage), []);
  }
});
