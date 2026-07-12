import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const { readOpenAIStream } = loadTypeScriptModule(new URL("../src/provider/openaiChat.ts", import.meta.url).pathname, { cache: new Map() });
const { normalizedTurnToolCalls } = loadTypeScriptModule(new URL("../src/loop.ts", import.meta.url).pathname, { cache: new Map() });

async function* chunks(...values) {
  for (const value of values) yield Buffer.from(value);
}

test("OpenAI stream assembler accumulates split arguments by index", async () => {
  const first = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-read", function: { name: "read", arguments: "{\"file" } }] } }] })}\n\n`;
  const second = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "Path\":\"README.md\"}" } }] } }] })}\n\ndata: [DONE]\n\n`;
  const result = await readOpenAIStream("task-stream", chunks(first.slice(0, 17), first.slice(17), second));
  assert.equal(result.toolCalls.get(0).id, "call-read");
  assert.equal(result.toolCalls.get(0).arguments, '{"filePath":"README.md"}');
});

test("length-truncated tool arguments are made non-executable", async () => {
  const row = `data: ${JSON.stringify({ choices: [{ finish_reason: "length", delta: { tool_calls: [{ index: 0, function: { name: "write", arguments: "{\"filePath\":\"x" } }] } }] })}\n\ndata: [DONE]\n\n`;
  const result = await readOpenAIStream("task-stream", chunks(row));
  assert.equal(result.truncatedToolArguments, true);
  assert.throws(() => JSON.parse(result.toolCalls.get(0).arguments));
});

test("missing and duplicate provider call IDs receive stable turn-local IDs", () => {
  const calls = new Map([
    [0, { id: "same", name: "read", arguments: "{}" }],
    [1, { id: "same", name: "search", arguments: "{}" }],
    [2, { id: "", name: "read", arguments: "{}" }],
  ]);
  const normalized = normalizedTurnToolCalls(calls, "session-turn-2");
  assert.equal(normalized.map((call) => call.id).join(","), "same,session-turn-2-tool-1,session-turn-2-tool-2");
});
