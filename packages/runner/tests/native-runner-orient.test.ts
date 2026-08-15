import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startProvider } from "./native-runner-provider.ts";
import { createSession, eventCollector, prompt, startRunner } from "./native-runner-harness.ts";

function chatBodies(provider: { requests: Array<{ path?: string; body: Record<string, unknown> }> }) {
  return provider.requests
    .filter((request) => request.path === "/api/engineering/chat")
    .map((request) => request.body);
}

test("the runner never classifies a turn and never sends a harness bucket", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-classify-"));
  fs.writeFileSync(path.join(cwd, "README.md"), "orient fixture\n");
  const provider = await startProvider();
  const run = await startRunner(cwd, provider.url, path.join(cwd, "runner.jsonl"));
  const events = await eventCollector(run);
  try {
    const session = await createSession(run);
    assert.equal((await prompt(run, session.id, "ORIENT_GUIDED please look at this")).status, 204);
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === session.id);

    assert.equal(provider.orientRequests.length, 0, "the runner must not call the classifier");
    for (const body of chatBodies(provider)) {
      assert.equal("harness_bucket" in body, false, "chat bodies must not select a playbook");
    }
    assert.equal(
      events.events.some((event) => String(event.type).startsWith("orient.")),
      false,
      "classifier diagnostics must not appear",
    );
    assert.equal(
      events.events.some((event) => event.type === "assistant.progress.delta"),
      false,
      "the harness must not inject a status sentence",
    );

    const serialized = JSON.stringify(events.events);
    for (const forbidden of [
      "harness_bucket",
      "debug_failure",
      "direct_answer",
      "open_task",
      "deep_review",
      "repo_orient",
      "Active task playbook",
      "summarySentence",
    ]) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked into runner events`);
    }
  } finally {
    await events?.close();
    await run.close();
    await provider.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a workspace question uses tools without a classifier gate", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-evidence-"));
  fs.writeFileSync(path.join(cwd, "README.md"), "evidence fixture\n");
  const provider = await startProvider();
  const run = await startRunner(cwd, provider.url, path.join(cwd, "runner.jsonl"));
  const events = await eventCollector(run);
  try {
    const session = await createSession(run);
    assert.equal((await prompt(run, session.id, "ORIENT_EVIDENCE tell me about this codebase")).status, 204);
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === session.id);

    assert.equal(provider.orientRequests.length, 0);
    assert.equal(
      events.events.some((event) => event.type === "orient.evidence_retry"),
      false,
      "the harness must not refuse a first answer",
    );
    const listed = events.events.filter(
      (event) => event.type === "tool.finished" && event.toolCallId === "evidence-ls",
    );
    assert.equal(listed.length, 1, "the model still inspects the workspace when it chooses to");
    const text = events.events
      .filter((event) => event.type === "assistant.delta")
      .map((event) => String(event.text))
      .join("");
    assert.ok(text.includes("README.md"), `the final answer must rest on tool results: ${text}`);
  } finally {
    await events?.close();
    await run.close();
    await provider.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("tool-step prose and the final answer both stream live", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-verbatim-"));
  fs.writeFileSync(path.join(cwd, "README.md"), "verbatim fixture\n");
  fs.writeFileSync(path.join(cwd, "site.js"), "console.log('bakery');\n");
  const provider = await startProvider();
  const run = await startRunner(cwd, provider.url, path.join(cwd, "runner.jsonl"));
  const events = await eventCollector(run);
  try {
    const session = await createSession(run);
    assert.equal((await prompt(run, session.id, "ORIENT_STREAM describe this page")).status, 204);
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === session.id);

    const answerDeltas = events.events
      .filter((event) => event.type === "assistant.delta")
      .map((event) => String(event.text));
    const answer = answerDeltas.join("");
    assert.ok(
      answer.includes("The bakery site is one static page"),
      `the final answer body must survive: ${answer}`,
    );
    assert.ok(
      answer.includes("Starting with the main config, which appears central."),
      `the answer's own closing words must ship verbatim: ${answer}`,
    );
    assert.ok(
      answerDeltas.length >= 2,
      `the final answer must stream as live deltas, got ${JSON.stringify(answerDeltas)}`,
    );
    assert.equal(
      events.events.some((event) => String(event.type).startsWith("orient.announcement")),
      false,
      "no announcement heuristics may run",
    );
  } finally {
    await events?.close();
    await run.close();
    await provider.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a long tool run injects nothing into the model's tool results", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-cadence-"));
  for (let index = 0; index < 13; index += 1) {
    fs.writeFileSync(path.join(cwd, `tour-${index}.txt`), `tour file ${index}\n`);
  }
  const provider = await startProvider();
  const run = await startRunner(cwd, provider.url, path.join(cwd, "runner.jsonl"));
  const events = await eventCollector(run);
  try {
    const session = await createSession(run);
    assert.equal((await prompt(run, session.id, "ORIENT_TOUR walk this folder")).status, 204);
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === session.id);

    assert.equal(provider.orientRequests.length, 0);
    const lastChat = provider.requests.filter((request) => request.path === "/api/engineering/chat").at(-1);
    const toolMessages = (lastChat?.body.messages as Array<{ role?: string; content?: unknown }>)
      .filter((message) => message.role === "tool" && !/^read: tour-\d+\.txt \(ok\)/.test(String(message.content ?? "")));
    assert.deepEqual(toolMessages, [], "no harness text may ride the model's tool results");

    const answer = events.events
      .filter((event) => event.type === "assistant.delta")
      .map((event) => String(event.text))
      .join("");
    assert.ok(answer.includes("the map is complete"), `the final answer must arrive: ${answer}`);
  } finally {
    await events?.close();
    await run.close();
    await provider.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
