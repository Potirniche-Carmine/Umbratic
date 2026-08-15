import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const { composerTimelineFromEvents } = loadTypeScriptModule(
  new URL("../src/renderer/composerTimeline.ts", import.meta.url),
);
const { activitySummary } = loadTypeScriptModule(
  new URL("../src/renderer/activityTiming.ts", import.meta.url),
);

test("thinking and orientation stay separate inside one Working block", () => {
  const timeline = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    { type: "user.message", taskId: "task-1", text: "tour this folder", at: "2026-01-01T00:00:00.000Z" },
    {
      type: "assistant.progress.delta",
      kind: "thinking",
      taskId: "task-1",
      text: "The user wants a folder tour.",
      at: "2026-01-01T00:00:01.000Z",
    },
    {
      type: "assistant.progress.delta",
      taskId: "task-1",
      text: "I will map the workspace root and read its docs.",
      at: "2026-01-01T00:00:02.000Z",
    },
    {
      type: "command.started",
      taskId: "task-1",
      id: "ls-1",
      command: "ls .",
      cwd: "C:/repo",
      kind: "read",
      commandClass: "read",
      at: "2026-01-01T00:00:03.000Z",
    },
    { type: "command.finished", taskId: "task-1", id: "ls-1", exitCode: 0, at: "2026-01-01T00:00:04.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "It is a static site.", at: "2026-01-01T00:00:05.000Z" },
    { type: "assistant.done", taskId: "task-1", at: "2026-01-01T00:00:06.000Z" },
  ], undefined, "completed")));

  assert.deepEqual(timeline.map((item) => item.type), ["user", "activity", "assistant"]);
  assert.deepEqual(
    timeline[1].segments.map((segment) => [
      segment.type,
      segment.type === "reasoning" ? segment.kind ?? "" : "",
      segment.type === "reasoning" ? segment.text : segment.run.command,
    ]),
    [
      ["reasoning", "thinking", "The user wants a folder tour."],
      ["reasoning", "", "I will map the workspace root and read its docs."],
      ["command", "", "ls ."],
    ],
  );
});

test("an empty wait labels the block Working, not Thinking", () => {
  const timeline = composerTimelineFromEvents([
    { type: "user.message", taskId: "task-1", text: "hello", at: "2026-01-01T00:00:00.000Z" },
  ], undefined, "running");
  assert.equal(timeline[1].type, "activity");
  assert.equal(activitySummary(timeline[1]), "Working");
});

test("work activity styles mute thinking without boxing it off from orientation", () => {
  const activityCss = fs.readFileSync(
    new URL("../src/renderer/styles/work-activity.css", import.meta.url),
    "utf8",
  );
  assert.match(activityCss, /\.activityLogEntry\.reasoningLog\.isThinking/);
  const thinkingRule = activityCss.match(
    /\.activityLogEntry\.reasoningLog\.isThinking \.workMarkdownContent \.markdownContent\s*{[^}]+}/s,
  )?.[0] ?? "";
  assert.match(thinkingRule, /--faint/);
  assert.match(thinkingRule, /--bg/);
  assert.doesNotMatch(thinkingRule, /\b(?:background|border)/);
});
