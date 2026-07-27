import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const promptContext = loadTypeScriptModule(new URL("../src/main/promptContext.ts", import.meta.url));

test("limitPromptImages retains the newest bounded images and all text context", () => {
  const parts = [
    { type: "text", text: "workspace" },
    { type: "image", data_url: "old" },
    { type: "text", text: "history" },
    { type: "image", data_url: "new" },
    { type: "text", text: "request" },
  ];
  const bounded = promptContext.limitPromptImages(parts, 1);
  assert.deepEqual(Array.from(bounded.filter((part) => part.type === "image"), (part) => part.data_url), ["new"]);
  assert.match(bounded.map((part) => part.text ?? "").join("\n"), /workspace[\s\S]*history[\s\S]*request/);
  assert.match(bounded[0].text, /1 older image attachment was omitted/);

  const byteBounded = promptContext.limitPromptImages([
    { type: "image", data_url: "a".repeat(8) },
    { type: "image", data_url: "b".repeat(8) },
  ], 12, 8);
  assert.deepEqual(Array.from(byteBounded.filter((part) => part.type === "image"), (part) => part.data_url), ["b".repeat(8)]);
});

test("casual introductions do not receive workspace context", () => {
  for (const prompt of [
    "hello",
    "Hey there, tell me about yourself!",
    "Good morning. What can you do?",
  ]) {
    assert.equal(promptContext.shouldIncludeWorkspaceContext(prompt, 0), false, prompt);
  }
});

test("workspace requests and attachments keep factual workspace context", () => {
  assert.equal(promptContext.shouldIncludeWorkspaceContext("Hey, inspect the repository", 0), true);
  assert.equal(promptContext.shouldIncludeWorkspaceContext("hello", 1), true);
});
