import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binary = path.join(repositoryRoot, "target", "debug", process.platform === "win32" ? "umbratic-runner.exe" : "umbratic-runner");

function sse(value: unknown) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

async function requestBody(request: http.IncomingMessage) {
  let body = "";
  for await (const chunk of request) body += chunk.toString("utf8");
  return body ? JSON.parse(body) : {};
}

async function startProvider() {
  const requests: Array<{ path?: string; body: Record<string, unknown>; authorization?: string; contentType?: string }> = [];
  const server = http.createServer(async (request, response) => {
    const body = await requestBody(request) as Record<string, unknown>;
    requests.push({
      path: request.url,
      body,
      authorization: request.headers.authorization,
      contentType: request.headers["content-type"],
    });
    if (request.url === "/api/internal/context/compact") {
      const source = JSON.stringify(body.messages ?? []);
      const recalledFacts = Array.from(source.matchAll(/(?:PRIOR_FAILURE|CHANGED_FILE|LAST_VERIFICATION)_\d+/g), (match) => match[0]);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        version: 1,
        summary: [
          "## Goal and current request", recalledFacts.join(" "),
          "## Constraints and decisions", "Keep context bounded and factual.",
          "## Work completed", "Prior work is compacted.",
          "## Files and verification", recalledFacts.join(" "),
          "## Errors or blockers", "Preserve recorded failures.",
          "## Next work", "Continue from the latest request.",
          "bounded factual summary ".repeat(20),
        ].join("\n"),
        sourceDigest: body.sourceDigest,
      }));
      return;
    }
    const encoded = JSON.stringify(body.messages ?? []);
    response.writeHead(200, { "Content-Type": "text/event-stream", "X-Umbratic-Action-Required": encoded.includes("WRITE_FILE") ? "change" : "" });
    if (encoded.includes("READ_FILE") && !encoded.includes("read: README.md (ok)")) {
      response.end(sse({ choices: [{ delta: { content: "Internal plan must stay hidden.", tool_calls: [{ index: 0, id: "read-1", function: { name: "read", arguments: "{\"filePath\":\"README.md\",\"limit\":2}" } }] } }] }) + "data: [DONE]\n\n");
    } else if (encoded.includes("WRITE_FILE") && !encoded.includes("write: note.txt (ok)")) {
      response.end(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "write-1", function: { name: "write", arguments: "{\"filePath\":\"note.txt\",\"content\":\"native write\\n\"}" } }] } }] }) + "data: [DONE]\n\n");
    } else if (encoded.includes("BLOCK_NETWORK") && !encoded.includes("policy_blocked")) {
      response.end(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "command-1", function: { name: "command", arguments: "{\"command\":\"curl https://example.com; printf spawned > blocked-command-spawned.txt\"}" } }] } }] }) + "data: [DONE]\n\n");
    } else if (encoded.includes("DUPLICATE_IDS") && !encoded.includes("read: README.md (ok)")) {
      response.end(sse({ choices: [{ delta: { tool_calls: [
        { index: 0, id: "duplicate", function: { name: "read", arguments: "{\"filePath\":\"README.md\",\"limit\":1}" } },
        { index: 1, id: "duplicate", function: { name: "read", arguments: "{\"filePath\":\"README.md\",\"offset\":2,\"limit\":1}" } },
      ] } }] }) + "data: [DONE]\n\n");
    } else if (encoded.includes("ATTACHMENT_FILE") && !encoded.includes("Read status: complete")) {
      const offsets = Array.from(encoded.matchAll(/continue with offset (\d+)/g), (match) => Number(match[1]));
      const offset = offsets.at(-1) ?? 0;
      response.end(sse({ choices: [{ delta: { tool_calls: [{
        index: 0,
        id: `attachment-${offset}`,
        function: { name: "read_attachment", arguments: JSON.stringify({ attachmentId: "complete-plan.md", offset, limit: 1024 }) },
      }] } }] }) + "data: [DONE]\n\n");
    } else if (encoded.includes("REPEAT_TOOL") && Array.isArray(body.tools)) {
      response.end(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "repeat", function: { name: "read", arguments: "{\"filePath\":\"README.md\",\"limit\":1}" } }] } }] }) + "data: [DONE]\n\n");
    } else if (encoded.includes("MISSING_DONE")) {
      response.end(sse({ choices: [{ delta: { content: "incomplete" } }] }));
    } else if (encoded.includes("DONE_WITHOUT_NEWLINE")) {
      response.end(sse({ choices: [{ delta: { content: "complete without newline" } }] }) + "data:[DONE]");
    } else if (encoded.includes("SPLIT_UTF8")) {
      const payload = Buffer.from(sse({ choices: [{ delta: { content: "café" } }] }) + "data: [DONE]\n\n", "utf8");
      const marker = Buffer.from("é", "utf8");
      const markerIndex = payload.indexOf(marker);
      response.write(payload.subarray(0, markerIndex + 1));
      setImmediate(() => response.end(payload.subarray(markerIndex + 1)));
    } else {
      response.end(sse({ choices: [{ delta: { content: "Native runner complete." } }] }) + sse({ choices: [], usage: { prompt_tokens: 16, completion_tokens: 4 } }) + "data: [DONE]\n\n");
    }
  });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function config(
  cwd: string,
  providerUrl: string,
  diagnosticLogPath: string,
  modelBoundary = "managed",
  overrides: Record<string, unknown> = {},
) {
  return {
    taskId: "native-test-task",
    cwd,
    workspaceMode: "local",
    modelBoundary,
    permissionMode: "normal",
    enabledTools: ["read", "write", "edit", "search", "command"],
    diagnostics: { enabled: true, logPath: diagnosticLogPath, includeToolOutput: "stderr" },
    provider: { id: "company-endpoint", name: "Test Veil", baseURL: providerUrl, chatEndpointPath: "/api/engineering/chat", apiKey: "local", modelId: "test" },
    ...overrides,
  };
}

async function startRunner(
  cwd: string,
  providerUrl: string,
  diagnosticLogPath: string,
  modelBoundary = "managed",
  overrides: Record<string, unknown> = {},
) {
  const password = "native-test-secret";
  const child = spawn(binary, ["serve", "--hostname=127.0.0.1", "--port=0", `--password=${password}`], {
    cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify(config(cwd, providerUrl, diagnosticLogPath, modelBoundary, overrides)));
  let output = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`runner startup timed out: ${output}`)), 5_000);
    const inspect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = output.match(/runner listening on\s+(http:\/\/\S+)/i);
      if (match?.[1]) { clearTimeout(timer); resolve(match[1]); }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", reject);
  });
  const authorization = `Basic ${Buffer.from(`umbratic-runner:${password}`).toString("base64")}`;
  const request = (route: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", authorization);
    return fetch(new URL(route, url), { ...init, headers });
  };
  return {
    child, url, request,
    async close() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    },
  };
}

async function eventCollector(run: Awaited<ReturnType<typeof startRunner>>) {
  const response = await run.request("/event");
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const events: Record<string, unknown>[] = [];
  const waiters: Array<{ predicate(event: Record<string, unknown>): boolean; resolve(event: Record<string, unknown>): void }> = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pump = (async () => {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split(/\r?\n/).find((line) => line.startsWith("data: "))?.slice(6);
        if (data) {
          const event = JSON.parse(data) as Record<string, unknown>;
          events.push(event);
          for (const waiter of [...waiters]) if (waiter.predicate(event)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event); }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  })();
  return {
    events,
    waitFor(predicate: (event: Record<string, unknown>) => boolean) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for runner event; observed ${events.map((event) => `${event.type}:${event.toolCallId ?? event.sessionId ?? ""}:${event.status ?? ""}:${event.errorMessage ?? ""}`).join(", ")}`)), 5_000);
        waiters.push({ predicate, resolve(event) { clearTimeout(timer); resolve(event); } });
      });
    },
    async close() { await reader.cancel(); await pump.catch(() => undefined); },
  };
}

async function createSession(run: Awaited<ReturnType<typeof startRunner>>, contextState?: unknown) {
  const response = await run.request("/session", {
    method: "POST",
    ...(contextState === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contextState }) }),
  });
  if (response.status !== 200) {
    throw new Error(`session create failed ${response.status}: ${await response.text()}`);
  }
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  return response.json() as Promise<{ id: string }>;
}

test("native runner semantically compacts a durable prefix and persists the validated handoff", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-native-compaction-"));
  const provider = await startProvider();
  const run = await startRunner(cwd, provider.url, path.join(cwd, "runner.jsonl"), "managed", {
    contextLength: 10_000,
    maxResponseTokens: 4_096,
    protectedPromptReserveTokens: 2_048,
  });
  const events = await eventCollector(run);
  try {
    const bootstrap = await createSession(run);
    assert.equal((await prompt(run, bootstrap.id, `old context ${"x".repeat(12_000)}`)).status, 204);
    await events.waitFor((event) => event.type === "session.idle" && event.sessionId === bootstrap.id);
    const bootstrapSnapshot = await run.request(`/session/${bootstrap.id}/context`);
    assert.equal(bootstrapSnapshot.status, 200);
    const contextState = await bootstrapSnapshot.json();
    const session = await createSession(run, contextState);
    assert.equal((await prompt(run, session.id, `latest request ${"z".repeat(15_000)}`)).status, 204);
    await events.waitFor((event) => event.type === "session.idle" && event.sessionId === session.id);
    assert.ok(provider.requests.some((request) => request.path === "/api/internal/context/compact"));
    const snapshotResponse = await run.request(`/session/${session.id}/context`);
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json() as { summary?: string; usage: { compactionCount: number }; tail: Array<{ role: string }> };
    assert.match(snapshot.summary ?? "", /bounded factual summary/);
    assert.equal(snapshot.usage.compactionCount, 1);
    assert.equal(snapshot.tail[0]?.role, "user");
  } finally {
    await events.close();
    await run.close();
    await provider.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("32K and 64K compaction evaluation preserves latest-request recall without overflow", async () => {
  for (const contextLength of [32_000, 64_000]) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `umbratic-context-${contextLength}-`));
    const provider = await startProvider();
    const run = await startRunner(cwd, provider.url, path.join(cwd, "runner.jsonl"), "managed", {
      contextLength,
      maxResponseTokens: 8_192,
      protectedPromptReserveTokens: 2_048,
    });
    const events = await eventCollector(run);
    try {
      const session = await createSession(run);
      const priorMarker = `PRIOR_FAILURE_${contextLength}`;
      const changedFileMarker = `CHANGED_FILE_${contextLength}`;
      const verificationMarker = `LAST_VERIFICATION_${contextLength}`;
      let latestMarker = "";
      let idleCount = 0;
      for (let turn = 0; turn < 40 && !provider.requests.some((request) => request.path === "/api/internal/context/compact"); turn += 1) {
        latestMarker = `LATEST_REQUEST_RECALL_${contextLength}_${turn}`;
        const durableFacts = turn === 0 ? `${priorMarker} ${changedFileMarker} ${verificationMarker} ` : "";
        assert.equal((await prompt(run, session.id, `${durableFacts}${latestMarker} ${"q".repeat(7_000)}`)).status, 204);
        idleCount += 1;
        const deadline = Date.now() + 5_000;
        while (events.events.filter((event) => event.type === "session.idle" && event.sessionId === session.id).length < idleCount) {
          if (Date.now() >= deadline) throw new Error(`timed out waiting for turn ${turn} at ${contextLength}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }

      const compactRequests = provider.requests.filter((request) => request.path === "/api/internal/context/compact");
      assert.equal(compactRequests.length, 1, `${contextLength} should compact exactly once`);
      const finalChat = provider.requests.filter((request) => request.path === "/api/engineering/chat").at(-1);
      assert.ok(finalChat);
      const finalMessages = JSON.stringify(finalChat.body.messages ?? []);
      assert.match(finalMessages, new RegExp(latestMarker));
      assert.match(finalMessages, /bounded factual summary/);
      assert.match(finalMessages, new RegExp(priorMarker));
      assert.match(finalMessages, new RegExp(changedFileMarker));
      assert.match(finalMessages, new RegExp(verificationMarker));
      assert.doesNotMatch(finalMessages, /context_window_full|context_overflow/);
      const snapshotResponse = await run.request(`/session/${session.id}/context`);
      const snapshotText = await snapshotResponse.text();
      assert.ok(Buffer.byteLength(snapshotText, "utf8") <= 128 * 1024);
      const snapshot = JSON.parse(snapshotText) as {
        sourceDigest: string;
        usage: { compactionCount: number; estimatedPromptTokens: number };
      };
      assert.match(snapshot.sourceDigest, /^[a-f0-9]{64}$/);
      assert.equal(snapshot.usage.compactionCount, 1);
      assert.ok(snapshot.usage.estimatedPromptTokens < contextLength);
      console.log(JSON.stringify({ contextLength, turns: idleCount, compactions: 1, snapshotBytes: Buffer.byteLength(snapshotText, "utf8"), overflowCount: 0 }));
    } finally {
      await events.close();
      await run.close();
      await provider.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
});

async function prompt(run: Awaited<ReturnType<typeof startRunner>>, id: string, text: string) {
  return run.request(`/session/${id}/prompt_async`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: text }) });
}

test("native runner preserves authenticated API, streaming tools, permissions, policy, and diagnostics", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-native-runner-"));
  fs.writeFileSync(path.join(cwd, "README.md"), "first\nsecond\n", "utf8");
  const logPath = path.join(cwd, "runner.jsonl");
  const provider = await startProvider();
  const run = await startRunner(cwd, provider.url, logPath);
  let events: Awaited<ReturnType<typeof eventCollector>> | undefined;
  try {
    assert.equal((await fetch(new URL("/session", run.url), { method: "POST" })).status, 401);
    events = await eventCollector(run);

    const readSession = await createSession(run);
    assert.equal((await prompt(run, readSession.id, "READ_FILE")).status, 204);
    const readFinished = await events.waitFor((event) => event.type === "tool.finished" && event.toolCallId === "read-1");
    assert.equal(readFinished.status, "success");
    const observedUsage = await events.waitFor((event) => event.type === "context.usage" && event.source === "provider");
    assert.deepEqual(
      {
        contentTokens: observedUsage.contentTokens,
        promptTokens: observedUsage.promptTokens,
        completionTokens: observedUsage.completionTokens,
        reserveTokens: observedUsage.reserveTokens,
        estimatedTokens: observedUsage.estimatedTokens,
        phase: observedUsage.phase,
      },
      { contentTokens: 16, promptTokens: 16, completionTokens: 4, reserveTokens: 8192, estimatedTokens: 8208, phase: "observed" },
    );
    await events.waitFor((event) => event.type === "session.idle" && event.sessionId === readSession.id);
    assert.equal(
      events.events.some((event) => event.type === "assistant.delta" && event.text === "Internal plan must stay hidden."),
      false,
      "provisional prose from a tool-call response must not escape as a final answer",
    );

    const writeSession = await createSession(run);
    assert.equal((await prompt(run, writeSession.id, "WRITE_FILE")).status, 204);
    const permission = await events.waitFor((event) => event.type === "permission.requested" && typeof event.permissionId === "string");
    const reply = await run.request(`/permission/${permission.permissionId}/reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reply: "once" }) });
    assert.equal(reply.status, 200);
    await events.waitFor((event) => event.type === "session.idle" && event.sessionId === writeSession.id);
    assert.equal(fs.readFileSync(path.join(cwd, "note.txt"), "utf8"), "native write\n");

    const blockedSession = await createSession(run);
    assert.equal((await prompt(run, blockedSession.id, "BLOCK_NETWORK")).status, 204);
    const blocked = await events.waitFor((event) => event.type === "tool.finished" && event.toolCallId === "command-1");
    assert.equal(blocked.status, "policy_blocked");
    assert.equal(fs.existsSync(path.join(cwd, "blocked-command-spawned.txt")), false, "policy-denied commands must never spawn");

    const duplicateSession = await createSession(run);
    assert.equal((await prompt(run, duplicateSession.id, "DUPLICATE_IDS")).status, 204);
    await events.waitFor((event) => event.type === "tool.finished" && event.toolCallId === "duplicate");
    await events.waitFor((event) => event.type === "tool.finished" && event.toolCallId === "duplicate-2");
    await events.waitFor((event) => event.type === "session.idle" && event.sessionId === duplicateSession.id);

    const utf8Session = await createSession(run);
    assert.equal((await prompt(run, utf8Session.id, "SPLIT_UTF8")).status, 204);
    const utf8 = await events.waitFor((event) => event.type === "assistant.delta" && event.text === "café");
    assert.equal(utf8.text, "café");
    await events.waitFor((event) => event.type === "session.idle" && event.sessionId === utf8Session.id);

    const system = await run.request(`/session/${blockedSession.id}/prompt_async`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "x", system: "override" }) });
    assert.equal(system.status, 400);
    assert.deepEqual(await system.json(), { error: "System prompts are managed by Veil.", code: "protected_system_prompt" });

    const diagnostics = await run.request("/diagnostics");
    assert.equal(diagnostics.status, 200);
    assert.equal((await diagnostics.json() as { enabled: boolean }).enabled, true);
    assert.ok(fs.readFileSync(logPath, "utf8").includes("tool.finished"));

    assert.ok(provider.requests.length >= 4);
    const firstRequest = provider.requests[0];
    assert.equal(firstRequest.authorization, "Bearer local");
    assert.match(firstRequest.contentType ?? "", /^application\/json/);
    assert.equal(firstRequest.body.stream, true);
    assert.equal(firstRequest.body.max_output_tokens, 8192);
    assert.equal("model" in firstRequest.body, false, "Veil routes must not receive a client-selected model");
    assert.ok(Array.isArray(firstRequest.body.messages));
    assert.ok(Array.isArray(firstRequest.body.tools));
    assert.deepEqual(
      (firstRequest.body.tools as Array<{ function?: { name?: string } }>).map((tool) => tool.function?.name).filter(Boolean).sort(),
      ["command", "edit", "read", "search", "write"],
    );
    assert.ok(
      provider.requests.some(({ body }) => {
        const messages = body.messages as Array<Record<string, unknown>>;
        return messages.some((message) => message.role === "assistant" && Array.isArray(message.tool_calls))
          && messages.some((message) => message.role === "tool" && message.tool_call_id === "read-1" && String(message.content).includes("read: README.md (ok)"));
      }),
      "Veil follow-up turns must retain structured assistant/tool history",
    );
  } finally {
    await events?.close();
    await run.close();
    await provider.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("native runner rejects oversized JSON bodies and missing sessions", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-native-limits-"));
  const provider = await startProvider();
  const run = await startRunner(cwd, provider.url, path.join(cwd, "runner.jsonl"));
  let events: Awaited<ReturnType<typeof eventCollector>> | undefined;
  try {
    const oversized = await run.request("/permission/missing/reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pad: "x".repeat(513 * 1024) }) });
    assert.equal(oversized.status, 413);
    assert.equal((await run.request("/session/missing/abort", { method: "POST" })).status, 404);

    events = await eventCollector(run);
    const session = await createSession(run);
    const image = `data:image/png;base64,${Buffer.alloc(450 * 1024, 1).toString("base64")}`;
    const accepted = await run.request(`/session/${session.id}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "describe" }, { type: "image", data_url: image }] }),
    });
    assert.equal(accepted.status, 204, "the prompt endpoint must accept bounded multimodal requests larger than the control-plane limit");
    await events.waitFor((event) => event.type === "session.idle" && event.sessionId === session.id);
    assert.ok(provider.requests.some(({ body }) => JSON.stringify(body.messages).includes(image.slice(-128))));
  } finally {
    await events?.close();
    await run.close();
    await provider.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("native runner sends the adaptive response allowance selected during preflight", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-native-context-"));
  const provider = await startProvider();
  const run = await startRunner(
    cwd,
    provider.url,
    path.join(cwd, "runner.jsonl"),
    "managed",
    {
      contextLength: 16_000,
      maxResponseTokens: 8_192,
      protectedPromptReserveTokens: 2_048,
      enabledTools: [],
    },
  );
  const events = await eventCollector(run);
  try {
    const session = await createSession(run);
    assert.equal((await prompt(run, session.id, `Summarize briefly\n${"x".repeat(45_000)}`)).status, 204);
    const preflight = await events.waitFor((event) => event.type === "context.usage" && event.phase === "preflight");
    await events.waitFor((event) => event.type === "session.idle" && event.sessionId === session.id);

    assert.ok([1_000, 2_000, 3_000].includes(Number(preflight.reserveTokens)));
    assert.equal(preflight.protectedTokens, 2_048);
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0].body.max_output_tokens, preflight.reserveTokens);
  } finally {
    await events.close();
    await run.close();
    await provider.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("native runner retrieves a complete chat attachment across bounded tool calls", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-native-attachment-workspace-"));
  const attachmentDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-native-attachments-"));
  const attachment = `BEGIN_MARKER\n${"full attachment body 中🙂\n".repeat(300)}END_MARKER`;
  fs.writeFileSync(path.join(attachmentDirectory, "complete-plan.md"), attachment, "utf8");
  const provider = await startProvider();
  const run = await startRunner(
    cwd,
    provider.url,
    path.join(cwd, "runner.jsonl"),
    "managed",
    { attachmentDirectory, enabledTools: [] },
  );
  const events = await eventCollector(run);
  try {
    const session = await createSession(run);
    assert.equal((await prompt(run, session.id, "ATTACHMENT_FILE analyze every part")).status, 204);
    await events.waitFor((event) => event.type === "session.idle" && event.sessionId === session.id);

    const attachmentRequests = provider.requests.filter(({ body }) =>
      JSON.stringify(body.messages).includes("ATTACHMENT_FILE")
    );
    assert.ok(attachmentRequests.length > 2);
    assert.ok(attachmentRequests.some(({ body }) =>
      (body.tools as Array<{ function?: { name?: string } }> | undefined)
        ?.some((tool) => tool.function?.name === "read_attachment")
    ));
    const finalMessages = JSON.stringify(attachmentRequests.at(-1)?.body.messages);
    assert.match(finalMessages, /BEGIN_MARKER/);
    assert.match(finalMessages, /END_MARKER/);
    assert.match(finalMessages, /Read status: complete/);
  } finally {
    await events.close();
    await run.close();
    await provider.close();
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(attachmentDirectory, { recursive: true, force: true });
  }
});

test("native runner rejects client system prompts in development mode", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-native-system-"));
  const provider = await startProvider();
  const run = await startRunner(cwd, provider.url, path.join(cwd, "runner.jsonl"), "development");
  try {
    const session = await createSession(run);
    const response = await run.request(`/session/${session.id}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", system: "override" }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "System prompts are managed by Veil.",
      code: "protected_system_prompt",
    });
    assert.equal(provider.requests.length, 0);
  } finally {
    await run.close();
    await provider.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("native runner refuses non-loopback listener addresses", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-native-listener-"));
  const provider = await startProvider();
  try {
    const child = spawn(binary, ["serve", "--hostname=0.0.0.0", "--port=0", "--password=secret"], {
      cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(JSON.stringify(config(cwd, provider.url, path.join(cwd, "runner.jsonl"))));
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 1);
    assert.match(stderr, /loopback address/);
  } finally {
    await provider.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("native runner accepts an unterminated final SSE line, stops repeated tools, and rejects missing markers", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-native-guards-"));
  fs.writeFileSync(path.join(cwd, "README.md"), "first\nsecond\n", "utf8");
  const provider = await startProvider();
  const run = await startRunner(cwd, provider.url, path.join(cwd, "runner.jsonl"));
  const events = await eventCollector(run);
  try {
    const trailingSession = await createSession(run);
    assert.equal((await prompt(run, trailingSession.id, "DONE_WITHOUT_NEWLINE")).status, 204);
    const trailing = await events.waitFor((event) => event.type === "assistant.delta" && event.taskId === "native-test-task" && event.text === "complete without newline");
    assert.equal(trailing.text, "complete without newline");
    await events.waitFor((event) => event.type === "session.idle" && event.sessionId === trailingSession.id);

    const repeatedSession = await createSession(run);
    assert.equal((await prompt(run, repeatedSession.id, "REPEAT_TOOL")).status, 204);
    await events.waitFor((event) => event.type === "session.idle" && event.sessionId === repeatedSession.id);
    assert.equal(
      events.events.filter((event) => event.type === "tool.finished" && event.toolCallId === "repeat").length,
      3,
    );
    assert.equal(
      provider.requests.filter(({ body }) => JSON.stringify(body.messages).includes("REPEAT_TOOL")).length,
      4,
      "three repeated tool turns must be followed by exactly one tool-free final request",
    );

    const incompleteSession = await createSession(run);
    assert.equal((await prompt(run, incompleteSession.id, "MISSING_DONE")).status, 204);
    const error = await events.waitFor((event) => event.type === "runner.error" && event.taskId === "native-test-task" && String(event.detail).includes("completion marker"));
    assert.equal(error.category, "provider");
    assert.equal(error.code, "model_stream_incomplete");
    assert.equal(events.events.some((event) => event.type === "session.idle" && event.sessionId === incompleteSession.id), false);
  } finally {
    await events.close();
    await run.close();
    await provider.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
