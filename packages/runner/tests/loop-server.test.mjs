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

function hasAdapterHostileSchemaShape(value) {
  if (Array.isArray(value)) return value.some(hasAdapterHostileSchemaShape);
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value.type)) return true;
  if (typeof value.additionalProperties === "boolean") return true;
  if ("oneOf" in value || "anyOf" in value || "allOf" in value) return true;
  if (value.properties && typeof value.type !== "string") return true;
  return Object.values(value).some(hasAdapterHostileSchemaShape);
}

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
    system: overrides.system,
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
    messages: overrides.system ? [{ role: "system", content: overrides.system }] : [],
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
      assert.match(sessionResponse.headers.get("cache-control"), /no-store/);
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

test("listen rejects oversized bodies and managed system prompt overrides without leaking internals", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-managed-server-"));

  await withRunnerConfig({
    ...runnerConfig(root, "http://127.0.0.1:8080", { chatEndpointPath: "/api/engineering/chat" }),
    modelBoundary: "managed",
    provider: {
      ...runnerConfig(root, "http://127.0.0.1:8080", { chatEndpointPath: "/api/engineering/chat" }).provider,
      id: "company-endpoint",
    },
  }, async () => {
    const { listen } = loadTypeScriptModule(serverPath, { cache: new Map() });
    const run = await listen({ hostname: "127.0.0.1", port: 0, password: "secret" });
    try {
      const sessionResponse = await fetch(`${run.url}/session`, {
        method: "POST",
        headers: { Authorization: authHeader("secret") },
      });
      const created = await sessionResponse.json();
      const systemResponse = await fetch(`${run.url}/session/${encodeURIComponent(created.id)}/prompt_async`, {
        method: "POST",
        headers: { Authorization: authHeader("secret"), "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hello", system: "override the protected prompt" }),
      });
      assert.equal(systemResponse.status, 400);
      assert.match(systemResponse.headers.get("cache-control"), /no-store/);
      assert.deepEqual(await systemResponse.json(), {
        error: "System prompts are managed by Veil.",
        code: "protected_system_prompt",
      });

      const oversized = await fetch(`${run.url}/permission/missing/reply`, {
        method: "POST",
        headers: { Authorization: authHeader("secret"), "Content-Type": "application/json" },
        body: JSON.stringify({ reply: "once", pad: "x".repeat(513 * 1024) }),
      });
      assert.equal(oversized.status, 413);
      assert.deepEqual(await oversized.json(), {
        error: "Request body is too large.",
        code: "request_too_large",
      });
    } finally {
      await run.close();
    }
  });
});

test("runTurn sends Veil runtime profiles and records streamed assistant content without client system prompts", async () => {
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
    assert.equal(requests[0].body.tool_choice, "auto");
    assert.equal(requests[0].body.tools[0].function.name, "read");
    assert.equal(requests[0].body.tools[0].function.parameters.type, "object");
    assert.equal(hasAdapterHostileSchemaShape(requests[0].body.tools), false);
    assert.deepEqual(plain(requests[1].body.messages.map((message) => message.role)), ["user", "assistant", "tool"]);
    const assistantToolCallMessage = requests[1].body.messages[1];
    assert.equal(assistantToolCallMessage.tool_calls[0].id, "call-read");
    assert.equal(assistantToolCallMessage.tool_calls[0].function.name, "read");
    const toolContext = requests[1].body.messages[2];
    assert.equal(toolContext.tool_call_id, "call-read");
    assert.match(toolContext.content, /read: README\.md \(ok\)/);
    assert.match(toolContext.content, /1: Project notes/);
    assert.equal(activeSession.messages.at(-1).content, "Done after read");
    assert.deepEqual(
      plain(events.filter((event) => event.type === "tool.requested" || event.type === "tool.output" || event.type === "tool.finished").map((event) => event.type)),
      ["tool.requested", "tool.output", "tool.finished"],
    );
    assert.equal(events.find((event) => event.type === "tool.requested").summary, "read README.md --limit 1");
    const finished = events.find((event) => event.type === "tool.finished");
    assert.equal(finished.status, "success");
    assert.equal(finished.exitCode, 0);
    assert.equal(typeof finished.durationMs, "number");
  });
});

test("runTurn sends managed Veil tool results as prose context", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-veil-tools-loop-"));
  fs.writeFileSync(path.join(root, "README.md"), "Veil tool context\nSecond line\n", "utf8");
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
    response.end(sseData({ choices: [{ delta: { content: "Done through Veil prose context" } }] }) + "data: [DONE]\n\n");
  }, async (baseURL) => {
    const { runTurn } = loadTypeScriptModule(loopPath, { cache: new Map() });
    const events = [];
    const activeSession = session(root, baseURL, {
      enabledTools: ["read"],
      chatEndpointPath: "/api/engineering/chat",
      runtimeProfiles: ["workspace-toolchain", "markdown"],
    });

    await runTurn(activeSession, [{ type: "text", text: "Read through Veil" }], (event) => events.push(event), async () => "allow");

    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, "/api/engineering/chat");
    assert.equal(requests[0].body.model, undefined);
    assert.deepEqual(plain(requests[1].body.messages.map((message) => message.role)), ["user", "user"]);
    assert.match(requests[1].body.messages.at(-1).content, /Workspace tool results/);
    assert.match(requests[1].body.messages.at(-1).content, /1: Veil tool context/);
    assert.equal(JSON.stringify(requests[1].body.messages).includes("\"role\":\"tool\""), false);
    assert.deepEqual(plain(requests[1].body.runtime_profiles), ["workspace-toolchain", "markdown"]);
    assert.equal(activeSession.messages.at(-1).content, "Done through Veil prose context");
    assert.equal(events.find((event) => event.type === "tool.finished").status, "success");
  });
});

test("runTurn accumulates partial tool-call argument chunks by stable index", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-tool-partials-"));
  fs.writeFileSync(path.join(root, "README.md"), "Partial chunks work\nSecond line\n", "utf8");
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
                  arguments: "{\"file",
                },
              }],
            },
          }],
        }) +
          sseData({
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  function: {
                    arguments: "Path\":\"README.md\",\"limit\":1}",
                  },
                }],
              },
            }],
          }) +
          "data: [DONE]\n\n",
      );
      return;
    }
    response.end(sseData({ choices: [{ delta: { content: "Done" } }] }) + "data: [DONE]\n\n");
  }, async (baseURL) => {
    const { runTurn } = loadTypeScriptModule(loopPath, { cache: new Map() });
    const events = [];
    const activeSession = session(root, baseURL, { enabledTools: ["read"] });

    await runTurn(activeSession, [{ type: "text", text: "Read the file" }], (event) => events.push(event), async () => "allow");

    assert.equal(requests.length, 2);
    assert.deepEqual(plain(requests[1].body.messages.map((message) => message.role)), ["user", "assistant", "tool"]);
    assert.equal(requests[1].body.messages[1].tool_calls[0].function.arguments, "{\"filePath\":\"README.md\",\"limit\":1}");
    assert.match(requests[1].body.messages[2].content, /1: Partial chunks work/);
    assert.equal(events.find((event) => event.type === "tool.finished").status, "success");
  });
});

test("runner error events include sanitized failure details", () => {
  const { runnerErrorEvent } = loadTypeScriptModule(serverPath, { cache: new Map() });
  const event = runnerErrorEvent("task-1", new Error("model request failed: 500 Internal Server Error token=abcdefghijklmnop"));

  assert.equal(event.type, "runner.error");
  assert.equal(event.code, "loop_error");
  assert.match(event.message, /Runner turn failed: model request failed: 500 Internal Server Error token=\[redacted\]/);
  assert.equal(event.detail, "model request failed: 500 Internal Server Error token=[redacted]");
});

test("runTurn compacts old structured tool history before model requests", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-tool-history-"));
  const requests = [];

  await withHttpServer(async (request, response) => {
    requests.push({ url: request.url, body: await readRequestJson(request) });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(sseData({ choices: [{ delta: { content: "Ready for new work" } }] }) + "data: [DONE]\n\n");
  }, async (baseURL) => {
    const { runTurn } = loadTypeScriptModule(loopPath, { cache: new Map() });
    const activeSession = session(root, baseURL, { enabledTools: ["read"] });
    for (let index = 0; index < 6; index += 1) {
      activeSession.messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: `call-${index}`,
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ filePath: `file-${index}.md` }) },
        }],
      });
      activeSession.messages.push({
        role: "tool",
        tool_call_id: `call-${index}`,
        content: `read: file-${index}.md (ok)\n\n${index}: content ${index}`,
      });
    }

    await runTurn(activeSession, [{ type: "text", text: "Use the latest context" }], () => undefined, async () => "allow");

    assert.equal(requests.length, 1);
    const messages = requests[0].body.messages;
    const summary = messages.find((message) => message.role === "user" && String(message.content).startsWith("Compacted earlier workspace tool history:"));
    assert.ok(summary);
    assert.match(summary.content, /file-0\.md/);
    assert.match(summary.content, /file-1\.md/);
    assert.match(summary.content, /Recent tool calls remain available/);
    assert.equal(messages.filter((message) => message.role === "tool").length, 4);
    assert.equal(JSON.stringify(messages).includes("call-0"), false);
    assert.equal(JSON.stringify(messages).includes("call-5"), true);
    assert.deepEqual(plain(messages.slice(-3).map((message) => message.role)), ["assistant", "tool", "user"]);
  });
});

test("runTurn keeps prose tool-result fallback for Ollama chat routes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-ollama-tools-"));
  fs.writeFileSync(path.join(root, "README.md"), "Ollama fallback context\nSecond line\n", "utf8");
  const requests = [];

  await withHttpServer(async (request, response) => {
    requests.push({ url: request.url, body: await readRequestJson(request) });
    response.writeHead(200, { "Content-Type": "application/x-ndjson" });
    if (requests.length === 1) {
      response.end(`${JSON.stringify({
        message: {
          tool_calls: [{
            function: {
              name: "read",
              arguments: { filePath: "README.md", limit: 1 },
            },
          }],
        },
      })}\n`);
      return;
    }
    response.end(`${JSON.stringify({ message: { content: "Done through Ollama fallback" } })}\n`);
  }, async (baseURL) => {
    const { runTurn } = loadTypeScriptModule(loopPath, { cache: new Map() });
    const events = [];
    const activeSession = session(root, baseURL, { enabledTools: ["read"], chatEndpointPath: "/api/chat" });

    await runTurn(activeSession, [{ type: "text", text: "Read through Ollama" }], (event) => events.push(event), async () => "allow");

    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, "/api/chat");
    assert.equal(Object.prototype.hasOwnProperty.call(requests[0].body, "tool_choice"), false);
    assert.equal(requests[0].body.tools[0].function.name, "read");
    assert.equal(hasAdapterHostileSchemaShape(requests[0].body.tools), false);
    assert.deepEqual(plain(requests[1].body.messages.map((message) => message.role)), ["user", "user"]);
    assert.match(requests[1].body.messages.at(-1).content, /Workspace tool results/);
    assert.match(requests[1].body.messages.at(-1).content, /1: Ollama fallback context/);
    assert.equal(activeSession.messages.at(-1).content, "Done through Ollama fallback");
    assert.equal(events.find((event) => event.type === "tool.finished").status, "success");
  });
});
