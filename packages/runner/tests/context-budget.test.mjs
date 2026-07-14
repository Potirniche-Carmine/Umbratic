import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const budget = loadTypeScriptModule(new URL("../src/contextBudget.ts", import.meta.url));

test("context accounting includes text, message envelopes, images, tool calls, and tool schemas", () => {
  const toolCalls = [{ id: "call-1", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } }];
  const tools = [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object" } } }];
  const messages = [
    { role: "user", content: "12345" },
    { role: "assistant", content: null, tool_calls: toolCalls },
    { role: "tool", tool_call_id: "call-1", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,x" } }] },
  ];

  const contentTokens = budget.estimateMessagesTokens(messages) + budget.estimateToolSchemaTokens(tools);
  assert.equal(contentTokens, 30 + 2 + 1600 + budget.estimateTextTokens(JSON.stringify(toolCalls))
    + budget.estimateTextTokens("call-1") + budget.estimateTextTokens(JSON.stringify(tools)));

  const usage = budget.estimateContextUsage(messages, tools, { contextLength: 64000 });
  assert.equal(usage.contextLength, 64000);
  assert.equal(usage.contentTokens, contentTokens);
  assert.equal(usage.reserveTokens, 8192);
  assert.equal(usage.estimatedTokens, contentTokens + 8192);
});

test("context accounting includes additional model-facing metadata", () => {
  const skills = [{ id: "python", name: "Python", description: "Use for Python work.", source: "system" }];
  const usage = budget.estimateContextUsage([], [], { contextLength: 64000, additionalPayloads: [skills] });
  assert.equal(usage.contentTokens, budget.estimateTextTokens(JSON.stringify(skills)));
});

test("context accounting defaults invalid budget values conservatively", () => {
  const usage = budget.estimateContextUsage([], [], {
    contextLength: -1,
    maxResponseTokens: 0,
    protectedPromptReserveTokens: Number.NaN,
  });
  assert.equal(usage.contextLength, 64000);
  assert.equal(usage.reserveTokens, 8192);
});
