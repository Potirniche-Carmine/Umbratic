import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const runnerAdapterPath = new URL("../src/main/runnerAdapter.ts", import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));

function electronMock(userData) {
  return {
    app: { getPath: () => userData },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(Buffer.from(value, "utf8").toString("base64"), "utf8"),
      decryptString: (buffer) => Buffer.from(buffer.toString("utf8"), "base64").toString("utf8"),
    },
  };
}

function loadRunnerAdapter(userData) {
  process.env.UMBRATIC_ALLOW_ENDPOINT_EDIT = "true";
  delete process.env.UMBRATIC_MANAGED_ENDPOINT_MODE;
  delete process.env.UMBRATIC_MANAGED_MODEL_API_KEY;
  delete process.env.UMBRATIC_MANAGED_MODEL_BASE_URL;
  delete process.env.UMBRATIC_MANAGED_MODEL_SOFTWARE;
  const cache = new Map();
  const electron = electronMock(userData);
  return {
    adapter: loadTypeScriptModule(runnerAdapterPath, { cache, mocks: { electron } }),
    storage: loadTypeScriptModule(new URL("../src/main/storage.ts", import.meta.url), { cache, mocks: { electron } }),
  };
}

test("buildUmbraticRunnerConfig uses harness route, endpoint headers, enabled tools, and runtime profiles", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-adapter-"));
  const { adapter, storage } = loadRunnerAdapter(userData);

  storage.writeHarnessProfileSetting("sales");
  storage.writeModelEndpointSettings({
    mode: "server",
    software: "vllm",
    baseUrl: "https://veil.example.internal",
    secret: "endpoint-token",
    headers: [{ name: " X-Team ", value: "engineering" }],
  });

  const model = {
    providerId: "company-endpoint",
    providerName: "Umbratic Veil",
    modelId: "veil-managed",
    displayName: "Veil",
    baseUrl: "https://veil.example.internal",
  };
  const task = {
    id: "task-1",
    repositoryId: "repo-1",
    prompt: "Debug a segfault in the C harness",
    workspaceKind: "git",
    workspaceMode: "worktree",
    runtimeProfile: "cmake",
    enabledTools: ["read", "debugger", "bad"],
    worktreePath: "C:/repo/.umbratic/worktree",
  };

  const config = adapter.buildUmbraticRunnerConfig(task, model);
  assert.equal(config.taskId, "task-1");
  assert.equal(config.cwd, "C:/repo/.umbratic/worktree");
  assert.equal(config.permissionMode, "normal");
  assert.deepEqual(plain(config.enabledTools), ["read", "debugger"]);
  assert.deepEqual(plain(config.runtimeProfiles), ["workspace-toolchain", "git", "worktree", "cmake", "debugger"]);
  assert.equal(config.provider.chatEndpointPath, "/api/sales/chat");
  assert.equal(config.provider.apiKey, "endpoint-token");
  assert.deepEqual(plain(config.provider.headers), { "X-Team": "engineering" });
});

test("runtimeEnv prepends workspace-managed runtime directories and hardening vars are stable", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-env-"));
  const { adapter } = loadRunnerAdapter(userData);
  const env = adapter.runtimeEnv("C:/repo");
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";

  assert.match(env[pathKey], /\.umbratic[\\/]runtime/);
  assert.match(env.UV_INSTALL_DIR, /\.umbratic[\\/]runtime[\\/]uv$/);
  assert.equal(env.UV_NO_MODIFY_PATH, "1");
  assert.match(env.UMBRATIC_PYTHON_RUNTIME_GUIDE, /Never verify by running bare `python`/);
});
