import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const policy = loadTypeScriptModule(new URL("../src/main/policy.ts", import.meta.url));
const tools = loadTypeScriptModule(new URL("../src/main/toolSettings.ts", import.meta.url));
const plain = (value) => JSON.parse(JSON.stringify(value));

test("desktop policy detects runtime profiles from realistic prompts", () => {
  assert.equal(policy.runtimeProfileForPrompt("Fix failing pytest in tests/test_api.py"), "python");
  assert.equal(policy.runtimeProfileForPrompt("Update README markdown tables"), "markdown");
  assert.equal(policy.runtimeProfileForPrompt("Debug a segfault in src/main.c with CMake"), "cmake");
  assert.equal(policy.runtimeProfileForPrompt("What is the app called?"), "none");
});

test("desktop command classifier blocks unsafe branches and allows expected tooling", () => {
  const cwd = path.join(os.tmpdir(), "umbratic-desktop-policy");
  const external = process.platform === "win32" ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/hosts";
  const inside = path.join(cwd, "src", "app.ts");
  const cases = [
    ["git diff -- src/main.ts", "git-read", false],
    ["git push --force origin main", "destructive-file", true],
    ["git clean -fd", "destructive-file", true],
    ["Remove-Item -Recurse build", "destructive-file", true],
    ["uv run python script.py", "python-runtime", false],
    ["python script.py", "python-runtime", true],
    ["cmake --build .umbratic/build --parallel", "cmake-build", false],
    ["npm install", "package-manager", true],
    ["curl http://127.0.0.1:8080/api/health", "network", true],
    [process.platform === "win32" ? `type "${external}"` : `cat "${external}"`, "external-directory", true],
    [process.platform === "win32" ? `type "${inside}"` : `cat "${inside}"`, "read", false],
  ];

  for (const [command, commandClass, risky] of cases) {
    const got = policy.classifyCommandText(command, cwd);
    assert.equal(got.commandClass, commandClass, command);
    assert.equal(got.risky, risky, command);
  }
});

test("hardening config asserts provider, model, permission, and tool boundaries", () => {
  const model = {
    providerId: "company-endpoint",
    providerName: "Umbratic Veil",
    modelId: "veil-managed",
    displayName: "Veil",
    baseUrl: "http://127.0.0.1:8080",
  };
  const config = {
    taskId: "task-1",
    cwd: "C:/repo",
    permissionMode: "normal",
    enabledTools: ["read", "search"],
    provider: {
      id: "company-endpoint",
      modelId: "veil-managed",
      baseURL: "http://127.0.0.1:8080",
    },
  };

  assert.doesNotThrow(() => policy.assertUmbraticRunnerConfig(config, model));
  assert.throws(() => policy.assertUmbraticRunnerConfig({ ...config, permissionMode: "bypass" }, model), /permissions/);
  assert.throws(() => policy.assertUmbraticRunnerConfig({ ...config, enabledTools: ["read", "bad"] }, model), /enabled tools/);
});

test("tool settings normalize enabled tools without accepting unknown ids", () => {
  assert.deepEqual(plain(tools.defaultToolSettings()), {
    read: true,
    write: true,
    edit: true,
    search: true,
    command: true,
  });
  assert.deepEqual(plain(tools.normalizeEnabledTools(["command", "bad", "read", "read", "legacy-tool"])), ["read", "command"]);
  assert.deepEqual(plain(tools.toolSettingsFromEnabledTools(["read", "legacy-tool"])), {
    read: true,
    write: false,
    edit: false,
    search: false,
    command: false,
  });
});
