import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import afterPack from "../scripts/after-pack.cjs";

const require = createRequire(import.meta.url);
const { Platform } = require("app-builder-lib");
const { load } = require("js-yaml");

test("directory packages include the resolved update feed and Windows publisher checks", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "umbratic-update-package-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = load(await fs.readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  assert.equal(config.afterPack, "scripts/after-pack.cjs");
  for (const platform of [Platform.MAC, Platform.WINDOWS]) {
    const appInfo = { updaterCacheDirName: "umbratic-updater", channel: null };
    const packager = {
      platform, config, appInfo, info: { config, appInfo },
      platformSpecificBuildOptions: {}, expandMacro: (value) => value,
      getResourcesDir: () => root,
      isForceCodeSigningVerification: true,
      signingManager: { value: Promise.resolve({ computedPublisherName: { value: Promise.resolve(["Umbratic Publisher"]) } }) },
    };
    await afterPack({ packager, appOutDir: root, arch: 3, targets: [] });
    const written = load(await fs.readFile(path.join(root, "app-update.yml"), "utf8"));
    assert.equal(written.provider, "github");
    assert.equal(written.owner, "Potirniche-Carmine");
    assert.equal(written.repo, "Umbratic");
    assert.equal(written.private, undefined);
    assert.equal(written.updaterCacheDirName, appInfo.updaterCacheDirName);
    assert.deepEqual(written.publisherName, platform === Platform.WINDOWS ? ["Umbratic Publisher"] : undefined);
  }
});
