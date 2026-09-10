import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function connectionHarness(apiOverrides = {}) {
  const values = [];
  const effectDeps = [];
  const cleanups = [];
  let cursor = 0;
  let pendingEffects = [];
  const status = { endpoint: "ready", providers: [], endpointConfig: { endpointEditingAllowed: true } };
  const connection = { state: "enrolled", baseUrl: "https://veil.example", orgName: "Example", deviceLabel: "Mac" };
  const calls = [];
  const published = [{ id: "qwen", display: "Qwen", available: true, default: true, contextLength: 65536, reasoningEfforts: [] }];
  const api = {
    getLocalMtp: async () => false,
    getCompanyConnectionStatus: async () => connection,
    getBackendStatus: async () => { calls.push("status"); return status; },
    listServerModels: async () => { calls.push("models"); return published; },
    ...apiOverrides,
  };
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
      return [values[index], (next) => { values[index] = typeof next === "function" ? next(values[index]) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in values)) values[index] = { current: initial };
      return values[index];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (effectDeps[index] && deps.every((value, i) => Object.is(value, effectDeps[index][i]))) return;
      effectDeps[index] = deps;
      pendingEffects.push(() => { cleanups[index]?.(); cleanups[index] = effect(); });
    },
  };
  const module = loadTypeScriptModule(new URL("../src/renderer/ConnectionSettings.tsx", import.meta.url), {
    realm: "host",
    mocks: {
      react: hooks,
      "lucide-react": {},
      "./LocalModelList": { useLocalModelCatalog: () => ({ models: [], reload: async () => {} }) },
      "./CompanyServerActions": {},
      "./Combobox": {},
      "./ComposerControls": { contextBadge: () => "64k" },
    },
  });
  const options = {
    api,
    backend: status,
    initialSettings: { mode: "server", baseUrl: connection.baseUrl, modelId: "veil-managed" },
    initialConnection: connection,
    settingsOpen: true,
    active: true,
    onBackendStatus: (value) => { calls.push("publish-status"); options.backend = value; },
  };
  function render() {
    cursor = 0;
    const result = module.useConnectionSettings(options);
    const effects = pendingEffects;
    pendingEffects = [];
    effects.forEach((effect) => effect());
    return result;
  }
  return { render, calls, published, module, options, cleanup: () => cleanups.forEach((cleanup) => cleanup?.()) };
}

test("opening server settings before enrollment does not request a model list", async (t) => {
  const connection = { state: "not_enrolled" };
  const harness = connectionHarness({ getCompanyConnectionStatus: async () => connection });
  harness.options.initialConnection = connection;
  t.after(harness.cleanup);
  harness.render();
  await new Promise((resolve) => setImmediate(resolve));
  const current = harness.render();
  assert.equal(harness.calls.includes("models"), false);
  assert.equal(current.serverModels.length, 0);
  assert.equal(current.serverModelStatus, "idle");
});

test("an authenticated server without a ready model still offers Disconnect", (t) => {
  const harness = connectionHarness();
  t.after(harness.cleanup);
  harness.options.backend = { ...harness.options.backend, endpoint: "degraded" };
  assert.equal(harness.render().companyServerActive, true);
});

test("refresh reloads the registry even while connection health stays ready", async (t) => {
  const initial = deferred();
  let reads = 0;
  const harness = connectionHarness({ listServerModels: () => ++reads === 1 ? initial.promise : Promise.resolve(harness.published) });
  t.after(harness.cleanup);
  const controller = harness.render();
  await controller.refresh();
  let current = harness.render();
  assert.equal(reads, 2);
  assert.equal(current.serverModels[0].id, "qwen");
  assert.equal(current.serverModels[0].contextLength, 65536);
  assert.equal(current.serverModelStatus, "ready");
  assert.deepEqual(harness.calls, ["status", "publish-status"]);
  initial.resolve([]);
  await new Promise((resolve) => setImmediate(resolve));
  current = harness.render();
  assert.equal(current.serverModels[0].id, "qwen", "a stale opening request must not replace the refreshed list");
  assert.equal(current.refreshing, false);
});

test("both server refresh buttons perform the same complete refresh", (t) => {
  const harness = connectionHarness();
  t.after(harness.cleanup);
  const controller = harness.render();
  let refreshes = 0;
  controller.refresh = () => { refreshes++; };
  const view = harness.module.ConnectionSettingsPanel({ controller });
  const buttons = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (node.type === "button" && ["Check again", "Refresh model list"].includes(node.props["aria-label"])) buttons.push(node);
    visit(node.props?.children);
  }
  visit(view);
  assert.equal(buttons.length, 2);
  buttons.forEach((button) => button.props.onClick());
  assert.equal(refreshes, 2);
});

test("refresh failures clear loading and report the failure", async (t) => {
  const harness = connectionHarness({ getBackendStatus: async () => { throw new Error("Server unavailable"); } });
  t.after(harness.cleanup);
  const controller = harness.render();
  await controller.refresh();
  const current = harness.render();
  assert.equal(current.refreshing, false);
  assert.equal(current.serverModelStatus, "unavailable");
  assert.equal(current.message, "Server unavailable");
});
