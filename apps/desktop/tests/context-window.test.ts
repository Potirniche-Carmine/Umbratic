import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const contextWindow = loadTypeScriptModule(new URL("../src/shared/contextWindow.ts", import.meta.url));

test("desktop reserve constants stay aligned with the runner", () => {
  const runnerContext = readFileSync(new URL("../../../packages/runner/src/context.rs", import.meta.url), "utf8");
  assert.match(runnerContext, /const MINIMUM_OUTPUT_TOKENS: u64 = 1_000;/);
  assert.match(runnerContext, /const OUTPUT_STEP_TOKENS: u64 = 1_000;/);
  assert.equal(contextWindow.CONTEXT_MINIMUM_OUTPUT_TOKENS, 1_000);
  assert.equal(contextWindow.CONTEXT_OUTPUT_STEP_TOKENS, 1_000);
  assert.equal(contextWindow.CONTEXT_OUTPUT_RESERVE_TOKENS, 8_192);
  assert.equal(contextWindow.CONTEXT_PROTECTED_RESERVE_TOKENS, 2_048);
});

test("context length settings use the 64K default and snap to every supported local choice", () => {
  assert.equal(contextWindow.normalizeContextLength(undefined), 64000);
  assert.equal(contextWindow.normalizeContextLength("128000"), 128000);
  assert.equal(contextWindow.normalizeContextLength(1000), 4000);
  assert.equal(contextWindow.normalizeContextLength(71000), 64000);
  assert.equal(contextWindow.normalizeContextLength(100000), 128000);
  assert.equal(contextWindow.normalizeContextLength(999999), 256000);
  assert.deepEqual(Array.from(contextWindow.CONTEXT_LENGTH_OPTIONS), [4000, 8000, 16000, 32000, 64000, 128000, 256000]);
  assert.equal(contextWindow.normalizeEffectiveContextLength(131072), 131072);
});

test("runner-measured content can be used as the base for an unsent draft", () => {
  const estimate = contextWindow.estimateContextUsage([{ text: "12345" }], 64000, { contentTokens: 12000 });
  assert.equal(estimate.contentTokens, 12012);
  assert.equal(estimate.reserveTokens, 8192);
  assert.equal(estimate.estimatedTokens, 20204);
  assert.equal(Math.round(estimate.percentage), 32);
  assert.equal(estimate.protectedTokens, 0);
});

test("runner-provided reserves replace the fallback without being counted twice", () => {
  const estimate = contextWindow.estimateContextUsage([], 131072, { contentTokens: 12000, reserveTokens: 4096 });
  assert.equal(estimate.contextLength, 131072);
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

test("context estimates use measured attachment text with a safe unmeasured fallback", () => {
  assert.equal(contextWindow.estimateTextTokens("12345"), 2);
  assert.equal(contextWindow.estimateTextTokens("你好🙂"), 5);
  assert.equal(contextWindow.estimateTextTokens(""), 0);

  const estimate = contextWindow.estimateContextUsage([
    { text: "12345" },
    { text: "image", attachments: [{ name: "reference.png" }, { name: "plan.md", contextTokens: 7500 }, { name: "unmeasured.md" }] },
  ], 64000);

  assert.equal(estimate.contentTokens, 2048 + 2 + 10 + 2 + 10 + 1600 + 7500 + 512);
  assert.equal(estimate.reserveTokens, 8192);
  assert.equal(estimate.protectedTokens, 2048);
  assert.equal(estimate.percentage, (estimate.estimatedTokens / 64000) * 100);
  assert.equal(estimate.level, "normal");
  assert.equal(estimate.overLimit, false);
});

test("attached text estimates preserve the full document and bound only initial context", () => {
  const plan = "a".repeat(33_385);
  assert.equal(contextWindow.estimateAttachmentTextTokens(plan), 8_347);
  assert.equal(contextWindow.attachmentPromptTokenBudget(16_000), 8_000);

  const estimate = contextWindow.estimateContextUsage([
    { text: "Summarize this", attachments: [{ name: "plan.md", contextTokens: 8_347 }] },
  ], 16_000);
  assert.equal(estimate.contentTokens, 2_048 + 4 + 10 + 8_000);
  assert.equal(estimate.reserveTokens, 5_000);
  assert.equal(estimate.estimatedTokens, 15_062);
});

test("oversized initial attachment context keeps both ends without losing full-document accounting", () => {
  const document = `BEGIN-${"中🙂body".repeat(2_000)}-END`;
  const excerpt = contextWindow.attachmentTextExcerpt(document, 500);
  assert.equal(excerpt.truncated, true);
  assert.ok(excerpt.text.startsWith("BEGIN-"));
  assert.ok(excerpt.text.endsWith("-END"));
  assert.ok(excerpt.text.includes("middle omitted from initial context"));
  assert.ok(contextWindow.estimateTextTokens(excerpt.text) <= 500);

  const complete = contextWindow.attachmentTextExcerpt(document, contextWindow.estimateTextTokens(document));
  assert.equal(complete.text, document);
  assert.equal(complete.truncated, false);
});

test("response allowance grows to 8K when space permits and steps down to a 1K minimum", () => {
  assert.equal(contextWindow.adaptiveOutputReserve(16_000, 8_000), 8_000);
  assert.equal(contextWindow.adaptiveOutputReserve(16_000, 12_400), 3_000);
  assert.equal(contextWindow.adaptiveOutputReserve(16_000, 13_400), 2_000);
  assert.equal(contextWindow.adaptiveOutputReserve(16_000, 14_400), 1_000);
  assert.equal(contextWindow.adaptiveOutputReserve(16_000, 15_400), 1_000);
});

test("context usage warns at 75 percent and becomes critical at 90 percent", () => {
  const warning = contextWindow.estimateContextUsage([{ text: "x".repeat(160000) }], 64000);
  const critical = contextWindow.estimateContextUsage([{ text: "x".repeat(205000) }], 64000);

  assert.equal(warning.level, "warning");
  assert.equal(Math.round(warning.percentage), 79);
  assert.equal(critical.level, "critical");
  assert.equal(Math.round(critical.percentage), 96);
  assert.equal(contextWindow.formatTokenCount(64000), "64K");
});

test("context percentage includes the response reserve shown in preflight", () => {
  const estimate = contextWindow.estimateContextUsage([], 32000, {
    contentTokens: 18000,
    reserveTokens: 8000,
  });

  assert.equal(estimate.estimatedTokens, 26000);
  assert.equal(estimate.percentage, 81.25);
  assert.equal(estimate.level, "warning");
});

test("PDF attachments without a measured inspection estimate as a page image, not a file stub", () => {
  assert.equal(contextWindow.isPdfContextAttachment({ name: "brief.pdf" }), true);
  assert.equal(contextWindow.isPdfContextAttachment({ path: "docs/brief.PDF" }), true);
  assert.equal(contextWindow.isPdfContextAttachment({ name: "readme.md" }), false);

  const estimate = contextWindow.estimateContextUsage([
    { text: "review", attachments: [{ name: "scan.pdf" }, { name: "notes.pdf", contextTokens: 9000 }] },
  ], 64000);
  // 1600 honest fallback for the uninspected PDF; the measured one uses its
  // route-aware inspection estimate instead of the 512 file stub.
  assert.equal(estimate.contentTokens, 2048 + 2 + 10 + 1600 + 9000);
});
