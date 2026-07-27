import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const policy = loadTypeScriptModule(new URL("../src/main/policy.ts", import.meta.url));
const tools = loadTypeScriptModule(new URL("../src/main/toolSettings.ts", import.meta.url));
const plain = (value) => JSON.parse(JSON.stringify(value));

test("desktop policy identifies generated runtime artifacts without creating prompt profiles", () => {
  assert.equal(policy.isGeneratedRuntimePath(".DS_Store"), true);
  assert.equal(policy.isGeneratedRuntimePath("notes/Desktop.ini"), true);
  assert.equal(policy.isGeneratedRuntimePath("%SystemDrive%/ProgramData/Microsoft/Windows/Caches/cversions.2.db"), true);
  assert.equal("runtimeProfileForPrompt" in policy, false);
});

test("local mode disables telemetry while server mode keeps managed redacted sync", () => {
  const local = policy.telemetryPolicyForMode("local");
  const server = policy.telemetryPolicyForMode("server");

  assert.equal(local.mode, "managed_disabled");
  assert.equal(local.syncEnabled, false);
  assert.equal(local.storage, "task-event-snapshots");
  assert.equal(server.mode, "managed_required");
  assert.equal(server.syncEnabled, true);
  assert.equal(server.storage, "company-managed-telemetry");
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
    ["python script.py", "python-runtime", false],
    ["python3 script.py", "python-runtime", false],
    ["py script.py", "python-runtime", false],
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
  assert.equal(policy.runtimeDiagnostics().python.barePythonVerification, "allowed_uv_preferred");
  // Desktop still honors runner safety.action === "allow", but interpreters now Confirm in the runner.
  assert.equal(policy.canAutoResolvePermission("auto_safe", "bash", policy.classifyCommandText("git status", cwd), "allow"), true);
  assert.equal(policy.canAutoResolvePermission("auto_safe", "bash", policy.classifyCommandText("python script.py", cwd), "confirm"), false);
  assert.equal(policy.canAutoResolvePermission("auto_safe", "bash", policy.classifyCommandText("uv run python script.py", cwd), "confirm"), false);
  assert.equal(policy.canAutoResolvePermission("normal", "bash", policy.classifyCommandText("git status", cwd), "allow"), false);
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
    modelBoundary: "managed",
    permissionMode: "normal",
    enabledTools: ["read", "search"],
    lspServers: [],
    provider: {
      id: "company-endpoint",
      modelId: "veil-managed",
      baseURL: "http://127.0.0.1:8080",
      chatEndpointPath: "/api/engineering/chat",
    },
  };

  assert.doesNotThrow(() => policy.assertUmbraticRunnerConfig(config, model));
  assert.throws(() => policy.assertUmbraticRunnerConfig({ ...config, permissionMode: "auto_safe" }, model), /permissions/);
  assert.throws(() => policy.assertUmbraticRunnerConfig({ ...config, enabledTools: ["read", "bad"] }, model), /enabled tools/);
  assert.throws(
    () => policy.assertUmbraticRunnerConfig({ ...config, provider: { ...config.provider, chatEndpointPath: "/api/chat" } }, model),
    /approved Veil chat API/,
  );
  assert.throws(() => policy.assertUmbraticRunnerConfig({ ...config, system: "client prompt" }, model), /protected system prompts/);
});

test("tool settings normalize enabled tools without accepting unknown ids", () => {
  assert.deepEqual(plain(tools.defaultToolSettings()), {
    read: true,
    write: true,
    edit: true,
    search: true,
    lsp: true,
    command: true,
  });
  assert.deepEqual(plain(tools.normalizeEnabledTools(["command", "bad", "read", "read", "legacy-tool"])), ["read", "command"]);
  assert.deepEqual(plain(tools.toolSettingsFromEnabledTools(["read", "legacy-tool"])), {
    read: true,
    write: false,
    edit: false,
    search: false,
    lsp: false,
    command: false,
  });
});

