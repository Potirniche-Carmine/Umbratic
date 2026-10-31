import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

// Exercise the production orchestrator while controlling SSH startup outcomes.
// The live probe separately verifies OpenSSH and the actual runner binary.
test("remote runners map an independent reverse port to local Veil and retry collisions", async () => {
  const attempts = [];
  const validated = [];
  const stopped = [];
  const ports = [24001, 24001, 24002, 24003, 24004];
  const connection = { id: "host", name: "Test host", platformOs: "Darwin", platformArch: "arm64", runnerSha256: "verified", runnerPath: "/remote/runner" };
  const runner = loadTypeScriptModule(new URL("../src/main/remoteRunner.ts", import.meta.url), {
    mocks: {
      electron: { app: { getPath: () => "/test-data" } },
      "node:crypto": { randomInt: () => ports.shift() - 20000, randomBytes: () => Buffer.from("test-secret") },
      "./localVeil": { currentLocalVeilConnection: () => ({ baseUrl: "http://127.0.0.1:31000" }) },
      "./policy": { assertUmbraticRunnerConfig: (config, model) => { assert.equal(config.provider.baseURL, model.baseUrl); validated.push(model); } },
      "./remoteConnections": { requireStoredRemoteConnection: () => connection, remoteTarget: () => ({}), remoteSecret: () => "" },
      "./remoteHost": { remotePlatformKey: () => "darwin-arm64", remoteRunnerArtifact: () => ({ sha256: "verified" }), remoteCapabilityReport: async () => ({ probes: [] }) },
      "./runnerAdapter": {
        freeLocalPort: async () => 32000,
        buildUmbraticRunnerConfig: (task, model, attachments) => { assert.equal(attachments, undefined); return { provider: { baseURL: model.baseUrl } }; },
      },
      "./sshTransport": { shellCommand: (args) => args.join(" "), spawnSsh: (_target, _root, args) => { const child = { args }; attempts.push(child); return child; } },
      "./storage": { readModelEndpointSettings: () => ({ mode: "local" }) },
      "./runnerLifecycle": {
        awaitRunnerListener: async (_child, expected, config) => {
          const index = attempts.length - 1;
          assert.equal(expected, `http://127.0.0.1:${index === 0 ? 24001 : 24003}`);
          assert.equal(config.provider.baseURL, `http://127.0.0.1:${index === 0 ? 24002 : 24004}`);
          return index === 0 ? { ok: false, output: "remote port forwarding failed", portInUse: true } : { ok: true };
        },
        stopRunnerProcess: (run) => stopped.push(run),
      },
    },
  });
  const model = { baseUrl: "http://127.0.0.1:31000" };
  const run = await runner.startRemoteRunnerServer({ id: "task", remote: { connectionId: "host", directory: "/remote/workspace" } }, model);
  assert.equal(attempts.length, 2);
  assert.equal(stopped.length, 1);
  assert.equal(validated.length, 2);
  assert.equal(model.baseUrl, "http://127.0.0.1:31000");
  assert.equal(run.url, "http://127.0.0.1:32000");
  for (const [index, child] of attempts.entries()) {
    assert.equal(child.args[child.args.indexOf("-R") + 1], `127.0.0.1:${index === 0 ? 24002 : 24004}:127.0.0.1:31000`);
    assert.equal(child.args[child.args.indexOf("-L") + 1], `127.0.0.1:32000:127.0.0.1:${index === 0 ? 24001 : 24003}`);
    assert.ok(child.args.includes("ExitOnForwardFailure=yes"));
  }
});
