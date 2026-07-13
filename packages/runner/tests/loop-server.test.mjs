import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const loopPath = new URL("../src/loop.ts", import.meta.url).pathname;
const serverPath = new URL("../src/server.ts", import.meta.url).pathname;
const contextStorePath = new URL("../src/context/sessionContextStore.ts", import.meta.url).pathname;
const diagnosticsPath = new URL("../src/diagnostics.ts", import.meta.url).pathname;
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

async function waitForFileIncludes(filePath, pattern, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const text = fs.readFileSync(filePath, "utf8");
      if (pattern.test(text)) return text;
    } catch {
      /* The async runner turn has not written diagnostics yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${filePath} to match ${pattern}`);
}

test("runner event coalescer merges adjacent stream text without crossing event boundaries", () => {
  const { createRunnerEventCoalescer } = loadTypeScriptModule(loopPath, { cache: new Map() });
  const emitted = [];
  const events = createRunnerEventCoalescer((event) => emitted.push(event), { intervalMs: 0, maxTextChars: 100 });

  events.emit({ type: "assistant.delta", taskId: "task-1", text: "Hel", at: "2026-01-01T00:00:00.000Z" });
  events.emit({ type: "assistant.delta", taskId: "task-1", text: "lo", at: "2026-01-01T00:00:00.040Z" });
  events.emit({ type: "assistant.reasoning.delta", taskId: "task-1", text: "Think", at: "2026-01-01T00:00:00.080Z" });
  events.emit({ type: "assistant.delta", taskId: "task-1", text: " world", at: "2026-01-01T00:00:00.120Z" });
  events.flush();

  assert.deepEqual(plain(emitted), [
    {
      type: "assistant.delta",
      taskId: "task-1",
      text: "Hello",
      at: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:00.040Z",
    },
    { type: "assistant.reasoning.delta", taskId: "task-1", text: "Think", at: "2026-01-01T00:00:00.080Z" },
    { type: "assistant.delta", taskId: "task-1", text: " world", at: "2026-01-01T00:00:00.120Z" },
  ]);
});

function runnerConfig(cwd, baseURL, overrides = {}) {
  return {
    taskId: "task-1",
    cwd,
    workspaceMode: "local",
    permissionMode: "normal",
    enabledTools: overrides.enabledTools ?? [],
    skills: overrides.skills ?? [],
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
  const { SessionContextStore } = loadTypeScriptModule(contextStorePath, { cache: new Map() });
  return {
    id: "session-1",
    taskId: "task-1",
    config: runnerConfig(cwd, baseURL, overrides),
    messages: [],
    abortController: new AbortController(),
    contextStore: new SessionContextStore(),
  };
}

function sseData(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

test("listen protects local API and returns sessions through authenticated routes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-server-"));
  const diagnosticLogPath = path.join(root, "runner-diagnostics.jsonl");

  await withRunnerConfig({ ...runnerConfig(root, "http://127.0.0.1:9"), diagnostics: { logPath: diagnosticLogPath } }, async () => {
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

      const promptResponse = await fetch(`${run.url}/session/${encodeURIComponent(created.id)}/prompt_async`, {
        method: "POST",
        headers: { Authorization: authHeader("secret"), "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "do not log this token=abcdefghijklmnopqrstuvwxyz" }),
      });
      assert.equal(promptResponse.status, 204);
      const diagnosticText = await waitForFileIncludes(diagnosticLogPath, /"eventType":"runner\.error"/);
      assert.doesNotMatch(diagnosticText, /abcdefghijklmnopqrstuvwxyz/);

      const diagnosticsResponse = await fetch(`${run.url}/diagnostics`, {
        headers: { Authorization: authHeader("secret") },
      });
      assert.equal(diagnosticsResponse.status, 200);
      const diagnostics = await diagnosticsResponse.json();
      assert.equal(diagnostics.enabled, true);
      assert.equal(diagnostics.logPath, diagnosticLogPath);
      assert.equal(diagnostics.exists, true);
      assert.equal(typeof diagnostics.sizeBytes, "number");

      const exportResponse = await fetch(`${run.url}/diagnostics/export`, {
        headers: { Authorization: authHeader("secret") },
      });
      assert.equal(exportResponse.status, 200);
      assert.match(exportResponse.headers.get("content-type"), /application\/x-ndjson/);
      assert.match(await exportResponse.text(), /"eventType":"runner\.error"/);

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

test("runTurn sends Veil skill metadata and exposes read_skill without client system prompts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-loop-"));
  const skillRoot = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-skill-"));
  const instructionPath = path.join(skillRoot, "SKILL.md");
  fs.writeFileSync(instructionPath, "# Python\n\nUse uv.\n", "utf8");
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
      skills: [{ id: "python", name: "Python", description: "Use for Python work.", source: "system", instructionPath }],
    });

    const summary = await runTurn(activeSession, [{ type: "text", text: "Say hi" }], (event) => events.push(event), async () => "allow");

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/api/engineering/chat");
    assert.equal(requests[0].body.model, undefined);
    assert.deepEqual(plain(requests[0].body.skills), [{ id: "python", name: "Python", description: "Use for Python work.", source: "system" }]);
    assert.equal(requests[0].body.tools.some((tool) => tool.function.name === "read_skill"), true);
    assert.deepEqual(plain(requests[0].body.messages.map((message) => message.role)), ["user"]);
    assert.equal(activeSession.messages.at(-1).content, "Hello");
    assert.deepEqual(plain(events.map((event) => event.type)), ["assistant.answer.started", "assistant.delta", "assistant.reasoning.delta"]);
    assert.deepEqual(plain(summary), {
      status: "completed",
      turns: 1,
      assistantTextChars: 5,
      reasoningTextChars: 8,
      toolCalls: 0,
      failedToolCalls: 0,
      attempts: [],
    });
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

    const summary = await runTurn(activeSession, [{ type: "text", text: "Read the notes" }], (event) => events.push(event), async () => "allow");

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
    assert.equal(summary.turns, 2);
    assert.equal(summary.toolCalls, 1);
    assert.equal(summary.failedToolCalls, 0);
  });
});

test("runTurn compresses oversized tool output and exposes retrieve_context on the next request", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-context-loop-"));
  fs.writeFileSync(
    path.join(root, "BIG.md"),
    Array.from({ length: 500 }, (_, index) => `line ${index + 1} ${"x".repeat(100)}`).join("\n"),
    "utf8",
  );
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
                id: "call-read-big",
                function: {
                  name: "read",
                  arguments: JSON.stringify({ filePath: "BIG.md", limit: 500 }),
                },
              }],
            },
          }],
        }) +
          "data: [DONE]\n\n",
      );
      return;
    }
    response.end(sseData({ choices: [{ delta: { content: "Done after compacted read" } }] }) + "data: [DONE]\n\n");
  }, async (baseURL) => {
    const { runTurn } = loadTypeScriptModule(loopPath, { cache: new Map() });
    const events = [];
    const activeSession = session(root, baseURL, { enabledTools: ["read"] });

    await runTurn(activeSession, [{ type: "text", text: "Read the big file" }], (event) => events.push(event), async () => "allow");

    assert.equal(requests.length, 2);
    assert.deepEqual(plain(requests[0].body.tools.map((tool) => tool.function.name)), ["read"]);
    assert.deepEqual(plain(requests[1].body.tools.map((tool) => tool.function.name)), ["read", "retrieve_context"]);
    assert.match(requests[1].body.messages[2].content, /<<umbratic-context:/);
    assert.match(requests[1].body.messages[2].content, /Use retrieve_context with hash/);
    const compressed = events.find((event) => event.type === "context.compressed");
    assert.equal(compressed.toolCallId, "call-read-big");
    assert.equal(compressed.kind, "file");
    assert.equal(compressed.strategy, "text_head_tail");
    assert.equal(activeSession.contextStore.stats().entries, 1);
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
    });

    await runTurn(activeSession, [{ type: "text", text: "Read through Veil" }], (event) => events.push(event), async () => "allow");

    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, "/api/engineering/chat");
    assert.equal(requests[0].body.model, undefined);
    assert.deepEqual(plain(requests[1].body.messages.map((message) => message.role)), ["user", "user"]);
    assert.match(requests[1].body.messages.at(-1).content, /Workspace tool results/);
    assert.match(requests[1].body.messages.at(-1).content, /1: Veil tool context/);
    assert.equal(JSON.stringify(requests[1].body.messages).includes("\"role\":\"tool\""), false);
    assert.equal(requests[1].body.runtime_profiles, undefined);
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

test("runTurn rejects Veil action completions without required tool evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-action-enforcement-"));
  const requests = [];

  await withHttpServer(async (request, response) => {
    requests.push({ url: request.url, body: await readRequestJson(request) });
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      ...(requests.length === 1 ? { "X-Umbratic-Action-Required": "change-and-execute" } : {}),
    });
    response.end(sseData({ choices: [{ delta: {
      content: "I created it and ran it successfully.",
      reasoning_content: `Planning workspace action ${requests.length}`,
    } }] }) + "data: [DONE]\n\n");
  }, async (baseURL) => {
    const { runTurn } = loadTypeScriptModule(loopPath, { cache: new Map() });
    const events = [];
    const activeSession = session(root, baseURL, {
      enabledTools: ["edit", "command"],
      chatEndpointPath: "/api/engineering/chat",
    });

    const summary = await runTurn(
      activeSession,
      [{ type: "text", text: "Create hello.py and verify it works" }],
      (event) => events.push(event),
      async () => "allow",
    );

    assert.equal(requests.length, 3);
    assert.equal(summary.toolCalls, 0);
    assert.equal(events.filter((event) => event.type === "assistant.delta").length, 1);
    const reasoningEvents = events.filter((event) => event.type === "assistant.reasoning.delta");
    assert.equal(reasoningEvents.length, 3);
    assert.equal(reasoningEvents.every((event) => /Planning workspace action/.test(event.text)), true);
    assert.equal(reasoningEvents.some((event) => /created it/i.test(event.text)), false);
    assert.equal(requests[0].body.tool_choice, "auto");
    assert.equal(requests[1].body.tool_choice, "required");
    assert.equal(requests[2].body.tool_choice, "required");
    assert.doesNotMatch(events.find((event) => event.type === "assistant.delta").text, /created it/i);
    assert.match(activeSession.messages.at(-1).content, /couldn't complete the requested workspace action/i);
    assert.equal(fs.existsSync(path.join(root, "hello.py")), false);
  });
});

test("runTurn requires a complete root directory read for exhaustive inspection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-inspection-enforcement-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "README.md"), "Project overview\n");
  fs.writeFileSync(path.join(root, "src", "app.ts"), "export const app = true;\n");
  const requests = [];

  await withHttpServer(async (request, response) => {
    requests.push({ url: request.url, body: await readRequestJson(request) });
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      ...(requests.length === 1 ? { "X-Umbratic-Action-Required": "inspect" } : {}),
    });
    if (requests.length === 1) {
      response.end(sseData({ choices: [{ delta: { reasoning_content: "Planning the complete folder inventory.", tool_calls: [{
        index: 0,
        id: "call-read-one",
        function: { name: "read", arguments: JSON.stringify({ filePath: "README.md" }) },
      }] } }] }) + "data: [DONE]\n\n");
      return;
    }
    if (requests.length === 2) {
      response.end(sseData({ choices: [{ delta: { content: "That covers every file." } }] }) + "data: [DONE]\n\n");
      return;
    }
    if (requests.length === 3) {
      response.end(sseData({ choices: [{ delta: { tool_calls: [{
        index: 0,
        id: "call-read-root",
        function: { name: "read", arguments: JSON.stringify({ filePath: ".", depth: 3 }) },
      }] } }] }) + "data: [DONE]\n\n");
      return;
    }
    response.end(sseData({ choices: [{ delta: { content: "I inspected the complete project inventory." } }] }) + "data: [DONE]\n\n");
  }, async (baseURL) => {
    const { runTurn } = loadTypeScriptModule(loopPath, { cache: new Map() });
    const events = [];
    const activeSession = session(root, baseURL, {
      enabledTools: ["read"],
      chatEndpointPath: "/api/engineering/chat",
    });

    const summary = await runTurn(
      activeSession,
      [{ type: "text", text: "Look at every file and describe what each does" }],
      (event) => events.push(event),
      async () => "allow",
    );

    assert.equal(requests.length, 4);
    assert.equal(summary.toolCalls, 2);
    assert.equal(requests[2].body.tool_choice, "required");
    assert.equal(requests[3].body.tool_choice, "auto");
    assert.doesNotMatch(events.find((event) => event.type === "assistant.delta").text, /covers every file/i);
    assert.equal(activeSession.messages.at(-1).content, "I inspected the complete project inventory.");
    assert.equal(events.filter((event) => event.type === "tool.finished").every((event) => event.status === "success"), true);
  });
});

test("runTurn repairs a malformed initial read for required workspace inventory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-inspection-repair-"));
  fs.writeFileSync(path.join(root, "README.md"), "Project overview\n");
  const requests = [];

  await withHttpServer(async (request, response) => {
    requests.push({ url: request.url, body: await readRequestJson(request) });
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      ...(requests.length === 1 ? { "X-Umbratic-Action-Required": "inspect" } : {}),
    });
    if (requests.length === 1) {
      response.end(sseData({ choices: [{ delta: { reasoning_content: "Planning the complete folder inventory.", tool_calls: [{
        index: 0,
        id: "call-malformed-read",
        function: { name: "read", arguments: 'filePath: "."' },
      }] } }] }) + "data: [DONE]\n\n");
      return;
    }
    if (requests.length === 2) {
      response.end(sseData({ choices: [{ delta: { content: "Let me read the remaining files to give you accurate descriptions:" } }] }) + "data: [DONE]\n\n");
      return;
    }
    response.write(sseData({ choices: [{ delta: { content: "Here is the complete folder inventory" } }] }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    response.end(sseData({ choices: [{ delta: { content: " and a short description of every file." } }] }) + "data: [DONE]\n\n");
  }, async (baseURL) => {
    const { runTurn } = loadTypeScriptModule(loopPath, { cache: new Map() });
    const events = [];
    const activeSession = session(root, baseURL, {
      enabledTools: ["read"],
      chatEndpointPath: "/api/engineering/chat",
    });

    const summary = await runTurn(
      activeSession,
      [{ type: "text", text: "Tell me about this folder and each file in it" }],
      (event) => events.push(event),
      async () => "allow",
    );

    assert.equal(requests.length, 3);
    assert.equal(summary.toolCalls, 1);
    assert.equal(summary.failedToolCalls, 0);
    assert.equal(events.find((event) => event.type === "tool.finished").status, "success");
    assert.equal(events.filter((event) => event.type === "assistant.delta").length, 2);
    assert.equal(events.some((event) => event.type === "assistant.reasoning.delta" && /Planning the complete folder inventory/.test(event.text)), true);
    assert.equal(events.filter((event) => event.type === "assistant.answer.started").length, 1);
    assert.ok(events.findIndex((event) => event.type === "assistant.answer.started") < events.findIndex((event) => event.type === "assistant.delta"));
    assert.equal(activeSession.messages.at(-1).content, "Here is the complete folder inventory and a short description of every file.");
  });
});

test("runTurn continues beyond the former twelve-tool-turn limit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-long-loop-"));
  const requests = [];

  await withHttpServer(async (request, response) => {
    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (requests.length <= 13) {
      response.end(sseData({ choices: [{ delta: { tool_calls: [{
        index: 0,
        id: `call-search-${requests.length}`,
        function: { name: "search", arguments: JSON.stringify({ query: `missing-${requests.length}` }) },
      }] } }] }) + "data: [DONE]\n\n");
      return;
    }
    response.end(sseData({ choices: [{ delta: { content: "Finished after thirteen tool turns" } }] }) + "data: [DONE]\n\n");
  }, async (baseURL) => {
    const { runTurn } = loadTypeScriptModule(loopPath, { cache: new Map() });
    const activeSession = session(root, baseURL, { enabledTools: ["search"] });
    const summary = await runTurn(activeSession, [{ type: "text", text: "Keep working" }], () => undefined, async () => "allow");

    assert.equal(requests.length, 14);
    assert.equal(summary.turns, 14);
    assert.equal(summary.toolCalls, 13);
    assert.equal(activeSession.messages.at(-1).content, "Finished after thirteen tool turns");
  });
});

test("runTurn reserves a tools-disabled final response after the 64-turn safety limit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-tool-budget-"));
  const requests = [];

  await withHttpServer(async (request, response) => {
    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (body.tools) {
      const index = requests.length;
      response.end(sseData({ choices: [{ delta: { tool_calls: [{
        index: 0,
        id: `call-budget-${index}`,
        function: { name: "search", arguments: JSON.stringify({ query: `budget-${index}` }) },
      }] } }] }) + "data: [DONE]\n\n");
      return;
    }
    response.end(sseData({ choices: [{ delta: { content: "Final response without more tools" } }] }) + "data: [DONE]\n\n");
  }, async (baseURL) => {
    const { runTurn } = loadTypeScriptModule(loopPath, { cache: new Map() });
    const activeSession = session(root, baseURL, { enabledTools: ["search"] });
    const summary = await runTurn(activeSession, [{ type: "text", text: "Use the full budget" }], () => undefined, async () => "allow");

    assert.equal(requests.length, 65);
    assert.equal(requests.at(-1).tools, undefined);
    assert.equal(summary.turns, 65);
    assert.equal(summary.toolCalls, 64);
    assert.equal(activeSession.messages.at(-1).content, "Final response without more tools");
  });
});

test("runTurn stops repeated identical tool calls and synthesizes without tools", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-repeated-tool-"));
  fs.writeFileSync(path.join(root, "README.md"), "repeat guard\n", "utf8");
  const requests = [];

  await withHttpServer(async (request, response) => {
    const body = await readRequestJson(request);
    requests.push(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (body.tools) {
      response.end(sseData({ choices: [{ delta: { tool_calls: [{
        index: 0,
        id: `call-repeat-${requests.length}`,
        function: { name: "read", arguments: JSON.stringify({ filePath: "README.md" }) },
      }] } }] }) + "data: [DONE]\n\n");
      return;
    }
    response.end(sseData({ choices: [{ delta: { content: "Stopped repeating and answered" } }] }) + "data: [DONE]\n\n");
  }, async (baseURL) => {
    const { runTurn } = loadTypeScriptModule(loopPath, { cache: new Map() });
    const activeSession = session(root, baseURL, { enabledTools: ["read"] });
    const summary = await runTurn(activeSession, [{ type: "text", text: "Read once" }], () => undefined, async () => "allow");

    assert.equal(requests.length, 4);
    assert.equal(requests.at(-1).tools, undefined);
    assert.equal(summary.toolCalls, 3);
    assert.equal(activeSession.messages.at(-1).content, "Stopped repeating and answered");
  });
});

test("runTurn summarizes failed tool calls for diagnostics", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-tool-failure-summary-"));
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
                id: "call-write-disabled",
                function: {
                  name: "write",
                  arguments: JSON.stringify({ filePath: "out.md", content: "created" }),
                },
              }],
            },
          }],
        }) +
          "data: [DONE]\n\n",
      );
      return;
    }
    response.end(sseData({ choices: [{ delta: { content: "Reported the write failure" } }] }) + "data: [DONE]\n\n");
  }, async (baseURL) => {
    const { runTurn } = loadTypeScriptModule(loopPath, { cache: new Map() });
    const events = [];
    const activeSession = session(root, baseURL, { enabledTools: ["read"] });

    const summary = await runTurn(activeSession, [{ type: "text", text: "Write the file" }], (event) => events.push(event), async () => "allow");

    assert.equal(requests.length, 2);
    assert.equal(summary.turns, 2);
    assert.equal(summary.toolCalls, 1);
    assert.equal(summary.failedToolCalls, 1);
    assert.equal(summary.lastToolFailure.toolKind, "write");
    assert.equal(summary.lastToolFailure.status, "validation_error");
    assert.equal(summary.lastToolFailure.errorCode, "tool_disabled");
    assert.match(summary.lastToolFailure.message, /disabled/);
    assert.deepEqual(plain(summary.attempts), [{
      attempt: 1,
      phase: "tool-validate",
      code: "tool_disabled",
      repairable: false,
      toolId: "write",
      redactedSummary: summary.lastToolFailure.message,
    }]);
    assert.match(events.find((event) => event.type === "tool.output" && event.stream === "stderr").text, /Tool failed/);
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

test("diagnostics write session idle turn summaries with redacted tool failure details", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-runner-idle-diagnostics-"));
  const logPath = path.join(root, "runner.jsonl");
  const { RunnerDiagnostics } = loadTypeScriptModule(diagnosticsPath, { cache: new Map() });
  const diagnostics = new RunnerDiagnostics({ enabled: true, logPath, includeToolOutput: "stderr" }, { cwd: root, taskId: "task-1" });

  diagnostics.record({
    type: "session.idle",
    taskId: "task-1",
    sessionId: "session-1",
    summary: {
      status: "completed",
      turns: 2,
      assistantTextChars: 24,
      reasoningTextChars: 0,
      toolCalls: 1,
      failedToolCalls: 1,
      lastToolFailure: {
        toolKind: "write",
        status: "validation_error",
        errorCode: "tool_disabled",
        message: "Tool failed token=abcdefghijklmnopqrstuvwxyz",
      },
    },
    at: "2026-01-01T00:00:00.000Z",
  });
  await diagnostics.close();

  const row = JSON.parse(fs.readFileSync(logPath, "utf8"));
  assert.equal(row.eventType, "session.idle");
  assert.equal(row.data.sessionId, "session-1");
  assert.equal(row.data.turns, 2);
  assert.equal(row.data.toolCalls, 1);
  assert.equal(row.data.failedToolCalls, 1);
  assert.equal(row.data.lastToolFailure.toolKind, "write");
  assert.equal(row.data.lastToolFailure.errorCode, "tool_disabled");
  assert.doesNotMatch(row.data.lastToolFailure.message, /abcdefghijklmnopqrstuvwxyz/);
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

test("compactToolHistoryMessages compacts prose tool context used by Veil and Ollama", () => {
  const { compactToolHistoryMessages } = loadTypeScriptModule(loopPath, { cache: new Map() });
  const messages = [{ role: "user", content: "Original request" }];
  for (let index = 0; index < 7; index++) {
    messages.push({ role: "user", content: `Workspace tool results:\n\n### search: result-${index} (ok)\n\n${index}` });
  }

  const compacted = compactToolHistoryMessages(messages);
  const summary = compacted.find((message) => message.role === "user" && String(message.content).startsWith("Compacted earlier workspace tool context:"));
  assert.ok(summary);
  assert.match(summary.content, /result-0/);
  assert.match(summary.content, /result-2/);
  assert.equal(compacted.filter((message) => String(message.content).startsWith("Workspace tool results:")).length, 4);
  assert.equal(compacted.at(-1).content.includes("result-6"), true);
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
