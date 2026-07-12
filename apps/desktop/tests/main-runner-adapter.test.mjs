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

test("harnessRouteConfig maps every profile to its purpose-built Veil API", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-routes-"));
  const { adapter } = loadRunnerAdapter(userData);

  assert.equal(adapter.harnessRouteConfig("engineering").chatEndpointPath, "/api/engineering/chat");
  assert.equal(adapter.harnessRouteConfig("marketing").chatEndpointPath, "/api/marketing/chat");
  assert.equal(adapter.harnessRouteConfig("sales").chatEndpointPath, "/api/sales/chat");
});

test("buildUmbraticRunnerConfig uses harness route, endpoint headers, enabled tools, and skill metadata", () => {
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
    enabledTools: ["read", "legacy-tool", "bad"],
    capabilityProbes: [
      {
        id: "uv",
        status: "missing",
        category: "recommended",
        importance: "recommended",
        workflows: ["Python"],
        affectedCurrentRun: true,
      },
    ],
    worktreePath: "C:/repo/.umbratic/worktree",
  };

  const config = adapter.buildUmbraticRunnerConfig(task, model);
  assert.equal(config.taskId, "task-1");
  assert.equal(config.cwd, "C:/repo/.umbratic/worktree");
  assert.equal(config.modelBoundary, "managed");
  assert.equal(config.permissionMode, "normal");
  assert.deepEqual(plain(config.enabledTools), ["read"]);
  assert.equal(config.diagnostics.enabled, true);
  assert.equal(config.diagnostics.includeToolOutput, "stderr");
  assert.equal(config.diagnostics.logPath, path.join(userData, "runner-diagnostics", "task-1.jsonl"));
  assert.deepEqual(plain(config.capabilities), [
    {
      id: "uv",
      status: "missing",
      category: "recommended",
      importance: "recommended",
      workflows: ["Python"],
      affectedCurrentRun: true,
    },
  ]);
  assert.equal(config.runtimeProfiles, undefined);
  assert.equal(config.skills.some((skill) => skill.id === "umbratic-markdown" && skill.source === "system"), true);
  assert.equal(config.skills.every((skill) => typeof skill.name === "string" && typeof skill.description === "string"), true);
  assert.equal(config.skills.every((skill) => !("content" in skill) && !("fullContent" in skill)), true);
  assert.equal(config.provider.chatEndpointPath, "/api/sales/chat");
  assert.equal("system" in config, false);
  assert.equal(config.provider.apiKey, "endpoint-token");
  assert.deepEqual(plain(config.provider.headers), { "X-Team": "engineering" });
});

test("engineering harness mode uses its Veil route without runtime prompt profiles", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-adapter-engineering-"));
  const { adapter, storage } = loadRunnerAdapter(userData);
  storage.writeHarnessProfileSetting("engineering");

  const model = {
    providerId: "company-endpoint",
    providerName: "Umbratic Veil",
    modelId: "veil-managed",
    displayName: "Veil",
    baseUrl: "http://127.0.0.1:8080",
  };
  const task = {
    id: "task-2",
    repositoryId: "repo-1",
    prompt: "Fix a CMake build",
    workspaceKind: "git",
    workspaceMode: "worktree",
    enabledTools: ["read", "command"],
    worktreePath: "/repo/.umbratic/worktree",
  };

  const config = adapter.buildUmbraticRunnerConfig(task, model);
  assert.equal(config.runtimeProfiles, undefined);
  assert.equal(config.skills.some((skill) => skill.id === "umbratic-python"), true);
  assert.equal(config.skills.some((skill) => skill.id === "umbratic-presentations"), true);
  assert.equal(config.provider.chatEndpointPath, "/api/engineering/chat");
  assert.equal(config.modelBoundary, "managed");
  assert.equal("system" in config, false);
});

test("business harness modes use their Veil route with the same enabled skill catalog", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-adapter-markdown-"));
  const { adapter, storage } = loadRunnerAdapter(userData);
  storage.writeHarnessProfileSetting("marketing");

  const model = {
    providerId: "company-endpoint",
    providerName: "Umbratic Veil",
    modelId: "veil-managed",
    displayName: "Veil",
    baseUrl: "http://127.0.0.1:8080",
  };
  const task = {
    id: "task-3",
    repositoryId: "repo-1",
    prompt: "Write a Markdown table for the launch brief",
    workspaceKind: "folder",
    workspaceMode: "local",
    enabledTools: ["read"],
    worktreePath: "/repo",
  };

  const config = adapter.buildUmbraticRunnerConfig(task, model);
  assert.equal(config.runtimeProfiles, undefined);
  assert.equal(config.skills.some((skill) => skill.id === "umbratic-cmake"), true);
  assert.equal(config.provider.chatEndpointPath, "/api/marketing/chat");
  assert.equal(config.modelBoundary, "managed");
  assert.equal("system" in config, false);
});

test("runtimeEnv prepends workspace-managed runtime directories and hardening vars are stable", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-env-"));
  const { adapter } = loadRunnerAdapter(userData);
  const env = adapter.runtimeEnv("C:/repo");
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";

  assert.match(env[pathKey], /\.umbratic[\\/]runtime/);
  assert.match(env.UV_INSTALL_DIR, /\.umbratic[\\/]runtime[\\/]uv$/);
  assert.equal(env.UV_NO_MODIFY_PATH, "1");
});

test("runnerBinaryPath prefers the packaged runner resource", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-binary-"));
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-resources-"));
  const runnerBin = path.join(resourcesPath, "runner", "bin");
  const runnerDist = path.join(resourcesPath, "runner", "dist");
  fs.mkdirSync(runnerBin, { recursive: true });
  fs.mkdirSync(runnerDist, { recursive: true });
  const cliPath = path.join(runnerBin, "umbratic-runner.cjs");
  fs.writeFileSync(cliPath, "#!/usr/bin/env node\n");
  fs.writeFileSync(path.join(runnerDist, "cli.js"), "export {};\n");

  const originalResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  Object.defineProperty(process, "resourcesPath", { configurable: true, value: resourcesPath });
  try {
    const { adapter } = loadRunnerAdapter(userData);
    assert.equal(adapter.runnerBinaryPath(), cliPath);
  } finally {
    if (originalResourcesPath) {
      Object.defineProperty(process, "resourcesPath", originalResourcesPath);
    } else {
      delete process.resourcesPath;
    }
  }
});
