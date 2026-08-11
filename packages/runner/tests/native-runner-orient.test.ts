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
    // A guided decision shows its status sentence exactly once, as narration —
    // progress text inside the working block, never answer text — and carries
    // the selector on every chat request in the run.
    const guided = await createSession(run);
    const guidedStart = events.events.length;
    const guidedChatStart = chatRequests().length;
    assert.equal((await prompt(run, guided.id, "ORIENT_GUIDED please look at this")).status, 204);
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === guided.id);
    const guidedProgress = events.events
      .slice(guidedStart)
      .filter((event) => event.type === "assistant.progress.delta")
      .map((event) => String(event.text));
    assert.deepEqual(
      guidedProgress,
      ["I'll inspect the failure path and isolate the cause."],
      "the status sentence must show exactly once, as narration",
    );
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

    // An invalid status sentence costs the sentence, never the classification:
    // the sentence is the optional part of the decision, so it is dropped whole
    // rather than scrubbed, and the validated bucket still guides the run.
    const badSentence = await createSession(run);
    const badStart = events.events.length;
    const badChatStart = chatRequests().length;
    assert.equal((await prompt(run, badSentence.id, "ORIENT_BAD_SENTENCE inspect this")).status, 204);
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === badSentence.id);
    const badChats = chatRequests().slice(badChatStart);
    assert.ok(badChats.length > 0);
    for (const request of badChats) {
      assert.equal(request.body.harness_bucket, "debug_failure", "a dropped sentence must not drop the bucket");
    }
    // The rejected sentence reached no one — not as answer text and not as
    // narration — and the log says it was dropped rather than never produced.
    assert.equal(
      events.events.slice(badStart).some(
        (event) => (event.type === "assistant.delta" || event.type === "assistant.progress.delta")
          && String(event.text).includes("deep_review"),
      ),
      false,
      "a rejected sentence must never reach the user",
    );
    const badDecision = events.events
      .slice(badStart)
      .find((event) => event.type === "orient.decision");
    assert.equal(badDecision?.sentence, "missing");

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

    // Hidden-bucket invariant: the bucket id exists in exactly one place on the
    // wire — the orient.* diagnostic events, which the desktop records in its
    // local log and never forwards to the renderer. Every other event, and in
    // particular every assistant delta, must be free of it. Asserting over the
    // whole stream instead would forbid the diagnostic itself.
    const diagnosticTypes = new Set(["orient.decision", "orient.evidence_retry"]);
    const forwarded = events.events.filter((event) => !diagnosticTypes.has(String(event.type)));
    const serialized = JSON.stringify(forwarded);
    for (const forbidden of [
      "harness_bucket",
      "debug_failure",
      "direct_answer",
      "open_task",
      "deep_review",
      "repo_orient",
      "Active task playbook",
      "summarySentence",
      "orient",
    ]) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked into forwarded runner events`);
    }
    // The diagnostic events carry the bucket and nothing else that is private:
    // no playbook text and no selector field the chat request uses.
    const diagnostics = events.events.filter((event) => diagnosticTypes.has(String(event.type)));
    assert.ok(diagnostics.length > 0, "orient decisions must be observable in the event stream");
    const diagnosticText = JSON.stringify(diagnostics);
    for (const forbidden of ["harness_bucket", "Active task playbook", "summarySentence"]) {
      assert.equal(diagnosticText.includes(forbidden), false, `${forbidden} leaked into an orient diagnostic`);
    }
  } finally {
    await events?.close();
    await run.close();
    await provider.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// A live repo_orient run answered "can you tell me more about this codebase?"
// with a confident, wholly invented architecture summary and zero tool calls.
// Nothing stopped it: the loop treats any tool-less content as the final answer.
// A bucket Veil marks as evidence-required must refuse that first answer once
// and restart the plan.
test("an evidence-required bucket cannot answer before calling a tool", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-evidence-"));
  fs.writeFileSync(path.join(cwd, "README.md"), "evidence fixture\n");
  const provider = await startProvider();
  const run = await startRunner(cwd, provider.url, path.join(cwd, "runner.jsonl"));
  const events = await eventCollector(run);
  try {
    const session = await createSession(run);
    assert.equal((await prompt(run, session.id, "ORIENT_EVIDENCE tell me about this codebase")).status, 204);
    await events.waitFor((event) => event.type === "run.settled" && event.sessionId === session.id);

    // The refusal is observable, and it happened exactly once.
    const retries = events.events.filter((event) => event.type === "orient.evidence_retry");
    assert.equal(retries.length, 1, "the ungrounded answer must be refused exactly once");
    assert.equal(retries[0].bucket, "repo_orient");

    // The refused text never reached the user. Refusing after streaming would
    // still leave the fabrication on screen, which is what a live run showed:
    // the invented summary was rendered as an answer and the tool calls only
    // appeared underneath it.
    const deltas = events.events
      .filter((event) => event.type === "assistant.delta")
      .map((event) => String(event.text));
    for (const delta of deltas) {
      assert.equal(
        delta.includes("three-layer monorepo"),
        false,
        `the refused answer must never be streamed: ${delta}`,
      );
    }
    // The status sentence still opens the run, as narration: holding applies
    // to the model's answer, never to orient's own status line.
    const progress = events.events
      .filter((event) => event.type === "assistant.progress.delta")
      .map((event) => String(event.text));
    assert.ok(
      progress.some((text) => text.startsWith("I will map this repository")),
      `the status sentence must still be shown: ${JSON.stringify(progress)}`,
    );
    // The preamble the model volunteered with its tool call sits inside the
    // status window, so the cadence drops it rather than showing a second
    // status two seconds after the first.
    assert.equal(
      events.events.some((event) =>
        (event.type === "assistant.delta" || event.type === "assistant.progress.delta")
          && String(event.text).includes("Listing the workspace root now")),
      false,
      "a preamble inside the status window must be dropped unshown",
    );

    // The run then did real work instead of shipping the fabrication.
    const listed = events.events.filter(
      (event) => event.type === "tool.finished" && event.toolCallId === "evidence-ls",
    );
    assert.equal(listed.length, 1, "the refused turn must be followed by an actual tool call");

    // The grounded answer is the one that survives to the end of the run.
    const text = events.events
      .filter((event) => event.type === "assistant.delta")
      .map((event) => String(event.text))
      .join("");
    assert.ok(text.includes("README.md"), `the final answer must rest on tool results: ${text}`);

    // A second identical refusal would spend the turn budget arguing, so the
    // rule fires once per run and the model is trusted after that.
    assert.equal(
      events.events.filter((event) => event.type === "run.settled").length,
      1,
      "the run settles normally after the single refusal",
    );
  } finally {
    await events?.close();
    await run.close();
    await provider.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// Past the status-line bound, a step's prose streams live and ships verbatim.
// The harness reads none of the words: an earlier version scanned answers for
// announcement phrasings and trimmed or refused them, and every live model
// promptly used a phrasing the list did not have. Whatever the model writes is
// what the user sees; ending on the answer is the playbook's guidance to give.
test("streamed prose ships verbatim, with no wording heuristics applied", async () => {
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

    const deltas = events.events
      .filter((event) => event.type === "assistant.delta")
      .map((event) => String(event.text));
    const answer = deltas.join("");
    // Both long texts streamed live and arrived whole, closing sentences
    // included — nothing was rewritten, trimmed, or held back.
    assert.ok(
      answer.includes("The documentation describes a static bakery site"),
      `the mid-turn report must stand where it streamed: ${answer}`,
    );
    assert.ok(
      answer.includes("I will read the site script"),
      `streamed prose must ship verbatim: ${answer}`,
    );
    assert.ok(
      answer.includes("The bakery site is one static page"),
      `the streamed answer body must survive: ${answer}`,
    );
    assert.ok(
      answer.includes("Starting with the main config, which appears central."),
      `the answer's own closing words must ship verbatim: ${answer}`,
    );

    // No wording-based event exists anywhere in the stream.
    assert.equal(
      events.events.some((event) => String(event.type).startsWith("orient.announcement")),
      false,
      "no announcement heuristics may run",
    );

    // The structural rules still hold: the short step-one preamble stayed
    // inside the status window and was dropped by size, not by wording.
    assert.equal(
      events.events.some((event) =>
        (event.type === "assistant.delta" || event.type === "assistant.progress.delta")
          && String(event.text).includes("Opening the documentation first")),
      false,
      "the volunteered preamble must be dropped unshown",
    );
  } finally {
    await events?.close();
    await run.close();
    await provider.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// The orientation is the run's only harness-driven status line, however long
// the run gets. Preambles are dropped by size alone, and nothing is ever
// injected into the model's context to ask for more narration — the tool rows
// narrate every call on their own.
test("a long guided run shows the orientation and nothing else is injected", async () => {
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

    // Exactly one status line for thirteen tool calls: the orientation.
    const progress = events.events
      .filter((event) => event.type === "assistant.progress.delta")
      .map((event) => String(event.text));
    assert.deepEqual(
      progress,
      ["I will map this repository and read what it documents."],
      `expected the orientation alone, got ${JSON.stringify(progress)}`,
    );

    // The volunteered per-step preambles were dropped, not shown anywhere.
    assert.equal(
      events.events.some((event) =>
        (event.type === "assistant.delta" || event.type === "assistant.progress.delta")
          && String(event.text).includes("Reading tour file")),
      false,
      "short per-step preambles must be dropped by size",
    );

    // Nothing was ever added to the model's context: every tool message the
    // model saw is exactly the tool output the runner produced.
    const lastChat = provider.requests.filter((request) => request.path === "/api/engineering/chat").at(-1);
    const toolMessages = (lastChat?.body.messages as Array<{ role?: string; content?: unknown }>)
      .filter((message) => message.role === "tool" && !/^read: tour-\d+\.txt \(ok\)/.test(String(message.content ?? "")));
    assert.deepEqual(toolMessages, [], "no harness text may ride the model's tool results");

    // The turn still ends on the real answer.
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
