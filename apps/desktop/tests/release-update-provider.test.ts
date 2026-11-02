import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const require = createRequire(import.meta.url);
const { releaseUpdateInfo, ReleaseUpdateProvider } = loadTypeScriptModule(new URL("../src/main/releaseUpdateProvider.ts", import.meta.url));
const bytes = Buffer.from("verified installer");
const digest = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
const prefix = "https://github.com/Potirniche-Carmine/Umbratic/releases/download/v0.0.3/";
function release() {
  return { tag_name: "v0.0.3", draft: false, prerelease: false, published_at: "2026-11-02T12:00:00Z",
    assets: ["Umbratic-0.0.3.zip", "Umbratic-0.0.3.dmg", "Umbratic-0.0.3-x64.exe", "Umbratic-0.0.3-arm64.exe"]
      .map((name) => ({ name, state: "uploaded", size: bytes.length, digest, browser_download_url: prefix + name })),
  };
}

test("clean releases select the exact package for all supported platforms with GitHub's digest", () => {
  for (const [platform, architecture, suffix] of [["darwin", "arm64", ".zip"], ["win32", "x64", "-x64.exe"], ["win32", "arm64", "-arm64.exe"]]) {
    const info = releaseUpdateInfo(release(), platform, architecture);
    assert.equal(info.version, "0.0.3");
    assert.equal(info.files.length, 1);
    assert.equal(info.files[0].url, `${prefix}Umbratic-0.0.3${suffix}`);
    assert.equal(info.files[0].sha2, digest.slice(7));
    assert.equal(info.files[0].sha512, undefined);
  }
});

test("the provider requests only the fixed public release API and resolves the verified package", async () => {
  const requests = [];
  const provider = new ReleaseUpdateProvider({}, {}, { platform: "win32", executor: {
    request(options) { requests.push(options); return Promise.resolve(JSON.stringify(release())); },
  } });
  provider.setRequestHeaders({ "User-Agent": "Umbratic/0.0.2" });
  const info = await provider.getLatestVersion();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].hostname, "api.github.com");
  assert.equal(requests[0].path, "/repos/Potirniche-Carmine/Umbratic/releases/latest");
  assert.equal(requests[0].headers["User-Agent"], "Umbratic/0.0.2");
  assert.equal(provider.resolveFiles(info)[0].url.href, info.files[0].url);
});

test("invalid release identity, missing architecture, unsafe URLs and absent digests fail closed", () => {
  for (const change of [
    (r) => { r.tag_name = "v0.0.3-beta.1"; },
    (r) => { r.draft = true; },
    (r) => { r.prerelease = true; },
    (r) => { r.published_at = "invalid"; },
    (r) => { r.assets = r.assets.filter((asset) => !asset.name.endsWith("-arm64.exe")); },
    (r) => { r.assets.push(r.assets[3]); },
    (r) => { r.assets[3].digest = undefined; },
    (r) => { r.assets[3].digest = "sha256:short"; },
    (r) => { r.assets[3].digest = `sha512:${"a".repeat(64)}`; },
    (r) => { r.assets[3].state = "starter"; },
    (r) => { r.assets[3].size = 0; },
    (r) => { r.assets[3].size = 1.5; },
    (r) => { r.assets[3].browser_download_url = "https://example.com/installer.exe"; },
    (r) => { r.assets[3].browser_download_url += "?redirect=other"; },
    (r) => { r.assets[3].browser_download_url = r.assets[3].browser_download_url.replace("v0.0.3/", "v0.0.2/"); },
  ]) {
    const data = release();
    change(data);
    assert.throws(() => releaseUpdateInfo(data, "win32", "arm64"));
  }
  assert.throws(() => releaseUpdateInfo(null, "win32", "arm64"));
  assert.throws(() => releaseUpdateInfo(release(), "darwin", "x64"), /Unsupported/);
  assert.throws(() => releaseUpdateInfo(release(), "linux", "x64"), /Unsupported/);
});

// Exercise the pinned updater's real download and digest verification, including
// its cache path, without Electron or requests to the public GitHub release.
test("the real updater accepts intact packages and discards tampered SHA-256 downloads", async (t) => {
  const { AppUpdater } = require("electron-updater/out/AppUpdater");
  const { ElectronHttpExecutor } = require("electron-updater/out/electronHttpExecutor");
  const { CancellationToken } = require("builder-util-runtime");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-release-update-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let servedBytes = bytes;
  const server = http.createServer((_request, response) => { response.end(servedBytes); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const executor = new ElectronHttpExecutor();
  executor.createRequest = (options, callback) => http.request({ ...options, protocol: "http:",
    hostname: "127.0.0.1", port: server.address().port }, callback);
  for (const platform of ["darwin", "win32"]) {
    const info = releaseUpdateInfo(release(), platform, "arm64");
    const updater = new AppUpdater(null, { version: "0.0.2", name: "Umbratic", baseCachePath: directory });
    updater.configOnDisk = { value: Promise.resolve({ updaterCacheDirName: platform }) };
    updater.logger = { info() {}, warn() {}, error() {}, debug() {} };
    const fileInfo = { url: new URL(info.files[0].url), info: info.files[0] };
    let ready = 0;
    const download = () => updater.executeDownload({ fileExtension: platform === "darwin" ? "zip" : "exe", fileInfo,
      downloadUpdateOptions: { updateInfoAndProvider: { info }, cancellationToken: new CancellationToken() },
      task: (destination, options) => executor.download(fileInfo.url, destination, options),
      done: () => { ready++; },
    });
    servedBytes = bytes;
    const [downloaded] = await download();
    assert.deepEqual(fs.readFileSync(downloaded), bytes);
    assert.equal(ready, 1);
    // A new process cannot trust cached SHA-256 bytes via the SHA-512-only
    // helper: it must fetch and verify again, even if a stale file exists.
    updater.downloadedUpdateHelper = null;
    servedBytes = Buffer.from("tampered installer");
    await assert.rejects(download(), /checksum mismatch/i);
    assert.equal(ready, 1);
    assert.equal(fs.existsSync(downloaded), false);
  }
});
