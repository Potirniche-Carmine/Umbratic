import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const contextWindow = loadTypeScriptModule(new URL("../src/shared/contextWindow.ts", import.meta.url));

test("context length settings use the Ollama-oriented 64K default and snap to supported choices", () => {
  assert.equal(contextWindow.normalizeContextLength(undefined), 64000);
  assert.equal(contextWindow.normalizeContextLength("128000"), 128000);
  assert.equal(contextWindow.normalizeContextLength(1000), 32000);
  assert.equal(contextWindow.normalizeContextLength(71000), 64000);
  assert.equal(contextWindow.normalizeContextLength(100000), 128000);
  assert.equal(contextWindow.normalizeContextLength(999999), 256000);
  assert.deepEqual(Array.from(contextWindow.CONTEXT_LENGTH_OPTIONS), [32000, 64000, 128000, 256000]);
});

test("runner-measured content can be used as the base for an unsent draft", () => {
  const estimate = contextWindow.estimateContextUsage([{ text: "12345" }], 64000, { contentTokens: 12000 });
  assert.equal(estimate.contentTokens, 12012);
  assert.equal(estimate.estimatedTokens, 20204);
  assert.equal(Math.round(estimate.percentage), 32);
});

test("runner-provided reserves replace the fallback without being counted twice", () => {
  const estimate = contextWindow.estimateContextUsage([], 64000, { contentTokens: 12000, reserveTokens: 4096 });
  assert.equal(estimate.contentTokens, 12000);
  assert.equal(estimate.reserveTokens, 4096);
  assert.equal(estimate.estimatedTokens, 16096);
});

test("the context meter stays hidden until a draft or conversation has context", () => {
  assert.equal(contextWindow.shouldShowContextMeter({
    hasRunnerUsage: false,
    timelineItemCount: 0,
    prompt: "   ",
    attachmentCount: 0,
  }), false);
  assert.equal(contextWindow.shouldShowContextMeter({
    hasRunnerUsage: false,
    timelineItemCount: 0,
    prompt: "Inspect this workspace",
    attachmentCount: 0,
  }), true);
  assert.equal(contextWindow.shouldShowContextMeter({
    hasRunnerUsage: true,
    timelineItemCount: 0,
    prompt: "",
    attachmentCount: 0,
  }), true);
});

test("context estimates use conservative text, message, attachment, and reserve costs", () => {
  assert.equal(contextWindow.estimateTextTokens("12345"), 2);
  assert.equal(contextWindow.estimateTextTokens(""), 0);

  const estimate = contextWindow.estimateContextUsage([
    { text: "12345" },
    { text: "image", attachments: [{ name: "reference.png" }, { name: "notes.md" }] },
  ], 64000);

  assert.equal(estimate.contentTokens, 2 + 10 + 2 + 10 + 1600 + 512);
  assert.equal(estimate.reserveTokens, 8192);
  assert.equal(estimate.percentage, (estimate.estimatedTokens / 64000) * 100);
  assert.equal(estimate.level, "normal");
  assert.equal(estimate.overLimit, false);
});

test("context usage warns at 75 percent and becomes critical at 90 percent", () => {
  const warning = contextWindow.estimateContextUsage([{ text: "x".repeat(160000) }], 64000);
  const critical = contextWindow.estimateContextUsage([{ text: "x".repeat(200000) }], 64000);

  assert.equal(warning.level, "warning");
  assert.equal(Math.round(warning.percentage), 75);
  assert.equal(critical.level, "critical");
  assert.equal(Math.round(critical.percentage), 91);
  assert.equal(contextWindow.formatTokenCount(64000), "64K");
});
