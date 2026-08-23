import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const modulePath = new URL("../src/main/appUpdates.ts", import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));

function fakeUpdater() {
  const updater = new EventEmitter();
  Object.assign(updater, {
    checks: 0,
    installs: 0,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowDowngrade: true,
    allowPrerelease: true,
    channel: null,
    requestHeaders: null,
    logger: null,
    checkForUpdates() {
      updater.checks += 1;
      updater.emit("checking-for-update");
      return updater.nextCheck ? updater.nextCheck() : Promise.resolve(null);
    },
    quitAndInstall() {
      updater.installs += 1;
    },
  });
  return updater;
}

function load({ packaged, automatic = true, updateFeedToken = "org_test.1787296036.signature" }) {
  const updater = fakeUpdater();
  const settings = { automatic, updateFeedToken };
  const diagnostics = [];
  const module = loadTypeScriptModule(modulePath, {
    cache: new Map(),
    mocks: {
      electron: { app: { isPackaged: packaged, getVersion: () => "0.0.3" } },
      "electron-updater": { autoUpdater: updater },
      "./storage": {
        readAutomaticAppUpdatesSetting: () => settings.automatic,
        readUpdateFeedTokenSetting: () => settings.updateFeedToken,
        writeAutomaticAppUpdatesSetting: (value) => {
          settings.automatic = value !== false;
          return settings.automatic;
        },
      },
      "./diagnostics": { recordLocalDiagnostic: (entry) => diagnostics.push(entry) },
    },
  });
  return { module, updater, settings, diagnostics };
}

test("a development build has no feed and never touches the updater", async () => {
  const { module, updater } = load({ packaged: false });
  assert.deepEqual(plain(module.appUpdateStatus()), {
    installedVersion: "0.0.3",
    automatic: true,
    checkedAt: null,
    state: { phase: "unsupported" },
  });
  module.startAppUpdates();
  const after = await module.checkForAppUpdate();
  assert.equal(after.state.phase, "unsupported");
  assert.equal(updater.checks, 0);
  module.installAppUpdate();
  assert.equal(updater.installs, 0);
});

test("a check configures the updater conservatively and reports each stage to the renderer", async () => {
  const { module, updater } = load({ packaged: true });
  const seen = [];
  module.onAppUpdateStatus((status) => seen.push(plain(status)));

  updater.nextCheck = () => {
    updater.emit("update-available", { version: "0.0.4" });
    return Promise.resolve({ updateInfo: { version: "0.0.4" } });
  };
  const status = await module.checkForAppUpdate();

  // No downgrade, no prerelease, background download, install on quit; and
  // a User-Agent that says which build asked and nothing else.
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(updater.requestHeaders["User-Agent"], `Umbratic/0.0.3 (${process.platform}; ${process.arch})`);
  assert.equal(updater.checks, 1);
  assert.equal(status.state.phase, "downloading");
  assert.equal(status.state.latestVersion, "0.0.4");
  assert.ok(status.checkedAt);

  updater.emit("download-progress", { percent: 41.6 });
  updater.emit("update-downloaded", { version: "0.0.4" });
  assert.deepEqual(seen.map((entry) => entry.state), [
    { phase: "checking" },
    { phase: "downloading", latestVersion: "0.0.4", percent: 0 },
    { phase: "downloading", latestVersion: "0.0.4", percent: 42 },
    { phase: "ready", latestVersion: "0.0.4" },
  ]);

  // A later failed check does not take a downloaded release away.
  updater.emit("error", new Error("net::ERR_INTERNET_DISCONNECTED"));
  assert.equal(module.appUpdateStatus().state.phase, "ready");

  module.installAppUpdate();
  assert.equal(updater.installs, 1);
});

test("an up-to-date check and a failed check both record when the feed was consulted", async () => {
  const { module, updater, diagnostics } = load({ packaged: true });
  updater.nextCheck = () => {
    updater.emit("update-not-available", { version: "0.0.3" });
    return Promise.resolve(null);
  };
  const current = await module.checkForAppUpdate();
  assert.equal(current.state.phase, "current");
  assert.ok(current.checkedAt);

  updater.nextCheck = () => {
    const failure = new Error("HttpError: 404 https://downloads.umbratic.ai/releases/latest-mac.yml");
    failure.code = "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND";
    updater.emit("error", failure);
    return Promise.reject(failure);
  };
  const failed = await module.checkForAppUpdate();
  // The person reads what went wrong, not the URL and the status code.
  assert.deepEqual(plain(failed.state), { phase: "failed", message: "No release is published for this platform yet" });
  assert.ok(diagnostics.some((entry) => entry.event === "updater.check.failed"));
  // Nothing installs when nothing is ready.
  module.installAppUpdate();
  assert.equal(updater.installs, 0);
});

test("turning automatic checks off is stored and stops the background rhythm", () => {
  const { module, settings } = load({ packaged: true, automatic: true });
  const off = module.setAutomaticAppUpdates(false);
  assert.equal(off.automatic, false);
  assert.equal(settings.automatic, false);
  // Only a real true turns it back on.
  assert.equal(module.setAutomaticAppUpdates("yes").automatic, false);
  assert.equal(module.setAutomaticAppUpdates(true).automatic, true);
  module.stopAppUpdates();
});

test("every check carries the update token the company server last minted", async () => {
  const { module, updater, settings } = load({ packaged: true });
  await module.checkForAppUpdate();
  assert.equal(updater.requestHeaders["X-Umbratic-Update-Token"], "org_test.1787296036.signature");
  assert.match(updater.requestHeaders["User-Agent"], /^Umbratic\/0\.0\.3 /);

  settings.updateFeedToken = "org_test.1787300000.newer";
  await module.checkForAppUpdate();
  assert.equal(updater.requestHeaders["X-Umbratic-Update-Token"], "org_test.1787300000.newer");
});

test("a feed that refuses this installation says so", async () => {
  const { module, updater } = load({ packaged: true });
  updater.nextCheck = () => {
    updater.emit("error", new Error("HttpError: 403 Forbidden"));
    return Promise.reject(new Error("HttpError: 403 Forbidden"));
  };
  const status = await module.checkForAppUpdate();
  assert.deepEqual(plain(status.state), { phase: "failed", message: "This installation is not licensed for updates" });
});
