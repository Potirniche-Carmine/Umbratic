import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";
import { loadRendererFile } from "./helpers/load-renderer.ts";

const { codexStreamConsumer } = loadTypeScriptModule(new URL("../src/main/cloudCodexStream.ts", import.meta.url), { realm: "host" });
const { consumeClaudeMessage } = loadTypeScriptModule(new URL("../src/main/cloudClaude.ts", import.meta.url), { realm: "host" });
const { cloudTurns } = loadTypeScriptModule(new URL("../src/renderer/cloud/cloudTurns.ts", import.meta.url), { realm: "host" });
const { WorkingBlock } = loadRendererFile("workingBlock.tsx");

function sinkFixture() {
  const text = new Map(); const thinking = new Map(); const tools = new Map();
  const sink = {
    text: (id, value, append, phase) => text.set(id, { text: (append ? text.get(id)?.text || "" : "") + value, phase }),
    thinking: (id, value, append) => thinking.set(id, (append ? thinking.get(id) || "" : "") + value),
    activity: (_, tool) => tools.set(tool.id, { ...tools.get(tool.id), ...tool }),
    session() {}, usage() {}, compact() {},
  };
  return { text, thinking, tools, sink };
}

test("Codex publishes summaries, message phases, and bounded tool output before completion", () => {
  const f = sinkFixture(); const consume = codexStreamConsumer(f.sink);
  const send = (method, params) => consume({ method, params });
  send("item/started", { item: { type: "agentMessage", id: "preamble", phase: "commentary", text: "" } });
  send("item/agentMessage/delta", { itemId: "preamble", delta: "Reading files" });
  assert.deepEqual(f.text.get("preamble"), { text: "Reading files", phase: "commentary" });
  send("item/reasoning/summaryTextDelta", { itemId: "r1", summaryIndex: 0, delta: "Checking" });
  send("item/reasoning/summaryTextDelta", { itemId: "r1", summaryIndex: 0, delta: " the scope" });
  send("item/completed", { item: { type: "reasoning", id: "r1", summary: ["Checking the scope"], content: ["opaque"] } });
  assert.deepEqual([...f.thinking.values()], ["Checking the scope"]);
  send("item/started", { item: { type: "commandExecution", id: "c1", command: "npm test" } });
  send("item/commandExecution/outputDelta", { itemId: "c1", delta: "first\n" });
  send("item/commandExecution/outputDelta", { itemId: "c1", delta: "second\n" });
  assert.equal(f.tools.get("c1").status, "running");
  assert.equal(f.tools.get("c1").output, "first\nsecond\n");
  send("item/completed", { item: { type: "commandExecution", id: "c1", command: "npm test", aggregatedOutput: "done", exitCode: 1 } });
  assert.equal(f.tools.size, 1); assert.equal(f.tools.get("c1").output, "done"); assert.equal(f.tools.get("c1").status, "failed");
  send("item/started", { item: { type: "commandExecution", id: "c2", command: "verbose" } });
  send("item/commandExecution/outputDelta", { itemId: "c2", delta: "x".repeat(20000) });
  assert.equal(f.tools.get("c2").output.length, 12000);
  send("item/started", { item: { type: "agentMessage", id: "final", phase: "final_answer" } });
  send("item/agentMessage/delta", { itemId: "final", delta: "Done" });
  send("item/completed", { item: { type: "agentMessage", id: "final", phase: "final_answer", text: "Done." } });
  assert.deepEqual(f.text.get("final"), { text: "Done.", phase: "final_answer" });
});

test("Claude exposes text and tool input as they stream and retains result output", () => {
  const f = sinkFixture(); const stream = { messageId: "" };
  const send = message => consumeClaudeMessage(message, f.sink, "account", stream);
  const event = event => send({ type: "stream_event", event });
  event({ type: "message_start", message: { id: "m1" } });
  event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Checking files" } });
  event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "I will inspect" } });
  assert.equal(f.text.get("m1").text, "I will inspect");
  assert.equal(f.thinking.get("m1:0"), "Checking files");
  event({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "t1", name: "Bash" } });
  event({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"command":"pwd"}' } });
  assert.equal(f.tools.get("t1").detail, '{"command":"pwd"}');
  send({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pwd" } }] } });
  assert.equal(f.text.get("m1").text, "I will inspect");
  send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "/workspace" }] }] } });
  assert.equal(f.tools.get("t1").status, "completed"); assert.equal(f.tools.get("t1").output, "/workspace");
});

function entries() {
  return [
    { id: "u1", kind: "instruction", text: "Check", at: "2026-11-03T12:00:00Z" },
    { id: "a1", kind: "answer", text: "I will inspect", at: "2026-11-03T12:00:01Z" },
    { id: "t1", kind: "activity", text: "Read", at: "2026-11-03T12:00:02Z", tool: { id: "t1", label: "Read", detail: "cat README", output: "live output", status: "running" } },
  ];
}

test("progress stays inside one live block, with the final answer outside on completion", () => {
  const list = entries();
  let turn = cloudTurns(list, true)[0];
  assert.equal(turn.answer, undefined); assert.equal(turn.activity.finished, false);
  list[2].tool.status = "completed";
  assert.equal(cloudTurns(list, true)[0].answer, undefined);
  list.push({ id: "a2", kind: "answer", text: "The result", at: "2026-11-03T12:00:05Z" });
  turn = cloudTurns(list, true)[0];
  assert.equal(turn.answer, undefined); assert.equal(turn.activity.segments.at(-1).text, "The result");
  list[0].completedAt = "2026-11-03T12:00:09Z";
  turn = cloudTurns(list, true)[0];
  assert.equal(turn.activity.finished, true); assert.equal(turn.activity.endedAt, list[0].completedAt);
  assert.equal(turn.answer.id, "a2"); assert.deepEqual(turn.activity.segments.map(segment => segment.id), ["a1", "t1"]);
  list.push({ id: "u2", kind: "instruction", text: "Next", at: "2026-11-03T12:00:10Z" });
  assert.deepEqual(cloudTurns(list, true).map(turn => turn.activity.finished), [true, false]);
});

test("Cloud locks live work open while keeping command output on demand, then permits reopening", () => {
  const list = entries();
  const props = { item: cloudTurns(list, true)[0].activity, clock: Date.parse("2026-11-03T12:00:05Z"), expandWhileRunning: true,
    expanded: false, expandedToolIds: new Set(), skills: [], followScrollRef: { current: new Map() },
    setExpanded() {}, setExpandedTools() {}, setBodyRef() {}, onPointerDown() {}, onScroll() {}, onTouchMove() {}, onWheel() {} };
  const render = overrides => renderToStaticMarkup(React.createElement(WorkingBlock, { ...props, ...overrides }));
  const live = render({});
  assert.match(live, /activityHeader[^>]*disabled=""[^>]*aria-expanded="true"/);
  assert.match(live, /activityBody open/); assert.match(live, /cat README/); assert.doesNotMatch(live, /live output/);
  assert.match(live, /<button[^>]*activityToolRow/);
  assert.match(render({ expandedToolIds: new Set([`${props.item.id}:t1`]) }), /live output/);
  const item = cloudTurns(list, false)[0].activity;
  const completed = render({ item });
  assert.match(completed, /aria-expanded="false"/); assert.match(completed, /Worked for/);
  assert.doesNotMatch(completed, /activityHeader[^>]*disabled/);
  assert.match(render({ item, expanded: true }), /activityBody open/);
});
