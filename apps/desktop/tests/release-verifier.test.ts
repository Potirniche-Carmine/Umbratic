import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createRequire } from "node:module";
import * as artifacts from "../../../scripts/ci/release-artifacts.ts";

const entry = new URL("../../../scripts/ci/verify-release.ts", import.meta.url);
// Execute the real asynchronous release entry point with native commands mocked.
const code = ts.transpileModule(fs.readFileSync(entry, "utf8"), {
  compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText.replaceAll("import.meta.url", JSON.stringify(entry.href));
const yaml = createRequire(import.meta.url)("js-yaml");
const version = "0.0.1", team = "ABCDEFGHIJ";

function fixture(t, failure = "", platform = "darwin") {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-verifier-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const desktop = path.join(temporary, "desktop"), stage = path.join(temporary, "upload");
  fs.mkdirSync(desktop);
  const prefix = `Umbratic-${version}`, commands = [], delays = [];
  const dmg = path.join(desktop, `${prefix}.dmg`);
  fs.writeFileSync(dmg, "disk image before stapling");
  fs.writeFileSync(`${dmg}.blockmap`, "stale blockmap");
  fs.writeFileSync(path.join(desktop, `${prefix}.zip`), "signed app archive");
  fs.writeFileSync(path.join(desktop, "latest-mac.yml"), JSON.stringify({ version, path: `${prefix}.dmg`, sha512: "old",
    files: [{ url: `${prefix}.dmg`, sha512: "old", size: 1, blockMapSize: 1 }] }));
  let staples = 0;
  const mocks = {
    "node:fs": { ...fs, readFileSync: (file, ...options) => file === "package.json" ? JSON.stringify({ version }) : fs.readFileSync(file, ...options) },
    "node:path": { ...path, resolve: (...parts) => parts[0] === "target/release/desktop" ? desktop
      : parts[0] === "target/release/upload" ? stage : path.resolve(...parts) },
    "node:module": { createRequire: () => () => yaml },
    "./release-artifacts.ts": artifacts,
    "node:child_process": {
      execFileSync(command, args) {
        commands.push([command, ...args]);
        if (command === "xcrun" && args[0] === "notarytool") return JSON.stringify({ status: failure === "notary" ? "Rejected" : "Accepted" });
        if ((failure === "validation" && args[0] === "stapler" && args[1] === "validate" && args[2] === dmg)
            || (failure === "signature" && command === "codesign" && args.at(-1) === dmg)
            || (failure === "gatekeeper" && command === "spctl" && args.at(-1) === dmg)) throw new Error("Native verification rejected disk image");
        return "";
      },
      spawnSync(command, args) {
        commands.push([command, ...args]);
        if (command === "codesign") return { status: 0, stderr: `TeamIdentifier=${failure === "team" ? "OTHERTEAM1" : team}\n` };
        assert.equal(command, "xcrun");
        assert.deepEqual(Array.from(args), ["stapler", "staple", dmg]);
        staples++;
        if (failure === "permanent") return { status: 65, stderr: "The disk image has no valid ticket." };
        if (failure === "network" || (failure === "transient" && staples === 1)) {
          return { status: 68, stderr: 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."' };
        }
        fs.appendFileSync(dmg, "stapled bytes");
        return { status: 0, stdout: "The staple and validate action worked!" };
      },
    },
  };
  const execute = () => vm.runInNewContext(`(async () => { ${code}\n})()`, {
    require(name) { assert.ok(Object.hasOwn(mocks, name), `Unexpected verifier dependency ${name}`); return mocks[name]; },
    exports: {}, process: { platform, arch: "arm64", env: { APPLE_TEAM_ID: team,
      UMBRATIC_NOTARY_PROFILE: "fixture-profile", CSC_KEYCHAIN: "fixture-keychain" } }, console: { log() {} },
    setTimeout(callback, delay) { delays.push(delay); callback(); },
  }, { filename: entry.pathname });
  return { execute, desktop, stage, commands, delays, prefix, staples: () => staples };
}

test("macOS verification retains signing, notarization, Gatekeeper checks and post-staple updater digests", async (t) => {
  const result = fixture(t);
  await result.execute();
  assert.ok(result.commands.some(([tool, ...args]) => tool === "codesign" && args.includes("--deep") && args.includes("--strict")));
  assert.equal(result.commands.filter(([tool]) => tool === "spctl").length, 2);
  assert.equal(result.commands.filter(([tool, ...args]) => tool === "xcrun" && args[0] === "stapler" && args[1] === "validate").length, 2);
  assert.ok(result.commands.some(([tool, ...args]) => tool === "xcrun" && args.includes("notarytool") && args.includes("submit")));
  const metadata = yaml.load(fs.readFileSync(path.join(result.stage, "latest-mac.yml"), "utf8"));
  const dmg = path.join(result.stage, `${result.prefix}.dmg`);
  assert.equal(metadata.sha512, artifacts.hashFile(dmg, "sha512", "base64"));
  assert.equal(metadata.files[0].sha512, metadata.sha512);
  assert.equal(metadata.files[0].size, fs.statSync(dmg).size);
  assert.equal(metadata.files[0].blockMapSize, undefined);
  assert.equal(fs.existsSync(`${dmg}.blockmap`), false);
  for (const failure of ["team", "notary", "validation", "signature", "gatekeeper"]) {
    const invalid = fixture(t, failure);
    await assert.rejects(invalid.execute, /Developer ID team|notarization|Native verification/);
    assert.deepEqual(fs.readdirSync(invalid.stage), []);
  }
});

test("transient Apple ticket delivery failures retry before final validation and fresh checksum staging", async (t) => {
  const result = fixture(t, "transient");
  await result.execute();
  assert.equal(result.staples(), 2);
  assert.deepEqual(result.delays, [15_000]);
  assert.ok(fs.readdirSync(result.stage).includes("latest-mac.yml"));
  const validation = result.commands.findIndex(([tool, ...args]) => tool === "xcrun" && args[1] === "validate" && args[2].endsWith(".dmg"));
  assert.ok(validation > result.commands.findLastIndex(([tool, ...args]) => tool === "xcrun" && args[1] === "staple"));
});

test("persistent network errors exhaust bounded retries and permanent stapling failures stop immediately", async (t) => {
  for (const [failure, attempts, delays] of [["network", 3, [15_000, 30_000]], ["permanent", 1, []]]) {
    const result = fixture(t, failure);
    await assert.rejects(result.execute, /Disk image stapling failed/);
    assert.equal(result.staples(), attempts);
    assert.deepEqual(result.delays, delays);
    assert.deepEqual(fs.readdirSync(result.stage), []);
  }
});

test("signed release verifier rejects Windows; unsigned Windows releases require authenticated CI promotion", async (t) => {
  const result = fixture(t, "", "win32");
  await assert.rejects(result.execute, /Unsupported release host/);
  assert.deepEqual(fs.readdirSync(result.stage), []);
});
