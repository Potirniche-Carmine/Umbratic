import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const iconNames = [
  "AtSign", "BarChart3", "Brain", "Check", "ChevronDown", "ChevronRight", "CheckCircle2", "CircleDashed",
  "Copy", "ExternalLink", "File", "FileText", "FolderOpen", "GitBranch", "Hand", "Loader2",
  "Monitor", "Moon", "PanelRight", "Paperclip", "Play", "Plus", "RefreshCw", "Send", "Settings",
  "ShieldCheck", "Sparkles", "SquarePen", "Sun", "ThumbsDown", "ThumbsUp",
  "Trash2", "TriangleAlert", "Type", "Undo2", "User", "X",
];

function browserGlobals() {
  const storage = new Map();
  const documentElement = {
    dataset: {},
    style: {
      colorScheme: "",
      setProperty() {},
    },
  };
  return {
    document: {
      body: { appendChild() {}, removeChild() {} },
      createElement: () => ({ setAttribute() {}, style: {}, select() {} }),
      documentElement,
      execCommand: () => true,
      getElementById: () => null,
    },
    navigator: { clipboard: undefined, platform: "Win32" },
    window: {
      clearTimeout,
      document: null,
      localStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, String(value)),
      },
      location: { search: "" },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      requestAnimationFrame: (callback) => {
        callback();
        return 0;
      },
      setTimeout,
      umbratic: undefined,
    },
  };
}

function loadRenderer() {
  const icon = (props) => React.createElement("svg", props);
  const lucide = Object.fromEntries(iconNames.map((name) => [name, icon]));
  return loadTypeScriptModule(new URL("../src/renderer/main.tsx", import.meta.url), {
    cache: new Map(),
    globals: browserGlobals(),
    mocks: {
      "lucide-react": lucide,
      "react-dom/client": {
        createRoot: () => ({ render() {} }),
      },
    },
  });
}

test("MarkdownContent renders real markdown while escaping raw HTML and scripts", () => {
  const { MarkdownContent } = loadRenderer();
  const content = [
    "## Safe **heading** <script>alert(1)</script>",
    "",
    "Paragraph with <img src=x onerror=alert(1)> and `</code><script>bad()</script>`.",
    "",
    "- Item with *emphasis* and @README.md",
    "",
    "| Key | Value |",
    "| --- | --- |",
    "| <b>raw</b> | `a|b` |",
    "",
    "```html",
    "<script>alert('x')</script>",
    "```",
  ].join("\n");

  const html = renderToStaticMarkup(React.createElement(MarkdownContent, { content }));
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img src=x/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<strong>heading<\/strong>/);
  assert.match(html, /<em>emphasis<\/em>/);
  assert.match(html, /<table>/);
  assert.match(html, /&lt;b&gt;raw&lt;\/b&gt;/);
  assert.match(html, /<code>&lt;\/code&gt;&lt;script&gt;bad\(\)&lt;\/script&gt;<\/code>/);
});

test("inline references render review buttons only for unambiguous review files", () => {
  const { MarkdownContent, reviewFileForReference, normalizeReviewReference } = loadRenderer();
  const reviewFiles = [
    { path: "src/app.ts", status: "modified", diff: "" },
    { path: "docs/README.md", status: "modified", diff: "" },
  ];

  assert.equal(normalizeReviewReference("@src\\app.ts,"), "src/app.ts");
  assert.equal(reviewFileForReference("app.ts", reviewFiles)?.path, "src/app.ts");

  const html = renderToStaticMarkup(
    React.createElement(MarkdownContent, {
      content: "See `src/app.ts` and @docs/README.md.",
      reviewFiles,
      onReviewFileClick() {},
    }),
  );
  assert.match(html, /<button class="inlineMentionToken reviewReferenceToken"/);
  assert.match(html, />src\/app\.ts<\/button>/);
  assert.match(html, />docs\/README\.md<\/button>/);
});

test("skill previews render markdown content and source filters split system from personal skills", () => {
  const { filterSkillsBySource, skillGovernanceLabel, skillPreviewMarkdown } = loadRenderer();
  const skillFile = [
    "---",
    "name: Marketing",
    "description: Launch copy and campaign briefs.",
    "---",
    "",
    "# Marketing",
    "",
    "Use concise campaign briefs.",
    "",
    "- Keep claims grounded.",
  ].join("\n");

  assert.equal(skillPreviewMarkdown(skillFile, "Marketing"), "Use concise campaign briefs.\n\n- Keep claims grounded.");
  assert.equal(skillPreviewMarkdown("# Custom Playbook\n\nKeep this heading.", "Marketing"), "# Custom Playbook\n\nKeep this heading.");

  const skills = [
    { id: "umbratic-marketing", name: "Marketing", description: "Campaign work.", enabled: true, source: "system" },
    { id: "personal-style", name: "Personal Style", description: "House tone.", enabled: true, source: "local" },
  ];
  assert.deepEqual(filterSkillsBySource(skills, "system").map((skill) => skill.id), ["umbratic-marketing"]);
  assert.deepEqual(filterSkillsBySource(skills, "local").map((skill) => skill.id), ["personal-style"]);
  assert.equal(
    skillGovernanceLabel({ id: "umbratic-marketing", name: "Marketing", description: "", enabled: true, source: "system", checksumStatus: "known_good", checksum: "sha256:1a81a685cafebabe" }),
    "",
  );
  assert.equal(
    skillGovernanceLabel({ id: "umbratic-marketing", name: "Marketing", description: "", enabled: true, source: "system", checksumStatus: "modified", modified: true }),
    "Modified",
  );
});

test("diff parsing, command aggregation, pending permissions, and timelines reflect real event streams", () => {
  const {
    activitySummary,
    activityToolGroups,
    assistantTextFromEvents,
    commandDetailLabel,
    commandLabel,
    commandRunsFromEvents,
    commandShellText,
    commandSummary,
    compactBackendEvents,
    composerTimelineFromEvents,
    formatDiffStats,
    parseUnifiedDiff,
    pendingPermissionFromEvents,
    reconcileActivityDisclosureState,
  } = loadRenderer();

  const diff = ["diff --git a/src/app.ts b/src/app.ts", "@@ -2,2 +2,3 @@", " const a = 1;", "-old", "+new", "+next"].join("\n");
  const parsed = parseUnifiedDiff(diff);
  assert.equal(formatDiffStats(parsed), "+2 -1");
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.rows)).map((row) => row.kind), ["remove", "add", "add"]);

  const events = [
    { type: "user.message", taskId: "task-1", text: "Run tests", at: "2026-01-01T00:00:00.000Z" },
    { type: "assistant.reasoning.delta", taskId: "task-1", text: "Thinking", at: "2026-01-01T00:00:01.000Z", endedAt: "2026-01-01T00:00:03.000Z" },
    { type: "command.started", taskId: "task-1", id: "cmd-1", command: "npm run test", cwd: "C:/repo", kind: "bash", commandClass: "package-manager", at: "2026-01-01T00:00:03.000Z" },
    { type: "command.output", taskId: "task-1", id: "cmd-1", stream: "stdout", text: "ok\n", at: "2026-01-01T00:00:04.000Z" },
    { type: "command.finished", taskId: "task-1", id: "cmd-1", exitCode: 0, at: "2026-01-01T00:00:05.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "**Umbratic AI**: Done", at: "2026-01-01T00:00:06.000Z" },
    { type: "permission.requested", taskId: "task-1", request: { id: "perm-1", kind: "bash", summary: "git commit", command: "git commit", cwd: "C:/repo" } },
  ];

  assert.equal(assistantTextFromEvents(events), "Done");
  const [run] = commandRunsFromEvents(events);
  assert.equal(run.status, "passed");
  assert.equal(commandSummary(run), "ok");
  const [failedWrite] = commandRunsFromEvents([
    { type: "command.started", taskId: "task-1", id: "write-1", command: "write bubble_sort.py", cwd: "C:/repo", kind: "edit", commandClass: "edit" },
    { type: "command.finished", taskId: "task-1", id: "write-1", exitCode: 1, status: "policy_blocked", errorCode: "policy_blocked", errorMessage: "Refusing path outside workspace: bubble_sort.py" },
  ]);
  assert.equal(commandSummary(failedWrite), "exit 1: Refusing path outside workspace: bubble_sort.py");
  assert.equal(commandShellText(failedWrite), "Refusing path outside workspace: bubble_sort.py");
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
  assert.deepEqual(delayedReasoningTimeline[1].segments.map((segment) => segment.type), ["reasoning", "command"]);
  const repeatedReasoningTimeline = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    events[0],
    { type: "assistant.reasoning.delta", taskId: "task-1", text: "First thought.", at: "2026-01-01T00:00:01.000Z" },
    events[2],
    events[3],
    events[4],
    { type: "assistant.reasoning.delta", taskId: "task-1", text: "Second thought.", at: "2026-01-01T00:00:05.500Z" },
    events[5],
  ])));
  assert.deepEqual(repeatedReasoningTimeline[1].segments.map((segment) => segment.type), ["reasoning", "command"]);
  assert.equal(repeatedReasoningTimeline[1].segments[0].text, "First thought.\n\nSecond thought.");
  const interleavedTimeline = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    events[0],
    { type: "assistant.reasoning.delta", taskId: "task-1", text: "First thought.", at: "2026-01-01T00:00:01.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "I’ll inspect the project.", at: "2026-01-01T00:00:02.000Z" },
    events[2],
    events[3],
    events[4],
    { type: "assistant.reasoning.delta", taskId: "task-1", text: "Second thought.", at: "2026-01-01T00:00:05.500Z" },
    { type: "assistant.delta", taskId: "task-1", text: "Here is the complete answer.", at: "2026-01-01T00:00:06.000Z" },
    { type: "assistant.done", taskId: "task-1", at: "2026-01-01T00:00:07.000Z" },
  ], undefined, "completed")));
  assert.deepEqual(interleavedTimeline.map((item) => item.type), ["user", "activity", "activity", "assistant"]);
  assert.equal(interleavedTimeline.filter((item) => item.type === "activity").length, 2);
  assert.equal(interleavedTimeline.filter((item) => item.type === "assistant").length, 1);
  assert.equal(interleavedTimeline[1].segments[0].text, "First thought.");
  assert.equal(interleavedTimeline[2].segments[0].text, "Second thought.");
  assert.equal(interleavedTimeline[3].text, "I’ll inspect the project.\n\nHere is the complete answer.");

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
    { type: "assistant.reasoning.delta", taskId: "task-1", text: "I have the document in context.", at: "2026-01-01T00:01:05.000Z", endedAt: "2026-01-01T00:01:07.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "Summary", at: "2026-01-01T00:01:08.000Z" },
    { type: "assistant.done", taskId: "task-1", at: "2026-01-01T00:01:10.000Z" },
  ], undefined, "completed")));
  assert.equal(
    activitySummary(delayedFirstTokenTimeline[1]),
    "Worked for 1 minute 8 seconds",
    "prompt evaluation before visible reasoning must count toward the response time",
  );

  const waitingTimeline = composerTimelineFromEvents([
    { type: "user.message", taskId: "task-1", text: "Summarize the attachment", at: "2026-01-01T00:00:00.000Z" },
  ], undefined, "running");
  assert.equal(waitingTimeline[1].type, "activity");
  assert.equal(
    activitySummary(waitingTimeline[1], Date.parse("2026-01-01T00:00:42.000Z")),
    "Working · 42 seconds",
  );

  const preAnswerTimeline = composerTimelineFromEvents([
    events[0],
    { type: "assistant.reasoning.delta", taskId: "task-1", text: "Working on it.", at: "2026-01-01T00:00:01.000Z" },
  ], undefined, "running");
  const openedDisclosure = reconcileActivityDisclosureState(new Set(), preAnswerTimeline, "task-1", new Set());
  assert.deepEqual([...openedDisclosure.expandedIds], ["activity-1"]);
  assert.deepEqual([...openedDisclosure.autoOpenedKeys], ["task-1:activity-1"]);
  const streamingAnswerTimeline = composerTimelineFromEvents([
    events[0],
    { type: "assistant.reasoning.delta", taskId: "task-1", text: "Working on it.", at: "2026-01-01T00:00:01.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "Here is the answer", at: "2026-01-01T00:00:02.000Z" },
  ], undefined, "running");
  assert.equal(streamingAnswerTimeline[1].type, "activity");
  assert.equal(streamingAnswerTimeline[1].finished, true);
  assert.equal(streamingAnswerTimeline[2].type, "assistant");
  assert.equal(streamingAnswerTimeline[2].streaming, true);
  const closedDisclosure = reconcileActivityDisclosureState(
    openedDisclosure.expandedIds,
    streamingAnswerTimeline,
    "task-1",
    openedDisclosure.autoOpenedKeys,
  );
  assert.deepEqual([...closedDisclosure.expandedIds], []);
  assert.deepEqual([...closedDisclosure.autoOpenedKeys], []);
  const modelFacingPrompt = "Umbratic workspace context:\n- opened folder: C:/repo\n\nUser request:\nRun tests";
  const displayTimeline = JSON.parse(JSON.stringify(composerTimelineFromEvents([events[0]], modelFacingPrompt)));
  assert.equal(displayTimeline.length, 1);
  assert.equal(displayTimeline[0].text, "Run tests");
  assert.doesNotMatch(displayTimeline[0].text, /workspace context/i);
  assert.deepEqual(
    JSON.parse(JSON.stringify(composerTimelineFromEvents([
      { type: "assistant.delta", taskId: "task-1", text: "Streaming now", at: "2026-01-01T00:00:05.000Z" },
    ], undefined, "running"))),
    [{ type: "assistant", id: "assistant-1", text: "Streaming now", streaming: true }],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(composerTimelineFromEvents([
      { type: "user.message", taskId: "task-1", text: "Do the work", at: "2026-01-01T00:00:00.000Z" },
      { type: "task.error", taskId: "task-1", message: "Runner turn failed.", at: "2026-01-01T00:00:01.000Z" },
    ], undefined, "failed"))),
    [
      { type: "user", id: "user-0-11", text: "Do the work", rawText: "Do the work", reviewFeedback: [], attachedFiles: [] },
      { type: "assistant", id: "assistant-1", text: "I couldn't complete this request.\n\nRunner turn failed." },
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

  const searchRun = {
    id: "tool-1",
    command: 'search "composer"',
    kind: "read",
    commandClass: "read",
    cwd: "C:/repo",
    stdout: "apps/desktop/src/renderer/main.tsx: content\n",
    stderr: "",
    exitCode: 0,
    status: "passed",
  };
  assert.equal(commandLabel(searchRun.command), "Search workspace");
  assert.equal(commandDetailLabel(searchRun), "Search workspace results - read");
  assert.equal(commandShellText(searchRun), "apps/desktop/src/renderer/main.tsx: content");

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

test("stream batching drains queued assistant text without adding a display backlog", () => {
  const {
    streamingMarkdownRenderBatchIntervalMs,
    takeBatchedBackendEvents,
  } = loadRenderer();

  assert.equal(streamingMarkdownRenderBatchIntervalMs, 50);
  const queue = [
    { type: "assistant.delta", taskId: "task-1", text: "abcdefghijklmnopqrstuvwxyz", at: "2026-01-01T00:00:00.000Z" },
    { type: "assistant.done", taskId: "task-1", at: "2026-01-01T00:00:01.000Z" },
  ];

  const batch = takeBatchedBackendEvents(queue);
  assert.deepEqual(JSON.parse(JSON.stringify(batch.map((event) => event.type))), ["assistant.delta", "assistant.done"]);
  assert.equal(batch[0].text, "abcdefghijklmnopqrstuvwxyz");
  assert.equal(queue.length, 0);
});

test("prompt mention parsing supports file and skill completion triggers", () => {
  const { mentionAtCursor, renderPromptHighlights, skillMention } = loadRenderer();

  assert.deepEqual(JSON.parse(JSON.stringify(mentionAtCursor("Open @src/app", 13))), {
    kind: "file",
    query: "src/app",
    start: 5,
    end: 13,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(mentionAtCursor("Apply $review", 13))), {
    kind: "skill",
    query: "review",
    start: 6,
    end: 13,
  });
  assert.equal(skillMention({ id: "review", name: "Review", description: "", enabled: true }), "$review");

  const highlighted = renderToStaticMarkup(
    React.createElement(React.Fragment, null, renderPromptHighlights("Use @app.ts and $review.", [{ path: "src/app.ts", name: "app.ts" }], [{ id: "review", name: "Review", description: "", enabled: true }])),
  );
  assert.match(highlighted, /promptMentionToken/);
  assert.match(highlighted, /\$review/);
});
