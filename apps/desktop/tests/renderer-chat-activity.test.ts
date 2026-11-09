import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadRendererFile } from "./helpers/load-renderer.ts";

const { ChatActivityIndicator, localChatActivity } = loadRendererFile("ChatActivityIndicator.tsx");
const { ChatArchiveContent } = loadRendererFile("ChatArchive.tsx");
const { CloudChatArchiveContent } = loadRendererFile("cloud/CloudChatArchive.tsx");
const { WorkspaceNavigation } = loadRendererFile("WorkspaceNavigation.tsx");
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));

test("chat activity distinguishes working, finished, and attention states without relying on color alone", () => {
  const working = render(ChatActivityIndicator, { state: "running" });
  assert.match(working, /is-running/); assert.match(working, /aria-label="Working"/);
  assert.equal((working.match(/<i /g) || []).length, 3);
  for (const [state, label] of [["idle", "Unread reply"], ["waiting", "Needs your attention"]]) {
    const html = render(ChatActivityIndicator, { state, unread: true });
    assert.match(html, new RegExp(`is-${state}`)); assert.match(html, new RegExp(`aria-label="${label}"`));
    assert.equal((html.match(/<i /g) || []).length, 1);
  }
  assert.equal(render(ChatActivityIndicator, { state: "idle" }), "");
  for (const state of ["running", "approving"]) assert.equal(localChatActivity(state), "running");
  for (const state of ["awaiting_worktree_approval", "failed"]) assert.equal(localChatActivity(state), "waiting");
  for (const state of [undefined, "completed", "review_ready", "approved", "merged", "rejected"]) assert.equal(localChatActivity(state), "idle");
  assert.equal(localChatActivity("running", true), "waiting");
});

test("Codex, Claude, local chats, and provider navigation render the shared activity indicator", () => {
  const navigation = render(WorkspaceNavigation, { provider: "local", activity: { codex: "running", claude: "waiting", local: "idle" }, onSelect() {} });
  for (const state of ["running", "waiting"]) assert.match(navigation, new RegExp(`workspaceActivity is-${state}`));
  assert.doesNotMatch(navigation, /workspaceActivity is-idle/);
  const unreadNavigation = render(WorkspaceNavigation, { provider: "local", activity: { codex: "idle", claude: "idle", local: "idle" }, unread: { codex: true }, onSelect() {} });
  assert.equal((unreadNavigation.match(/workspaceActivity/g) || []).length, 1);
  assert.match(unreadNavigation, /ChatGPT has unread replies/);
  const common = { query: "", collapsed: new Set(), menu: null, disabled: false, loading: false,
    onSelect() {}, onNew() {}, onAddFolder() {}, onDelete() {}, onQueryChange() {}, onToggle() {}, onMenu() {} };
  for (const provider of ["codex", "claude"]) {
    for (const state of ["running", "waiting"]) {
      const html = render(CloudChatArchiveContent, { ...common, projects: [], chats: [{ key: "one", title: "Task", provider, state, paths: [] }] });
      assert.match(html, new RegExp(`workspaceActivity is-${state}`));
    }
    const props = { ...common, projects: [], chats: [{ key: "one", title: "Task", provider, state: "idle", paths: [] }] };
    assert.doesNotMatch(render(CloudChatArchiveContent, props), /workspaceActivity/);
    assert.match(render(CloudChatArchiveContent, { ...props, unreadChatIds: new Set(["one"]) }), /aria-label="Unread reply"/);
  }
  const chat = { id: "one", title: "Task", taskState: "running", modelEndpointMode: "local" };
  const props = { chatProjectGroups: [{ key: "project", name: "Project", chats: [chat], worktrees: [] }], activeChatId: "one",
    chatJumpNumbersById: new Map(), collapsedProjectKeys: new Set(), collapsedWorktreeKeys: new Set(),
    chatProjectTarget: () => null, query: "", busy: false };
  assert.match(render(ChatArchiveContent, props), /workspaceActivity is-running/);
  assert.match(render(ChatArchiveContent, { ...props, waitingChatId: "one" }), /workspaceActivity is-waiting/);
  const finished = { ...props, chatProjectGroups: [{ ...props.chatProjectGroups[0], chats: [{ ...chat, taskState: "completed" }] }] };
  assert.doesNotMatch(render(ChatArchiveContent, finished), /workspaceActivity/);
  assert.match(render(ChatArchiveContent, { ...finished, unreadChatIds: new Set(["one"]) }), /aria-label="Unread reply"/);
});
