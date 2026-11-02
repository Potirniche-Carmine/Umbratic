import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
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
    setFeedURL(options) { updater.feed = options; },
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

function load({ packaged, automatic = true }) {
  const updater = fakeUpdater();
  const settings = { automatic };
  const diagnostics = [];
  const module = loadTypeScriptModule(modulePath, {
    cache: new Map(),
    mocks: {
      electron: { app: { isPackaged: packaged, getVersion: () => "0.0.3" } },
      "electron-updater": { autoUpdater: updater },
      "./storage": {
        readAutomaticAppUpdatesSetting: () => settings.automatic,
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
  assert.equal(updater.feed.provider, "custom");
  assert.equal(updater.feed.updateProvider.name, "ReleaseUpdateProvider");
  assert.equal(updater.disableDifferentialDownload, true);
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
    const failure = new Error("HttpError: 404 https://github.com/Potirniche-Carmine/Umbratic/releases/download/v0.0.4/latest-mac.yml");
    failure.code = "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND";
    updater.emit("error", failure);
    return Promise.reject(failure);
  };
  const failed = await module.checkForAppUpdate();
  // The person reads what went wrong, not the URL and the status code.
  assert.deepEqual(plain(failed.state), { phase: "failed", message: "No release available yet" });
  assert.ok(diagnostics.some((entry) => entry.event === "updater.check.failed"));
  // Nothing installs when nothing is ready.
  module.installAppUpdate();
  assert.equal(updater.installs, 0);
});

test("the real GitHub provider's empty release feed reports that no release is published", async () => {
  const { GitHubProvider } = createRequire(import.meta.url)("electron-updater/out/providers/GitHubProvider");
  const { module, updater } = load({ packaged: true });
  const provider = new GitHubProvider({ owner: "Potirniche-Carmine", repo: "Umbratic" },
    { allowPrerelease: false }, { executor: {}, platform: process.platform });
  provider.httpRequest = async () => '<feed xmlns="http://www.w3.org/2005/Atom"><title>Umbratic releases</title></feed>';
  updater.nextCheck = () => provider.getLatestVersion().catch((error) => {
    updater.emit("error", error);
    throw error;
  });
  assert.deepEqual(plain((await module.checkForAppUpdate()).state), {
    phase: "failed", message: "No release available yet",
  });
  assert.ok(module.appUpdateStatus().checkedAt);
  assert.equal(updater.installs, 0);
});

test("network failures and malformed release feeds remain errors", async () => {
  for (const [error, message] of [
    [new Error("net::ERR_INTERNET_DISCONNECTED"), "Could not reach GitHub releases"],
    [Object.assign(new Error('No element "title"'), { code: "ERR_XML_MISSED_ELEMENT" }), "The update check failed"],
  ]) {
    const { module, updater } = load({ packaged: true });
    updater.nextCheck = () => {
      updater.emit("error", error);
      return Promise.reject(error);
    };
    assert.deepEqual(plain((await module.checkForAppUpdate()).state), { phase: "failed", message });
    assert.equal(updater.installs, 0);
  }
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

test("public updates need no company credential and report GitHub throttling", async () => {
  const { module, updater } = load({ packaged: true });
  await module.checkForAppUpdate();
  assert.deepEqual(Object.keys(updater.requestHeaders), ["User-Agent"]);
  updater.nextCheck = () => {
    const error = new Error("HttpError: 403 Forbidden");
    updater.emit("error", error);
    return Promise.reject(error);
  };
  assert.deepEqual(plain((await module.checkForAppUpdate()).state), {
    phase: "failed", message: "GitHub is limiting update requests. Try again later",
  });
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

test("simultaneous checks share a request and reject invalid release signatures", async () => {
  const { module, updater } = load({ packaged: true });
  let finish;
  updater.nextCheck = () => new Promise((resolve) => { finish = resolve; });
  const first = module.checkForAppUpdate();
  const second = module.checkForAppUpdate();
  assert.equal(updater.checks, 1);
  finish(null);
  await Promise.all([first, second]);
  updater.emit("error", new Error("Publisher certificate mismatch"));
  assert.deepEqual(plain(module.appUpdateStatus().state), {
    phase: "failed", message: "The downloaded release did not verify and was discarded",
  });
});

test("manual checks work with automatic checks off and refresh the checked time", async () => {
  const { module, updater } = load({ packaged: true, automatic: false });
  updater.nextCheck = () => {
    updater.emit("update-not-available", { version: "0.0.1" });
    return Promise.resolve(null);
  };
  const first = await module.checkForAppUpdate();
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = await module.checkForAppUpdate();
  assert.equal(updater.checks, 2);
  assert.equal(second.automatic, false);
  assert.equal(second.state.phase, "current");
  assert.ok(Date.parse(second.checkedAt) > Date.parse(first.checkedAt));
});

test("manual checks preserve a downloading or ready release", async () => {
  const { module, updater } = load({ packaged: true });
  await module.checkForAppUpdate();
  updater.emit("update-available", { version: "0.0.2" });
  assert.equal((await module.checkForAppUpdate()).state.phase, "downloading");
  updater.emit("update-downloaded", { version: "0.0.2" });
  assert.equal((await module.checkForAppUpdate()).state.phase, "ready");
  assert.equal(updater.checks, 1);
  assert.equal(updater.installs, 0);
});

// Exercise the pinned updater implementation, not our EventEmitter stand-in.
test("unsigned Windows packages need no publisher override and signed packages retain verification", async () => {
  const { NsisUpdater } = createRequire(import.meta.url)("electron-updater/out/NsisUpdater");
  for (const publisherName of [undefined, "Umbratic Publisher", ["Umbratic Publisher"]]) {
    const calls = [];
    const updater = {
      configOnDisk: { value: Promise.resolve({ publisherName }) },
      _verifyUpdateCodeSignature: async (...args) => { calls.push(args); return "publisher mismatch"; },
    };
    const result = await NsisUpdater.prototype.verifySignature.call(updater, "downloaded-update.exe");
    if (publisherName === undefined) {
      assert.equal(result, null);
      assert.equal(calls.length, 0);
    } else {
      assert.equal(result, "publisher mismatch");
      assert.deepEqual(calls, [[["Umbratic Publisher"], "downloaded-update.exe"]]);
    }
  }
});
