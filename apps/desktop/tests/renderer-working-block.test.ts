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
  assert.match(thinkingRule, /font-style:\s*italic/);
  assert.doesNotMatch(thinkingRule, /\b(?:background|border)/);
  assert.match(activityCss, /\.activityThinkingLabel/);
  const workingBlock = fs.readFileSync(
    new URL("../src/renderer/workingBlock.tsx", import.meta.url),
    "utf8",
  );
  assert.match(workingBlock, /activityThinkingLabel">Thinking/);
});

test("after tools, live prose stays inside Working until the turn ends", () => {
  const liveEvents = [
    { type: "user.message", taskId: "task-1", text: "add a health check", at: "2026-01-01T00:00:00.000Z" },
    {
      type: "command.started",
      taskId: "task-1",
      id: "edit-1",
      command: "write src/routes/health.ts",
      cwd: "C:/repo",
      kind: "read",
      commandClass: "edit",
      at: "2026-01-01T00:00:02.000Z",
    },
    { type: "command.finished", taskId: "task-1", id: "edit-1", exitCode: 0, at: "2026-01-01T00:00:04.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "The endpoint is live at `/health`.", at: "2026-01-01T00:00:05.000Z" },
  ];
  const live = JSON.parse(JSON.stringify(composerTimelineFromEvents(liveEvents, undefined, "running")));
  assert.deepEqual(live.map((item) => item.type), ["user", "activity"]);
  assert.equal(live[1].finished, false);
  assert.equal(live[1].segments[1].held, true);
  assert.equal(live[1].segments[1].text, "The endpoint is live at `/health`.");
  assert.match(activitySummary(live[1], Date.parse("2026-01-01T00:00:09.000Z")), /^Working/);

  const settled = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    ...liveEvents,
    { type: "assistant.done", taskId: "task-1", at: "2026-01-01T00:00:06.000Z" },
  ], undefined, "completed")));
  assert.deepEqual(settled.map((item) => item.type), ["user", "activity", "assistant"]);
  assert.equal(settled[1].finished, true);
  assert.equal(settled[1].segments.some((segment) => segment.held), false);
  assert.equal(settled[2].text, "The endpoint is live at `/health`.");
  assert.equal(settled[2].final, true);
});

test("a lifted answer is the same held passage promoted out of Working", () => {
  const { liftedAssistantId } = loadTypeScriptModule(
    new URL("../src/renderer/answerLift.ts", import.meta.url),
  );
  const liveEvents = [
    { type: "user.message", taskId: "task-1", text: "tour", at: "2026-01-01T00:00:00.000Z" },
    {
      type: "command.started",
      taskId: "task-1",
      id: "ls-1",
      command: "ls .",
      cwd: "C:/repo",
      kind: "read",
      commandClass: "read",
      at: "2026-01-01T00:00:01.000Z",
    },
    { type: "command.finished", taskId: "task-1", id: "ls-1", exitCode: 0, at: "2026-01-01T00:00:02.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "It is a static site.", at: "2026-01-01T00:00:03.000Z" },
  ];
  const live = JSON.parse(JSON.stringify(composerTimelineFromEvents(liveEvents, undefined, "running")));
  const settled = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    ...liveEvents,
    { type: "assistant.done", taskId: "task-1", at: "2026-01-01T00:00:04.000Z" },
  ], undefined, "completed")));
  assert.equal(liftedAssistantId(live, settled), settled[2].id);
  assert.equal(liftedAssistantId(settled, settled), undefined);

  const { reconcileActivityDisclosureState } = loadTypeScriptModule(
    new URL("../src/renderer/composerActivity.ts", import.meta.url),
  );
  const liveDisclosure = reconcileActivityDisclosureState(new Set(), live, "task-1", new Set());
  assert.deepEqual([...liveDisclosure.expandedIds], [live[1].id]);
  const liftingDisclosure = reconcileActivityDisclosureState(
    liveDisclosure.expandedIds,
    settled,
    "task-1",
    liveDisclosure.autoOpenedKeys,
    true,
  );
  assert.deepEqual([...liftingDisclosure.expandedIds], [settled[1].id]);
  const tuckedDisclosure = reconcileActivityDisclosureState(
    liftingDisclosure.expandedIds,
    settled,
    "task-1",
    liftingDisclosure.autoOpenedKeys,
    false,
  );
  assert.deepEqual([...tuckedDisclosure.expandedIds], []);
});

test("answer lift styles skip the entrance pop and restyle from narration", () => {
  const timelineCss = fs.readFileSync(
    new URL("../src/renderer/styles/timeline.css", import.meta.url),
    "utf8",
  );
  assert.match(timelineCss, /\.timelineMessage\.assistantMessage\.isLifted/);
  assert.match(timelineCss, /animation:\s*none/);
  const motionCss = fs.readFileSync(
    new URL("../src/renderer/styles/motion-accessibility.css", import.meta.url),
    "utf8",
  );
  assert.match(motionCss, /@keyframes answerLiftRestyle/);
  assert.match(motionCss, /@keyframes answerLiftRail/);
});
