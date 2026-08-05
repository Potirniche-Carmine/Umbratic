import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startProvider } from "./native-runner-provider.ts";
import { createSession, eventCollector, prompt, startRunner } from "./native-runner-harness.ts";

test("orient classifies once per run, stays hidden, and degrades silently", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-classify-"));
  fs.writeFileSync(path.join(cwd, "README.md"), "orient fixture\n");
  const provider = await startProvider();
  const run = await startRunner(cwd, provider.url, path.join(cwd, "runner.jsonl"));
  const events = await eventCollector(run);
  const chatRequests = () => provider.requests.filter((request) => request.path === "/api/engineering/chat");
  try {
    // A guided decision emits exactly one status delta, terminated with a blank
    // line so it cannot glue to the model's first token, and carries the
    // selector on every chat request in the run.
    const guided = await createSession(run);
    const guidedStart = events.events.length;
    const guidedChatStart = chatRequests().length;
    assert.equal((await prompt(run, guided.id, "ORIENT_GUIDED please look at this")).status, 204);
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === guided.id);
    const guidedDeltas = events.events
      .slice(guidedStart)
      .filter((event) => event.type === "assistant.delta")
      .map((event) => String(event.text));
    const status = guidedDeltas.filter((text) => text.startsWith("I'll inspect the failure path"));
    assert.equal(status.length, 1, `expected exactly one status delta, got ${JSON.stringify(guidedDeltas)}`);
    assert.ok(status[0].endsWith("\n\n"), "the status sentence must be terminated with a blank line");
    for (const request of chatRequests().slice(guidedChatStart)) {
      assert.equal(request.body.harness_bucket, "debug_failure");
    }
    assert.equal(provider.orientRequests.length, 1, "orient runs exactly once per accepted run");
    assert.equal(provider.orientRequests[0].route, "engineering/chat");
    assert.ok(!("messages" in provider.orientRequests[0]), "orient must not carry conversation messages");

    // A direct answer emits no status and selects no bucket: today's path.
    const direct = await createSession(run);
    const directStart = events.events.length;
    const directChatStart = chatRequests().length;
    assert.equal((await prompt(run, direct.id, "ORIENT_DIRECT what can you do?")).status, 204);
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === direct.id);
    const directChats = chatRequests().slice(directChatStart);
    assert.ok(directChats.length > 0);
    for (const request of directChats) {
      assert.equal("harness_bucket" in request.body, false, "direct answers select no bucket");
    }
    assert.equal(
      events.events.slice(directStart).some((event) => event.type === "assistant.progress.delta"),
      false,
      "a direct answer must not raise progress theater",
    );

    // An invalid status sentence is not scrubbed: the whole decision is dropped
    // and the run degrades to today's path.
    const badSentence = await createSession(run);
    const badChatStart = chatRequests().length;
    assert.equal((await prompt(run, badSentence.id, "ORIENT_BAD_SENTENCE inspect this")).status, 204);
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === badSentence.id);
    for (const request of chatRequests().slice(badChatStart)) {
      assert.equal("harness_bucket" in request.body, false, "an invalid sentence invalidates the decision");
    }

    // An orient failure degrades silently: no error surfaces and the run works.
    const degraded = await createSession(run);
    const degradedStart = events.events.length;
    const degradedChatStart = chatRequests().length;
    assert.equal((await prompt(run, degraded.id, "an unmarked request")).status, 204);
    const settled = await events.waitFor((event) => event.type === "run.settled" && event.sessionId === degraded.id);
    assert.notEqual(settled.summary, undefined);
    for (const request of chatRequests().slice(degradedChatStart)) {
      assert.equal("harness_bucket" in request.body, false);
    }
    assert.equal(
      events.events.slice(degradedStart).some((event) => event.type === "error" || event.type === "run.failed"),
      false,
      "orient failure must never surface as a user-visible error",
    );

    // Hidden-bucket invariant: no bucket id, decision, selector, or playbook
    // text ever crosses runner -> desktop, in any event.
    const serialized = JSON.stringify(events.events);
    for (const forbidden of [
      "harness_bucket",
      "debug_failure",
      "direct_answer",
      "open_task",
      "deep_review",
      "Active task playbook",
      "summarySentence",
      "orient",
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
