import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const localVeil = loadTypeScriptModule(new URL("../src/main/localVeil.ts", import.meta.url));
const plain = (value) => JSON.parse(JSON.stringify(value));

test("managed local Veil receives runtime settings, loopback binding, transient auth, and no telemetry", () => {
  const previousProxy = process.env.HTTP_PROXY;
  process.env.HTTP_PROXY = "http://evil.example:8080";
  process.env.VEIL_MODEL = "should-not-inherit";
  try {
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
    assert.equal(env.VEIL_ENV_FILE, "-");
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
    assert.equal("HTTP_PROXY" in env, false);
    assert.equal("http_proxy" in env, false);
    assert.equal("HTTPS_PROXY" in env, false);
    assert.equal("ALL_PROXY" in env, false);
    assert.equal(Object.keys(env).every((name) => (
      name.startsWith("VEIL_")
      || ["HOME", "USERPROFILE", "TMP", "TEMP", "TMPDIR", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "LANG", "LC_ALL"].includes(name)
    )), true);
  } finally {
    if (previousProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = previousProxy;
    delete process.env.VEIL_MODEL;
  }
});

test("source development gives Go its Windows build-cache root", () => {
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local";
  try {
    const env = localVeil.localVeilEnvironment(
      {
        mode: "local",
        software: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        modelId: "llama3.2",
        secret: "",
        headers: [],
      },
      "127.0.0.1:43123",
      "transient-internal-token",
      64000,
      { includeGoToolchain: true },
    );

    assert.equal(env.LOCALAPPDATA, "C:\\Users\\test\\AppData\\Local");
  } finally {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
  }
});

test("managed local Veil source keeps readiness independent of go run output and cleans up Windows process trees", () => {
  const source = fs.readFileSync(new URL("../src/main/localVeil.ts", import.meta.url), "utf8");
  assert.match(source, /probeLocalVeil\(baseUrl, authToken/);
  assert.match(source, /response\.statusCode === 200/);
  assert.match(source, /VEIL_ADDR.*127\.0\.0\.1:0|127\.0\.0\.1:0/);
  assert.match(source, /VEIL_ENV_FILE: "-"/);
  assert.match(source, /spawn\("taskkill", \["\/pid", String\(child\.pid\), "\/t", "\/f"\]/);
  assert.equal(source.includes("...process.env"), false);
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

test("local model discovery accepts only bounded model IDs and removes duplicates", () => {
  assert.deepEqual(
    plain(localVeil.parseLocalModelProbeOutput(JSON.stringify([
      { id: "qwen3:8b", context_length: 32768 },
      { id: " llama3.2 " },
      { id: "qwen3:8b" },
      { id: "" },
      { name: "not-an-id" },
    ]))),
    ["llama3.2", "qwen3:8b"],
  );
  assert.throws(
    () => localVeil.parseLocalModelProbeOutput('{"models":[]}'),
    /invalid data/,
  );
});

test("local model discovery returns a safe unavailable state instead of an IPC error", async () => {
  assert.deepEqual(
    plain(await localVeil.probeLocalModels("")),
    { status: "unavailable", models: [] },
  );
});
