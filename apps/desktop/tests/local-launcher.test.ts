import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const launcherUrl = new URL("../../../scripts/run-local-veil.ts", import.meta.url);

test("local launcher matches packaged connection switching behavior", () => {
  const launcher = fs.readFileSync(launcherUrl, "utf8");

  assert.match(launcher, /UMBRATIC_DEFAULT_ENDPOINT_MODE: "local"/);
  assert.match(launcher, /UMBRATIC_ALLOW_ENDPOINT_EDIT:/);
  assert.doesNotMatch(launcher, /UMBRATIC_FORCE_LOCAL_ENDPOINT/);
  assert.doesNotMatch(launcher, /readDotEnv|veilEnvPath|Optional local defaults/);
});


