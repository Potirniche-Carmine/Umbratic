import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const loopPath = new URL("../src/loop.ts", import.meta.url).pathname;
const serverPath = new URL("../src/server.ts", import.meta.url).pathname;
const plain = (value) => JSON.parse(JSON.stringify(value));

async function readRequestJson(request) {
  let text = "";
  for await (const chunk of request) {
    text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : Buffer.from(chunk).toString("utf8");
  }
  return text ? JSON.parse(text) : {};
}

async function withHttpServer(handler, fn) {
  let handlerError = null;
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      handlerError = error;
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const result = await fn(baseUrl);
    if (handlerError) throw handlerError;
    return result;
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function withRunnerConfig(value, fn) {
  const previous = process.env.UMBRATIC_RUNNER_CONFIG;
  process.env.UMBRATIC_RUNNER_CONFIG = JSON.stringify(value);
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.UMBRATIC_RUNNER_CONFIG;
    } else {
      process.env.UMBRATIC_RUNNER_CONFIG = previous;
    }
  }
}

function authHeader(password) {
  return `Basic ${Buffer.from(`umbratic-runner:${password}`).toString("base64")}`;
}

function runnerConfig(cwd, baseURL, overrides = {}) {
  return {
    taskId: "task-1",
    cwd,
    workspaceMode: "local",
    permissionMode: "normal",
    enabledTools: overrides.enabledTools ?? [],
    runtimeProfiles: overrides.runtimeProfiles,
    provider: {
      name: "Veil",
      baseURL,
      chatEndpointPath: overrides.chatEndpointPath,
      apiKey: "local",
      modelId: "model-a",
    },
  };
}

function session(cwd, baseURL, overrides = {}) {
  return {
    id: "session-1",
    taskId: "task-1",
    config: runnerConfig(cwd, baseURL, overrides),
    messages: [],
    abortController: new AbortController(),
  };
}

function sseData(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

test("listen protects local API and returns sessions through authenticated routes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-server-"));

  await withRunnerConfig(runnerConfig(root, "http://127.0.0.1:9"), async () => {
    const { listen } = loadTypeScriptModule(serverPath, { cache: new Map() });
    const run = await listen({ hostname: "127.0.0.1", port: 0, password: "secret" });
    try {
      const unauthorized = await fetch(`${run.url}/session`, { method: "POST" });
      assert.equal(unauthorized.status, 401);

      const sessionResponse = await fetch(`${run.url}/session`, {
        method: "POST",
        headers: { Authorization: authHeader("secret") },
      });
      assert.equal(sessionResponse.status, 200);
      const created = await sessionResponse.json();
      assert.match(created.id, /^session-/);

      const permissionResponse = await fetch(`${run.url}/permission/missing/reply`, {
        method: "POST",
        headers: { Authorization: authHeader("secret"), "Content-Type": "application/json" },
        body: JSON.stringify({ reply: "once" }),
      });
      assert.equal(permissionResponse.status, 404);
      assert.equal(await permissionResponse.json(), false);
    } finally {
      await run.close();
    }
  });
});

test("runTurn sends Veil runtime profiles and records streamed assistant content", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-loop-"));
  const requests = [];

  await withHttpServer(async (request, response) => {
    requests.push({ url: request.url, body: await readRequestJson(request) });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      sseData({ choices: [{ delta: { content: "Hello", reasoning_content: "Thinking" } }] }) +
        "data: [DONE]\n\n",
    );
  }, async (baseURL) => {
    const { runTurn } = loadTypeScriptModule(loopPath, { cache: new Map() });
    const events = [];
    const activeSession = session(root, baseURL, {
      chatEndpointPath: "/api/engineering/chat",
      runtimeProfiles: ["workspace-toolchain", "python"],
    });

    await runTurn(activeSession, [{ type: "text", text: "Say hi" }], (event) => events.push(event), async () => "allow");

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/api/engineering/chat");
    assert.equal(requests[0].body.model, undefined);
    assert.deepEqual(plain(requests[0].body.runtime_profiles), ["workspace-toolchain", "python"]);
    assert.deepEqual(plain(requests[0].body.messages.map((message) => message.role)), ["user"]);
    assert.equal(activeSession.messages.at(-1).content, "Hello");
    assert.deepEqual(plain(events.map((event) => event.type)), ["assistant.delta", "assistant.reasoning.delta"]);
  });
});

test("runTurn executes model tool calls and feeds real tool output into the next request", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-tools-loop-"));
  fs.writeFileSync(path.join(root, "README.md"), "Project notes\nSecond line\n", "utf8");
  const requests = [];

  await withHttpServer(async (request, response) => {
    requests.push({ url: request.url, body: await readRequestJson(request) });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (requests.length === 1) {
      response.end(
        sseData({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call-read",
                function: {
                  name: "read",
                  arguments: JSON.stringify({ filePath: "README.md", limit: 1 }),
                },
              }],
            },
          }],
        }) +
          "data: [DONE]\n\n",
      );
      return;
    }
    response.end(sseData({ choices: [{ delta: { content: "Done after read" } }] }) + "data: [DONE]\n\n");
  }, async (baseURL) => {
    const { runTurn } = loadTypeScriptModule(loopPath, { cache: new Map() });
    const events = [];
    const activeSession = session(root, baseURL, { enabledTools: ["read"] });

    await runTurn(activeSession, [{ type: "text", text: "Read the notes" }], (event) => events.push(event), async () => "allow");

    assert.equal(requests.length, 2);
    const toolContext = requests[1].body.messages.at(-1).content;
    assert.match(toolContext, /Workspace tool results/);
    assert.match(toolContext, /1: Project notes/);
    assert.equal(activeSession.messages.at(-1).content, "Done after read");
    assert.deepEqual(
      plain(events.filter((event) => event.type.startsWith("tool.")).map((event) => event.type)),
      ["tool.requested", "tool.output", "tool.finished"],
    );
    assert.equal(events.find((event) => event.type === "tool.requested").summary, "read README.md --limit 1");
  });
});
