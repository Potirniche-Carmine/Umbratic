import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const configModulePath = new URL("../src/config.ts", import.meta.url).pathname;
const plain = (value) => JSON.parse(JSON.stringify(value));

function withRunnerConfig(value, fn) {
  const previous = process.env.UMBRATIC_RUNNER_CONFIG;
  process.env.UMBRATIC_RUNNER_CONFIG = JSON.stringify(value);
  try {
    return fn(loadTypeScriptModule(configModulePath, { cache: new Map() }));
  } finally {
    if (previous === undefined) {
      delete process.env.UMBRATIC_RUNNER_CONFIG;
    } else {
      process.env.UMBRATIC_RUNNER_CONFIG = previous;
    }
  }
}

test("loadRunnerConfig normalizes enabled tools, runtime profiles, headers, and provider URL", () => {
  const loaded = withRunnerConfig(
    {
      taskId: " task-1 ",
      cwd: " C:/workspace ",
      workspaceMode: "worktree",
      runtimeProfiles: ["python", "python", "", "git"],
      permissionMode: "bypass",
      enabledTools: ["read", "bogus", "command", "read"],
      system: "protected system prompt",
      provider: {
        name: " Veil ",
        baseURL: "http://127.0.0.1:8080///",
        chatEndpointPath: " /api/engineering/chat ",
        apiKey: "secret",
        modelId: " veil-managed ",
        headers: {
          " X-Trace ": "trace-id",
          Empty: "",
          Ignored: 42,
        },
        mtls: {
          caPath: " ca.pem ",
          passphrase: " ",
          pinnedServerCertificateSha256: " sha256/AB:CD ",
        },
      },
    },
    (config) => config.loadRunnerConfig(),
  );

  assert.equal(loaded.taskId, "task-1");
  assert.equal(loaded.cwd, "C:/workspace");
  assert.equal(loaded.workspaceMode, "worktree");
  assert.equal(loaded.modelBoundary, "development");
  assert.deepEqual(plain(loaded.runtimeProfiles), ["python", "git"]);
  assert.equal(loaded.permissionMode, "bypass");
  assert.deepEqual(plain(loaded.enabledTools), ["read", "command"]);
  assert.equal(loaded.provider.baseURL, "http://127.0.0.1:8080");
  assert.equal(loaded.provider.chatEndpointPath, "/api/engineering/chat");
  assert.deepEqual(plain(loaded.provider.headers), { "X-Trace": "trace-id" });
  assert.equal(loaded.provider.mtls.caPath, "ca.pem");
  assert.equal(loaded.provider.mtls.passphrase, undefined);
  assert.equal(loaded.system, "protected system prompt");
});

test("loadRunnerConfig defaults invalid modes and all tools when no explicit list is supplied", () => {
  const loaded = withRunnerConfig(
    {
      cwd: "/repo",
      permissionMode: "surprise",
      provider: {
        name: "Veil",
        baseURL: "https://veil.example",
        modelId: "model-a",
      },
    },
    (config) => config.loadRunnerConfig(),
  );

  assert.equal(loaded.workspaceMode, "local");
  assert.equal(loaded.permissionMode, "normal");
  assert.deepEqual(plain(loaded.enabledTools), ["read", "write", "edit", "search", "command"]);
  assert.equal(loaded.provider.apiKey, "local");
});

test("loadRunnerConfig rejects missing config, malformed shapes, and unsupported provider protocols", () => {
  const previous = process.env.UMBRATIC_RUNNER_CONFIG;
  delete process.env.UMBRATIC_RUNNER_CONFIG;
  assert.throws(() => loadTypeScriptModule(configModulePath, { cache: new Map() }).loadRunnerConfig(), /required/);

  process.env.UMBRATIC_RUNNER_CONFIG = JSON.stringify([]);
  assert.throws(() => loadTypeScriptModule(configModulePath, { cache: new Map() }).loadRunnerConfig(), /JSON object/);

  process.env.UMBRATIC_RUNNER_CONFIG = JSON.stringify({
    cwd: "/repo",
    provider: { name: "Veil", baseURL: "file:///tmp/model.sock", modelId: "model" },
  });
  assert.throws(() => loadTypeScriptModule(configModulePath, { cache: new Map() }).loadRunnerConfig(), /HTTP\(S\)/);

  if (previous === undefined) {
    delete process.env.UMBRATIC_RUNNER_CONFIG;
  } else {
    process.env.UMBRATIC_RUNNER_CONFIG = previous;
  }
});

test("loadRunnerConfig enforces managed Veil boundary in managed mode", () => {
  const managed = {
    cwd: "/repo",
    modelBoundary: "managed",
    provider: {
      id: "company-endpoint",
      name: "Veil",
      baseURL: "https://veil.example.internal",
      chatEndpointPath: "/api/engineering/chat",
      modelId: "veil-managed",
    },
  };

  const loaded = withRunnerConfig(managed, (config) => config.loadRunnerConfig());
  assert.equal(loaded.modelBoundary, "managed");
  assert.equal(loaded.provider.id, "company-endpoint");
  assert.equal(loaded.provider.chatEndpointPath, "/api/engineering/chat");

  assert.throws(
    () => withRunnerConfig({ ...managed, provider: { ...managed.provider, id: "ollama" } }, (config) => config.loadRunnerConfig()),
    /company-endpoint/,
  );
  assert.throws(
    () => withRunnerConfig({ ...managed, provider: { ...managed.provider, chatEndpointPath: "/api/chat" } }, (config) => config.loadRunnerConfig()),
    /approved Veil chat route/,
  );
  assert.throws(
    () => withRunnerConfig({ ...managed, provider: { ...managed.provider, chatEndpointPath: "/v1/chat/completions" } }, (config) => config.loadRunnerConfig()),
    /approved Veil chat route/,
  );
  assert.throws(
    () => withRunnerConfig({ ...managed, system: "client-side protected prompt" }, (config) => config.loadRunnerConfig()),
    /client system prompt/,
  );
});
