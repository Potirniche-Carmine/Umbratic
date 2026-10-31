import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadRendererFile } from "./helpers/load-renderer.ts";

const { ChatArchive } = loadRendererFile("ChatArchive.tsx");
const chat = { id: "chat-a", title: "Review the project", modelEndpointMode: "local", updatedAt: "2026-09-19T12:00:00Z", taskState: "completed" };
const group = { key: "project", name: "Project", path: "/workspace", chats: [chat], worktrees: [] };

function props(overrides = {}) {
  return {
    chatProjectGroups: [group], activeChatId: chat.id, chatJumpKeysVisible: false,
    chatJumpNumbersById: new Map([[chat.id, 1]]), collapsedProjectKeys: new Set(), collapsedWorktreeKeys: new Set(),
    projectActionMenuKey: null, setProjectActionMenuKey() {}, setDeleteCandidate() {},
    chatProjectTarget: () => ({ id: "project", name: "Project", path: "/workspace", chatCount: 1 }),
    toggleProjectGroup() {}, toggleWorktreeGroup() {}, selectChat: async () => {}, newChat: async () => {}, newProject: async () => {},
    newChatForProject: async () => {}, newChatForWorktree: async () => {}, busy: false, ...overrides,
  };
}

function elements(node, tag, found = []) {
  if (!node || typeof node !== "object") return found;
  if (Array.isArray(node)) { node.forEach((child) => elements(child, tag, found)); return found; }
  if (node.type === tag) found.push(node);
  return elements(node.props?.children, tag, found);
}

test("chat archive renders active, empty, collapsed, and keyboard-jump states", () => {
  const render = (value) => renderToStaticMarkup(React.createElement(ChatArchive, props(value)));
  const expanded = render({});
  assert.match(expanded, /Review the project/);
  assert.match(expanded, /chatRow active/);
  assert.match(expanded, /aria-label="Local model"/);
  assert.doesNotMatch(render({ collapsedProjectKeys: new Set(["project"]) }), /Review the project/);
  assert.match(render({ chatProjectGroups: [] }), /No chats yet/);
  assert.match(render({ chatJumpKeysVisible: true }), /chatJumpKey/);
});

test("chat archive routes selection and deletion through the supplied actions", () => {
  const calls = [];
  const tree = ChatArchive(props({ selectChat: async (selected) => calls.push(["select", selected.id]), setDeleteCandidate: (candidate) => calls.push([candidate.kind, candidate.chat.id]) }));
  const buttons = elements(tree, "button");
  buttons.find((button) => button.props.className === "chatRowMain").props.onClick();
  buttons.find((button) => button.props.className === "chatDeleteButton").props.onClick({ stopPropagation() {} });
  assert.deepEqual(calls, [["select", chat.id], ["chat", chat.id]]);
});
