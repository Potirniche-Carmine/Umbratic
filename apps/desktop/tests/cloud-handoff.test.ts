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
