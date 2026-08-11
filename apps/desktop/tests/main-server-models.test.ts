import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const serverModelsPath = new URL("../src/main/serverModels.ts", import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));

async function withVeil(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function provider(baseUrl) {
  return { baseUrl, apiKey: "test-token", headers: {}, mtls: undefined };
}

test("the published registry is read with its metadata and live availability", async () => {
  const { fetchServerModels } = loadTypeScriptModule(serverModelsPath, { cache: new Map() });
  let seenAuthorization = "";
  let seenPath = "";
  await withVeil((request, response) => {
    seenAuthorization = request.headers.authorization ?? "";
    seenPath = request.url ?? "";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      models: [
        { id: "qwen3-32b", display: "Qwen 32B", context_length: 98304, capabilities: { reasoning: true }, available: true, default: true },
        { id: "small", display: "", capabilities: {}, available: false, default: false },
      ],
    }));
  }, async (baseUrl) => {
    const models = plain(await fetchServerModels(provider(baseUrl)));
    assert.equal(seenPath, "/api/models");
    assert.equal(seenAuthorization, "Bearer test-token");
    assert.deepEqual(models, [
      { id: "qwen3-32b", display: "Qwen 32B", contextLength: 98304, reasoning: true, available: true, default: true },
      // A blank display falls back to the id; a missing window is omitted
      // rather than reported as zero.
      { id: "small", display: "small", reasoning: false, available: false, default: false },
    ]);
  });
});

test("a row this build cannot read costs that row, never the whole list", async () => {
  const { fetchServerModels } = loadTypeScriptModule(serverModelsPath, { cache: new Map() });
  await withVeil((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      models: [
        "qwen3-32b",
        { display: "No id here", available: true },
        { id: "   " },
        { id: "good", display: "Good", available: true, quantization: "fp8", served_since: "yesterday" },
      ],
      registry_generation: 4,
    }));
  }, async (baseUrl) => {
    const models = plain(await fetchServerModels(provider(baseUrl)));
    assert.deepEqual(models.map((model) => model.id), ["good"]);
    assert.equal(models[0].display, "Good");
  });
});

test("an unreachable or refusing server lists nothing rather than failing the caller", async () => {
  const { fetchServerModels } = loadTypeScriptModule(serverModelsPath, { cache: new Map() });
  await withVeil((request, response) => {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "unknown route" }));
  }, async (baseUrl) => {
    assert.deepEqual(plain(await fetchServerModels(provider(baseUrl))), []);
  });
  assert.deepEqual(plain(await fetchServerModels(provider("http://127.0.0.1:1"))), []);
});
