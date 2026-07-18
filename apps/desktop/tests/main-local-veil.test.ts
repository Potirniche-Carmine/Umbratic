import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const localVeil = loadTypeScriptModule(new URL("../src/main/localVeil.ts", import.meta.url));
const plain = (value) => JSON.parse(JSON.stringify(value));

test("managed local Veil receives runtime settings, loopback binding, transient auth, and no telemetry", () => {
  const env = localVeil.localVeilEnvironment(
    {
      mode: "local",
      software: "ollama",
      baseUrl: "http://127.0.0.1:11434/",
      modelId: " llama3.2 ",
      secret: "user-facing-token-is-ignored",
      headers: [{ name: "X-Ignored", value: "ignored" }],
    },
    "127.0.0.1:43123",
    "transient-internal-token",
    64000,
  );

  assert.equal(env.VEIL_ADDR, "127.0.0.1:43123");
  assert.equal(env.VEIL_PROVIDER_PROTOCOL, "ollama");
  assert.equal(env.VEIL_PROVIDER_BASE_URL, "http://127.0.0.1:11434");
  assert.equal(env.VEIL_MODEL, "llama3.2");
  assert.equal(env.VEIL_AUTH_TOKEN, "transient-internal-token");
  assert.equal(env.VEIL_PROVIDER_API_KEY, "");
  assert.equal(env.VEIL_PROVIDER_CHAT_PATH, "");
  assert.equal(env.VEIL_PROVIDER_MODELS_PATH, "");
  assert.equal(env.VEIL_CONTEXT_LENGTH, "64000");
  assert.equal(env.VEIL_MODEL_TIMEOUT, "10m");
  assert.equal(env.VEIL_REQUEST_TIMEOUT, "12m");
  assert.equal(env.VEIL_MAX_OUTPUT_TOKENS, "8192");
  assert.equal(env.VEIL_MAX_BODY_BYTES, "67108864");
  assert.equal(env.VEIL_TELEMETRY_ENABLED, "false");
  assert.equal(env.VEIL_TELEMETRY_STORE_PATH, "");
  assert.notEqual(env.VEIL_AUTH_TOKEN, "user-facing-token-is-ignored");
});

test("managed local Veil source keeps readiness independent of go run output and cleans up Windows process trees", () => {
  const source = fs.readFileSync(new URL("../src/main/localVeil.ts", import.meta.url), "utf8");
  assert.match(source, /probeLocalVeil\(baseUrl, authToken/);
  assert.match(source, /spawn\("taskkill", \["\/pid", String\(child\.pid\), "\/t", "\/f"\]/);
});

test("managed local Veil diagnostics retain safe failure metadata and ignore ordinary stderr", () => {
  assert.deepEqual(
    plain(localVeil.parseLocalVeilDiagnosticLine(
      '2026/07/18 VEIL_DIAGNOSTIC {"level":"error","event":"model.request_failed","failureCode":"model_service_rejected","upstreamStatus":500,"requestBytes":12345}',
    )),
    {
      level: "error",
      event: "veil.model.request_failed",
      data: {
        failureCode: "model_service_rejected",
        upstreamStatus: 500,
        requestBytes: 12345,
      },
    },
  );
  assert.equal(localVeil.parseLocalVeilDiagnosticLine("go: downloading a build dependency"), null);
  assert.equal(localVeil.parseLocalVeilDiagnosticLine("VEIL_DIAGNOSTIC not-json"), null);
});
