import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const { activityToolLabel, commandShellText } = loadTypeScriptModule(new URL("../src/renderer/commandDisplay.ts", import.meta.url));

test("file activity distinguishes writing, success, and failure", () => {
  for (const [toolKind, command, running, passed, failed] of [
    ["write", "write", "Writing file", "Wrote file", "Write file"],
    ["write", "write docs/PRD.md", "Writing PRD.md", "Wrote PRD.md", "Write PRD.md"],
    ["artifact", "artifact create PRD.docx", "Creating PRD.docx", "Created PRD.docx", "Create PRD.docx"],
  ]) {
    for (const [status, expected] of [["running", running], ["passed", passed], ["failed", failed]]) {
      assert.equal(activityToolLabel({ toolKind, command, status }).label, expected);
    }
  }
  assert.equal(activityToolLabel({ toolKind: "artifact", command: "artifact", status: "running" }).label, "Preparing document");
  assert.doesNotMatch(commandShellText({ toolKind: "artifact", command: "artifact create PRD.docx", status: "passed", stdout: "Created PRD.docx", stderr: "" }), /\$ artifact/);
});
