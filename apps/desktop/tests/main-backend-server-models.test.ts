import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

function backend(mode, state, sessionError = null, health = { features: ["models.list"] }, globals = {}) {
  const calls = [];
  let settings = { mode, baseUrl: "https://veil.example", modelId: "veil-managed" };
  const mocks = Object.fromEntries([
    "electron", "./mainRuntime", "./config", "./capabilities", "./runnerAdapter",
    "./policy", "./localVeil", "./localLlama", "./localSpeech", "./localModels",
    "./toolSettings", "./appPaths", "./hardware", "./diagnostics", "./telemetry",
    "./telemetrySync", "./skills", "../shared/harnessSkills", "./utils",
  ].map((name) => [name, {}]));
  Object.assign(mocks, {
    electron: { app: { getPath: () => "/tmp" } },
    "./mainRuntime": { activeRunnerProcesses: new Set(), getPermissionMode: () => "ask" },
    "./storage": {
      readModelEndpointSettings: () => settings,
      writeModelEndpointSettings: (value) => { calls.push("settings"); settings = value; return settings; },
      publicModelEndpointSettings: (value) => value,
      readDictationSettings: () => ({}), readToolSettings: () => ({}),
      hasStoredModelEndpointSettings: () => true, readLocalDiagnosticInfo: () => ({}),
    },
    "./companyIdentity": {
      companyConnectionStatus: () => ({ state, baseUrl: settings.baseUrl }),
      ensureCompanySession: async () => { calls.push("session"); if (sessionError) throw sessionError; },
      connectCompanySession: async () => { calls.push("connect"); if (sessionError) throw sessionError; },
      enrollCompanyDevice: async () => { calls.push("enroll"); if (sessionError) throw sessionError; },
    },
    "./endpointConfig": { companyTransportOptions: () => ({}), endpointProvider: () => ({}), configuredEndpointModel: () => ({ baseUrl: settings.baseUrl }) },
    "./modelEndpointRuntime": { checkEndpointHealth: async () => { calls.push("health"); return typeof health === "function" ? health() : health; } },
    "./veilFeatures": { recordVeilFeatures: () => {}, connectedVeilFeatures: () => [], connectedVeilSupports: () => true, veilFeature: { modelsList: "models.list" } },
    "./serverModels": { fetchServerModels: async () => { calls.push("models"); return [{ id: "qwen" }]; } },
    "./localVeil": { stopLocalVeil: () => {} },
    "./localLlama": { stopLocalLlama: () => {} },
    "./config": { managedModelEndpointDefaults: () => null, endpointEditingAllowed: () => true },
    "./capabilities": { probeLocalCapabilities: async () => ({}) },
    "./runnerAdapter": { runnerBinaryPath: () => "/runner", runnerDiagnosticsDirectory: () => "/logs" },
    "./hardware": { systemProfile: async () => ({}) },
    "./policy": { isLocalhostUrl: () => false, telemetryPolicyForMode: () => ({}), runtimeDiagnostics: () => ({}) },
    "./toolSettings": { webToolsEnabled: () => false },
    "./utils": { isRecord: (value) => value && typeof value === "object" },
  });
  return { calls, ...loadTypeScriptModule(new URL("../src/main/backendSettings.ts", import.meta.url), { mocks, globals }) };
}

test("model discovery stays idle in local mode and before company enrollment", async () => {
  for (const [mode, state] of [["local", "enrolled"], ["server", "not_enrolled"]]) {
    const api = backend(mode, state);
    for (let attempt = 0; attempt < 3; attempt++) assert.equal((await api.listServerModels()).length, 0);
    assert.deepEqual(api.calls, [], "idle discovery must not authenticate or contact a server");
  }
});

test("login and enrollment succeed while the model health check is unavailable", async () => {
  for (const operation of ["connectCompanyConnection", "enrollCompanyConnection"]) {
    const api = backend("server", "enrolled", null, { status: "unavailable", message: "Health check failed with 502" });
    const result = await api[operation]({ baseUrl: "https://veil.example", enrollmentCode: "umbr_test" });
    assert.equal(result.connection.state, "enrolled");
    assert.equal(result.settings.mode, "server");
    assert.equal(result.status.endpoint, "degraded");
    assert.equal(result.status.model, null);
    assert.equal(result.status.providers[0].message, "Connected. No model is available yet.");
  }
});

test("the connection timeout ends when authentication finishes, before model health", async () => {
  let deadlineCleared = false;
  const api = backend("server", "enrolled", null, () => {
    assert.equal(deadlineCleared, true);
    return { status: "unavailable" };
  }, { setTimeout: () => 1, clearTimeout: () => { deadlineCleared = true; } });
  await api.connectCompanyConnection();
});

test("a refused login does not switch connection settings", async () => {
  const api = backend("local", "enrolled", new Error("Session refused"));
  await assert.rejects(api.connectCompanyConnection(), /Session refused/);
  assert.deepEqual(api.calls, ["connect"]);
});

test("enrolled discovery authenticates before reading the registry", async () => {
  const api = backend("server", "enrolled");
  assert.equal((await api.listServerModels())[0].id, "qwen");
  assert.deepEqual(api.calls, ["session", "health", "models"]);
});

test("enrolled authentication failures remain visible", async () => {
  const api = backend("server", "enrolled", new Error("Session refused"));
  await assert.rejects(api.listServerModels(), /Session refused/);
  assert.deepEqual(api.calls, ["session"]);
});
