import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

function createBuffer() {
  const { RunnerAssistantOutputBuffer } = loadTypeScriptModule(
    new URL("../src/main/runnerAssistantOutput.ts", import.meta.url),
  );
  return new RunnerAssistantOutputBuffer();
}

test("assistant text before a tool is classified as reasoning", () => {
  const buffer = createBuffer();
  buffer.append("Let me inspect ", "2026-01-01T00:00:01.000Z");
  buffer.append("the files.", "2026-01-01T00:00:02.000Z", "2026-01-01T00:00:03.000Z");

  assert.deepEqual(JSON.parse(JSON.stringify(buffer.continueWorking())), {
    kind: "reasoning",
    text: "Let me inspect the files.",
    at: "2026-01-01T00:00:01.000Z",
    endedAt: "2026-01-01T00:00:03.000Z",
  });
  assert.equal(buffer.complete(), null);
});

test("only the text remaining at session completion is classified as the assistant answer", () => {
  const buffer = createBuffer();
  buffer.append("I’ll read the workspace.");
  assert.equal(buffer.continueWorking().kind, "reasoning");

  buffer.append("Here is the complete answer.");
  assert.deepEqual(JSON.parse(JSON.stringify(buffer.complete())), {
    kind: "assistant",
    text: "Here is the complete answer.",
  });
  assert.equal(buffer.continueWorking(), null);
});

test("assistant text streams immediately after the validated answer boundary", () => {
  const buffer = createBuffer();
  buffer.append("Planning first.", "2026-01-01T00:00:01.000Z");

  assert.deepEqual(JSON.parse(JSON.stringify(buffer.startAnswer())), {
    kind: "reasoning",
    text: "Planning first.",
    at: "2026-01-01T00:00:01.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(buffer.append("First batch", "2026-01-01T00:00:02.000Z"))), {
    kind: "assistant",
    text: "First batch",
    at: "2026-01-01T00:00:02.000Z",
    endedAt: "2026-01-01T00:00:02.000Z",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(buffer.append(" second batch", "2026-01-01T00:00:03.000Z"))), {
    kind: "assistant",
    text: " second batch",
    at: "2026-01-01T00:00:03.000Z",
    endedAt: "2026-01-01T00:00:03.000Z",
  });
  assert.equal(buffer.complete(), null);
});

test("partial output from a failed model pass remains work activity", () => {
  const buffer = createBuffer();
  buffer.append("I’m still checking the folder.");

  assert.deepEqual(JSON.parse(JSON.stringify(buffer.fail())), {
    kind: "reasoning",
    text: "I’m still checking the folder.",
  });
  assert.equal(buffer.complete(), null);
});


