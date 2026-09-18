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

test("after tools, live prose streams as the answer from its first token", () => {
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
  // The answer streams as a message below the block from its first token, and
  // that token finishes the block: the run stopped working and started
  // talking. If more work follows, it opens a new block after this passage —
  // a finished block never reopens, so finishing it here has no stutter.
  const live = JSON.parse(JSON.stringify(composerTimelineFromEvents(liveEvents, undefined, "running")));
  assert.deepEqual(live.map((item) => item.type), ["user", "activity", "assistant"]);
  assert.equal(live[1].finished, true);
  assert.equal(live[1].segments.some((segment) => segment.type === "reasoning"), false);
  assert.equal(live[2].text, "The endpoint is live at `/health`.");
  assert.equal(live[2].streaming, true);
  assert.equal(live[2].final, true);
  assert.match(activitySummary(live[1], Date.parse("2026-01-01T00:00:09.000Z")), /^Worked for/);

  // Settling re-derives the page the reader was already looking at: same
  // items, same ids, only the streaming flag gone. Nothing moves.
  const settled = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    ...liveEvents,
    { type: "assistant.done", taskId: "task-1", at: "2026-01-01T00:00:06.000Z" },
  ], undefined, "completed")));
  assert.deepEqual(settled.map((item) => item.type), ["user", "activity", "assistant"]);
  assert.equal(settled[1].finished, true);
  assert.equal(settled[1].id, live[1].id);
  assert.equal(settled[2].id, live[2].id);
  assert.equal(settled[2].streaming, undefined);
  assert.equal(settled[2].text, "The endpoint is live at `/health`.");
  assert.equal(settled[2].final, true);
});

test("blocks are collapsed by default and stay open once opened by hand", () => {
  const workingEvents = [
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
  ];
  const working = JSON.parse(JSON.stringify(composerTimelineFromEvents(workingEvents, undefined, "running")));
  const answeringEvents = [
    ...workingEvents,
    { type: "assistant.delta", taskId: "task-1", text: "It is a static site.", at: "2026-01-01T00:00:03.000Z" },
  ];
  const answering = JSON.parse(JSON.stringify(composerTimelineFromEvents(answeringEvents, undefined, "running")));
  assert.equal(working[1].finished, false);
  // Prose finishes the block it follows; were more work to come, it would
  // open a new block after the passage rather than reopening this one.
  assert.equal(answering[1].finished, true);
  const settled = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    ...answeringEvents,
    { type: "assistant.done", taskId: "task-1", at: "2026-01-01T00:00:04.000Z" },
  ], undefined, "completed")));
  assert.equal(settled[1].finished, true);

  const { reconcileActivityDisclosureState } = loadTypeScriptModule(
    new URL("../src/renderer/composerActivity.ts", import.meta.url),
  );
  // Collapsed by default, live or not: the header row summarizes the work,
  // and the log opens only by hand — so the transcript's shape never changes
  // under the reader.
  const liveDisclosure = reconcileActivityDisclosureState(new Set(), working);
  assert.deepEqual([...liveDisclosure], []);
  // Opened by hand, it stays open — settling does not take the choice back.
  const openedByHand = reconcileActivityDisclosureState(new Set([working[1].id]), settled);
  assert.deepEqual([...openedByHand], [settled[1].id]);
  // State for a block that no longer exists is dropped.
  const pruned = reconcileActivityDisclosureState(new Set(["activity-99"]), settled);
  assert.deepEqual([...pruned], []);
});
