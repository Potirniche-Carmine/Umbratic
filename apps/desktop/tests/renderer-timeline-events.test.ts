import assert from "node:assert/strict";
import test from "node:test";

import { loadRendererFile } from "./helpers/load-renderer.ts";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const { compactTaskEvents: compactBackendEvents } = loadTypeScriptModule(
  new URL("../src/shared/taskEvents.ts", import.meta.url),
);

test("command aggregation, pending permissions, and timelines reflect real event streams", () => {
  const { activitySummary } = loadRendererFile("activityTiming.ts");
  const {
    activityToolGroups,
    commandRunsFromEvents,
    pendingPermissionFromEvents,
    reconcileActivityDisclosureState,
  } = loadRendererFile("composerActivity.ts");
  const {
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
  // One turn, one block. Prose with work after it is narration and joins the
  // block already open — it does not close it and start another. Only the
  // answer, which nothing follows, renders outside.
  assert.deepEqual(interleavedTimeline.map((item) => item.type), ["user", "activity", "assistant"]);
  assert.deepEqual(
    interleavedTimeline[1].segments.map((segment) => segment.type),
    ["reasoning", "command", "reasoning"],
  );
  // A preamble and the progress line before it are one voice, so they read as
  // one passage rather than two stacked fragments.
  assert.equal(interleavedTimeline[1].segments[0].text, "First step.\n\nI’ll inspect the project.");
  assert.equal(interleavedTimeline[1].segments[2].text, "Second step.");
  assert.equal(interleavedTimeline[2].text, "Here is the complete answer.");
  assert.equal(interleavedTimeline[2].final, true);

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
  // The model said everything before the tool call and then fell silent. A tool
  // followed it, so it was narration whatever it looked like, and the turn ends
  // with no answer rather than promoting the preamble into one.
  assert.deepEqual(preToolOnlyAnswerTimeline.map((item) => item.type), ["user", "activity"]);
  assert.deepEqual(preToolOnlyAnswerTimeline[1].segments.map((segment) => segment.type), ["reasoning", "command"]);
  assert.equal(preToolOnlyAnswerTimeline[1].segments[0].text, "# Umbratic Project Overview\n\nA private AI workbench.");

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
  // The plan preamble reads as what it is — a sentence before the work — and it
  // sits with the two tools it introduced in one Working block.
  assert.deepEqual(escapedPlanTimeline.map((item) => item.type), ["user", "activity", "assistant"]);
  assert.deepEqual(
    escapedPlanTimeline[1].segments.map((segment) => segment.type),
    ["reasoning", "command", "command"],
  );
  assert.equal(escapedPlanTimeline[1].segments[0].text, "I’ll write a bubble sort script, save it, then verify it runs correctly with test cases.");
  assert.equal(escapedPlanTimeline[2].text, "Done — the script passed five test cases.");

  // A multi-round turn never relocates what the user has read. Prose that
  // streamed below a block with real work in it stands exactly there: the
  // block above settles and the next tool opens a new block beneath it.
  // Folding that prose into the block instead — the old rule — moved a
  // paragraph mid-read, which is the flash this replaces. Guided tool-step
  // preambles stay out of assistant.delta, so a split happens at a
  // substantial mid-turn report, not at every sentence.
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
    ["user", "activity", "assistant", "activity", "assistant"],
  );
  // The opening sentence arrived before any work, so it joins the first
  // block's narration — it was never rendered anywhere else.
  assert.deepEqual(
    multiRoundTimeline[1].segments.map((segment) => segment.type),
    ["reasoning", "command"],
  );
  assert.equal(multiRoundTimeline[1].segments[0].text, "I'll start by listing all the contents of the root directory.");
  // The mid-turn report streamed below the first block and stays there.
  assert.equal(multiRoundTimeline[2].text, "I have listed the root. Now I will list the main subdirectories.");
  assert.deepEqual(multiRoundTimeline[3].segments.map((segment) => segment.type), ["command"]);
  assert.equal(multiRoundTimeline[4].text, "This repository is a Next.js application.");

  // The reported regression: the answer used to stream inside the open Working
  // block and only move outside once the run settled, so it arrived as a jump
  // rather than a stream. Prose now closes the block and streams in place.
  const streamingMidTurnTimeline = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    { type: "user.message", taskId: "task-1", text: "can you tell me about this folder?", at: "2026-01-01T00:00:00.000Z" },
    { type: "command.started", taskId: "task-1", id: "ls-1", command: "ls .", cwd: "C:/repo", kind: "read", commandClass: "read", at: "2026-01-01T00:00:01.000Z" },
    { type: "command.finished", taskId: "task-1", id: "ls-1", exitCode: 0, at: "2026-01-01T00:00:02.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "Now I will list the main subdirectories.", at: "2026-01-01T00:00:03.000Z" },
  ], undefined, "running")));
  assert.deepEqual(streamingMidTurnTimeline.map((item) => item.type), ["user", "activity", "assistant"]);
  // The block settles the moment prose starts, so it shows its elapsed time
  // instead of staying open behind the text.
  assert.equal(streamingMidTurnTimeline[1].finished, true);
  assert.deepEqual(streamingMidTurnTimeline[1].segments.map((segment) => segment.type), ["command"]);
  assert.equal(streamingMidTurnTimeline[2].text, "Now I will list the main subdirectories.");
  assert.equal(streamingMidTurnTimeline[2].streaming, true);

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
  assert.deepEqual(cancelledTurnTimeline.map((item) => item.type), ["user", "activity", "assistant"]);
  assert.equal(cancelledTurnTimeline[1].finished, true);
  assert.deepEqual(cancelledTurnTimeline[1].segments.map((segment) => segment.type), ["reasoning", "command"]);
  assert.equal(cancelledTurnTimeline[1].segments[0].text, "I'll look at the invoice list.");
  // Whatever was streaming when the stop landed keeps its place as a message:
  // nothing follows it, so it was the last thing the run said.
  assert.equal(cancelledTurnTimeline[2].text, "* \n*");

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
  const waitingDisclosure = reconcileActivityDisclosureState(new Set(), waitingTimeline, "task-1", new Set());
  assert.deepEqual([...waitingDisclosure.expandedIds], []);

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
  // Narration opens the block before any tool exists. It is the only place that
  // sentence renders now, so leaving the block shut would show the reader
  // "Working" and nothing else while the run says what it is about to do.
  const openedDisclosure = reconcileActivityDisclosureState(new Set(), preAnswerTimeline, "task-1", new Set());
  assert.deepEqual([...openedDisclosure.expandedIds], [preAnswerTimeline[1].id]);
  assert.deepEqual([...openedDisclosure.autoOpenedKeys], [`task-1:${preAnswerTimeline[1].id}`]);

  // It closes again on its own once the turn settles, exactly as an auto-opened
  // tool block does: the account of the work stops competing with the answer.
  const settledNarration = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    events[0],
    { type: "assistant.progress.delta", taskId: "task-1", text: "Working on it.", at: "2026-01-01T00:00:01.000Z" },
    { type: "command.started", taskId: "task-1", id: "cmd-9", command: "npm test", cwd: "C:/repo", kind: "bash", commandClass: "package-manager", at: "2026-01-01T00:00:02.000Z" },
    { type: "command.finished", taskId: "task-1", id: "cmd-9", exitCode: 0, at: "2026-01-01T00:00:03.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "Tests pass.", at: "2026-01-01T00:00:04.000Z" },
    { type: "assistant.done", taskId: "task-1", at: "2026-01-01T00:00:05.000Z" },
  ], undefined, "completed")));
  const settledDisclosure = reconcileActivityDisclosureState(
    new Set(openedDisclosure.expandedIds),
    settledNarration,
    "task-1",
    new Set(openedDisclosure.autoOpenedKeys),
  );
  assert.deepEqual([...settledDisclosure.expandedIds], []);
  const streamingToolsTimeline = composerTimelineFromEvents([
    events[0],
    { type: "assistant.progress.delta", taskId: "task-1", text: "Working on it.", at: "2026-01-01T00:00:01.000Z" },
    { type: "command.started", taskId: "task-1", id: "cmd-1", command: "npm run test", cwd: "C:/repo", kind: "bash", commandClass: "package-manager", at: "2026-01-01T00:00:02.000Z" },
  ], undefined, "running");
  assert.match(activitySummary(streamingToolsTimeline[1], Date.parse("2026-01-01T00:00:05.000Z")), /^Working/);
  const toolsDisclosure = reconcileActivityDisclosureState(new Set(), streamingToolsTimeline, "task-1", new Set());
  assert.deepEqual([...toolsDisclosure.expandedIds], ["activity-1"]);
  assert.deepEqual([...toolsDisclosure.autoOpenedKeys], ["task-1:activity-1"]);
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
  const streamingDisclosure = reconcileActivityDisclosureState(
    toolsDisclosure.expandedIds,
    streamingAnswerTimeline,
    "task-1",
    toolsDisclosure.autoOpenedKeys,
  );
  assert.deepEqual([...streamingDisclosure.expandedIds], []);
  assert.deepEqual([...streamingDisclosure.autoOpenedKeys], []);
  const completedAnswerTimeline = composerTimelineFromEvents([
    events[0],
    { type: "assistant.progress.delta", taskId: "task-1", text: "Working on it.", at: "2026-01-01T00:00:01.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "Here is the answer", at: "2026-01-01T00:00:02.000Z" },
    { type: "assistant.done", taskId: "task-1", at: "2026-01-01T00:00:03.000Z" },
  ], undefined, "completed");
  const completedDisclosure = reconcileActivityDisclosureState(
    streamingDisclosure.expandedIds,
    completedAnswerTimeline,
    "task-1",
    streamingDisclosure.autoOpenedKeys,
  );
  assert.deepEqual([...completedDisclosure.expandedIds], []);
  assert.deepEqual([...completedDisclosure.autoOpenedKeys], []);
  const loadedCompletedDisclosure = reconcileActivityDisclosureState(new Set(), completedAnswerTimeline, "task-1", new Set());
  assert.deepEqual([...loadedCompletedDisclosure.expandedIds], []);
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

  const readRun = { ...searchRun, command: "read apps/desktop/src/renderer/main.tsx" };
  const readGroups = activityToolGroups([
    { type: "command", id: "read-1", run: { ...readRun, id: "read-1" } },
    { type: "command", id: "read-2", run: { ...readRun, id: "read-2" } },
  ]);
  assert.equal(readGroups[0].label, "Read main.tsx");
  assert.equal(readGroups[0].runs.length, 2);
});

