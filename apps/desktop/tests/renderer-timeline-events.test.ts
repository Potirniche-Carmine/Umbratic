import assert from "node:assert/strict";
import test from "node:test";

import { loadRendererFile } from "./helpers/load-renderer.ts";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const { compactTaskEvents: compactBackendEvents } = loadTypeScriptModule(
  new URL("../src/shared/taskEvents.ts", import.meta.url),
);

test("generated image metadata survives command aggregation and saved conversation timelines", () => {
  const { commandRunsFromEvents } = loadRendererFile("composerActivity.ts");
  const { composerTimelineFromEvents } = loadRendererFile("composerTimeline.ts");
  const details = { path: "sphere.png", image: true, width: 512, height: 512, bytes: 12000 };
  const events = [
    { type: "command.started", taskId: "image-task", id: "image-1", command: "generate image sphere.png", cwd: "/repo", kind: "edit", toolKind: "generate_image", at: "2026-09-21T10:00:00Z" },
    { type: "command.finished", taskId: "image-task", id: "image-1", exitCode: 0, details, at: "2026-09-21T10:02:00Z" },
  ];
  const [run] = commandRunsFromEvents(events);
  const timeline = composerTimelineFromEvents(JSON.parse(JSON.stringify(events)));
  const image = timeline.flatMap((item) => item.type === "activity" ? item.segments : []).find((segment) => segment.type === "command");
  for (const result of [run, image.run]) {
    assert.equal(result.toolKind, "generate_image");
    assert.equal(result.status, "passed");
    assert.deepEqual(JSON.parse(JSON.stringify(result.details)), details);
  }
});

test("command aggregation, pending permissions, and timelines reflect real event streams", () => {
  const { activitySummary } = loadRendererFile("activityTiming.ts");
  const {
    activityToolGroups,
    commandRunsFromEvents,
    pendingPermissionFromEvents,
    reconcileActivityDisclosureState,
  } = loadRendererFile("composerActivity.ts");
  const {
    activityToolLabel,
    commandDetailLabel,
    commandLabel,
    commandHasVisibleDetails,
    commandShellText,
    commandSummary,
  } = loadRendererFile("commandDisplay.ts");
  const { composerTimelineFromEvents } = loadRendererFile("composerTimeline.ts");

  const events = [
    { type: "user.message", taskId: "task-1", text: "Run tests", at: "2026-01-01T00:00:00.000Z" },
    { type: "assistant.progress.delta", taskId: "task-1", text: "Planning", at: "2026-01-01T00:00:01.000Z", endedAt: "2026-01-01T00:00:03.000Z" },
    { type: "command.started", taskId: "task-1", id: "cmd-1", command: "npm run test", cwd: "C:/repo", kind: "bash", commandClass: "package-manager", at: "2026-01-01T00:00:03.000Z" },
    { type: "command.output", taskId: "task-1", id: "cmd-1", stream: "stdout", text: "ok\n", at: "2026-01-01T00:00:04.000Z" },
    { type: "command.finished", taskId: "task-1", id: "cmd-1", exitCode: 0, at: "2026-01-01T00:00:05.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "**Umbratic AI**: Done", at: "2026-01-01T00:00:06.000Z" },
    { type: "permission.requested", taskId: "task-1", request: { id: "perm-1", kind: "bash", summary: "git commit", command: "git commit", cwd: "C:/repo" } },
  ];

  const [run] = commandRunsFromEvents(events);
  assert.equal(run.status, "passed");
  assert.equal(commandSummary(run), "ok");
  const [failedWrite] = commandRunsFromEvents([
    { type: "command.started", taskId: "task-1", id: "write-1", command: "write bubble_sort.py", cwd: "C:/repo", kind: "edit", commandClass: "edit" },
    { type: "command.finished", taskId: "task-1", id: "write-1", exitCode: 1, status: "policy_blocked", errorCode: "policy_blocked", errorMessage: "Refusing path outside workspace: bubble_sort.py" },
  ]);
  assert.equal(commandSummary(failedWrite), "exit 1: Refusing path outside workspace: bubble_sort.py");
  assert.equal(commandShellText(failedWrite), "Refusing path outside workspace: bubble_sort.py");
  const [missingRead] = commandRunsFromEvents([
    { type: "command.started", taskId: "task-1", id: "read-2", command: "read missing.ts", cwd: "C:/repo", kind: "read", toolKind: "read", commandClass: "read" },
    { type: "command.finished", taskId: "task-1", id: "read-2", exitCode: 1, status: "validation_error", errorCode: "invalid_arguments", errorMessage: "Path not found: missing.ts.\nNearby workspace entries:\n- src/" },
  ]);
  assert.equal(commandHasVisibleDetails(missingRead), false);
  assert.equal(commandShellText(missingRead), "exit 1");
  assert.equal(pendingPermissionFromEvents(events).id, "perm-1");
  const timeline = JSON.parse(JSON.stringify(composerTimelineFromEvents(events)));
  assert.deepEqual(timeline.map((item) => item.type), [
    "user",
    "activity",
    "assistant",
  ]);
  assert.deepEqual(timeline[1].segments.map((segment) => segment.type), ["reasoning", "command"]);
  assert.equal(activitySummary(timeline[1]), "Worked for 6 seconds");
  const groupedTools = activityToolGroups([
    ...timeline[1].segments,
    { ...timeline[1].segments[1], id: "cmd-2", run: { ...timeline[1].segments[1].run, id: "cmd-2" } },
  ]);
  assert.equal(groupedTools.length, 1);
  assert.equal(groupedTools[0].runs.length, 2);
  const delayedReasoningTimeline = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    events[0],
    events[2],
    events[3],
    events[4],
    events[1],
    events[5],
  ])));
  assert.deepEqual(delayedReasoningTimeline[1].segments.map((segment) => segment.type), ["command", "reasoning"]);
  const repeatedReasoningTimeline = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    events[0],
    { type: "assistant.progress.delta", taskId: "task-1", text: "First step.", at: "2026-01-01T00:00:01.000Z" },
    events[2],
    events[3],
    events[4],
    { type: "assistant.progress.delta", taskId: "task-1", text: "Second step.", at: "2026-01-01T00:00:05.500Z" },
    events[5],
  ])));
  assert.deepEqual(repeatedReasoningTimeline[1].segments.map((segment) => segment.type), ["reasoning", "command", "reasoning"]);
  assert.equal(repeatedReasoningTimeline[1].segments[0].text, "First step.");
  assert.equal(repeatedReasoningTimeline[1].segments[2].text, "Second step.");
  // Consecutive status labels stay separate lines instead of running together.
  const groupedProgressTimeline = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    events[0],
    { type: "assistant.progress.delta", taskId: "task-1", text: "Reading files", at: "2026-01-01T00:00:01.000Z" },
    { type: "assistant.progress.delta", taskId: "task-1", text: "Editing files", at: "2026-01-01T00:00:02.000Z" },
    events[5],
  ])));
  assert.deepEqual(groupedProgressTimeline.map((item) => item.type), ["user", "activity", "assistant"]);
  assert.equal(groupedProgressTimeline[2].text, "**Umbratic AI**: Done");
  const runningGroupedProgressTimeline = composerTimelineFromEvents([
    events[0],
    { type: "assistant.progress.delta", taskId: "task-1", text: "Reading files", at: "2026-01-01T00:00:01.000Z" },
    { type: "assistant.progress.delta", taskId: "task-1", text: "Editing files", at: "2026-01-01T00:00:02.000Z" },
  ], undefined, "running");
  assert.equal(runningGroupedProgressTimeline[1].type, "activity");
  assert.equal(runningGroupedProgressTimeline[1].finished, false);
  assert.equal(activitySummary(runningGroupedProgressTimeline[1]), "Working");
  assert.equal(runningGroupedProgressTimeline[1].segments[0].text, "Reading files\n\nEditing files");
  const skillTimeline = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    events[0],
    { type: "assistant.progress.delta", taskId: "task-1", text: "I will inspect the project.", at: "2026-01-01T00:00:01.000Z" },
    { type: "skill.loaded", taskId: "task-1", sessionId: "session-1", runId: "run-1", requestId: "skill-req-1", skillId: "project-review", source: "local", origin: "harness", contentHash: "abc", bytes: 20, at: "2026-01-01T00:00:02.000Z" },
    events[2],
    events[3],
    events[4],
    { type: "assistant.progress.delta", taskId: "task-1", text: "The tests pass.", at: "2026-01-01T00:00:05.500Z" },
    events[5],
  ])));
  assert.deepEqual(
    skillTimeline[1].segments.map((segment) => segment.type),
    ["reasoning", "skill", "command", "reasoning"],
  );
  assert.equal(skillTimeline[1].segments[1].skillId, "project-review");
  const interleavedTimeline = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    events[0],
    { type: "assistant.progress.delta", taskId: "task-1", text: "First step.", at: "2026-01-01T00:00:01.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "I’ll inspect the project.", at: "2026-01-01T00:00:02.000Z" },
    events[2],
    events[3],
    events[4],
    { type: "assistant.progress.delta", taskId: "task-1", text: "Second step.", at: "2026-01-01T00:00:05.500Z" },
    { type: "assistant.delta", taskId: "task-1", text: "Here is the complete answer.", at: "2026-01-01T00:00:06.000Z" },
    { type: "assistant.done", taskId: "task-1", at: "2026-01-01T00:00:07.000Z" },
  ], undefined, "completed")));
  // Interleaved: prose stands where it streamed, and each stretch of work is
  // its own block after it. Narration lines stay inside the blocks.
  assert.deepEqual(interleavedTimeline.map((item) => item.type), ["user", "activity", "assistant", "activity", "assistant"]);
  assert.deepEqual(interleavedTimeline[1].segments.map((segment) => segment.type), ["reasoning"]);
  assert.equal(interleavedTimeline[1].segments[0].text, "First step.");
  assert.equal(interleavedTimeline[2].text, "I’ll inspect the project.");
  assert.equal(interleavedTimeline[2].final, undefined);
  assert.deepEqual(interleavedTimeline[3].segments.map((segment) => segment.type), ["command", "reasoning"]);
  assert.equal(interleavedTimeline[3].segments[1].text, "Second step.");
  assert.equal(interleavedTimeline[4].text, "Here is the complete answer.");
  assert.equal(interleavedTimeline[4].final, true);

  const progressOnlyAnswerTimeline = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    { type: "user.message", taskId: "task-1", text: "Tell me about this project", at: "2026-01-01T00:00:00.000Z" },
    { type: "command.started", taskId: "task-1", id: "search-1", command: "search workspace", cwd: "C:/repo", kind: "read", commandClass: "read", at: "2026-01-01T00:00:01.000Z" },
    { type: "command.output", taskId: "task-1", id: "search-1", stream: "stdout", text: "No matches.", at: "2026-01-01T00:00:02.000Z" },
    { type: "command.finished", taskId: "task-1", id: "search-1", exitCode: 0, at: "2026-01-01T00:00:03.000Z" },
    { type: "assistant.progress.delta", taskId: "task-1", text: "# Umbratic Project Overview\n\nA private AI workbench.", at: "2026-01-01T00:00:04.000Z" },
    { type: "assistant.done", taskId: "task-1", at: "2026-01-01T00:00:05.000Z" },
  ], undefined, "completed")));
  assert.deepEqual(progressOnlyAnswerTimeline.map((item) => item.type), ["user", "activity"]);
  assert.deepEqual(progressOnlyAnswerTimeline[1].segments.map((segment) => segment.type), ["command", "reasoning"]);
  assert.equal(progressOnlyAnswerTimeline[1].segments[1].text, "# Umbratic Project Overview\n\nA private AI workbench.");

  const preToolOnlyAnswerTimeline = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    { type: "user.message", taskId: "task-1", text: "Tell me about this project", at: "2026-01-01T00:00:00.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "# Umbratic Project Overview\n\nA private AI workbench.", at: "2026-01-01T00:00:01.000Z" },
    { type: "command.started", taskId: "task-1", id: "search-1", command: "search workspace", cwd: "C:/repo", kind: "read", commandClass: "read", at: "2026-01-01T00:00:02.000Z" },
    { type: "command.finished", taskId: "task-1", id: "search-1", exitCode: 0, at: "2026-01-01T00:00:03.000Z" },
    { type: "assistant.done", taskId: "task-1", at: "2026-01-01T00:00:04.000Z" },
  ], undefined, "completed")));
  // The model said everything before the tool call and then fell silent. The
  // sentence stays on the page where it streamed; the block follows it, and
  // since work follows the prose, no passage carries the answer affordances.
  assert.deepEqual(preToolOnlyAnswerTimeline.map((item) => item.type), ["user", "assistant", "activity"]);
  assert.equal(preToolOnlyAnswerTimeline[1].text, "# Umbratic Project Overview\n\nA private AI workbench.");
  assert.equal(preToolOnlyAnswerTimeline[1].final, undefined);
  assert.deepEqual(preToolOnlyAnswerTimeline[2].segments.map((segment) => segment.type), ["command"]);

  const escapedPlanTimeline = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    { type: "user.message", taskId: "task-1", text: "write me bubble sort algorithm in python and verify that it runs", at: "2026-01-01T00:00:00.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "I’ll write a bubble sort script, save it, then verify it runs correctly with test cases.", at: "2026-01-01T00:00:01.000Z" },
    { type: "command.started", taskId: "task-1", id: "write-1", command: "write bubble_sort.py", cwd: "C:/repo", kind: "edit", commandClass: "edit", at: "2026-01-01T00:00:02.000Z" },
    { type: "command.finished", taskId: "task-1", id: "write-1", exitCode: 0, at: "2026-01-01T00:00:03.000Z" },
    { type: "command.started", taskId: "task-1", id: "run-1", command: "uv run bubble_sort.py", cwd: "C:/repo", kind: "bash", commandClass: "package-manager", at: "2026-01-01T00:00:04.000Z" },
    { type: "command.finished", taskId: "task-1", id: "run-1", exitCode: 0, at: "2026-01-01T00:00:05.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "Done — the script passed five test cases.", at: "2026-01-01T00:00:06.000Z" },
    { type: "assistant.done", taskId: "task-1", at: "2026-01-01T00:00:07.000Z" },
  ], undefined, "completed")));
  // The plan preamble stands where it streamed, the two tools it introduced
  // follow as one block, and the report after them closes the turn.
  assert.deepEqual(escapedPlanTimeline.map((item) => item.type), ["user", "assistant", "activity", "assistant"]);
  assert.equal(escapedPlanTimeline[1].text, "I’ll write a bubble sort script, save it, then verify it runs correctly with test cases.");
  assert.deepEqual(
    escapedPlanTimeline[2].segments.map((segment) => segment.type),
    ["command", "command"],
  );
  assert.equal(escapedPlanTimeline[3].text, "Done — the script passed five test cases.");

  // A multi-round turn interleaves: each round of work is its own block, and
  // what the run said between rounds stays standing between them — text the
  // reader has seen never moves.
  const multiRoundTimeline = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    { type: "user.message", taskId: "task-1", text: "can you tell me about this folder?", at: "2026-01-01T00:00:00.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "I'll start by listing all the contents of the root directory.", at: "2026-01-01T00:00:01.000Z" },
    { type: "command.started", taskId: "task-1", id: "ls-1", command: "ls .", cwd: "C:/repo", kind: "read", commandClass: "read", at: "2026-01-01T00:00:02.000Z" },
    { type: "command.finished", taskId: "task-1", id: "ls-1", exitCode: 0, at: "2026-01-01T00:00:03.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "I have listed the root. Now I will list the main subdirectories.", at: "2026-01-01T00:00:04.000Z" },
    { type: "command.started", taskId: "task-1", id: "ls-2", command: "ls src", cwd: "C:/repo", kind: "read", commandClass: "read", at: "2026-01-01T00:00:05.000Z" },
    { type: "command.finished", taskId: "task-1", id: "ls-2", exitCode: 0, at: "2026-01-01T00:00:06.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "This repository is a Next.js application.", at: "2026-01-01T00:00:07.000Z" },
    { type: "assistant.done", taskId: "task-1", at: "2026-01-01T00:00:08.000Z" },
  ], undefined, "completed")));
  assert.deepEqual(
    multiRoundTimeline.map((item) => item.type),
    ["user", "assistant", "activity", "assistant", "activity", "assistant"],
  );
  assert.equal(multiRoundTimeline[1].text, "I'll start by listing all the contents of the root directory.");
  assert.deepEqual(multiRoundTimeline[2].segments.map((segment) => segment.type), ["command"]);
  assert.equal(multiRoundTimeline[3].text, "I have listed the root. Now I will list the main subdirectories.");
  assert.deepEqual(multiRoundTimeline[4].segments.map((segment) => segment.type), ["command"]);
  // Only the passage nothing follows carries the answer affordances.
  assert.equal(multiRoundTimeline[1].final, undefined);
  assert.equal(multiRoundTimeline[3].final, undefined);
  assert.equal(multiRoundTimeline[5].text, "This repository is a Next.js application.");
  assert.equal(multiRoundTimeline[5].final, true);

  // After tools have run, live prose streams below the block from its first
  // token, and that token finishes the block: the run stopped working and
  // started talking. Should more work follow, it opens a new block after this
  // passage — the finished one never reopens, and the passage never moves.
  const streamingMidTurnTimeline = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    { type: "user.message", taskId: "task-1", text: "can you tell me about this folder?", at: "2026-01-01T00:00:00.000Z" },
    { type: "command.started", taskId: "task-1", id: "ls-1", command: "ls .", cwd: "C:/repo", kind: "read", commandClass: "read", at: "2026-01-01T00:00:01.000Z" },
    { type: "command.finished", taskId: "task-1", id: "ls-1", exitCode: 0, at: "2026-01-01T00:00:02.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "Now I will list the main subdirectories.", at: "2026-01-01T00:00:03.000Z" },
  ], undefined, "running")));
  assert.deepEqual(streamingMidTurnTimeline.map((item) => item.type), ["user", "activity", "assistant"]);
  assert.equal(streamingMidTurnTimeline[1].finished, true);
  assert.deepEqual(streamingMidTurnTimeline[1].segments.map((segment) => segment.type), ["command"]);
  assert.equal(streamingMidTurnTimeline[2].text, "Now I will list the main subdirectories.");
  assert.equal(streamingMidTurnTimeline[2].streaming, true);
  assert.match(
    activitySummary(streamingMidTurnTimeline[1], Date.parse("2026-01-01T00:00:08.000Z")),
    /^Worked for/,
  );

  // A stopped turn ends where it was: no error bubble, and whatever had already
  // streamed stays exactly where the user saw it, partial text included.
  const cancelledTurnTimeline = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    { type: "user.message", taskId: "task-1", text: "tell me about the invoices", at: "2026-01-01T00:00:00.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "I'll look at the invoice list.", at: "2026-01-01T00:00:01.000Z" },
    { type: "command.started", taskId: "task-1", id: "read-1", command: "read src/invoices.ts", cwd: "C:/repo", kind: "read", commandClass: "read", at: "2026-01-01T00:00:02.000Z" },
    { type: "command.finished", taskId: "task-1", id: "read-1", exitCode: 0, at: "2026-01-01T00:00:03.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "* \n* ", at: "2026-01-01T00:00:04.000Z" },
    { type: "turn.outcome", taskId: "task-1", outcome: "aborted", at: "2026-01-01T00:00:05.000Z" },
    { type: "assistant.done", taskId: "task-1", at: "2026-01-01T00:00:05.000Z" },
  ], undefined, "completed")));
  assert.deepEqual(cancelledTurnTimeline.map((item) => item.type), ["user", "assistant", "activity", "assistant"]);
  assert.equal(cancelledTurnTimeline[1].text, "I'll look at the invoice list.");
  assert.equal(cancelledTurnTimeline[2].finished, true);
  assert.deepEqual(cancelledTurnTimeline[2].segments.map((segment) => segment.type), ["command"]);
  // Whatever was streaming when the stop landed keeps its place as a message:
  // nothing follows it, so it was the last thing the run said.
  assert.equal(cancelledTurnTimeline[3].text, "* \n*");

  // Stopping a tool-less turn keeps the partial answer as the answer.
  const cancelledDirectAnswerTimeline = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    { type: "user.message", taskId: "task-1", text: "tell me about the invoices", at: "2026-01-01T00:00:00.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "Invoices are stored in", at: "2026-01-01T00:00:01.000Z" },
    { type: "turn.outcome", taskId: "task-1", outcome: "aborted", at: "2026-01-01T00:00:02.000Z" },
    { type: "assistant.done", taskId: "task-1", at: "2026-01-01T00:00:02.000Z" },
  ], undefined, "completed")));
  assert.deepEqual(cancelledDirectAnswerTimeline.map((item) => item.type), ["user", "assistant"]);
  assert.equal(cancelledDirectAnswerTimeline[1].text, "Invoices are stored in");

  const failedToolTimeline = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    events[0],
    { type: "command.started", taskId: "task-1", id: "read-1", command: "read .", cwd: "C:/repo", kind: "read", commandClass: "read", at: "2026-01-01T00:00:01.000Z" },
    { type: "command.finished", taskId: "task-1", id: "read-1", exitCode: 1, status: "validation_error", at: "2026-01-01T00:00:02.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "Partial answer", at: "2026-01-01T00:00:03.000Z" },
    { type: "assistant.done", taskId: "task-1", at: "2026-01-01T00:00:04.000Z" },
  ], undefined, "completed")));
  // The work window closes at the answer's first token (00:00:03), not at
  // assistant.done — the last second was talking, not working.
  assert.equal(activitySummary(failedToolTimeline[1]), "Worked for 3 seconds");

  const delayedFirstTokenTimeline = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    { type: "user.message", taskId: "task-1", text: "Summarize the attachment", at: "2026-01-01T00:00:00.000Z" },
    { type: "assistant.progress.delta", taskId: "task-1", text: "I have the document in context.", at: "2026-01-01T00:01:05.000Z", endedAt: "2026-01-01T00:01:07.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "Summary", at: "2026-01-01T00:01:08.000Z" },
    { type: "assistant.done", taskId: "task-1", at: "2026-01-01T00:01:10.000Z" },
  ], undefined, "completed")));
  assert.deepEqual(
    delayedFirstTokenTimeline.map((item) => item.type),
    ["user", "activity", "assistant"],
    "thinking stays in Working and collapses when the answer starts",
  );
  assert.equal(delayedFirstTokenTimeline[2].text, "Summary");

  const waitingTimeline = composerTimelineFromEvents([
    { type: "user.message", taskId: "task-1", text: "Summarize the attachment", at: "2026-01-01T00:00:00.000Z" },
  ], undefined, "running");
  assert.equal(waitingTimeline[1].type, "activity");
  assert.equal(
    activitySummary(waitingTimeline[1], Date.parse("2026-01-01T00:00:42.000Z")),
    "Working",
  );
  assert.equal(waitingTimeline[1].segments.length, 0);
  const waitingDisclosure = reconcileActivityDisclosureState(new Set(), waitingTimeline);
  assert.deepEqual([...waitingDisclosure], []);

  const directAnswerTimeline = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    { type: "user.message", taskId: "task-1", text: "Hey, tell me about yourself", at: "2026-01-01T00:00:00.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "I’m Umbratic.", at: "2026-01-01T00:00:07.000Z" },
    { type: "assistant.done", taskId: "task-1", at: "2026-01-01T00:00:08.000Z" },
  ], undefined, "completed")));
  assert.deepEqual(directAnswerTimeline.map((item) => item.type), ["user", "assistant"]);
  assert.equal("responseDurationMs" in directAnswerTimeline[1], false);

  const preAnswerTimeline = composerTimelineFromEvents([
    events[0],
    { type: "assistant.progress.delta", taskId: "task-1", text: "Working on it.", at: "2026-01-01T00:00:01.000Z" },
  ], undefined, "running");
  assert.equal(activitySummary(preAnswerTimeline[1]), "Working");
  // Blocks are collapsed by default, live ones included: the header row
  // summarizes the work and names what the run is doing, and opening the log
  // is the reader's choice rather than a shape change under their eyes.
  const openedDisclosure = reconcileActivityDisclosureState(new Set(), preAnswerTimeline);
  assert.deepEqual([...openedDisclosure], []);

  // A block the reader opened by hand stays open — settling does not take
  // their choice back.
  const settledNarration = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    events[0],
    { type: "assistant.progress.delta", taskId: "task-1", text: "Working on it.", at: "2026-01-01T00:00:01.000Z" },
    { type: "command.started", taskId: "task-1", id: "cmd-9", command: "npm test", cwd: "C:/repo", kind: "bash", commandClass: "package-manager", at: "2026-01-01T00:00:02.000Z" },
    { type: "command.finished", taskId: "task-1", id: "cmd-9", exitCode: 0, at: "2026-01-01T00:00:03.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "Tests pass.", at: "2026-01-01T00:00:04.000Z" },
    { type: "assistant.done", taskId: "task-1", at: "2026-01-01T00:00:05.000Z" },
  ], undefined, "completed")));
  const settledDisclosure = reconcileActivityDisclosureState(new Set(["activity-1"]), settledNarration);
  assert.deepEqual([...settledDisclosure], ["activity-1"]);
  const streamingToolsTimeline = composerTimelineFromEvents([
    events[0],
    { type: "assistant.progress.delta", taskId: "task-1", text: "Working on it.", at: "2026-01-01T00:00:01.000Z" },
    { type: "command.started", taskId: "task-1", id: "cmd-1", command: "npm run test", cwd: "C:/repo", kind: "bash", commandClass: "package-manager", at: "2026-01-01T00:00:02.000Z" },
  ], undefined, "running");
  assert.match(activitySummary(streamingToolsTimeline[1], Date.parse("2026-01-01T00:00:05.000Z")), /^Working/);
  // A live tool block stays shut too: the header names the running tool.
  const toolsDisclosure = reconcileActivityDisclosureState(new Set(), streamingToolsTimeline);
  assert.deepEqual([...toolsDisclosure], []);
  const streamingAnswerTimeline = composerTimelineFromEvents([
    events[0],
    { type: "assistant.progress.delta", taskId: "task-1", text: "Working on it.", at: "2026-01-01T00:00:01.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "Here is the answer", at: "2026-01-01T00:00:02.000Z" },
  ], undefined, "running");
  assert.deepEqual(
    JSON.parse(JSON.stringify(streamingAnswerTimeline.map((item) => item.type))),
    ["user", "activity", "assistant"],
  );
  assert.equal(streamingAnswerTimeline[2].streaming, true);
  assert.equal(streamingAnswerTimeline[1].segments[0].finished, true);
  // Opened by hand mid-run, the block does not close when the answer starts.
  const streamingDisclosure = reconcileActivityDisclosureState(new Set(["activity-1"]), streamingAnswerTimeline);
  assert.deepEqual([...streamingDisclosure], ["activity-1"]);
  const completedAnswerTimeline = composerTimelineFromEvents([
    events[0],
    { type: "assistant.progress.delta", taskId: "task-1", text: "Working on it.", at: "2026-01-01T00:00:01.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "Here is the answer", at: "2026-01-01T00:00:02.000Z" },
    { type: "assistant.done", taskId: "task-1", at: "2026-01-01T00:00:03.000Z" },
  ], undefined, "completed");
  const completedDisclosure = reconcileActivityDisclosureState(streamingDisclosure, completedAnswerTimeline);
  assert.deepEqual([...completedDisclosure], ["activity-1"]);
  // A transcript loaded fresh starts with every block shut.
  const loadedCompletedDisclosure = reconcileActivityDisclosureState(new Set(), completedAnswerTimeline);
  assert.deepEqual([...loadedCompletedDisclosure], []);
  const redundantCompletionTimeline = composerTimelineFromEvents([
    events[0],
    { type: "assistant.progress.delta", taskId: "task-1", text: "Work complete", at: "2026-01-01T00:00:01.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "Here is the answer", at: "2026-01-01T00:00:02.000Z" },
    { type: "assistant.done", taskId: "task-1", at: "2026-01-01T00:00:03.000Z" },
  ], undefined, "completed");
  assert.deepEqual(JSON.parse(JSON.stringify(redundantCompletionTimeline.map((item) => item.type))), ["user", "assistant"]);
  assert.equal(redundantCompletionTimeline[1].text, "Here is the answer");
  const modelFacingPrompt = "Umbratic workspace context:\n- opened folder: C:/repo\n\nUser request:\nRun tests";
  const displayTimeline = JSON.parse(JSON.stringify(composerTimelineFromEvents([events[0]], modelFacingPrompt)));
  assert.equal(displayTimeline.length, 1);
  assert.equal(displayTimeline[0].text, "Run tests");
  assert.doesNotMatch(displayTimeline[0].text, /workspace context/i);
  assert.deepEqual(
    JSON.parse(JSON.stringify(composerTimelineFromEvents([
      { type: "assistant.delta", taskId: "task-1", text: "Streaming now", at: "2026-01-01T00:00:05.000Z" },
    ], undefined, "running"))),
    // A lone streaming message has nothing after it, so it is already the
    // turn's answer and renders at full strength from its first token.
    [{ type: "assistant", id: "assistant-1", text: "Streaming now", streaming: true, final: true }],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(composerTimelineFromEvents([
      { type: "user.message", taskId: "task-1", text: "Do the work", at: "2026-01-01T00:00:00.000Z" },
      { type: "task.error", taskId: "task-1", message: "Runner turn failed.", at: "2026-01-01T00:00:01.000Z" },
    ], undefined, "failed"))),
    [
      { type: "user", id: "user-0-11", text: "Do the work", rawText: "Do the work", reviewFeedback: [], attachedFiles: [] },
      // A failure notice is how the turn ended, so it takes the closing slot.
      { type: "assistant", id: "assistant-1", text: "I couldn't complete this request.\n\nRunner turn failed.", final: true },
    ],
  );

  const duplicateDelivery = [
    events[0],
    events[1],
    { ...events[0] },
    { ...events[0], at: "2026-01-01T00:00:05.000Z" },
  ];
  assert.deepEqual(
    JSON.parse(JSON.stringify(compactBackendEvents(duplicateDelivery).filter((event) => event.type === "user.message").map((event) => event.text))),
    ["Run tests", "Run tests"],
  );

  // grep is no longer a runner tool, but a user can still run it through
  // `command`, so the shell-command label must survive the merge.
  assert.equal(commandLabel('grep "composer"'), "Search text");

  // search is the workspace locator and a workspace read. Without its entry in
  // the tool-label map it would fall through to shell rendering, which is a
  // user-visible regression rather than a cosmetic one.
  const searchRun = {
    id: "tool-1",
    command: "search composer",
    kind: "read",
    toolKind: "search",
    commandClass: "read",
    cwd: "C:/repo",
    stdout: "apps/desktop/src/renderer/main.tsx: content\n",
    stderr: "",
    exitCode: 0,
    status: "passed",
  };
  assert.equal(commandDetailLabel(searchRun), "Search workspace results - read");
  assert.ok(!commandDetailLabel(searchRun).startsWith("Shell"));
  assert.equal(commandShellText(searchRun), "apps/desktop/src/renderer/main.tsx: content");

  // Every runner tool is rendered from its reported tool kind, so a tool whose
  // summary does not look like a known command is still not shown as a shell.
  for (const toolKind of [
    "read",
    "read_attachment",
    "read_skill",
    "ls",
    "find",
    "search",
    "web_search",
    "web_fetch",
    "write",
    "edit",
    "apply_patch",
    "lsp",
    "workspace_graph",
  ]) {
    const toolRun = { ...searchRun, toolKind, command: `${toolKind} target`, stdout: "result\n" };
    assert.equal(commandShellText(toolRun), "result", `${toolKind} must not render as a shell`);
    assert.ok(
      !commandDetailLabel(toolRun).startsWith("Shell"),
      `${toolKind} must not be labelled as a shell`,
    );
  }

  for (const toolKind of ["command", "run_program"]) {
    const shellRun = { ...searchRun, toolKind, kind: "bash", command: "npm run test", stdout: "ok\n" };
    assert.equal(commandShellText(shellRun), "$ npm run test\n\nok");
    assert.equal(commandDetailLabel(shellRun), "Shell - read");
  }

  const verboseRun = {
    ...searchRun,
    stdout: Array.from({ length: 7 }, (_, index) => `line ${index + 1}`).join("\n"),
  };
  assert.equal(commandShellText(verboseRun), "[3 earlier output lines omitted.]\nline 4\nline 5\nline 6\nline 7");

  const fetchRun = {
    ...searchRun,
    toolKind: "web_fetch",
    command: "web_fetch https://www.democracynow.org/headlines",
    commandClass: "network",
    stdout: `${"A".repeat(2000)} footer`,
  };
  assert.equal(activityToolLabel(fetchRun).label, "Read www.democracynow.org");
  assert.equal(commandDetailLabel(fetchRun), "Read web page results - network");
  const fetchText = commandShellText(fetchRun);
  assert.ok(fetchText.startsWith("A"));
  assert.match(fetchText, /\[Page text truncated\.\]/);
  assert.ok(!fetchText.includes("footer"));
  assert.ok(fetchText.length < 800);

  const readRun = { ...searchRun, command: "read apps/desktop/src/renderer/main.tsx" };
  const readGroups = activityToolGroups([
    { type: "command", id: "read-1", run: { ...readRun, id: "read-1" } },
    { type: "command", id: "read-2", run: { ...readRun, id: "read-2" } },
  ]);
  assert.equal(readGroups[0].label, "Read main.tsx");
  assert.equal(readGroups[0].runs.length, 2);
});

test("live tool output is only for a streaming shell command that has bytes", () => {
  const { commandLiveOutputPreview } = loadRendererFile("commandDisplay.ts");
  const running = {
    id: "run-1",
    command: "npm test",
    kind: "bash",
    commandClass: "package-manager",
    cwd: "C:/repo",
    stdout: "",
    stderr: "",
    exitCode: null,
    status: "running",
  };
  assert.equal(commandLiveOutputPreview(running), undefined);
  assert.equal(commandLiveOutputPreview({ ...running, stdout: "ok\n" }), "ok\n");
  assert.equal(commandLiveOutputPreview({ ...running, status: "passed", stdout: "ok\n" }), undefined);
  assert.equal(
    commandLiveOutputPreview({
      ...running,
      toolKind: "web_search",
      command: "web_search latest news",
      kind: "read",
      commandClass: "network",
    }),
    undefined,
  );
  assert.equal(
    commandLiveOutputPreview({
      ...running,
      toolKind: "web_search",
      command: "web_search latest news",
      kind: "read",
      commandClass: "network",
      stdout: "1. Example — https://example.com\nThese are short snippets.\n",
    }),
    undefined,
  );
});


test("a turn that talks between rounds of tools interleaves passages and blocks", () => {
  const { composerTimelineFromEvents } = loadRendererFile("composerTimeline.ts");
  const at = (second) => `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;

  // A web-search turn: the run concedes it has the tool, searches twice, says
  // so again, reads a page, then answers. Every sentence stays where it
  // streamed; each stretch of work is its own block after the sentence that
  // introduced it, and only the last passage carries the answer affordances.
  const timeline = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    { type: "user.message", taskId: "task-1", text: "don't you have a web search tool?", at: at(0) },
    { type: "assistant.delta", taskId: "task-1", text: "You're right — I do have a web search tool.", at: at(1) },
    { type: "command.started", taskId: "task-1", id: "s1", command: "web_search top stories", cwd: ".", kind: "read", at: at(2) },
    { type: "command.finished", taskId: "task-1", id: "s1", exitCode: 0, at: at(3) },
    { type: "command.started", taskId: "task-1", id: "s2", command: "web_search good news", cwd: ".", kind: "read", at: at(4) },
    { type: "command.finished", taskId: "task-1", id: "s2", exitCode: 0, at: at(5) },
    { type: "assistant.delta", taskId: "task-1", text: "Yes, I do — let me pull the actual stories.", at: at(6) },
    { type: "command.started", taskId: "task-1", id: "r1", command: "web_fetch apnews.com", cwd: ".", kind: "read", at: at(7) },
    { type: "command.finished", taskId: "task-1", id: "r1", exitCode: 0, at: at(8) },
    { type: "assistant.delta", taskId: "task-1", text: "Here's what's going on today.", at: at(9) },
    { type: "assistant.done", taskId: "task-1", at: at(10) },
  ], undefined, "completed")));

  assert.deepEqual(
    timeline.map((item) => item.type),
    ["user", "assistant", "activity", "assistant", "activity", "assistant"],
  );
  assert.equal(timeline[1].text, "You're right — I do have a web search tool.");
  assert.deepEqual(timeline[2].segments.map((segment) => segment.type), ["command", "command"]);
  assert.equal(timeline[3].text, "Yes, I do — let me pull the actual stories.");
  assert.deepEqual(timeline[4].segments.map((segment) => segment.type), ["command"]);
  // Each block's elapsed window is its own: it opens with the round's first
  // tool and closes when the next passage's first token arrives.
  assert.equal(timeline[2].startedAt, at(2));
  assert.equal(timeline[2].endedAt, at(6));
  assert.equal(timeline[4].startedAt, at(7));
  assert.equal(timeline[4].endedAt, at(9));
  assert.equal(timeline[1].final, undefined);
  assert.equal(timeline[3].final, undefined);
  assert.equal(timeline[5].text, "Here's what's going on today.");
  assert.equal(timeline[5].final, true);
});

test("a steer accepted mid-stream lands after the sentence it interrupted", () => {
  const { composerTimelineFromEvents } = loadRendererFile("composerTimeline.ts");
  const at = (seconds) => `2026-01-01T00:00:0${seconds}.000Z`;
  // The steer's user.message is appended the moment it is accepted, which is
  // chronologically inside the model's sentence. Rendering it there split the
  // sentence around a user bubble; the bubble belongs after the prose it
  // interrupted.
  const flowing = [
    { type: "user.message", taskId: "task-1", text: "compare the languages", at: at(0) },
    { type: "assistant.delta", taskId: "task-1", text: "Get things done quickly", at: at(1) },
    { type: "user.message", taskId: "task-1", text: "Tell me about Python.", at: at(2) },
    { type: "assistant.delta", taskId: "task-1", text: ", the machine hides complexity.", at: at(3) },
  ];

  // Live: the prose streams on uninterrupted, the steer sits below it, and a
  // fresh Working block under the steer says it is what the run turns to next.
  const live = JSON.parse(JSON.stringify(composerTimelineFromEvents(flowing, undefined, "running")));
  assert.deepEqual(live.map((item) => item.type), ["user", "assistant", "user", "activity"]);
  assert.equal(live[1].text, "Get things done quickly, the machine hides complexity.");
  assert.equal(live[2].text, "Tell me about Python.");
  assert.equal(live[3].finished, false);

  // Settled: the interrupted answer stands whole, then the steer, then the
  // turn that answers it.
  const settled = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    ...flowing,
    { type: "turn.outcome", taskId: "task-1", outcome: "completed", at: at(4) },
    { type: "assistant.delta", taskId: "task-1", text: "Happy to go deeper into Python.", at: at(5) },
    { type: "assistant.done", taskId: "task-1", at: at(6) },
  ], undefined, "completed")));
  assert.deepEqual(settled.map((item) => item.type), ["user", "assistant", "user", "assistant"]);
  assert.equal(settled[1].text, "Get things done quickly, the machine hides complexity.");
  assert.equal(settled[1].final, true);
  assert.equal(settled[2].text, "Tell me about Python.");
  assert.equal(settled[3].text, "Happy to go deeper into Python.");
  assert.equal(settled[3].final, true);
});
