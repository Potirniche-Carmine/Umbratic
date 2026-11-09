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

test("saved native cursors survive serialization without duplicating the chat history", () => {
  const { rememberCloudSession, cloudTurnPrompt } = loadTypeScriptModule(new URL("../src/shared/cloudHandoff.ts", import.meta.url), { realm: "host" });
  let workspace = { provider: "codex", sessionId: "gpt-session", account: "openai-account", compactions: 2, entries: [{ id: "old", kind: "answer", text: "Already known" }] };
  rememberCloudSession(workspace);
  workspace = JSON.parse(JSON.stringify(workspace));
  assert.equal(cloudTurnPrompt(workspace, "Continue"), "Continue");
  workspace.entries.push({ id: "new", kind: "answer", text: "Unsent update" });
  const prompt = cloudTurnPrompt(workspace, "Continue");
  assert.match(prompt, /Unsent update/); assert.doesNotMatch(prompt, /Already known/);
  workspace.entries = workspace.entries.slice(1);
  assert.match(cloudTurnPrompt(workspace, "Continue"), /Unsent update/);
});
