import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const { chatTitleFromFirstMessage, stableChatTitle } = loadTypeScriptModule(
  new URL("../src/shared/chatTitle.ts", import.meta.url),
);

test("chat titles prefer two or three meaningful words", () => {
  assert.equal(
    chatTitleFromFirstMessage("I want you to look at EACH file and give a description for exactly what each is"),
    "File Description",
  );
  assert.equal(chatTitleFromFirstMessage("Please implement stable chat titles for the sidebar"), "Implement Stable Chat");
  assert.equal(chatTitleFromFirstMessage("fix it"), "Fix It");
});

test("chat titles ignore attachment metadata and never exceed three words", () => {
  const title = chatTitleFromFirstMessage("Review the authentication middleware carefully\n\nAttached files:\n- secret-plan.md");
  assert.equal(title, "Review Authentication Middleware");
  assert.ok(title.split(/\s+/).length <= 3);
  assert.doesNotMatch(title, /secret/i);
});

test("an existing chat title remains anchored to the first user message", () => {
  assert.equal(stableChatTitle("File Description", "Now fix the table"), "File Description");
  assert.equal(stableChatTitle("New chat", "Now fix the table"), "Now Fix Table");
  assert.equal(stableChatTitle(undefined, "Now fix the table"), "Now Fix Table");
});
