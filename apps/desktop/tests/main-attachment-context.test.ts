import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const attachmentContext = loadTypeScriptModule(new URL("../src/main/attachmentContext.ts", import.meta.url));
const plain = (value) => JSON.parse(JSON.stringify(value));

test("prior chat attachments remain available after their original turn", () => {
  const uploaded = {
    path: "attachments/uploaded-notes.txt",
    name: "notes.txt",
    source: "chat",
    storedPath: "C:/app-data/chat-attachments/chat-1/uploaded-notes.txt",
  };
  const current = {
    path: "attachments/current.png",
    name: "current.png",
    source: "chat",
    storedPath: "C:/app-data/chat-attachments/chat-1/current.png",
  };
  const events = [
    { type: "user.message", taskId: "task-1", text: "Summarize this", attachedFiles: [uploaded] },
    { type: "assistant.delta", taskId: "task-1", text: "Summary" },
    { type: "user.message", taskId: "task-1", text: "What was the second point?", attachedFiles: [current] },
  ];

  assert.deepEqual(
    plain(attachmentContext.priorChatAttachments(events, "What was the second point?")),
    [uploaded],
  );
});

test("prior chat attachments are deduplicated and bounded by recency", () => {
  const first = { path: "attachments/first.txt", name: "first.txt", source: "chat", storedPath: "C:/uploads/first.txt" };
  const second = { path: "attachments/second.txt", name: "second.txt", source: "chat", storedPath: "C:/uploads/second.txt" };
  const events = [
    { type: "user.message", taskId: "task-1", text: "First", attachedFiles: [first] },
    { type: "user.message", taskId: "task-1", text: "Second", attachedFiles: [first, second] },
    { type: "user.message", taskId: "task-1", text: "Continue", attachedFiles: [] },
  ];

  assert.deepEqual(plain(attachmentContext.priorChatAttachments(events, "Continue", 1)), [second]);
});

test("legacy materialized chat paths are identified exactly without hiding neighboring files", () => {
  const events = [
    {
      type: "user.message",
      taskId: "task-1",
      text: "Review these",
      attachedFiles: [
        {
          path: "./attachments/stored-report.docx",
          name: "report.docx",
          source: "chat",
          storedPath: "/app-data/chat-attachments/chat-1/stored-report.docx",
        },
        {
          path: "attachments/workspace-notes.md",
          name: "workspace-notes.md",
          source: "workspace",
        },
      ],
    },
  ];

  assert.deepEqual(
    [...attachmentContext.materializedChatAttachmentReviewPaths(events, true)],
    ["attachments/stored-report.docx"],
  );
  assert.deepEqual(
    [...attachmentContext.materializedChatAttachmentReviewPaths(events, false)],
    [],
    "real repository reviews must not suppress matching paths",
  );
});
