import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const { chatTitleFromFirstMessage, stableChatTitle } = loadTypeScriptModule(
  new URL("../src/shared/chatTitle.ts", import.meta.url),
);

test("chat titles lead with the words that tell one chat from another", () => {
  // Openers are what every chat shares, so they are dropped before truncation
  // rather than filling the narrow sidebar column.
  assert.equal(chatTitleFromFirstMessage("can you tell me about this porject"), "Porject");
  assert.equal(chatTitleFromFirstMessage("what is the retry policy"), "Retry policy");
  assert.equal(chatTitleFromFirstMessage("hey, can you please fix the CRLF bug"), "Fix the CRLF bug");
  assert.equal(chatTitleFromFirstMessage("fix it"), "Fix it");
});

test("a greeting is not a title", () => {
  // "Hey there, fix the build" opens with two words of nothing. Stripping only
  // the first left a sidebar where three different chats all read "There".
  assert.equal(chatTitleFromFirstMessage("hey there fix the build"), "Fix the build");
  assert.equal(chatTitleFromFirstMessage("hi there, tell me about the retry policy"), "Retry policy");
  // A message that is only a greeting still has to say what it said.
  assert.equal(chatTitleFromFirstMessage("hey there"), "Hey there");
  // The subject on its own line, behind a greeting on the first one.
  assert.equal(chatTitleFromFirstMessage("hi!\ncan you fix the CRLF bug"), "Fix the CRLF bug");
});

test("a full stop inside a word or a number does not end the title", () => {
  // "Tell me 1. what the runner does" used to break at the enumerator and
  // title the chat with the number it broke on.
  assert.equal(chatTitleFromFirstMessage("tell me 1. what the runner does"), "What the runner does");
  assert.equal(chatTitleFromFirstMessage("bump to v1.2 and rebuild"), "Bump to v1.2 and rebuild");
  assert.equal(chatTitleFromFirstMessage("use e.g. a mutex here"), "Use e.g. a mutex here");
  // A number that is counting keeps its number.
  assert.equal(chatTitleFromFirstMessage("tell me 1 thing about retries"), "1 thing about retries");
});

test("politeness at the end is not part of the title", () => {
  assert.equal(chatTitleFromFirstMessage("Update the release docs please"), "Update the release docs");
  assert.equal(chatTitleFromFirstMessage("Update the release docs, thanks"), "Update the release docs");
});

test("chat titles fit the sidebar column", () => {
  const long = chatTitleFromFirstMessage(
    "Investigate why the streaming relay drops events under concurrent load",
  );
  assert.ok(long.length <= 33, `${long} (${long.length})`);
  assert.ok(long.endsWith("…"), long);
  assert.doesNotMatch(long, /\s…$/);
});

test("chat titles keep capitalization the user chose", () => {
  assert.equal(chatTitleFromFirstMessage("read.rs normalizes line endings"), "read.rs normalizes line endings");
  assert.equal(chatTitleFromFirstMessage("Veil returns 400"), "Veil returns 400");
});

test("chat titles use the first statement only", () => {
  assert.equal(
    chatTitleFromFirstMessage("Review the auth middleware. Then check the session store."),
    "Review the auth middleware",
  );
});

test("chat titles ignore attachments, code fences, and list markup", () => {
  const title = chatTitleFromFirstMessage(
    "Review the auth middleware\n\nAttached files:\n- secret-plan.md",
  );
  assert.equal(title, "Review the auth middleware");
  assert.doesNotMatch(title, /secret/i);

  assert.equal(
    chatTitleFromFirstMessage("```\nconst a = 1;\n```\nExplain this snippet"),
    "Snippet",
  );
  assert.equal(chatTitleFromFirstMessage("## Add retry\n\nDetails follow"), "Add retry");
});

test("an empty or formatting-only message keeps the placeholder title", () => {
  assert.equal(chatTitleFromFirstMessage("   "), "New chat");
  assert.equal(chatTitleFromFirstMessage("```\ncode only\n```"), "New chat");
});

test("an existing chat title remains anchored to the first user message", () => {
  assert.equal(stableChatTitle("File description", "Now fix the table"), "File description");
  assert.equal(stableChatTitle("New chat", "Now fix the table"), "Fix the table");
  assert.equal(stableChatTitle(undefined, "Now fix the table"), "Fix the table");
});
