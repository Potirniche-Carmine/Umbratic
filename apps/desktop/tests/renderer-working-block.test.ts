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
  // The answer is a message below the block from the first token, and the
  // block is done: its elapsed window closed when the prose began.
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

test("a finished Working block stays open for the tuck delay, then closes", () => {
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
  const answering = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    ...workingEvents,
    { type: "assistant.delta", taskId: "task-1", text: "It is a static site.", at: "2026-01-01T00:00:03.000Z" },
  ], undefined, "running")));
  assert.equal(working[1].finished, false);
  assert.equal(answering[1].finished, true);

  const { reconcileActivityDisclosureState } = loadTypeScriptModule(
    new URL("../src/renderer/composerActivity.ts", import.meta.url),
  );
  const liveDisclosure = reconcileActivityDisclosureState(new Set(), working, "task-1", new Set());
  assert.deepEqual([...liveDisclosure.expandedIds], [working[1].id]);
  // The block finished when the answer began. The tuck delay holds it open a
  // beat so the collapse is not part of the same burst as the first tokens.
  const holdingDisclosure = reconcileActivityDisclosureState(
    liveDisclosure.expandedIds,
    answering,
    "task-1",
    liveDisclosure.autoOpenedKeys,
    true,
  );
  assert.deepEqual([...holdingDisclosure.expandedIds], [answering[1].id]);
  const tuckedDisclosure = reconcileActivityDisclosureState(
    holdingDisclosure.expandedIds,
    answering,
    "task-1",
    holdingDisclosure.autoOpenedKeys,
    false,
  );
  assert.deepEqual([...tuckedDisclosure.expandedIds], []);
});
