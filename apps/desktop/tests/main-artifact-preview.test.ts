import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

// The artifact engine lives in src/main/artifacts/, which is committed
// separately from this file. A checkout without it cannot load the preview
// service at all, so these tests skip rather than fail on the wrong cause.
const engineAvailable = fs.existsSync(new URL("../src/main/artifacts/service.ts", import.meta.url));
const service = engineAvailable
  ? loadTypeScriptModule(new URL("../src/main/artifactReview.ts", import.meta.url))
  : null;
const maybe = engineAvailable
  ? test
  : (name, fn) => test(name, { skip: "artifact engine sources are missing from this checkout" }, fn);
const documentPath = ".umbratic/artifacts/docx/proposal.docx";

function taskIn(root) {
  return { worktreePath: root, originalRepoPath: root };
}

maybe("artifact preview refuses paths the artifact tool does not write", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-artifact-preview-"));
  try {
    for (const requested of [
      "notes/report.docx",
      ".umbratic/artifacts/docx/../../../etc/passwd",
      ".umbratic/artifacts/pptx/report.docx",
      path.join(root, documentPath),
    ]) {
      const result = await service.readArtifactPreview(taskIn(root), requested);
      assert.equal(result.ok, false);
      assert.equal(result.code, "not_available", requested);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

maybe("artifact preview reports a missing file rather than throwing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-artifact-preview-"));
  try {
    const result = await service.readArtifactPreview(taskIn(root), documentPath);
    assert.equal(result.ok, false);
    assert.equal(result.code, "not_available");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

maybe("artifact preview rejects symlinked and oversized documents", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-artifact-preview-"));
  const outside = path.join(os.tmpdir(), `umbratic-artifact-preview-outside-${process.pid}.docx`);
  const absoluteDocument = path.join(root, documentPath);
  fs.mkdirSync(path.dirname(absoluteDocument), { recursive: true });
  fs.writeFileSync(outside, "docx", "utf8");
  let symlinkCreated = false;
  try {
    fs.symlinkSync(outside, absoluteDocument);
    symlinkCreated = true;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EPERM")) {
      throw error;
    }
  }
  try {
    if (symlinkCreated) {
      const result = await service.readArtifactPreview(taskIn(root), documentPath);
      assert.equal(result.ok, false);
      assert.equal(result.code, "unsafe");
      fs.unlinkSync(absoluteDocument);
    }
    const fd = fs.openSync(absoluteDocument, "w");
    fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1);
    fs.closeSync(fd);
    const result = await service.readArtifactPreview(taskIn(root), documentPath);
    assert.equal(result.ok, false);
    assert.equal(result.code, "too_large");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});
