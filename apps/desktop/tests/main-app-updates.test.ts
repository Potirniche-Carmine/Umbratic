import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const modulePath = new URL("../src/main/appUpdates.ts", import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));
const day = 24 * 60 * 60;

// Minted against the clock rather than written down: a literal stamp would age
// past the grace window one day and fail these tests for nothing to do with
// the code under them.
const stamped = (offsetSeconds) => `org_test.${Math.floor(Date.now() / 1000) + offsetSeconds}.signature`;

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

function load({ packaged, automatic = true, updateFeedToken = stamped(0) }) {
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
  assert.equal(updater.requestHeaders["X-Umbratic-Update-Token"], settings.updateFeedToken);
  assert.match(updater.requestHeaders["User-Agent"], /^Umbratic\/0\.0\.3 /);

  settings.updateFeedToken = stamped(60);
  await module.checkForAppUpdate();
  assert.equal(updater.requestHeaders["X-Umbratic-Update-Token"], settings.updateFeedToken);
});

test("a feed that refuses this installation reports it as a licence, not a fault", async () => {
  const { module, updater } = load({ packaged: true });
  updater.nextCheck = () => {
    updater.emit("error", new Error("HttpError: 403 Forbidden"));
    return Promise.reject(new Error("HttpError: 403 Forbidden"));
  };
  const status = await module.checkForAppUpdate();
  assert.deepEqual(plain(status.state), { phase: "unlicensed" });
});

test("a missing packaged feed identifies the installation problem", async () => {
  const { module, updater } = load({ packaged: true });
  updater.nextCheck = () => {
    const error = Object.assign(new Error("ENOENT: open /app/Resources/app-update.yml"), { code: "ENOENT" });
    updater.emit("error", error);
    return Promise.reject(error);
  };
  assert.deepEqual(plain((await module.checkForAppUpdate()).state), {
    phase: "failed", message: "Update settings are missing. Reinstall Umbratic",
  });
});

test("an installation holding no usable token never reaches the feed at all", async () => {
  const useless = {
    "nothing stored": "",
    "not a token": "not-a-token",
    "no stamp": "org_test..signature",
    "no signature": `org_test.${Math.floor(Date.now() / 1000)}.`,
    "long past the grace window": stamped(-32 * day),
  };
  for (const [why, token] of Object.entries(useless)) {
    const { module, updater } = load({ packaged: true, updateFeedToken: token });
    const status = await module.checkForAppUpdate();
    assert.deepEqual(plain(status.state), { phase: "unlicensed" }, why);
    // The whole point: downloads.umbratic.ai never hears from this machine.
    assert.equal(updater.checks, 0, why);
    // And nothing pretends a check happened.
    assert.equal(status.checkedAt, null, why);
  }
});

test("the local test refuses only what the feed certainly would", async () => {
  // Inside the feed's own thirty days, so it is the feed's question to answer.
  const inside = load({ packaged: true, updateFeedToken: stamped(-29 * day) });
  await inside.module.checkForAppUpdate();
  assert.equal(inside.updater.checks, 1);

  // Past thirty but inside the grace: erring long costs one refused request,
  // where erring short would strand a licensed machine with no way back.
  const grace = load({ packaged: true, updateFeedToken: stamped(-30 * day - 3600) });
  await grace.module.checkForAppUpdate();
  assert.equal(grace.updater.checks, 1);

  // A clock running ahead is somebody else's problem to rule on.
  const skewed = load({ packaged: true, updateFeedToken: stamped(600) });
  await skewed.module.checkForAppUpdate();
  assert.equal(skewed.updater.checks, 1);
});

test("a token arriving after a quiet spell puts the app back on the feed on its own", async () => {
  const { module, updater, settings } = load({ packaged: true, updateFeedToken: "" });
  assert.deepEqual(plain((await module.checkForAppUpdate()).state), { phase: "unlicensed" });
  assert.equal(updater.checks, 0);

  // What a Veil session leaves behind. Nobody presses anything.
  settings.updateFeedToken = stamped(0);
  updater.nextCheck = () => {
    updater.emit("update-not-available", { version: "0.0.3" });
    return Promise.resolve(null);
  };
  const status = await module.checkForAppUpdate();
  assert.equal(updater.checks, 1);
  assert.equal(status.state.phase, "current");
});
