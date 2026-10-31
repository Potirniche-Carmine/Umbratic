import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

test("a live Veil without a configured model does not expose a usable model", async () => {
  const api = loadTypeScriptModule(new URL("../src/main/modelEndpointRuntime.ts", import.meta.url), {
    mocks: {
      "./endpointConfig": { endpointHealthRoute: () => "https://veil.example/api/health", endpointRequestHeaders: () => ({}) },
      "./providerClient": { getProviderJson: async () => ({ statusCode: 200, json: { status: "ok", state: "model_not_configured", features: ["speech.transcribe"] } }) },
      "./storage": {}, "./veilContext": {},
    },
  });
  const result = await api.checkEndpointHealth({});
  assert.equal(result.status, "unavailable");
  assert.deepEqual(Array.from(result.features), ["speech.transcribe"]);
  assert.equal(result.capabilities, undefined);
});
