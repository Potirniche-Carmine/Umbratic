import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadRendererFile } from "./helpers/load-renderer.ts";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const { ConfirmationDialog } = loadRendererFile("ConfirmationDialog.tsx");
const { AttachmentPreviewDialog } = loadRendererFile("AttachmentPreviewDialog.tsx");
const { CloudTimeline } = loadRendererFile("cloud/CloudTimeline.tsx");
const { ReviewPanel } = loadRendererFile("review/ReviewPanel.tsx");
const { CloudPermissionSettings } = loadRendererFile("cloud/CloudPermissionSettings.tsx");
const { cloudChatRecord } = loadTypeScriptModule(new URL("../src/shared/cloudChatRecord.ts", import.meta.url));
const { chatTitleFromFirstMessage } = loadTypeScriptModule(new URL("../src/shared/chatTitle.ts", import.meta.url));
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));

test("review uses one branded file-opening control with accessible icon actions", () => {
  const selectedIde = { id: "vscode", label: "VS Code", icon: "vscode" };
  const props = { files: [{ path: "src/example.ts", status: "modified", additions: 1, deletions: 0, hunks: [], patch: "" }], open: true,
    taskId: "review", scope: "task", selectedIdeLabel: selectedIde.label, selectedIde, availableIdes: [selectedIde], canOpenIde: true, onSelectIde() {} };
  const html = render(ReviewPanel, props);
  assert.equal((html.match(/class="idePickerTrigger"/g) || []).length, 1);
  assert.match(html, /aria-label="Open example.ts in VS Code"/);
  assert.doesNotMatch(html, /reviewOpenWith|idePickerOpen|idePickerToggle/);
  for (const label of ["Leave feedback", "Side by side", "Unified", "Hide review"]) assert.match(html, new RegExp(`aria-label="${label}"`));
  assert.doesNotMatch(html, /<span>Leave feedback<|<span>Side by side<|<span>Unified</);
  const deleted = render(ReviewPanel, { ...props, files: [{ ...props.files[0], status: "deleted" }] });
  assert.match(deleted, /class="idePickerTrigger"[^>]*disabled=""/);
});

test("saved-command settings use a short explanation", () => {
  const html = render(CloudPermissionSettings, { api: {} });
  assert.match(html, /class="cloudPermissionHint">Remembered for this provider and workspace/);
  assert.doesNotMatch(html, /Saved across restarts|Settings changes apply/);
});

test("shared confirmation dialogs use destructive styling, accessible descriptions, and an inline failure state", () => {
  const props = { title: "Delete chat?", description: "Remove this chat", actionLabel: "Delete chat", onCancel() {}, onConfirm() {} };
  const html = render(ConfirmationDialog, props);
  assert.match(html, /<dialog/); assert.match(html, /riskDialog deleteDialog confirmationDialog/);
  assert.match(html, /aria-describedby=/); assert.match(html, /class="dangerAction"/); assert.match(html, /autoFocus=""/i);
  const pending = render(ConfirmationDialog, { ...props, busy: true });
  assert.equal((pending.match(/disabled=""/g) || []).length, 2); assert.match(pending, /Working…/);
  const failed = render(ConfirmationDialog, { ...props, error: "Stop this chat first" });
  assert.match(failed, /role="alert">Stop this chat first/);
});

test("attachment previews share a named header, close action, and image or file presentation", () => {
  const image = render(AttachmentPreviewDialog, { name: "shot.png", imageUrl: "data:image/png;base64,AA==", onClose() {} });
  assert.match(image, /imagePreviewHeader/); assert.match(image, /aria-label="Close preview"/); assert.match(image, /<img alt="shot.png"/);
  const file = render(AttachmentPreviewDialog, { name: "notes.txt", onClose() {} });
  assert.match(file, /attachmentFilePlaceholder/); assert.doesNotMatch(file, /<img/);
});

test("cloud answers use local answer controls and expose copy only when complete", () => {
  const entries = [{ id: "prompt", kind: "instruction", text: "Question", at: "2026-11-04T10:00:00Z" },
    { id: "answer", kind: "answer", phase: "final_answer", text: "Shared answer", at: "2026-11-04T10:01:00Z" }];
  const props = { workspace: { entries, state: "idle" }, onLocalFile() {}, onReviewFile() {} };
  const complete = render(CloudTimeline, props);
  assert.match(complete, /assistantMessage assistantAnswer/); assert.match(complete, /title="Copy answer"/);
  assert.doesNotMatch(render(CloudTimeline, { ...props, workspace: { entries, state: "running" } }), /title="Copy answer"/);
});

test("cloud summaries use the same title rules as local chats", () => {
  const text = "Hey there, can you fix the login flow please?\n\nAttached files: screenshot.png";
  const row = cloudChatRecord({ key: "chat", provider: "codex", path: "/repo", state: "idle", entries: [{ kind: "instruction", text, at: "today" }] });
  assert.equal(row.title, chatTitleFromFirstMessage(text)); assert.equal(row.updatedAt, "today");
});
