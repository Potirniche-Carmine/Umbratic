import assert from "node:assert/strict";
import test from "node:test";
import { requireSigningEnvironment } from "../../../scripts/release-env.ts";

test("signed packages fail closed on missing credentials and development CPU-only mode", (t) => {
  const names = ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID",
    "UMBRATIC_WIN_SIGN_ENDPOINT", "UMBRATIC_WIN_SIGN_ACCOUNT", "UMBRATIC_WIN_SIGN_PROFILE", "UMBRATIC_WIN_SIGN_PUBLISHER", "UMBRATIC_LLAMA_CPU_ONLY"];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  for (const name of names) delete process.env[name];
  assert.throws(() => requireSigningEnvironment("darwin"), /notarization credentials/);
  assert.throws(() => requireSigningEnvironment("win32"), /release signing is required/);
  process.env.APPLE_ID = "release@example.test";
  process.env.APPLE_TEAM_ID = "TEAM";
  assert.throws(() => requireSigningEnvironment("darwin"), /notarization credentials/);
  process.env.APPLE_APP_SPECIFIC_PASSWORD = "test";
  assert.doesNotThrow(() => requireSigningEnvironment("darwin"));
  process.env.UMBRATIC_LLAMA_CPU_ONLY = "1";
  assert.throws(() => requireSigningEnvironment("darwin"), /cannot be released/);
});
