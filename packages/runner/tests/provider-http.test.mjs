import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const { modelHttpRequest, readBodyText } = loadTypeScriptModule(new URL("../src/provider/http.ts", import.meta.url).pathname);

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  try {
    return await fn(url);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("modelHttpRequest sends JSON body, content length, headers, and exposes the response stream", async () => {
  await withServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions?trace=1");
    assert.equal(request.headers["x-test"], "ok");
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      assert.equal(request.headers["content-length"], Buffer.byteLength(body).toString());
      assert.equal(body, '{"hello":"world"}');
      response.writeHead(202, { "Content-Type": "application/json" });
      response.end('{"accepted":true}');
    });
  }, async (baseUrl) => {
    const response = await modelHttpRequest(`${baseUrl}/v1/chat/completions?trace=1`, {
      method: "POST",
      headers: { "X-Test": "ok" },
      body: '{"hello":"world"}',
    });

    assert.equal(response.statusCode, 202);
    assert.equal(await readBodyText(response.body), '{"accepted":true}');
  });
});

test("modelHttpRequest aborts in-flight requests", async () => {
  await withServer((_request, response) => {
    setTimeout(() => response.end("late"), 250);
  }, async (baseUrl) => {
    const controller = new AbortController();
    const pending = modelHttpRequest(`${baseUrl}/slow`, { method: "GET", signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, /aborted/i);
  });
});

test("readBodyText clips oversized streams at the byte limit", async () => {
  async function* chunks() {
    yield "abc";
    yield Buffer.from("def");
    yield "ghi";
  }

  assert.equal(await readBodyText(chunks(), 5), "abcde");
});

