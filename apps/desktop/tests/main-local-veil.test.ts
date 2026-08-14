import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const localVeil = loadTypeScriptModule(new URL("../src/main/localVeil.ts", import.meta.url));
const plain = (value) => JSON.parse(JSON.stringify(value));

const runtime = {
  baseUrl: "http://127.0.0.1:43999",
  apiKey: "per-run-llama-secret",
  reasoning: true,
};

test("managed local Veil is pointed at the app's own llama-server with its per-run bearer", () => {
  const previousProxy = process.env.HTTP_PROXY;
  process.env.HTTP_PROXY = "http://evil.example:8080";
  process.env.VEIL_MODEL = "should-not-inherit";
  try {
    const env = localVeil.localVeilEnvironment({
      settings: {
        mode: "local",
        baseUrl: "",
        modelId: " gemma4-e4b ",
        secret: "user-facing-token-is-ignored",
        headers: [{ name: "X-Ignored", value: "ignored" }],
      },
      address: "127.0.0.1:43123",
      authToken: "transient-internal-token",
      runtime,
      contextLength: 64000,
    });

    assert.equal(env.VEIL_ADDR, "127.0.0.1:43123");
    assert.equal(env.VEIL_MODE, "local");
    assert.equal(env.VEIL_MODEL, "gemma4-e4b");
    assert.equal(env.VEIL_AUTH_TOKEN, "transient-internal-token");
    assert.equal(env.VEIL_ENV_FILE, "-");
    // The sidecar's address and secret, not anything the user typed.
    assert.equal(env.VEIL_PROVIDER_BASE_URL, "http://127.0.0.1:43999");
    assert.equal(env.VEIL_PROVIDER_API_KEY, "per-run-llama-secret");
    // The catalog decides whether a thinking directive means anything.
    assert.equal(env.VEIL_MODEL_REASONING, "true");
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

test("a non-reasoning catalog model does not advertise reasoning to Veil", () => {
  const env = localVeil.localVeilEnvironment({
    settings: { mode: "local", baseUrl: "", modelId: "gemma4-e2b", secret: "", headers: [] },
    address: "127.0.0.1:0",
    authToken: "t",
    runtime: { ...runtime, reasoning: false },
  });
  assert.equal(env.VEIL_MODEL_REASONING, "false");
});

test("source development gives Go its Windows build-cache root", () => {
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local";
  try {
    const env = localVeil.localVeilEnvironment({
      settings: { mode: "local", baseUrl: "", modelId: "gemma4-e4b", secret: "", headers: [] },
      address: "127.0.0.1:43123",
      authToken: "transient-internal-token",
      runtime,
      contextLength: 64000,
      includeGoToolchain: true,
    });

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
  // The listen deadline and the health deadline are separate: `go run` compile
  // time must not eat the health probe's window, and a health timeout must
  // blame the model runtime, not Veil.
  assert.match(source, /Timed out waiting for local Veil to report its listening address/);
  assert.match(source, /listening at \$\{baseUrl\} but its health check did not pass/);
  assert.match(source, /model runtime at \$\{runtimeBaseUrl\} to answer/);
  assert.match(source, /VEIL_ADDR.*127\.0\.0\.1:0|127\.0\.0\.1:0/);
  assert.match(source, /VEIL_ENV_FILE: "-"/);
  assert.match(source, /spawn\("taskkill", \["\/pid", String\(child\.pid\), "\/t", "\/f"\]/);
  assert.equal(source.includes("...process.env"), false);
});

test("a changed sidecar restarts Veil, because Veil's environment named the old one", () => {
  const source = fs.readFileSync(new URL("../src/main/localVeil.ts", import.meta.url), "utf8");
  const start = source.indexOf("function localVeilKey(");
  const key = source.slice(start, source.indexOf("\n}", start));
  for (const field of ["modelId", "contextLength", "runtimeBaseUrl", "runtimeApiKey", "reasoning"]) {
    assert.match(key, new RegExp(`${field}[,:]`));
  }
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
