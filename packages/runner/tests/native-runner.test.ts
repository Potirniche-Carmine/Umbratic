import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startProvider } from "./native-runner-provider.ts";
import { config, createSession, eventCollector, prompt, requestBody, sse, startRunner } from "./native-runner-harness.ts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binary = path.join(repositoryRoot, "target", "debug", process.platform === "win32" ? "umbratic-runner.exe" : "umbratic-runner");

test("native runner gates and executes workspace-relative LSP code intelligence", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-native-lsp-"));
  const sourcePath = path.join(cwd, "main.ts");
  const stubPath = path.join(cwd, "lsp-stub.mjs");
  fs.writeFileSync(sourcePath, "export const answer = 42;\nconsole.log(answer);\n");
  fs.writeFileSync(stubPath, `
let buffer = Buffer.alloc(0);
function send(value) {
  const body = Buffer.from(JSON.stringify(value));
  process.stdout.write(Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"));
  process.stdout.write(body);
}
function inspect() {
  while (true) {
    const boundary = buffer.indexOf("\\r\\n\\r\\n");
    if (boundary < 0) return;
    const header = buffer.subarray(0, boundary).toString("ascii");
    const match = header.match(/Content-Length:\\s*(\\d+)/i);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    if (buffer.length < boundary + 4 + length) return;
    const message = JSON.parse(buffer.subarray(boundary + 4, boundary + 4 + length).toString("utf8"));
    buffer = buffer.subarray(boundary + 4 + length);
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { definitionProvider: true } } });
    } else if (message.method === "textDocument/definition") {
      send({ jsonrpc: "2.0", id: message.id, result: [{
        uri: new URL("./main.ts", import.meta.url).href,
        range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } }
      }] });
    } else if (message.method === "textDocument/references") {
      send({ jsonrpc: "2.0", id: message.id, result: [
        {
          uri: new URL("./main.ts", import.meta.url).href,
          range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } }
        },
        {
          uri: new URL("./main.ts", import.meta.url).href,
          range: { start: { line: 1, character: 12 }, end: { line: 1, character: 18 } }
        }
      ] });
    } else if (message.method === "textDocument/hover") {
      send({ jsonrpc: "2.0", id: message.id, result: {
        contents: { kind: "markdown", value: "const answer: 42" }
      } });
    } else if (message.method === "textDocument/documentSymbol") {
      send({ jsonrpc: "2.0", id: message.id, result: [{
        name: "answer",
        kind: 14,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 25 } },
        selectionRange: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } }
      }] });
    } else if (message.method === "shutdown") {
      send({ jsonrpc: "2.0", id: message.id, result: null });
    } else if (message.method === "exit") {
      process.exit(0);
    }
  }
}
process.stdin.on("data", (chunk) => { buffer = Buffer.concat([buffer, chunk]); inspect(); });
`);
  const provider = await startProvider();
  const run = await startRunner(cwd, provider.url, path.join(cwd, "runner.jsonl"), {
    enabledTools: ["read", "find", "lsp"],
    lspServers: [{
      id: "typescript-language-server",
      command: process.execPath,
      args: [stubPath],
      languageIds: ["typescript"],
      extensions: ["ts"],
    }],
  });
  const events = await eventCollector(run);
  try {
    const session = await createSession(run);
    assert.equal((await prompt(run, session.id, "LSP_CODE_INTELLIGENCE")).status, 204);
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === session.id);
    const firstChat = provider.requests.find((request) => request.path === "/api/engineering/chat" && request.body.response_mode !== "progress");
    const toolNames = ((firstChat?.body.tools ?? []) as Array<{ function?: { name?: string } }>)
      .map((tool) => tool.function?.name);
    assert.ok(toolNames.includes("lsp"));
    const outputs = new Map(
      events.events
        .filter((event) => event.type === "tool.output" && String(event.toolCallId).startsWith("lsp-"))
        .map((event) => [event.toolCallId, String(event.text)]),
    );
    // Structured evidence is read from typed details; the text is presentation.
    const details = new Map(events.events
      .filter((event) => event.type === "tool.finished" && String(event.toolCallId).startsWith("lsp-"))
      .map((event) => [event.toolCallId, event.details as Record<string, unknown>]));
    const locations = (id: string) =>
      (details.get(id)?.locations ?? []) as Array<Record<string, unknown>>;
    assert.equal(locations("lsp-definition-1")[0]?.path, "main.ts");
    assert.equal(locations("lsp-references-1").length, 2);
    assert.match(String(details.get("lsp-hover-1")?.hoverMarkdown), /const answer: 42/);
    assert.equal(locations("lsp-symbols-1")[0]?.name, "answer");
    for (const evidence of details.values()) {
      assert.equal(evidence?.freshness, "ready");
    }
    for (const output of outputs.values()) {
      assert.doesNotMatch(output, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  } finally {
    await events.close();
    await run.close();
    await provider.close();
    let cleanupError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        fs.rmSync(cwd, { recursive: true, force: true });
        cleanupError = undefined;
        break;
      } catch (error) {
        cleanupError = error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (cleanupError) throw cleanupError;
  }
});

test("native runner degrades a crashed language server without failing the task", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-native-lsp-degraded-"));
  fs.writeFileSync(path.join(cwd, "main.ts"), "export const answer = 42;\n");
  const provider = await startProvider();
  const run = await startRunner(cwd, provider.url, path.join(cwd, "runner.jsonl"), {
    enabledTools: ["read", "lsp"],
    lspServers: [{
      id: "typescript-language-server",
      command: process.execPath,
      args: ["-e", "process.exit(1)"],
      languageIds: ["typescript"],
      extensions: ["ts"],
    }],
  });
  const events = await eventCollector(run);
  try {
    const session = await createSession(run);
    assert.equal((await prompt(run, session.id, "LSP_DEGRADED")).status, 204);
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === session.id);
    const output = events.events.find((event) => event.type === "tool.output" && event.toolCallId === "lsp-degraded-1");
    assert.match(String(output?.text), /unavailable for this session/);
    const finished = events.events.find((event) => event.type === "tool.finished" && event.toolCallId === "lsp-degraded-1");
    assert.equal(finished?.status, "success");
    // Degradation is a typed field, not a string in the model-facing text.
    assert.equal((finished?.details as Record<string, unknown>)?.freshness, "degraded");
  } finally {
    await events.close();
    await run.close();
    await provider.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("native runner semantically compacts a durable prefix and persists the validated handoff", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-native-compaction-"));
  const provider = await startProvider();
  const run = await startRunner(cwd, provider.url, path.join(cwd, "runner.jsonl"), {
    contextLength: 12_000,
    maxResponseTokens: 4_096,
    protectedPromptReserveTokens: 2_048,
  });
  const events = await eventCollector(run);
  try {
    // The durable prefix has to be built over several turns, and the newest
    // request has to stay inside the protected-tail budget — at a 12K context
    // that budget is 4,000 tokens. A single oversized latest message makes
    // semantic_prefix_end refuse to cut at all, which is correct behavior but
    // tests nothing: the run then simply sends a near-full request.
    const bootstrap = await createSession(run);
    let bootstrapTurns = 0;
    for (const marker of ["old context one", "old context two", "old context three"]) {
      assert.equal((await prompt(run, bootstrap.id, `${marker} ${"x".repeat(8_000)}`)).status, 204);
      bootstrapTurns += 1;
      await events.waitFor((event) =>
        event.type === "run.settled"
        && event.sessionId === bootstrap.id
        && events.events.filter((seen) => seen.type === "run.settled" && seen.sessionId === bootstrap.id).length >= bootstrapTurns
      );
    }
    const conversationState = events.events
      .filter((event) => event.type === "step.settled" && event.sessionId === bootstrap.id)
      .at(-1)?.conversationState;
    assert.ok(conversationState);
    const session = await createSession(run, conversationState);
    assert.equal((await prompt(run, session.id, `latest request ${"z".repeat(6_000)}`)).status, 204);
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === session.id);
    assert.ok(provider.requests.some((request) => request.path === "/api/internal/context/compact"));
    const snapshot = events.events
      .filter((event) => event.type === "step.settled" && event.sessionId === session.id)
      .at(-1)?.conversationState as { summary?: string | null; usage: { compactionCount: number }; tail: Array<{ role: string }> };
    assert.ok(snapshot);
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
    const run = await startRunner(cwd, provider.url, path.join(cwd, "runner.jsonl"), {
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
        while (events.events.filter((event) => event.type === "run.settled" && event.sessionId === session.id).length < idleCount) {
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
      const snapshot = events.events
        .filter((event) => event.type === "step.settled" && event.sessionId === session.id)
        .at(-1)?.conversationState as {
          sourceDigest: string;
          usage: { compactionCount: number; estimatedPromptTokens: number };
        };
      assert.ok(snapshot);
      const snapshotText = JSON.stringify(snapshot);
      assert.ok(Buffer.byteLength(snapshotText, "utf8") <= 128 * 1024);
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


test("native runner rejects a second prompt while a turn is active and scopes abort to that turn", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-native-turn-guard-"));
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let heldRequestSeen!: () => void;
  const heldRequest = new Promise<void>((resolve) => {
    heldRequestSeen = resolve;
  });
  const provider = http.createServer(async (request, response) => {
    const body = await requestBody(request) as Record<string, unknown>;
    const encoded = JSON.stringify(body.messages ?? []);
    response.writeHead(200, { "Content-Type": "text/event-stream", "X-Umbratic-Stream-Version": "2" });
    if (encoded.includes("HOLD_TURN")) {
      // Flush headers so the runner leaves .send() and enters the abort-aware stream loop.
      response.write(": held\n\n");
      heldRequestSeen();
      await firstGate;
      response.end(sse({ choices: [{ delta: { content: "Held turn complete." } }] }) + "data: [DONE]\n\n");
      return;
    }
    if (encoded.includes("AFTER_ABORT")) {
      response.end(sse({ choices: [{ delta: { content: "Follow-up after abort." } }] }) + "data: [DONE]\n\n");
      return;
    }
    response.end(sse({ choices: [{ delta: { content: "Native runner complete." } }] }) + "data: [DONE]\n\n");
  });
  await new Promise<void>((resolve, reject) => provider.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const providerUrl = `http://127.0.0.1:${address.port}`;
  const run = await startRunner(cwd, providerUrl, path.join(cwd, "runner.jsonl"), { enabledTools: [] });
  const events = await eventCollector(run);
  try {
    const session = await createSession(run);
    assert.equal((await prompt(run, session.id, "HOLD_TURN")).status, 204);
    await heldRequest;
    const busy = await prompt(run, session.id, "should be rejected");
    assert.equal(busy.status, 409);
    const busyBody = await busy.json() as { code?: string; error?: string };
    assert.equal(busyBody.code, "run_in_progress");

    assert.equal((await run.request(`/session/${session.id}/abort`, { method: "POST" })).status, 204);
    const abortedSettled = await events.waitFor((event) =>
      event.type === "run.settled"
      && event.sessionId === session.id
      && event.outcome === "aborted"
    );
    assert.equal(abortedSettled.errorCode, null);
    assert.equal(
      events.events.filter((event) =>
        event.type === "runner.error" && event.sessionId === session.id && event.code === "run_aborted"
      ).length,
      0,
    );
    assert.equal(events.events.filter((event) => event.type === "run.settled" && event.sessionId === session.id).length, 1);

    // Releasing the held provider after abort must not emit another run.settled.
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(events.events.filter((event) => event.type === "run.settled" && event.sessionId === session.id).length, 1);

    assert.equal((await prompt(run, session.id, "AFTER_ABORT")).status, 204);
    const settled = await events.waitFor((event) =>
      event.type === "run.settled"
      && event.sessionId === session.id
      && event.outcome === "completed"
    );
    assert.match(String(settled.runId ?? ""), /^run-/);
    assert.equal(events.events.filter((event) => event.type === "run.settled" && event.sessionId === session.id).length, 2);
  } finally {
    releaseFirst();
    await events.close();
    await run.close();
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("native runner preserves authenticated API, streaming tools, permissions, policy, and diagnostics", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-native-runner-"));
  fs.writeFileSync(path.join(cwd, "README.md"), "first\nsecond\n", "utf8");
  const logPath = path.join(cwd, "runner.jsonl");
  const provider = await startProvider();
  const run = await startRunner(cwd, provider.url, logPath, {
    approvedExecutables: [{ id: "node", command: process.execPath }],
  });
  let events: Awaited<ReturnType<typeof eventCollector>> | undefined;
  try {
    assert.equal((await fetch(new URL("/session", run.url), { method: "POST" })).status, 401);
    events = await eventCollector(run);

    const readSession = await createSession(run);
    const readEventStart = events.events.length;
    assert.equal((await prompt(run, readSession.id, "READ_FILE")).status, 204);
    const readFinished = await events.waitFor((event) => event.type === "tool.finished" && event.toolCallId === "read-1");
    assert.deepEqual({ status: readFinished.status, unexpected: ["errorCode", "errorMessage", "response"].filter((key) => key in readFinished) }, { status: "success", unexpected: [] });
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
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === readSession.id);
    assert.deepEqual(
      events.events
        .slice(readEventStart)
        .filter((event) => [
          "assistant.delta", "assistant.progress.delta", "tool.requested",
          "tool.policy.stage", "tool.output", "tool.finished", "step.settled", "run.settled",
        ].includes(String(event.type)))
        .map((event) => event.type),
      [
        "assistant.delta", "tool.requested", "tool.policy.stage",
        "tool.output", "tool.finished", "step.settled", "assistant.delta", "step.settled", "run.settled",
      ],
      "the read scenario keeps one stable public lifecycle trajectory with no pre-tool progress row",
    );
    assert.equal(
      events.events.some((event) => event.type === "assistant.delta" && event.text === "I will read the requested file before I answer."),
      true,
      "plain model preamble text streams on the assistant channel",
    );
    assert.equal(
      JSON.stringify(events.events).includes("RAW_REASONING_MARKER"),
      false,
      "provider reasoning fields must never become runner events",
    );

    const inspectionRetrySession = await createSession(run), inspectionEventStart = events.events.length;
    assert.equal((await prompt(run, inspectionRetrySession.id, "REQUIRED_INSPECTION_RETRY")).status, 204);
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === inspectionRetrySession.id);
    assert.equal(
      events.events.slice(inspectionEventStart).some((event) => event.type === "assistant.delta" && event.text === "I can explain this directly without changing or inspecting the workspace."),
      true,
      "a verb-prefixed question may end directly without an intent retry",
    );
    assert.equal(
      events.events.slice(inspectionEventStart).some((event) => event.type === "tool.requested"),
      false,
      "the runner does not force a workspace action",
    );

    const writeSession = await createSession(run);
    assert.equal((await prompt(run, writeSession.id, "WRITE_FILE")).status, 204);
    const permission = await events.waitFor((event) => event.type === "permission.requested" && typeof event.permissionId === "string");
    const reply = await run.request(`/permission/${permission.permissionId}/reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reply: "once" }) });
    assert.equal(reply.status, 200);
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === writeSession.id);
    assert.equal(fs.readFileSync(path.join(cwd, "note.txt"), "utf8"), "native write\n");

    const approvedSession = await createSession(run);
    assert.equal((await prompt(run, approvedSession.id, "APPROVED_EXECUTABLE")).status, 204);
    const approvedPermission = await events.waitFor((event) =>
      event.type === "permission.requested"
      && String(event.summary).includes("approved-runtime-ok")
    );
    const approvedReply = await run.request(`/permission/${approvedPermission.permissionId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply: "once" }),
    });
    assert.equal(approvedReply.status, 200);
    const approvedFinished = await events.waitFor((event) =>
      event.type === "tool.finished" && event.toolCallId === "approved-command-1"
    );
    assert.equal(approvedFinished.status, "success");
    assert.equal(
      events.events.some((event) =>
        event.type === "tool.requested"
        && event.toolCallId === "approved-command-1"
        && event.toolKind === "run_program"
      ),
      true,
      "run_program remains the exact public tool kind",
    );
    assert.equal(
      events.events.some((event) =>
        event.type === "tool.output"
        && event.toolCallId === "approved-command-1"
        && String(event.text).includes("approved-runtime-ok")
      ),
      true,
    );
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === approvedSession.id);

    const networkSession = await createSession(run);
    assert.equal((await prompt(run, networkSession.id, "NETWORK_APPROVAL")).status, 204);
    const networkPermission = await events.waitFor((event) =>
      event.type === "permission.requested"
      && String(event.summary).includes("curl https://example.com")
    );
    const networkReply = await run.request(`/permission/${networkPermission.permissionId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply: "reject" }),
    });
    assert.equal(networkReply.status, 200);
    const networkFinished = await events.waitFor((event) =>
      event.type === "tool.finished" && event.toolCallId === "network-command-1"
    );
    assert.equal(networkFinished.status, "permission_denied");
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === networkSession.id);
    assert.equal(fs.existsSync(path.join(cwd, "network-command-spawned.txt")), false);

    const rejectedSession = await createSession(run);
    assert.equal((await prompt(run, rejectedSession.id, "REJECTED_COMMAND")).status, 204);
    const rejectedPermission = await events.waitFor((event) =>
      event.type === "permission.requested"
      && String(event.summary).includes("rejected-command.txt")
    );
    const rejectedReply = await run.request(`/permission/${rejectedPermission.permissionId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply: "reject" }),
    });
    assert.equal(rejectedReply.status, 200);
    const rejectedFinished = await events.waitFor((event) =>
      event.type === "tool.finished" && event.toolCallId === "rejected-command-1"
    );
    assert.equal(rejectedFinished.status, "permission_denied");
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === rejectedSession.id);
    assert.equal(fs.existsSync(path.join(cwd, "rejected-command.txt")), false);
    assert.equal(events.events.some((event) => event.type === "assistant.delta" && event.text === "The command was rejected and was not run."), true);

    const duplicateSession = await createSession(run), duplicateEventStart = events.events.length;
    assert.equal((await prompt(run, duplicateSession.id, "DUPLICATE_IDS")).status, 204);
    await events.waitFor((event) => event.type === "tool.finished" && event.toolCallId === "duplicate-fixed-1");
    await events.waitFor((event) => event.type === "tool.finished" && event.toolCallId === "duplicate-fixed-2");
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === duplicateSession.id);
    assert.equal(
      events.events.slice(duplicateEventStart).some((event) => event.type === "tool.requested" && event.toolCallId === "duplicate"),
      false,
      "an ambiguous duplicate-id batch is rejected before any tool starts",
    );

    const utf8Session = await createSession(run);
    assert.equal((await prompt(run, utf8Session.id, "SPLIT_UTF8")).status, 204);
    const utf8 = await events.waitFor((event) => event.type === "assistant.delta" && event.text === "café");
    assert.equal(utf8.text, "café");
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === utf8Session.id);

    const streamingSession = await createSession(run);
    const streamingEventStart = events.events.length;
    assert.equal((await prompt(run, streamingSession.id, "what can you do and who are you")).status, 204);
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === streamingSession.id);
    const directAnswer = events.events.slice(streamingEventStart).filter((event) => event.type === "assistant.delta").map((event) => event.text);
    assert.deepEqual(directAnswer, ["Hello ", "there."]);
    assert.equal(events.events.slice(streamingEventStart).some((event) => event.type === "assistant.progress.delta"), false, "a direct answer must not create a public work-summary block");
    const streamRequests = provider.requests.filter(({ body }) => JSON.stringify(body.messages).includes("what can you do and who are you"));
    assert.equal(streamRequests.length, 1, "a direct answer uses one model request");
    assert.ok(Array.isArray(streamRequests[0].body.tools), "the model keeps automatic tool choice");

    const system = await run.request(`/session/${networkSession.id}/prompt_async`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "x", system: "override" }) });
    assert.equal(system.status, 400);
    assert.deepEqual(await system.json(), { error: "System prompts are managed by Veil.", code: "protected_system_prompt" });

    const diagnostics = await run.request("/diagnostics");
    assert.equal(diagnostics.status, 200);
    assert.equal((await diagnostics.json() as { enabled: boolean }).enabled, true);
    assert.ok(fs.readFileSync(logPath, "utf8").includes("tool.finished"));
    assert.equal(fs.readFileSync(logPath, "utf8").includes("RAW_REASONING_MARKER"), false);

    assert.ok(provider.requests.length >= 4);
    const progressRequests = provider.requests.filter(({ body }) => body.response_mode === "progress");
    assert.equal(progressRequests.length, 0, "progress must not create extra full-context model requests");
    const firstRequest = provider.requests[0];
    assert.ok(firstRequest);
    assert.equal(firstRequest.authorization, "Bearer local");
    assert.match(firstRequest.contentType ?? "", /^application\/json/);
    assert.equal(firstRequest.body.stream, true);
    assert.equal(firstRequest.body.max_output_tokens, 8192);
    assert.equal("model" in firstRequest.body, false, "Veil routes must not receive a client-selected model");
    assert.ok(Array.isArray(firstRequest.body.messages));
    assert.ok(Array.isArray(firstRequest.body.tools));
    assert.equal(firstRequest.body.tools?.length > 0, true);
    assert.equal("tool_choice" in firstRequest.body, false);
    assert.equal("parallel_tool_calls" in firstRequest.body, false);
    assert.deepEqual(
      (firstRequest.body.tools as Array<{ function?: { name?: string } }>).map((tool) => tool.function?.name).filter(Boolean).sort(),
      // retrieve_context is declared at task start and answers context_not_available
      // when nothing has been compacted, rather than appearing between steps.
      ["apply_patch", "command", "edit", "find", "ls", "read", "retrieve_context", "run_program", "search", "write"],
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

test("decision behavior suite answers verb-prefixed questions without forced tools or canned failures", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-native-decision-suite-"));
  const provider = await startProvider();
  const run = await startRunner(cwd, provider.url, path.join(cwd, "runner.jsonl"));
  const events = await eventCollector(run);
  const prompts = [
    "Update me on the repo", "Run me through the auth flow", "Test my understanding of X",
    "Address the reviewer's question", "Fix the grammar in this paragraph: hello world",
    "Create an explanation of closures", "Build my understanding of ownership", "Write about safe deployment",
    "Implement a mental model for caching", "Make this sentence clearer", "Change how I think about queues",
    "Edit this idea for clarity", "Delete ambiguity from this sentence", "Move me through the architecture",
    "Remove confusion about async code", "Rename this concept in plain language", "Verify my reasoning about TLS",
    "Execute a walkthrough of the parser", "Inspect the idea of immutability", "Read me a summary of the pattern",
    "Look at this hypothetical example", "Explain this project type in general", "Tell me how event loops work",
    "Summarize common test strategies", "List the tradeoffs of retries", "Give me a conceptual code review",
    "Review this paragraph for tone", "Check my understanding of schemas", "Audit this argument for logic",
    "Test whether this explanation is clear", "Run through a sample incident", "Update this prose mentally",
    "Address a question about concurrency", "Fix my interpretation of context windows", "Build a concise analogy",
    "Create a short definition", "Write a one-sentence summary", "Make an abstract example",
    "Change the wording in your answer", "Implement the explanation in prose",
  ];
  try {
    let totalToolCalls = 0;
    let cannedFailures = 0;
    for (const userPrompt of prompts) {
      const session = await createSession(run);
      const eventStart = events.events.length;
      const requestStart = provider.requests.length;
      assert.equal((await prompt(run, session.id, userPrompt)).status, 204);
      await events.waitFor((event) => event.type === "run.settled" && event.sessionId === session.id);
      const trajectory = events.events.slice(eventStart);
      totalToolCalls += trajectory.filter((event) => event.type === "tool.requested").length;
      cannedFailures += trajectory.filter((event) => event.type === "assistant.delta" && String(event.text).includes("I couldn't")).length;
      assert.equal(provider.requests.length - requestStart, 1, userPrompt);
    }
    assert.deepEqual(
      { prompts: prompts.length, toolCalls: totalToolCalls, cannedFailures },
      { prompts: 40, toolCalls: 0, cannedFailures: 0 },
    );
  } finally {
    await events.close();
    await run.close();
    await provider.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("long continuity keeps more than thirty tool rounds append-only", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-native-continuity-"));
  for (let index = 0; index < 35; index += 1) {
    fs.writeFileSync(path.join(cwd, `file-${index}.txt`), `fact ${index}\n`, "utf8");
  }
  const provider = await startProvider();
  const run = await startRunner(cwd, provider.url, path.join(cwd, "runner.jsonl"), { contextLength: 256_000 });
  const events = await eventCollector(run);
  try {
    const session = await createSession(run);
    assert.equal((await prompt(run, session.id, "LONG_CONTINUITY")).status, 204);
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === session.id, 15_000);
    const requests = provider.requests.filter(({ body }) => JSON.stringify(body.messages).includes("LONG_CONTINUITY"));
    assert.equal(requests.length, 36);
    for (let index = 1; index < requests.length; index += 1) {
      const previous = requests[index - 1].body.messages as unknown[];
      const current = requests[index].body.messages as unknown[];
      assert.deepEqual(current.slice(0, previous.length), previous, `request ${index} rewrote prior history`);
    }
    assert.equal(events.events.some((event) => event.type === "context.compressed"), false);
    assert.equal(
      events.events.some((event) => event.type === "assistant.delta" && event.text === "Continuity retained file-0.txt and file-34.txt."),
      true,
    );
  } finally {
    await events.close();
    await run.close();
    await provider.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("one shared provider accepts 1, 4, and 16 concurrent direct turns", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-native-concurrency-"));
  const provider = await startProvider();
  const run = await startRunner(cwd, provider.url, path.join(cwd, "runner.jsonl"));
  const events = await eventCollector(run);
  try {
    for (const concurrency of [1, 4, 16]) {
      const sessions = await Promise.all(Array.from({ length: concurrency }, () => createSession(run)));
      const started = performance.now();
      await Promise.all(sessions.map((session, index) => prompt(run, session.id, `CONCURRENCY_${concurrency}_${index}`)));
      await Promise.all(sessions.map((session) => events.waitFor(
        (event) => event.type === "run.settled" && event.sessionId === session.id,
        10_000,
      )));
      const elapsedMs = performance.now() - started;
      assert.ok(elapsedMs < 10_000);
    }
  } finally {
    await events.close();
    await run.close();
    await provider.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("native runner rejects oversized JSON bodies and missing sessions", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-native-limits-"));
  const provider = await startProvider();
  const run = await startRunner(cwd, provider.url, path.join(cwd, "runner.jsonl"), { contextLength: 256_000 });
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
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === session.id);
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
    assert.equal((await prompt(run, session.id, `Summarize briefly\n${"x".repeat(35_000)}`)).status, 204);
    const preflight = await events.waitFor((event) => event.type === "context.usage" && event.phase === "preflight");
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === session.id);

    assert.ok([1_000, 2_000, 3_000].includes(Number(preflight.reserveTokens)));
    assert.equal(preflight.protectedTokens, 2_048);
    assert.equal(provider.requests.length, 1, "a direct answer uses one model request");
    const answerRequest = provider.requests.at(-1);
    assert.ok(answerRequest);
    assert.equal(answerRequest.body.max_output_tokens, preflight.reserveTokens);
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
    { attachmentDirectory, enabledTools: [] },
  );
  const events = await eventCollector(run);
  try {
    const session = await createSession(run);
    assert.equal((await prompt(run, session.id, "ATTACHMENT_FILE analyze every part")).status, 204);
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === session.id);

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

test("native runner rejects client system prompts", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-native-system-"));
  const provider = await startProvider();
  const run = await startRunner(cwd, provider.url, path.join(cwd, "runner.jsonl"));
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

test("native runner keeps its API password out of process arguments", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-native-argv-"));
  const provider = await startProvider();
  const run = await startRunner(cwd, provider.url, path.join(cwd, "runner.jsonl"));
  try {
    // Any local process can read argv via `ps` on macOS and Linux, and via WMI
    // on Windows. The credential belongs on the stdin channel instead.
    // wmic was removed in Windows 11 24H2, where spawning it fails with ENOENT
    // and never emits "exit" — which hung this whole file rather than failing
    // it. CIM is the supported query, and the listener below settles on either
    // outcome so a missing tool can only ever fail the assertion.
    const listing = process.platform === "win32"
      ? spawn("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${run.child.pid}").CommandLine`,
      ])
      : spawn("ps", ["-o", "args=", "-p", String(run.child.pid)]);
    let argv = "";
    listing.stdout.on("data", (chunk) => { argv += chunk.toString("utf8"); });
    await new Promise<void>((resolve) => {
      listing.once("exit", () => resolve());
      listing.once("error", () => resolve());
    });
    assert.match(argv, /umbratic-runner/);
    assert.doesNotMatch(argv, /password/i);
    assert.doesNotMatch(argv, /native-test-secret/);
    // The credential still authenticates, so it did arrive over stdin.
    assert.ok((await createSession(run)).id);
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
    const child = spawn(binary, ["serve", "--hostname=0.0.0.0", "--port=0"], {
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

test("native runner accepts an unterminated final SSE line, stops stalled repeated tools, and rejects missing markers", async () => {
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
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === trailingSession.id);
    const repeatedSession = await createSession(run), repeatedEventStart = events.events.length;
    assert.equal((await prompt(run, repeatedSession.id, "REPEAT_TOOL")).status, 204);
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === repeatedSession.id);
    const repeatedEvents = events.events.slice(repeatedEventStart);
    assert.equal(JSON.stringify(repeatedEvents).includes("<|toolcall>"), false);
    assert.equal(repeatedEvents.some((event) => event.type === "assistant.delta" && String(event.text).includes("same workspace tool call returned the same result")), true);
    // Tool calls speak for themselves in the activity log, so nothing announces
    // them beforehand. Compaction remains the only progress the runner emits.
    assert.equal(repeatedEvents.filter((event) => event.type === "assistant.progress.delta").length, 0);
    assert.equal(events.events.filter((event) => event.type === "tool.finished" && event.toolCallId === "repeat").length, 10);
    const repeatedRequests = provider.requests.filter(({ body }) => JSON.stringify(body.messages).includes("REPEAT_TOOL"));
    assert.equal(repeatedRequests.length, 11, "ten identical tool turns and one final request are required");
    assert.equal(repeatedRequests.filter(({ body }) => body.response_mode === "progress").length, 0, "tool count must not schedule progress requests");
    const literalSyntaxSession = await createSession(run), literalSyntaxEventStart = events.events.length;
    assert.equal((await prompt(run, literalSyntaxSession.id, "MALFORMED_TOOL_SYNTAX")).status, 204);
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === literalSyntaxSession.id);
    const literalSyntaxEvents = events.events.slice(literalSyntaxEventStart);
    assert.equal(
      literalSyntaxEvents.some((event) =>
        event.type === "assistant.delta"
        && event.text === "<|tool*call>call:read{path:'README.md'}<tool*call|>"
      ),
      true,
      "provider-like syntax in assistant content must remain visible text",
    );
    assert.equal(literalSyntaxEvents.some((event) => event.type === "tool.requested"), false);
    const recoveringSession = await createSession(run);
    assert.equal((await prompt(run, recoveringSession.id, "RECOVER_AFTER_FAILURES")).status, 204);
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === recoveringSession.id);
    assert.equal(events.events.filter((event) => event.type === "tool.finished" && /^recover-\d+$/.test(String(event.toolCallId)) && event.status !== "success").length, 9);
    assert.equal(events.events.some((event) => event.type === "tool.finished" && event.toolCallId === "recover-success" && event.status === "success"), true);
    assert.equal(events.events.some((event) => event.type === "assistant.delta" && event.text === "Recovered after distinct failures."), true);

    const incompleteSession = await createSession(run);
    assert.equal((await prompt(run, incompleteSession.id, "MISSING_DONE")).status, 204);
    const error = await events.waitFor((event) => event.type === "runner.error" && event.taskId === "native-test-task" && String(event.detail).includes("completion marker"));
    assert.equal(error.category, "provider");
    assert.equal(error.code, "model_stream_incomplete");
    const failed = await events.waitFor((event) => event.type === "run.settled" && event.sessionId === incompleteSession.id && event.outcome === "failed");
    assert.equal(failed.errorCode, "model_stream_incomplete");
  } finally {
    await events.close();
    await run.close();
    await provider.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
