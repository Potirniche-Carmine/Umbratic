import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const { snapshotFolder } = loadTypeScriptModule(new URL("../src/main/workspaceSnapshot.ts", import.meta.url), {
  mocks: {
    electron: {}, "./chatStore": {}, "./ocrRuntime": {}, "./appPaths": {},
    "./mainRuntime": { binarySnapshotPrefix: "binary:", missingSnapshotValue: "missing", textAttachmentByteLimit: 1024 },
  },
});

test("default artifact outputs enter review snapshots while internal state stays excluded", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-artifact-snapshot-"));
  try {
    fs.mkdirSync(path.join(root, "artifacts/docx"), { recursive: true });
    fs.mkdirSync(path.join(root, ".umbratic/runtime"), { recursive: true });
    fs.writeFileSync(path.join(root, "artifacts/docx/PRD.docx"), Buffer.from([80, 75, 0]));
    fs.writeFileSync(path.join(root, ".umbratic/runtime/private.json"), "private");
    const snapshot = snapshotFolder(root);
    assert.deepEqual(Object.keys(snapshot), ["artifacts/docx/PRD.docx"]);
    assert.match(snapshot["artifacts/docx/PRD.docx"], /^binary:/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
