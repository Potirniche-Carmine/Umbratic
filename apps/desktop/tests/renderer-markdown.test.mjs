import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const iconNames = [
  "AtSign", "BarChart3", "Brain", "Check", "ChevronDown", "ChevronRight", "CheckCircle2", "CircleDashed",
  "Copy", "ExternalLink", "File", "FileText", "FolderOpen", "GitBranch", "Hand", "Loader2", "Minus",
  "Monitor", "Moon", "PanelRight", "Paperclip", "Play", "Plus", "RefreshCw", "Send", "Settings",
  "ShieldAlert", "ShieldCheck", "Sparkles", "SquarePen", "Sun", "TerminalSquare", "ThumbsDown", "ThumbsUp",
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

test("diff parsing, command aggregation, pending permissions, and timelines reflect real event streams", () => {
  const {
    assistantTextFromEvents,
    commandRunsFromEvents,
    commandSummary,
    composerTimelineFromEvents,
    formatDiffStats,
    parseUnifiedDiff,
    pendingPermissionFromEvents,
  } = loadRenderer();

  const diff = ["diff --git a/src/app.ts b/src/app.ts", "@@ -2,2 +2,3 @@", " const a = 1;", "-old", "+new", "+next"].join("\n");
  const parsed = parseUnifiedDiff(diff);
  assert.equal(formatDiffStats(parsed), "+2 -1");
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.rows)).map((row) => row.kind), ["remove", "add", "add"]);

  const events = [
    { type: "user.message", taskId: "task-1", text: "Run tests", at: "2026-01-01T00:00:00.000Z" },
    { type: "assistant.reasoning.delta", taskId: "task-1", text: "Thinking", at: "2026-01-01T00:00:01.000Z", endedAt: "2026-01-01T00:00:03.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "**Umbratic AI**: Done", at: "2026-01-01T00:00:04.000Z" },
    { type: "command.started", taskId: "task-1", id: "cmd-1", command: "npm run test", cwd: "C:/repo", kind: "bash", commandClass: "package-manager" },
    { type: "command.output", taskId: "task-1", id: "cmd-1", stream: "stdout", text: "ok\n" },
    { type: "command.finished", taskId: "task-1", id: "cmd-1", exitCode: 0 },
    { type: "permission.requested", taskId: "task-1", request: { id: "perm-1", kind: "bash", summary: "git commit", command: "git commit", cwd: "C:/repo" } },
  ];

  assert.equal(assistantTextFromEvents(events), "Done");
  const [run] = commandRunsFromEvents(events);
  assert.equal(run.status, "passed");
  assert.equal(commandSummary(run), "ok");
  assert.equal(pendingPermissionFromEvents(events).id, "perm-1");
  assert.deepEqual(JSON.parse(JSON.stringify(composerTimelineFromEvents(events))).map((item) => item.type), [
    "user",
    "reasoning",
    "assistant",
    "command",
  ]);
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
