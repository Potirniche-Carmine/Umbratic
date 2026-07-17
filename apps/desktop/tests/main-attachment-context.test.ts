import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("chat attachments are copied into a project-less chat workspace", (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-attachment-context-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const sourceDirectory = path.join(temporaryRoot, "app-data");
  const workspace = path.join(temporaryRoot, "workspace");
  fs.mkdirSync(sourceDirectory, { recursive: true });
  const storedPath = path.join(sourceDirectory, "stored-report.docx");
  fs.writeFileSync(storedPath, "document bytes");

  const [attachment] = attachmentContext.materializeChatAttachments(workspace, [
    {
      path: "attachments/stored-report.docx",
      name: "report.docx",
      source: "chat",
      storedPath,
    },
  ]);

  assert.equal(attachment.path, "attachments/stored-report.docx");
  assert.equal(fs.readFileSync(path.join(workspace, attachment.path), "utf8"), "document bytes");
});


