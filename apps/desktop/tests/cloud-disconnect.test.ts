import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const { defaultCloudSettings } = loadTypeScriptModule(new URL("../src/shared/cloud.ts", import.meta.url), { realm: "host" });

test("Codex disconnect uses account/logout and closes its RPC on success and failure", async () => {
  const methods = []; let closed = 0; let fail = false;
  class Rpc {
    async request(method) { methods.push(method); if (method === "account/logout" && fail) throw new Error("Logout failed"); return {}; }
    send() {} close() { closed++; }
  }
  const { codexCloudRuntime } = loadTypeScriptModule(new URL("../src/main/cloudCodex.ts", import.meta.url), {
    realm: "host", mocks: { electron: { shell: {} }, "./cloudTransport": { CloudRpc: Rpc } },
  });
  const settings = defaultCloudSettings(); settings.providers.codex.executable = process.execPath;
  await codexCloudRuntime.signOut(settings, "/preview");
  assert.deepEqual(methods, ["initialize", "account/logout"]); assert.equal(closed, 1);
  fail = true; await assert.rejects(codexCloudRuntime.signOut(settings, "/preview"), /Logout failed/);
  assert.equal(closed, 2);
});

test("Claude disconnect invokes official auth logout without a shell and propagates failure", async () => {
  const calls = []; let fail = false;
  const { claudeCloudRuntime } = loadTypeScriptModule(new URL("../src/main/cloudClaude.ts", import.meta.url), {
    realm: "host", mocks: { "node:child_process": { execFile: (...args) => { calls.push(args.slice(0, 3)); args[3](fail ? new Error("credential detail") : null); } } },
  });
  const settings = defaultCloudSettings(); settings.providers.claude.executable = process.execPath;
  await claudeCloudRuntime.signOut(settings, "/preview");
  assert.equal(calls[0][0], process.execPath); assert.deepEqual(calls[0][1], ["--setting-sources", "", "auth", "logout"]);
  assert.equal(calls[0][2].cwd, "/preview"); assert.equal(calls[0][2].shell, undefined);
  fail = true; await assert.rejects(claudeCloudRuntime.signOut(settings, "/preview"), error => /could not disconnect/.test(error.message) && !/credential/.test(error.message));
});
