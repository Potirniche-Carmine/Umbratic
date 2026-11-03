import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";
const { cloudHandoff } = loadTypeScriptModule(new URL("../src/shared/cloudHandoff.ts", import.meta.url), { realm: "host" });
test("handoffs bound history, omit raw tools, and keep the current instruction intact", () => {
  const entries = [
    { kind: "instruction", text: "old".repeat(30_000) },
    { kind: "activity", text: "private raw tool output" },
    { kind: "answer", text: "Current result" },
    { kind: "instruction", text: "Use the file", images: [{ name: "brief.pdf", previewDataUrl: "secret image bytes" }] },
  ];
  const prompt = cloudHandoff(entries, "New instruction");
  assert.ok(prompt.length < 49_000);
  assert.match(prompt, /Current result/); assert.match(prompt, /brief.pdf/);
  assert.doesNotMatch(prompt, /private raw tool output|secret image bytes/);
  assert.ok(prompt.endsWith("Current user request:\nNew instruction"));
  assert.equal(cloudHandoff([], "First instruction"), "First instruction");
});

test("saved provider cursors survive serialization and switches without duplicating history", () => {
  const { rememberCloudSession, switchCloudProvider, cloudTurnPrompt } = loadTypeScriptModule(new URL("../src/shared/cloudHandoff.ts", import.meta.url), { realm: "host" });
  let workspace = { provider: "codex", sessionId: "gpt-session", account: "openai-account", compactions: 2, contextWindow: 200_000, inputTokens: 15_000, entries: [{ id: "old", kind: "answer", text: "Already known to GPT" }] };
  rememberCloudSession(workspace);
  switchCloudProvider(workspace, "claude");
  workspace.sessionId = "claude-session"; workspace.account = "claude-account";
  workspace.entries.push({ id: "new", kind: "answer", text: "New Claude findings" });
  rememberCloudSession(workspace);
  workspace = JSON.parse(JSON.stringify(workspace));
  switchCloudProvider(workspace, "codex");
  assert.equal(workspace.sessionId, "gpt-session"); assert.equal(workspace.account, "openai-account");
  assert.equal(workspace.inputTokens, 15_000); assert.equal(workspace.compactions, 2);
  switchCloudProvider(workspace, "claude"); switchCloudProvider(workspace, "codex");
  const prompt = cloudTurnPrompt(workspace, "Continue");
  assert.match(prompt, /New Claude findings/); assert.doesNotMatch(prompt, /Already known to GPT/);
  // An evicted cursor falls back to bounded visible history instead of dropping updates.
  workspace.entries = workspace.entries.slice(1);
  assert.match(cloudTurnPrompt(workspace, "Continue"), /New Claude findings/);
});
