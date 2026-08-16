import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const promptContext = loadTypeScriptModule(new URL("../src/main/promptContext.ts", import.meta.url));

test("limitPromptImages retains the newest bounded images and all text context", () => {
  const parts = [
    { type: "text", text: "workspace" },
    { type: "image", data_url: "old" },
    { type: "text", text: "history" },
    { type: "image", data_url: "new" },
    { type: "text", text: "request" },
  ];
  const bounded = promptContext.limitPromptImages(parts, 1);
  assert.deepEqual(Array.from(bounded.filter((part) => part.type === "image"), (part) => part.data_url), ["new"]);
  assert.match(bounded.map((part) => part.text ?? "").join("\n"), /workspace[\s\S]*history[\s\S]*request/);
  assert.match(bounded[0].text, /1 older image attachment was omitted/);

  const byteBounded = promptContext.limitPromptImages([
    { type: "image", data_url: "a".repeat(8) },
    { type: "image", data_url: "b".repeat(8) },
  ], 12, 8);
  assert.deepEqual(Array.from(byteBounded.filter((part) => part.type === "image"), (part) => part.data_url), ["b".repeat(8)]);
});

test("local calendar date is a weekday month day year on the user's clock", () => {
  assert.equal(promptContext.localCalendarDate(new Date(2026, 7, 15)), "Saturday, August 15, 2026");
  assert.equal(promptContext.localDateContextLine(new Date(2026, 7, 15)), "today's date: Saturday, August 15, 2026");
});

test("workspace context follows project, file, and attachment state without matching prompt text", () => {
  const emptyChat = { hasProject: false, workspaceHasFiles: false, attachmentCount: 0, historicalAttachmentCount: 0 };
  assert.equal(promptContext.shouldIncludeWorkspaceContext(emptyChat), false);
  for (const key of ["hasProject", "workspaceHasFiles"] as const) {
    assert.equal(promptContext.shouldIncludeWorkspaceContext({ ...emptyChat, [key]: true }), true);
  }
  assert.equal(promptContext.shouldIncludeWorkspaceContext({ ...emptyChat, attachmentCount: 1 }), true);
  assert.equal(promptContext.shouldIncludeWorkspaceContext({ ...emptyChat, historicalAttachmentCount: 1 }), true);
});
