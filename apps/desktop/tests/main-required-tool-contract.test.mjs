import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const contract = loadTypeScriptModule(new URL("../src/main/requiredToolContract.ts", import.meta.url));
const plain = (value) => JSON.parse(JSON.stringify(value));

test("file-change contract detects concrete create/edit requests without treating read-only questions as mutations", () => {
  assert.equal(contract.promptLooksLikeFileChange("Create a README.md with setup instructions."), true);
  assert.equal(contract.promptLooksLikeFileChange("Fix the failing login test in auth.test.ts."), true);
  assert.equal(contract.promptLooksLikeFileChange("Explain what the README says."), false);
  assert.equal(contract.promptLooksLikeFileChange("Summarize this code.\n\nAttached files:\ncreate-report.md"), false);
});

test("file-change contract only accepts tools that can modify the workspace", () => {
  assert.deepEqual(plain(contract.enabledFileChangeTools(["read", "search"])), []);
  assert.equal(contract.canSatisfyFileChangeContract(["read", "search"]), false);
  assert.deepEqual(plain(contract.enabledFileChangeTools(["search", "edit", "command"])), ["edit", "command"]);
  assert.equal(contract.canSatisfyFileChangeContract(["write"]), true);
  assert.equal(contract.isFileChangingTool("read"), false);
  assert.equal(contract.isFileChangingTool("write"), true);
  assert.equal(contract.isFileChangingTool("command"), true);
});

test("retry prompt gives the model one explicit correction path and one explicit blocker path", () => {
  const prompt = contract.buildRequiredFileChangeRetryPrompt({
    originalUserRequest: "Create docs/language-comparison.md with tables.",
    previousAssistantText: "I created src/app.ts.",
    enabledTools: ["read", "edit", "command"],
    workspacePath: "C:/repo",
  });

  assert.match(prompt, /Harness check failed/);
  assert.match(prompt, /Continue the original request/);
  assert.match(prompt, /Create docs\/language-comparison\.md with tables/);
  assert.match(prompt, /Workspace target directory: C:\/repo/);
  assert.match(prompt, /I created src\/app\.ts/);
  assert.match(prompt, /Enabled tools for this run: read, edit, command/);
  assert.match(prompt, /calling `write`, `edit`, or an approved workspace `command`/);
  assert.match(prompt, /save that content into an appropriate file/);
  assert.match(prompt, /CANNOT_CREATE_FILE:/);
});

test("contract turns model-reported blockers and missing review diffs into concrete failure reasons", () => {
  assert.equal(contract.cannotCreateFileBlocker("CANNOT_CREATE_FILE: write tool is disabled"), "write tool is disabled");
  assert.equal(contract.cannotCreateFileBlocker("CANNOTCREATEFILE: no target path was provided"), "no target path was provided");
  assert.equal(contract.cannotCreateFileBlocker("I cannot create that file."), null);

  assert.deepEqual(plain(contract.noReviewFailureSummary({ toolRequested: false, toolSucceeded: false })), {
    reason: "missing_tool_call",
    detail: "No file creation tool was called.",
  });
  assert.deepEqual(plain(contract.noReviewFailureSummary({ toolRequested: true, toolSucceeded: false })), {
    reason: "attempted_tool_failed",
    detail: "A file creation tool was attempted but did not succeed.",
  });
  const noChanges = contract.noReviewFailureSummary({ toolRequested: true, toolSucceeded: true });
  assert.deepEqual(plain(noChanges), {
    reason: "no_review_changes",
    detail: "A file creation tool reported success, but no reviewable file changes were found.",
  });
  assert.equal(
    contract.requiredToolFailureMessage(noChanges),
    "Umbratic runner finished without file changes. A file creation tool reported success, but no reviewable file changes were found.",
  );
});
