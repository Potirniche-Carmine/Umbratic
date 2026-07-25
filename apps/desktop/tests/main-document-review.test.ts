import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const service = loadTypeScriptModule(new URL("../src/main/documentReview.ts", import.meta.url));
const documentPath = ".umbratic/artifacts/docx/proposal.docx";
const sidecarPath = `${documentPath}.review.json`;

function reviewFile(filePath) {
  return { path: filePath };
}

function source() {
  return JSON.stringify({
    schemaVersion: 1,
    documentPath,
    title: "Proposal",
    blocks: [
      { id: "title", style: "title", text: "Proposal" },
      { id: "body", style: "paragraph", text: "Review this sentence." },
    ],
  });
}

test("document review service reads only a matching changed DOCX sidecar", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-document-review-"));
  const absoluteDocument = path.join(root, documentPath);
  const absoluteSidecar = path.join(root, sidecarPath);
  fs.mkdirSync(path.dirname(absoluteDocument), { recursive: true });
  fs.writeFileSync(absoluteDocument, "docx", "utf8");
  fs.writeFileSync(absoluteSidecar, source(), "utf8");
  const task = {
    id: "task-1",
    worktreePath: root,
    originalRepoPath: root,
    reviewFiles: [reviewFile(documentPath), reviewFile(sidecarPath)],
  };
  try {
    const result = service.readTaskDocumentReview(task, documentPath);
    assert.equal(result.ok, true);
    assert.equal(result.preview.title, "Proposal");
    assert.equal(service.readTaskDocumentReview({ ...task, reviewFiles: [reviewFile(documentPath)] }, documentPath).code, "not_available");
    assert.equal(service.readTaskDocumentReview(task, "../proposal.docx").code, "not_available");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("document review service rejects symlinked and oversized sidecars", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-document-review-"));
  const outside = path.join(os.tmpdir(), `umbratic-document-review-outside-${Date.now()}.json`);
  const absoluteSidecar = path.join(root, sidecarPath);
  fs.mkdirSync(path.dirname(absoluteSidecar), { recursive: true });
  fs.writeFileSync(outside, source(), "utf8");
  fs.symlinkSync(outside, absoluteSidecar);
  const task = {
    id: "task-1",
    worktreePath: root,
    originalRepoPath: root,
    reviewFiles: [reviewFile(documentPath), reviewFile(sidecarPath)],
  };
  try {
    assert.equal(service.readTaskDocumentReview(task, documentPath).code, "unsafe");
    fs.unlinkSync(absoluteSidecar);
    fs.writeFileSync(absoluteSidecar, "x".repeat(1024 * 1024 + 1), "utf8");
    assert.equal(service.readTaskDocumentReview(task, documentPath).code, "too_large");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});
