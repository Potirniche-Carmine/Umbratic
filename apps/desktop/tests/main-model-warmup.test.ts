import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

function loadWarmup(settings, ensureError) {
  const calls = [];
  const diagnostics = [];
  const warmup = loadTypeScriptModule(new URL("../src/main/modelWarmup.ts", import.meta.url), {
    cache: new Map(),
    mocks: {
      "./diagnostics": {
        recordLocalDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      },
      "./localVeil": {
        ensureLocalVeil: async (...args) => {
          calls.push(args);
          if (ensureError) throw ensureError;
          args[2]({ level: "warn", event: "veil.test", message: "test warning" });
        },
      },
      "./storage": {
        readContextLengthSetting: () => 64000,
        readModelEndpointSettings: () => settings,
      },
    },
  });
  return { warmup, calls, diagnostics };
}

test("startup warm-up loads the configured local model and forwards safe diagnostics", async () => {
  const settings = {
    mode: "local",
    software: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    modelId: "llama3.2",
    secret: "",
    headers: [],
  };
  const state = loadWarmup(settings);

  await state.warmup.warmConfiguredModel();

  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0][0], settings);
  assert.equal(state.calls[0][1], 64000);
  assert.deepEqual(JSON.parse(JSON.stringify(state.diagnostics)), [{
    level: "warn",
    event: "veil.test",
    message: "test warning",
    source: "veil",
  }]);
});

test("startup warm-up leaves server-mode model lifecycle to the server", async () => {
  const state = loadWarmup({
    mode: "server",
    software: "vllm",
    baseUrl: "https://veil.example",
    modelId: "",
    secret: "",
    headers: [],
  });

  await state.warmup.warmConfiguredModel();

  assert.equal(state.calls.length, 0);
});

test("startup warm-up records a safe warning when the local model cannot load", async () => {
  const state = loadWarmup({
    mode: "local",
    software: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    modelId: "missing",
    secret: "",
    headers: [],
  }, "model unavailable");

  await state.warmup.warmConfiguredModel();

  assert.equal(state.calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(state.diagnostics)), [{
    level: "warn",
    source: "desktop",
    event: "startup.model_warmup.failed",
    message: "model unavailable",
  }]);
});

test("desktop model warm-up overlaps renderer loading", async () => {
  const state = loadWarmup({ mode: "server" });
  const events = [];
  let finishWindow;

  const sequence = state.warmup.loadWindowWithModelWarmup(
    () => new Promise((resolve) => {
      events.push("window-started");
      finishWindow = () => {
        events.push("window-loaded");
        resolve();
      };
    }),
    async () => {
      events.push("model-warmup-started");
    },
  );

  assert.deepEqual(events, ["window-started", "model-warmup-started"]);
  finishWindow();
  await sequence;
  assert.deepEqual(events, ["window-started", "model-warmup-started", "window-loaded"]);
});
