import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { verifyNsisUninstaller } from "../../../scripts/ci/nsis-archive.ts";
import { withWindowsArchiveTool } from "../../../scripts/ci/windows-archive-tool.ts";

// Reproduce the signed-PE wrapper without inventing a trusted signature. Real
// signature/chain/timestamp qualification runs on both native Windows hosts.
function certificateTable(file: string): void {
  const original = fs.readFileSync(file);
  const offset = Math.ceil(original.length / 8) * 8;
  const bytes = Buffer.alloc(offset + 24);
  original.copy(bytes);
  const optional = bytes.readUInt32LE(60) + 24;
  const directory = optional + (bytes.readUInt16LE(optional) === 0x20b ? 112 : 96) + 32;
  bytes.writeUInt32LE(offset, directory);
  bytes.writeUInt32LE(24, directory + 4);
  bytes.writeUInt32LE(24, offset);
  bytes.writeUInt16LE(0x200, offset + 4);
  bytes.writeUInt16LE(2, offset + 6);
  fs.writeFileSync(file, bytes);
}

test("full-format NSIS verification extracts the exact generated uninstaller and rejects ambiguous or changed payloads", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-nsis-regression-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const require = createRequire(import.meta.url);
  const { getMakeNsisPath } = require("app-builder-lib/out/toolsets/windows");
  const { UninstallerReader } = require("app-builder-lib/out/targets/nsis/nsisUtil");
  const nsis = await getMakeNsisPath();
  const fixtures = new URL("../../../scripts/ci/fixtures/", import.meta.url);
  const releaseVersion = JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version;
  const generator = path.join(root, "generator.exe");
  const uninstaller = path.join(root, "generated-uninstaller.exe");
  const appArchive = path.join(root, "app.7z");
  function compile(source: string, name: string): string {
    const file = path.join(root, `${name}.exe`);
    const script = path.join(root, `${name}.nsi`);
    fs.writeFileSync(script, source);
    execFileSync(nsis.path, ["-V2", `-DOUT_FILE=${file}`, `-DUNINSTALLER_FILE=${uninstaller}`, `-DAPP_ARCHIVE=${appArchive}`,
      `-DRELEASE=${releaseVersion}`, script], { env: { ...process.env, ...nsis.env }, timeout: 30_000 });
    return file;
  }
  compile(fs.readFileSync(new URL("nsis-uninstaller.nsi", fixtures), "utf8"), "generator");
  // The pinned builder reads its generated uninstaller without executing the
  // generator. Native preflight uses this same compiler/reader pair.
  await UninstallerReader.exec(generator, uninstaller);
  certificateTable(uninstaller);
  const expected = crypto.createHash("sha256").update(fs.readFileSync(uninstaller)).digest("hex");
  const source = fs.readFileSync(new URL("nsis-installer.nsi", fixtures), "utf8");
  const check = (tool: string) => {
    execFileSync(tool, ["a", "-t7z", appArchive, uninstaller], { timeout: 30_000 });
    const installer = compile(source, "installer");
    certificateTable(installer);
    assert.doesNotThrow(() => verifyNsisUninstaller(tool, installer, expected));
    assert.throws(() => verifyNsisUninstaller(tool, installer, "0".repeat(64)), /differs from the approved signed bytes/);
    assert.throws(() => verifyNsisUninstaller(tool, appArchive, expected));
    const entry = '  File "/oname=Uninstall Umbratic.exe" "${UNINSTALLER_FILE}"';
    const missing = compile(source.replace(entry, ""), "missing");
    assert.throws(() => verifyNsisUninstaller(tool, missing, expected), /exactly one/);
    const other = path.join(root, "different-uninstaller.exe");
    fs.writeFileSync(other, Buffer.concat([fs.readFileSync(uninstaller), Buffer.from("changed")]));
    const duplicate = compile(source.replace(entry, `${entry}\n  SetOutPath "$INSTDIR\\duplicate"\n  File "/oname=Uninstall Umbratic.exe" "${other}"`), "duplicate");
    assert.throws(() => verifyNsisUninstaller(tool, duplicate, expected), /exactly one/);
  };
  if (process.platform === "win32") await withWindowsArchiveTool(check);
  else check(await require("app-builder-lib/out/toolsets/7zip").getPath7za());
});
