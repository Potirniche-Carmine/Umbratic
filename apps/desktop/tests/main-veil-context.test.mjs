import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const veilContext = loadTypeScriptModule(new URL("../src/main/veilContext.ts", import.meta.url));

test("Veil context probing uses the authenticated model context route", async () => {
  let requestedPath = "";
  let authorization = "";
  const server = http.createServer((request, response) => {
    requestedPath = request.url;
    authorization = request.headers.authorization ?? "";
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ context_length: 98304 }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const contextLength = await veilContext.probeVeilContextLength({
      baseUrl: `http://127.0.0.1:${address.port}/api`,
      headers: { Authorization: "Bearer test-token" },
    });
    assert.equal(contextLength, 98304);
    assert.equal(requestedPath, "/api/model/context");
    assert.equal(authorization, "Bearer test-token");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Veil context parsing rejects invalid limits", () => {
  assert.equal(veilContext.contextLengthFromVeilPayload({ context_length: 131072 }), 131072);
  assert.equal(veilContext.contextLengthFromVeilPayload({ context_length: -1 }), null);
  assert.equal(veilContext.contextLengthFromVeilPayload({}), null);
});

test("new chats and changed Veil endpoints trigger a fresh context probe", () => {
  const selected = { baseUrl: "https://veil.example", modelId: "veil-managed" };
  assert.equal(veilContext.shouldProbeVeilContext(undefined, selected), true);
  assert.equal(veilContext.shouldProbeVeilContext({ ...selected, contextLength: 64000 }, selected), false);
  assert.equal(veilContext.shouldProbeVeilContext({ ...selected, baseUrl: "https://old.example", contextLength: 64000 }, selected), true);
});
