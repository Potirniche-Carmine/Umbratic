import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadRendererFile } from "./helpers/load-renderer.ts";

const { cloudArchiveGroups, CloudChatArchiveContent } = loadRendererFile("cloud/CloudChatArchive.tsx");
const { UserPrompt } = loadRendererFile("UserPrompt.tsx");
const projects = [{ id: "one", name: "App", rootPath: "/project/app" }, { id: "two", name: "Notes", rootPath: "/project/notes" }];
const chat = { key: "codex-one", provider: "codex", title: "Review app", state: "idle", paths: ["/project/app"], updatedAt: "2026-11-03T10:00:00Z" };

test("cloud archives show every registered folder, including folders with no chats", () => {
  const groups = cloudArchiveGroups([chat], projects, "");
  assert.deepEqual(Array.from(groups, group => [group.name, group.chats.length]), [["App", 1], ["Notes", 0]]);
  const aliased = { ...chat, paths: ["/canonical/app"], repositoryIds: ["one", "two"] };
  assert.deepEqual(Array.from(cloudArchiveGroups([aliased], projects, ""), group => group.chats.length), [1, 1]);
  assert.equal(cloudArchiveGroups([chat], projects, "review").length, 1);
  assert.equal(cloudArchiveGroups([chat], projects, "notes")[0].chats.length, 0);
});

test("cloud folder collapse and search match the local archive behavior", () => {
  const render = query => renderToStaticMarkup(React.createElement(CloudChatArchiveContent, {
    chats: [chat], projects, activeKey: chat.key, disabled: false, loading: false, query, collapsed: new Set(["one"]), menu: null,
    onSelect() {}, onNew() {}, onAddFolder() {}, onDelete() {}, onQueryChange() {}, onToggle() {}, onMenu() {},
  }));
  assert.doesNotMatch(render(""), /Review app|No chats yet/);
  const searched = render("review");
  assert.match(searched, /chatProjectChats/); assert.match(searched, /Review app/); assert.match(searched, /aria-current="page"/);
  assert.doesNotMatch(searched, /Notes/);
});

test("user prompts keep text literal and expose compact image previews and copy", () => {
  const result = renderToStaticMarkup(React.createElement(UserPrompt, {
    text: "# Keep this size\n<img onerror=alert(1)>", files: [{ path: "shot.png", kind: "file", previewDataUrl: "data:image/png;base64,AA==" }], onOpen() {}, onCopy() {},
  }));
  assert.match(result, /class="userPromptText"/); assert.match(result, /# Keep this size/); assert.match(result, /&lt;img onerror/);
  assert.doesNotMatch(result, /<h1|<img onerror/); assert.match(result, /messageAttachmentList/); assert.match(result, /Copy prompt/);
});
