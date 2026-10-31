import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { loadReleaseEnv, requireSigningEnvironment } from "../../../scripts/release-env.ts";
import { verifyMacSigningTeam, verifyUpdaterPublisher } from "../../../scripts/ci/release-artifacts.ts";

test("signed release identities cannot omit updater verification or switch Apple developer teams", () => {
  for (const publisherName of [undefined, null, [], ["Other"], ["Umbratic", "Other"], ""]) {
    assert.throws(() => verifyUpdaterPublisher({ publisherName }, "Umbratic"), /publisher/);
  }
  assert.doesNotThrow(() => verifyUpdaterPublisher({ publisherName: "Umbratic" }, "Umbratic"));
  assert.doesNotThrow(() => verifyUpdaterPublisher({ publisherName: ["Umbratic"] }, "Umbratic"));
  assert.throws(() => verifyUpdaterPublisher({ publisherName: "Umbratic" }, ""), /publisher/);
  for (const description of ["", "TeamIdentifier=not set", "TeamIdentifier=OTHER12345"]) {
    assert.throws(() => verifyMacSigningTeam(description, "P3UF4Y6ASK"), /Developer ID team/);
  }
  assert.doesNotThrow(() => verifyMacSigningTeam("Identifier=ai.umbratic.desktop\nTeamIdentifier=P3UF4Y6ASK\n", "P3UF4Y6ASK"));
});

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

test("malformed release environment errors never echo credential contents", (t) => {
  const secret = "pasted-private-credential-without-equals";
  t.mock.method(fs, "readFileSync", () => `# release environment\n\n${secret}`);
  assert.throws(() => loadReleaseEnv(), (error) => {
    assert.match(error.message, /:3: expected KEY=value$/);
    assert.ok(!error.message.includes(secret));
    return true;
  });
});
