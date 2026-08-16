import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

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
  delete process.env.UMBRATIC_VEIL_BASE_URL;
  const cache = new Map();
  const electron = electronMock(userData);
  const mocks = { electron, "node:os": { ...os, homedir: () => path.join(userData, "home") } };
  return {
    adapter: loadTypeScriptModule(runnerAdapterPath, { cache, mocks }),
    skills: loadTypeScriptModule(new URL("../src/main/skills.ts", import.meta.url), { cache, mocks }),
    storage: loadTypeScriptModule(new URL("../src/main/storage.ts", import.meta.url), { cache, mocks }),
  };
}

test("harnessRouteConfig maps every profile to its purpose-built Veil API", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-routes-"));
  const { adapter } = loadRunnerAdapter(userData);

  assert.equal(adapter.harnessRouteConfig("engineering").chatEndpointPath, "/api/engineering/chat");
  assert.equal(adapter.harnessRouteConfig("marketing").chatEndpointPath, "/api/marketing/chat");
  assert.equal(adapter.harnessRouteConfig("sales").chatEndpointPath, "/api/sales/chat");
});

test("every harness receives the scratch workspace as its runner directory", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-scratch-"));
  const { adapter, storage } = loadRunnerAdapter(userData);
  const scratchPath = path.join(userData, "workspaces", "scratch", "chat-1");
  const model = {
    providerId: "company-endpoint",
    providerName: "Umbratic Veil",
    modelId: "veil-managed",
    displayName: "Veil",
    baseUrl: "http://127.0.0.1:8080",
  };
  const task = {
    id: "task-scratch",
    repositoryId: "hidden-chat-1",
    prompt: "Create a document",
    workspaceKind: "folder",
    workspaceMode: "local",
    hiddenWorkspace: true,
    enabledTools: ["read", "write"],
    worktreePath: scratchPath,
  };

  for (const profile of ["engineering", "marketing", "sales"]) {
    storage.writeHarnessProfileSetting(profile);
    assert.equal(adapter.buildUmbraticRunnerConfig(task, model).cwd, scratchPath);
  }
});

test("buildUmbraticRunnerConfig uses harness route, endpoint headers, enabled tools, and skill metadata", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-adapter-"));
  const { adapter, storage } = loadRunnerAdapter(userData);

  storage.writeHarnessProfileSetting("sales");
  storage.writeContextLengthSetting(128000);
  storage.writeModelEndpointSettings({
    mode: "server",
    baseUrl: "https://veil.example.internal",
    secret: "endpoint-token",
    headers: [
      { name: "Authorization", value: "internal-shared-token" },
      { name: " X-Team ", value: "engineering" },
    ],
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
    enabledTools: ["read", "unknown-tool", "bad"],
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

  const config = adapter.buildUmbraticRunnerConfig(task, model, "C:/app-data/chat-attachments/chat-1");
  assert.equal(config.taskId, "task-1");
  assert.equal(config.cwd, "C:/repo/.umbratic/worktree");
  assert.equal(config.permissionMode, "normal");
  assert.match(String(config.localDate), /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), /);
  assert.equal(config.contextLength, 128000);
  assert.equal(config.maxResponseTokens, 8192);
  assert.equal(config.protectedPromptReserveTokens, 2048);
  assert.equal(config.attachmentDirectory, "C:/app-data/chat-attachments/chat-1");
  assert.deepEqual(plain(config.enabledTools), ["read"]);
  assert.deepEqual(plain(config.diagnostics), { enabled: false });
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
  // Trusted mode, forwarded from endpoint settings rather than inferred.
  assert.equal(config.provider.mode, "server");
  // The bucket selector is a runtime decision; no bucket field is ever config.
  assert.equal("harness_bucket" in config.provider, false);
  assert.equal("harnessBucket" in config, false);
  assert.equal(config.provider.thinking, "on");
  assert.equal(config.provider.sendThinkingField, false);
  assert.deepEqual(plain(config.provider.capabilities), {
    parallelToolCalls: false,
    vision: false,
    reasoning: false,
  });
  assert.equal("system" in config, false);
  assert.equal(config.provider.apiKey, "");
  assert.deepEqual(plain(config.provider.headers), { "X-Team": "engineering" });
});

test("local mode defaults runner parallel tool capability on", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-local-parallel-"));
  const { adapter, storage } = loadRunnerAdapter(userData);
  storage.writeHarnessProfileSetting("engineering");
  storage.writeModelEndpointSettings({
    mode: "local",
    baseUrl: "http://127.0.0.1:11434",
    secret: "",
    headers: [],
  });

  const config = adapter.buildUmbraticRunnerConfig(
    {
      id: "task-local",
      repositoryId: "repo-1",
      prompt: "Inspect README",
      workspaceKind: "git",
      workspaceMode: "worktree",
      enabledTools: ["read"],
      worktreePath: "C:/repo/.umbratic/worktree",
    },
    {
      providerId: "local-veil",
      providerName: "Local Veil",
      modelId: "veil-managed",
      displayName: "Local",
      baseUrl: "http://127.0.0.1:4317",
    },
  );

  assert.deepEqual(plain(config.provider.capabilities), {
    parallelToolCalls: true,
    vision: false,
    reasoning: false,
  });
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
    contextLength: 32768,
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
  assert.equal(config.skills.some((skill) => skill.id === "umbratic-git-worktree"), true);
  assert.equal(config.skills.some((skill) => skill.id === "umbratic-cmake"), true);
  assert.equal(config.skills.some((skill) => skill.id === "umbratic-presentations"), false);
  assert.equal(config.skills.some((skill) => skill.id === "umbratic-spreadsheets"), false);
  assert.equal(config.provider.chatEndpointPath, "/api/engineering/chat");
  assert.equal(config.contextLength, 32768);
  assert.equal("system" in config, false);
});

test("business harness modes keep their Veil route and the matching business skill catalog", () => {
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
  assert.equal(config.skills.some((skill) => skill.id === "umbratic-git-worktree"), false);
  assert.equal(config.skills.some((skill) => skill.id === "umbratic-cmake"), false);
  assert.equal(config.skills.some((skill) => skill.id === "umbratic-data-analysis"), true);
  assert.equal(config.skills.some((skill) => skill.id === "umbratic-pdf"), true);
  assert.equal(config.skills.some((skill) => skill.id === "umbratic-presentations"), true);
  assert.equal(config.skills.some((skill) => skill.id === "umbratic-marketing-brief"), true);
  assert.equal(config.skills.some((skill) => skill.id === "umbratic-sales-enablement"), false);
  assert.equal(config.provider.chatEndpointPath, "/api/marketing/chat");
  assert.equal("system" in config, false);
});

test("runtimeEnv keeps UV dirs but does not prepend workspace runtime onto PATH", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-env-"));
  const { adapter } = loadRunnerAdapter(userData);
  const previousSystemDrive = process.env.SystemDrive;
  process.env.SystemDrive = "C:";
  const env = (() => {
    try {
      return adapter.runtimeEnv("C:/repo");
    } finally {
      if (previousSystemDrive === undefined) delete process.env.SystemDrive;
      else process.env.SystemDrive = previousSystemDrive;
    }
  })();
  // Windows reports environment names in whatever case the system uses, and it
  // is not consistent across installs: this machine exposes SYSTEMDRIVE while
  // others expose SystemDrive. process.env hides that behind case-insensitive
  // lookup, but runtimeEnv returns a plain object that does not, so the test
  // has to look up the way it already does for PATH.
  const lookup = (name: string) => {
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : env[key];
  };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";

  assert.equal(env[pathKey]?.includes(".umbratic"), false);
  assert.equal(path.relative(path.join(userData, "runtimes"), env.UV_INSTALL_DIR).startsWith(".."), false);
  assert.equal(path.basename(env.UV_INSTALL_DIR), "uv");
  assert.equal(env.UV_CACHE_DIR, path.join(path.dirname(env.UV_INSTALL_DIR), "uv-cache"));
  assert.equal(env.UV_NO_MODIFY_PATH, "1");
  assert.equal(lookup("SystemDrive"), "C:");
  assert.equal("UMBRATIC_RUNNER_CONFIG" in env, false);
  assert.equal(Object.keys(env).some((name) => /token|secret|api[_-]?key|password/i.test(name)), false);
});

test("runnerBinaryPath prefers the packaged runner resource", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-binary-"));
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-resources-"));
  const runnerDir = path.join(resourcesPath, "runner");
  fs.mkdirSync(runnerDir, { recursive: true });
  const binaryPath = path.join(runnerDir, process.platform === "win32" ? "umbratic-runner.exe" : "umbratic-runner");
  fs.writeFileSync(binaryPath, "native runner fixture\n");

  const originalResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  Object.defineProperty(process, "resourcesPath", { configurable: true, value: resourcesPath });
  try {
    const { adapter } = loadRunnerAdapter(userData);
    assert.equal(adapter.runnerBinaryPath(), binaryPath);
  } finally {
    if (originalResourcesPath) {
      Object.defineProperty(process, "resourcesPath", originalResourcesPath);
    } else {
      delete process.resourcesPath;
    }
  }
});

test("runner config enables LSP only for a successful approved probe", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-lsp-"));
  const serverPath = path.join(userData, process.platform === "win32" ? "typescript-language-server.cmd" : "typescript-language-server");
  fs.writeFileSync(serverPath, "fixture");
  const { adapter } = loadRunnerAdapter(userData);
  const model = {
    providerId: "company-endpoint",
    providerName: "Umbratic Veil",
    modelId: "veil-managed",
    displayName: "Veil",
    baseUrl: "http://127.0.0.1:8080",
  };
  const task = {
    id: "task-lsp",
    repositoryId: "repo-1",
    prompt: "Find a definition",
    workspaceKind: "folder",
    workspaceMode: "local",
    enabledTools: ["read", "find", "lsp"],
    worktreePath: userData,
  };
  const baseReport = {
    checkedAt: "2026-01-01T00:00:00.000Z",
    summary: { available: 1, missing: 0, error: 0, unknown: 0, requiredMissing: 0, recommendedMissing: 0, optionalMissing: 0 },
  };
  const available = {
    ...baseReport,
    probes: [{
      id: "typescript-language-server",
      label: "TypeScript language server",
      category: "optional-engineering",
      importance: "optional",
      status: "available",
      executablePath: serverPath,
      purpose: "Code intelligence.",
      installHint: "Install it.",
      workflows: ["code intelligence"],
      checkedAt: baseReport.checkedAt,
    }],
  };
  const enabled = adapter.buildUmbraticRunnerConfig(task, model, undefined, available);
  assert.deepEqual(plain(enabled.enabledTools), ["read", "find", "lsp"]);
  assert.deepEqual(plain(enabled.lspServers), [{
    id: "typescript-language-server",
    command: fs.realpathSync(serverPath),
    args: ["--stdio"],
    languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    extensions: ["ts", "tsx", "js", "jsx"],
  }]);

  const missing = adapter.buildUmbraticRunnerConfig(task, model, undefined, {
    ...baseReport,
    summary: { ...baseReport.summary, available: 0, missing: 1, optionalMissing: 1 },
    probes: [{ ...available.probes[0], status: "missing", executablePath: undefined }],
  });
  assert.deepEqual(plain(missing.enabledTools), ["read", "find"]);
  assert.deepEqual(plain(missing.lspServers), []);
});

test("runner config passes only verified command executables", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-executables-"));
  const { adapter } = loadRunnerAdapter(userData);
  const config = adapter.buildUmbraticRunnerConfig(
    {
      id: "task-executables",
      repositoryId: "repo-1",
      prompt: "Run Python",
      workspaceKind: "folder",
      workspaceMode: "local",
      enabledTools: ["command"],
      worktreePath: userData,
    },
    {
      providerId: "company-endpoint",
      providerName: "Umbratic Veil",
      modelId: "veil-managed",
      displayName: "Veil",
      baseUrl: "http://127.0.0.1:8080",
    },
    undefined,
    {
      checkedAt: "2026-01-01T00:00:00.000Z",
      summary: {
        available: 2,
        missing: 0,
        error: 0,
        unknown: 0,
        requiredMissing: 0,
        recommendedMissing: 0,
        optionalMissing: 0,
      },
      probes: [
        {
          id: "uv",
          label: "uv",
          category: "recommended",
          importance: "recommended",
          status: "available",
          executablePath: process.execPath,
          detectedCommand: "uv",
          purpose: "Python runtime.",
          installHint: "Install uv.",
          workflows: ["Python"],
          checkedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "node-runtime",
          label: "Node",
          category: "required",
          importance: "required",
          status: "available",
          executablePath: process.execPath,
          purpose: "Desktop runtime.",
          installHint: "Bundled.",
          workflows: ["desktop"],
          checkedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "npm",
          label: "npm",
          category: "recommended",
          importance: "recommended",
          status: "available",
          executablePath: process.execPath,
          detectedCommand: "npm",
          purpose: "Node scripts.",
          installHint: "Install Node.",
          workflows: ["verification"],
          checkedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
  );
  assert.deepEqual(plain(config.approvedExecutables), [
    { id: "uv", command: fs.realpathSync(process.execPath) },
    { id: "npm", command: fs.realpathSync(process.execPath) },
  ]);
});

test("the runner names its model only when the server invited it", () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-send-model-"));
  const cache = new Map();
  const electron = electronMock(userData);
  const mocks = { electron, "node:os": { ...os, homedir: () => path.join(userData, "home") } };
  const adapter = loadTypeScriptModule(runnerAdapterPath, { cache, mocks });
  const storage = loadTypeScriptModule(new URL("../src/main/storage.ts", import.meta.url), { cache, mocks });
  const features = loadTypeScriptModule(new URL("../src/main/veilFeatures.ts", import.meta.url), { cache, mocks });

  const task = {
    id: "task-model",
    repositoryId: "repo-1",
    prompt: "Ship it",
    workspaceKind: "git",
    workspaceMode: "local",
    enabledTools: ["read"],
    worktreePath: path.join(userData, "work"),
  };
  const model = (modelId) => ({
    providerId: "company-endpoint",
    providerName: "Umbratic Veil",
    modelId,
    displayName: modelId,
    baseUrl: "https://veil.example.internal",
  });
  const sendModelField = (modelId) =>
    adapter.buildUmbraticRunnerConfig(task, model(modelId)).provider.sendModelField;

  storage.writeModelEndpointSettings({ mode: "server", baseUrl: "https://veil.example.internal", modelId: "qwen3-32b" });

  // A server that never advertised the feature refuses `model` outright.
  features.recordVeilFeatures([]);
  assert.equal(sendModelField("qwen3-32b"), false);

  features.recordVeilFeatures(["chat.model_selection"]);
  assert.equal(sendModelField("qwen3-32b"), true);
  // The sentinel means "no pick", so there is nothing to name.
  assert.equal(sendModelField("veil-managed"), false);

  // Local mode runs one model per Veil process; there is no registry to pick
  // from, and the local Veil refuses the field.
  storage.writeModelEndpointSettings({ mode: "local", baseUrl: "http://127.0.0.1:11434", modelId: "qwen3:8b" });
  assert.equal(sendModelField("qwen3:8b"), false);

  const thinkingConfig = () => adapter.buildUmbraticRunnerConfig(task, model("qwen3-32b")).provider;
  features.recordVeilFeatures([]);
  assert.equal(thinkingConfig().sendThinkingField, false);
  features.recordVeilFeatures(["chat.thinking_toggle"]);
  assert.equal(thinkingConfig().sendThinkingField, true);
  assert.equal(thinkingConfig().thinking, "on");
  storage.writeReasoningEffortSetting("off");
  assert.equal(thinkingConfig().thinking, "off");
  features.recordVeilFeatures(["chat.reasoning_visible"]);
  storage.writeShowThinkingSetting(true);
  storage.writeReasoningEffortSetting("medium");
  assert.equal(thinkingConfig().sendReasoningVisibleField, true);
  assert.equal(thinkingConfig().reasoningVisible, true);
  features.recordVeilFeatures([]);
  assert.equal(thinkingConfig().sendReasoningVisibleField, false);
  storage.writeReasoningEffortSetting("off");
  features.recordVeilFeatures(["chat.reasoning_visible"]);
  assert.equal(thinkingConfig().reasoningVisible, false);
});
