import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadRendererFile } from "./helpers/load-renderer.ts";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const { groupActivitySegments, activityCommandPresentation, visibleActivityTools, activityGroupSummary } = loadTypeScriptModule(new URL("../src/renderer/activityPresentation.ts", import.meta.url), { realm: "host" });
const command = (id, overrides = {}) => ({ type: "command", id, run: { id, command: "npm test", status: "passed", cwd: "/repo", stdout: "", stderr: "", exitCode: 0, ...overrides } });

test("Cloud and Private use actual commands and filenames in their activity rows", () => {
  for (const run of [
    command("private", { toolKind: "bash", command: "npm test" }).run,
    command("cloud", { command: "/bin/zsh -lc 'npm test'", nativeDisplay: { label: "Run command", detail: "/bin/zsh -lc 'npm test'" } }).run,
    command("claude", { toolKind: "bash", command: '{"command":"npm test"}', nativeDisplay: { label: "Bash", detail: '{"command":"npm test"}' } }).run,
  ]) assert.deepEqual(activityCommandPresentation(run), { kind: "command", verb: "Ran", target: "npm test" });
  assert.deepEqual(activityCommandPresentation(command("read", { toolKind: "read", command: "read src/settings.ts" }).run), { kind: "read", verb: "Read", target: "settings.ts" });
  assert.deepEqual(activityCommandPresentation(command("edit", { toolKind: "edit", command: "src/settings.ts\n@@ diff" }).run), { kind: "edit", verb: "Edited", target: "settings.ts" });
  assert.equal(activityCommandPresentation(command("failed", { status: "failed" }).run).verb, "Failed");
});

test("tool groups preserve narration order and always expose current actions while live", () => {
  const tools = [command("a"), command("b"), command("c"), command("d", { status: "running" })];
  const narration = { type: "reasoning", id: "narration", text: "Checking", finished: true, durationMs: null };
  const groups = groupActivitySegments([...tools, narration, command("e")]);
  assert.deepEqual(groups.map(group => group.id), ["a", "narration", "e"]);
  assert.equal(groups[0].segments.length, 4);
  assert.equal(activityGroupSummary(tools), "4 commands");
  assert.deepEqual(visibleActivityTools(tools, false, false).map(tool => tool.id), ["d"]);
  assert.deepEqual(visibleActivityTools(tools, false, true), []);
  assert.equal(visibleActivityTools(tools, true, true).length, 4);
  assert.equal(visibleActivityTools(tools.slice(0, 3), false, true).length, 3);
});

test("dictation projects muted partial text at the caret without editing the draft", () => {
  const { dictationPromptParts } = loadRendererFile("DictationPreview.tsx");
  const { PromptTextarea } = loadRendererFile("PromptTextarea.tsx");
  const parts = dictationPromptParts("Hello world", 5, "new");
  assert.deepEqual(JSON.parse(JSON.stringify(parts)), ["Hello ", "new", " world"]);
  const draft = "Hello world";
  const html = renderToStaticMarkup(React.createElement(PromptTextarea, { value: draft, previewCaret: 5, dictation: { state: "recording", preview: "new", level: 0 }, onChange() {} }));
  assert.match(html, /readOnly=""/); assert.match(html, /promptSpeechInterim">new/);
  assert.match(html, /Hello new world<\/textarea>/); assert.doesNotMatch(html, /Listening|Finishing/);
  const settled = renderToStaticMarkup(React.createElement(PromptTextarea, { value: draft, dictation: { state: "idle", preview: "", level: 0 }, onChange() {} }));
  assert.match(settled, /Hello world<\/textarea>/); assert.doesNotMatch(settled, /promptSpeechInterim|readOnly/);
});
