import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { loadRenderer, loadRendererFile } from "./helpers/load-renderer.ts";

test("MarkdownContent renders real markdown while escaping raw HTML and scripts", () => {
  const { MarkdownContent } = loadRendererFile("markdownContent.tsx");
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

test("WorkMarkdownContent renders safe markdown with a distinct streaming marker", () => {
  const { WorkMarkdownContent } = loadRendererFile("markdownContent.tsx");
  const html = renderToStaticMarkup(
    React.createElement(WorkMarkdownContent, {
      content: "**Inspecting** the workspace.\n\n- Read `main.tsx`\n- Run tests",
      streaming: true,
    }),
  );
  assert.match(html, /workMarkdownContent isStreaming/);
  assert.match(html, /<strong>Inspecting<\/strong>/);
  // The live tail renders as real markdown too, so completed blocks never pop
  // from plain text to styled when the next paragraph boundary arrives.
  assert.match(html, /<ul>/);
  assert.match(html, /Run tests/);
  assert.doesNotMatch(html, /workStreamingCaret/);
  assert.doesNotMatch(html, /streamingPlainTail/);
  assert.doesNotMatch(html, /\*\*Inspecting\*\*/);
});

test("streaming markdown stabilizes unfinished inline syntax instead of popping", () => {
  const { WorkMarkdownContent } = loadRendererFile("markdownContent.tsx");
  const unfinishedBold = renderToStaticMarkup(
    React.createElement(WorkMarkdownContent, { content: "Checking the **invoice tot", streaming: true }),
  );
  assert.match(unfinishedBold, /<strong>invoice tot<\/strong>/);
  const heldBackOpener = renderToStaticMarkup(
    React.createElement(WorkMarkdownContent, { content: "Checking the **", streaming: true }),
  );
  assert.doesNotMatch(heldBackOpener, /\*\*/);
  const intraWordMarkers = renderToStaticMarkup(
    React.createElement(WorkMarkdownContent, { content: "compute 5 * 3 in snake_case fields", streaming: true }),
  );
  assert.doesNotMatch(intraWordMarkers, /<em>/);
  // An unterminated fence renders as a code block mid-stream, never as a
  // paragraph of backticks that later converts.
  const openFence = renderToStaticMarkup(
    React.createElement(WorkMarkdownContent, { content: "Running:\n\n```bash\nnpm test", streaming: true }),
  );
  assert.match(openFence, /npm test/);
  assert.doesNotMatch(openFence, /```/);
});

test("work activity styles keep reasoning and tool calls in one seamless flow", () => {
  const activityCss = fs.readFileSync(
    new URL("../src/renderer/styles/work-activity.css", import.meta.url),
    "utf8",
  );
  const reasoningRule = activityCss.match(/\.activityLogEntry\.reasoningLog\s*{[^}]+}/s)?.[0] ?? "";
  assert.match(reasoningRule, /\.activityLogEntry\.reasoningLog/);
  assert.doesNotMatch(reasoningRule, /\b(?:background|border)/);
  assert.doesNotMatch(activityCss, /activityToolToggle::before/);
  assert.doesNotMatch(activityCss, /\.commandLog\.(?:running|passed|failed)/);
});

test("toast close control centers its icon without a text line box", () => {
  const css = fs.readFileSync(
    new URL("../src/renderer/styles/motion-accessibility.css", import.meta.url),
    "utf8",
  );
  const buttonRule = css.match(/\.toast button\s*{[^}]+}/s)?.[0] ?? "";
  const iconRule = css.match(/\.toast button svg\s*{[^}]+}/s)?.[0] ?? "";
  assert.match(buttonRule, /place-items:\s*center/);
  assert.match(buttonRule, /padding:\s*0/);
  assert.match(buttonRule, /line-height:\s*0/);
  assert.match(iconRule, /display:\s*block/);
  // The turn-outcome toast is gone: it keyed off the newest turn.outcome
  // event, which persists with the task, so it could never dismiss itself.
  assert.doesNotMatch(css, /turnOutcome/);
});

test("feedback dialog and prompt controls do not allow horizontal growth", () => {
  const composerCss = fs.readFileSync(
    new URL("../src/renderer/styles/composer.css", import.meta.url),
    "utf8",
  );
  const feedbackCss = fs.readFileSync(
    new URL("../src/renderer/styles/response-feedback.css", import.meta.url),
    "utf8",
  );
  const feedbackDialogRule = feedbackCss.match(/\.responseFeedbackDialog\s*{[^}]+}/s)?.[0] ?? "";
  const feedbackTextRule = feedbackCss.match(/\.responseFeedbackDialog textarea\s*{[^}]+}/s)?.[0] ?? "";
  const sendRule = composerCss.match(/\.sendButton\s*{[^}]+}/s)?.[0] ?? "";
  const actionRailRule = composerCss.match(/\.promptActionRail\s*{[^}]+}/s)?.[0] ?? "";
  const textareaRule = composerCss.match(/\.composer textarea\s*{[^}]+}/s)?.[0] ?? "";
  assert.match(feedbackDialogRule, /width:\s*min\(500px,\s*calc\(100vw - 32px\)\)/);
  assert.match(feedbackTextRule, /box-sizing:\s*border-box/);
  assert.match(feedbackTextRule, /width:\s*100%/);
  assert.doesNotMatch(sendRule, /position:\s*absolute/);
  assert.match(sendRule, /width:\s*30px/);
  // The rail holds two groups now — how the turn is written on the left, what
  // answers it on the right — so it spreads rather than pushing everything right.
  assert.match(actionRailRule, /justify-content:\s*space-between/);
  assert.match(actionRailRule, /min-height:\s*36px/);
  // No strip at all. Even a translucent one draws a rectangle under the text,
  // and a rectangle with a hairline on top of it is a second box: the controls
  // sit on the prompt's own surface instead.
  assert.match(actionRailRule, /border-top:\s*0/);
  assert.match(actionRailRule, /background:\s*transparent/);
  assert.doesNotMatch(actionRailRule, /backdrop-filter/);
  assert.doesNotMatch(actionRailRule, /linear-gradient/);
  // And the controls in it are borderless, so nothing inside the box outlines
  // itself against the box's own outline.
  const railControlsRule = composerCss.match(
    /\.promptActionRail \.permissionControl \.permissionTrigger,\r?\n\.promptActionRail \.modelControl \.modelTrigger,\r?\n\.promptActionRail \.dictationControl \{[^}]+\}/s,
  )?.[0] ?? "";
  assert.match(railControlsRule, /border:\s*0/);
  assert.match(railControlsRule, /background:\s*transparent/);
  assert.doesNotMatch(railControlsRule, /border-radius:\s*999px/);
  assert.match(textareaRule, /max-width:\s*100%/);
  assert.match(textareaRule, /overflow-x:\s*hidden/);
  assert.match(textareaRule, /overflow-wrap:\s*anywhere/);
});

test("work and skill disclosures use restrained motion without text geometry changes", () => {
  const timelineCss = fs.readFileSync(
    new URL("../src/renderer/styles/timeline.css", import.meta.url),
    "utf8",
  );
  const skillCss = fs.readFileSync(
    new URL("../src/renderer/styles/skills-settings.css", import.meta.url),
    "utf8",
  );
  const bodyRule = timelineCss.match(/\.activityBody\s*{[^}]+}/s)?.[0] ?? "";
  const bodyContentRule = timelineCss.match(/\.activityBodyContent\s*{[^}]+}/s)?.[0] ?? "";
  const skillPreviewRule = skillCss.match(/\.skillPreviewPanel\s*{[^}]+}/s)?.[0] ?? "";
  assert.match(bodyRule, /grid-template-rows\s+210ms/);
  assert.match(bodyRule, /70ms/);
  assert.match(bodyContentRule, /opacity\s+90ms/);
  assert.doesNotMatch(bodyContentRule, /transform/);
  assert.match(skillPreviewRule, /skillPreviewReveal\s+170ms/);
});

test("inline references render review buttons only for unambiguous review files", () => {
  const { MarkdownContent, reviewFileForReference, normalizeReviewReference } = loadRendererFile("markdownContent.tsx");
  const reviewFiles = [
    { path: "src/app.ts", status: "modified", patch: "" },
    { path: "docs/README.md", status: "modified", patch: "" },
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

test("generated document paths become clean response labels", () => {
  const { documentReviewDisplayName } = loadRendererFile("composerChrome.tsx");
  assert.equal(documentReviewDisplayName(".umbratic/artifacts/docx/narrative-proposal.docx"), "Narrative Proposal");
  assert.equal(documentReviewDisplayName(".umbratic/artifacts/docx/Q3_brief.docx"), "Q3 Brief");
});

test("skill previews render markdown content and source filters split system from personal skills", () => {
  const { filterSkillsBySource, skillGovernanceLabel, skillPreviewMarkdown } = loadRendererFile("skillDisplay.ts");
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

test("a streaming answer shows the text as it arrives, and a settled answer is complete", () => {
  const { AssistantAnswerContent } = loadRendererFile("markdownContent.tsx");

  const content = "The answer streams token by token.";
  const render = (props) =>
    renderToStaticMarkup(React.createElement(AssistantAnswerContent, { content, ...props }));

  const streaming = render({ streaming: true });
  assert.match(streaming, /streamingTextContent/);
  assert.match(streaming, /The answer streams token by token/);
  assert.match(streaming, /streamingTextCaret/);

  const settled = render({ streaming: false });
  assert.doesNotMatch(settled, /streamingTextContent/);
  assert.match(settled, /The answer streams token by token/);
});

test("the streaming caret rides the end of the code being written, not the bottom of the message", () => {
  const { AssistantAnswerContent } = loadRendererFile("markdownContent.tsx");
  const render = (content) =>
    renderToStaticMarkup(React.createElement(AssistantAnswerContent, { content, streaming: true }));

  // An open fence: the caret is inside <code>, after the last streamed line.
  const code = render("Here:\n\n```c\nint main() {\n  return 0;");
  assert.match(code, /return 0;<span class="streamingTextCaret"[^>]*><\/span><\/code><\/pre>/);
  assert.equal((code.match(/streamingTextCaret/g) ?? []).length, 1);

  // A table in progress: the caret is in the last cell written.
  const table = render("| a | b |\n| --- | --- |\n| 1 | 2 |");
  assert.match(table, /2<span class="streamingTextCaret"[^>]*><\/span><\/td>/);

  // A rule has nowhere to hold it, so it follows the block.
  const rule = render("done\n\n---");
  assert.match(rule, /<hr\/><span class="streamingTextCaret"/);
});

test("the review panel's close spring stays stable however long a frame takes", () => {
  const { reviewCloseSpring, reviewOpenSpring, reviewSpringStep } = loadRendererFile("reviewSpring.ts");

  const width = 910;
  const target = width + 18;
  // A closing panel starts at 0 and slides out to `target`.
  const close = (frameMs, spring = reviewCloseSpring) => {
    let value = 0;
    let velocity = 0;
    let elapsed = 0;
    let peak = 0;
    while (elapsed < 5000 && value < width) {
      ({ value, velocity } = reviewSpringStep(value, velocity, target, frameMs / 1000, spring));
      peak = Math.max(peak, value);
      elapsed += frameMs;
    }
    return { elapsed, offscreen: value >= width, peak };
  };

  // Both springs sit just under critical damping, so neither sails past the
  // target and springs back into view on its way out.
  for (const spring of [reviewOpenSpring, reviewCloseSpring]) {
    assert.ok(spring.damping < 2 * Math.sqrt(spring.stiffness), "spring is overdamped");
    assert.ok(spring.damping > 1.6 * Math.sqrt(spring.stiffness), "spring will visibly bounce");
  }

  // Dismissal is quicker than arrival, and moving by the first frame.
  assert.ok(close(16.7).elapsed < close(16.7, reviewOpenSpring).elapsed);
  assert.ok(reviewSpringStep(0, 0, target, 16.7 / 1000, reviewCloseSpring).value > 100);

  // Integrating a whole frame in one step diverged here: at 50ms the offset
  // went 974, 49, 1805, -697, 3261 and grew without bound, so the panel never
  // reached the state that unmounts it.
  for (const frameMs of [16.7, 33, 50, 100, 200]) {
    for (const spring of [reviewOpenSpring, reviewCloseSpring]) {
      const result = close(frameMs, spring);
      assert.equal(result.offscreen, true, `panel never left the screen at ${frameMs}ms frames`);
      assert.ok(result.elapsed <= 600, `close took ${result.elapsed}ms at ${frameMs}ms frames`);
      assert.ok(result.peak <= target + 1, `overshot to ${result.peak} at ${frameMs}ms frames`);
    }
  }

  // A window that stopped drawing entirely catches up by a bounded amount
  // rather than simulating the whole gap.
  const stalled = reviewSpringStep(0, 0, target, 60);
  const capped = reviewSpringStep(0, 0, target, 0.25);
  assert.equal(stalled.value, capped.value);
});

test("prompt mention parsing supports file and skill completion triggers", () => {
  const { mentionAtCursor, renderPromptHighlights, skillMention } = loadRendererFile("promptMentions.tsx");

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

test("spaced list items stay one list and inline math renders as symbols", () => {
  const { MarkdownContent } = loadRendererFile("markdownContent.tsx");
  const content = [
    String.raw`Desktop $\rightarrow$ Runner $\rightarrow$ Veil`,
    "",
    "1. First step",
    "",
    "2. Second step",
    "",
    "3. Third step",
    "",
    "```",
    String.raw`literal $\rightarrow$ stays`,
    "```",
  ].join("\n");

  const html = renderToStaticMarkup(React.createElement(MarkdownContent, { content }));
  // A blank line between items used to close the list, so every <ol> restarted
  // at 1 and the reader saw "1. 1. 1.".
  assert.equal(html.match(/<ol>/g)?.length, 1);
  assert.equal(html.match(/<li>/g)?.length, 3);
  assert.match(html, /Desktop → Runner → Veil/);
  assert.doesNotMatch(html.split("<pre")[0], new RegExp(String.raw`\\rightarrow`));
  // Code keeps whatever the author wrote.
  assert.ok(html.includes(String.raw`literal $\rightarrow$ stays`), html);
});

test("unsupported inline math is left verbatim rather than half translated", () => {
  const { MarkdownContent } = loadRendererFile("markdownContent.tsx");
  const html = renderToStaticMarkup(
    React.createElement(MarkdownContent, { content: String.raw`Ratio $\frac{a}{b}$ holds` }),
  );
  assert.ok(html.includes(String.raw`$\frac{a}{b}$`), html);
});

test("context compaction is a top-level transcript marker, not a hidden log line", () => {
  const { compactionElapsedLabel } = loadRendererFile("activityTiming.ts");
  const { composerTimelineFromEvents } = loadRendererFile("composerTimeline.ts");

  const started = [
    { type: "user.message", taskId: "task-1", text: "Keep going", at: "2026-01-01T00:00:00.000Z" },
    { type: "context.compaction", taskId: "task-1", phase: "started", at: "2026-01-01T00:00:01.000Z" },
  ];
  // The marker sits beside the messages rather than inside a Working block, so
  // nothing has to be expanded to see that the turn is waiting on compaction.
  const live = JSON.parse(JSON.stringify(composerTimelineFromEvents(started, undefined, "running")));
  assert.deepEqual(live.map((item) => item.type), ["user", "compaction"]);
  assert.equal(live[1].status, "running");

  const settled = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    ...started,
    {
      type: "context.compaction",
      taskId: "task-1",
      phase: "finished",
      outcome: "compacted",
      reclaimedTokens: 32_000,
      at: "2026-01-01T00:00:07.000Z",
    },
    { type: "assistant.delta", taskId: "task-1", text: "Done", at: "2026-01-01T00:00:08.000Z" },
  ])));
  assert.deepEqual(settled.map((item) => item.type), ["user", "compaction", "assistant"]);
  assert.equal(settled[1].status, "compacted");
  assert.equal(settled[1].reclaimedTokens, 32_000);
  // The elapsed time the user watched is the elapsed time that settles.
  assert.equal(compactionElapsedLabel(settled[1]), "6 seconds");

  // A pass that reclaimed nothing still cost the wait, so it stays on screen.
  const refused = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    ...started,
    { type: "context.compaction", taskId: "task-1", phase: "finished", outcome: "unchanged", reclaimedTokens: 0, at: "2026-01-01T00:00:05.000Z" },
    { type: "assistant.delta", taskId: "task-1", text: "Done", at: "2026-01-01T00:00:06.000Z" },
  ])));
  assert.equal(refused[1].status, "unchanged");

  // A summarization round-trip that came back unusable is its own state: the
  // turn continued on the full context, and saying "unchanged" would hide it.
  const failed = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    ...started,
    { type: "context.compaction", taskId: "task-1", phase: "finished", outcome: "failed", reclaimedTokens: 0, at: "2026-01-01T00:00:05.000Z" },
  ])));
  assert.equal(failed[1].status, "failed");

  // A finish with no start replays from a truncated log; nothing is invented.
  const orphaned = composerTimelineFromEvents([
    started[0],
    { type: "context.compaction", taskId: "task-1", phase: "finished", outcome: "compacted", at: "2026-01-01T00:00:05.000Z" },
  ]);
  assert.equal(orphaned.some((item) => item.type === "compaction"), false);
});

test("a dropped connection reports its retries and never outlives the outage", () => {
  const { providerReconnectFromEvents } = loadRendererFile("connectionStatus.ts");

  const dropped = [
    { type: "user.message", taskId: "task-1", text: "go", at: "2026-01-01T00:00:00.000Z" },
    { type: "provider.reconnecting", taskId: "task-1", attempt: 1, maxAttempts: 10, delayMs: 30000, at: "2026-01-01T00:00:01.000Z" },
    { type: "provider.reconnecting", taskId: "task-1", attempt: 2, maxAttempts: 10, delayMs: 30000, at: "2026-01-01T00:00:32.000Z" },
  ];
  // The composer shows the latest attempt, not the first one, and when the
  // next one is due so it can count down to it.
  assert.deepEqual(
    JSON.parse(JSON.stringify(providerReconnectFromEvents(dropped))),
    { attempt: 2, maxAttempts: 10, retryAt: Date.parse("2026-01-01T00:01:02.000Z") },
  );
  // An event with no timestamp still shows the count; it just cannot count down.
  assert.equal(
    providerReconnectFromEvents([{ type: "provider.reconnecting", taskId: "task-1", attempt: 1, maxAttempts: 10, delayMs: 30000 }]).retryAt,
    null,
  );

  // An explicit reconnect clears it.
  assert.equal(
    providerReconnectFromEvents([...dropped, { type: "provider.reconnected", taskId: "task-1", attempt: 3 }]),
    null,
  );

  // So does any evidence the turn resumed, which is what stops a missed
  // reconnected event from stranding the banner on screen forever.
  for (const resumed of [
    { type: "assistant.delta", taskId: "task-1", text: "back" },
    { type: "command.started", taskId: "task-1", id: "c1", command: "ls", cwd: "." },
    { type: "task.error", taskId: "task-1", message: "gave up" },
    { type: "turn.outcome", taskId: "task-1", outcome: "aborted" },
  ]) {
    assert.equal(providerReconnectFromEvents([...dropped, resumed]), null, resumed.type);
  }

  // A healthy turn never shows it at all.
  assert.equal(providerReconnectFromEvents([dropped[0]]), null);
});

test("the connection notice sits on the prompt box and counts down to the next retry", () => {
  const { secondsUntil } = loadRendererFile("connectionNotice.tsx");
  assert.equal(secondsUntil(null, 0), null);
  assert.equal(secondsUntil(30_000, 0), 30);
  assert.equal(secondsUntil(30_000, 29_100), 1);
  // Never negative: a wait that has elapsed reads as "now", not "-3s".
  assert.equal(secondsUntil(30_000, 45_000), 0);

  const renderer = fs.readFileSync(new URL("../src/renderer/main.tsx", import.meta.url), "utf8");
  // Inside the prompt box, absolutely positioned over its corner, so it never
  // reflows the box or the conversation above it.
  const composerOpen = renderer.indexOf('<div className="composer" onDrop=');
  const composerHead = renderer.slice(composerOpen, composerOpen + 400);
  assert.match(composerHead, /<ConnectionNotice state=\{providerReconnect\} \/>/);
  assert.doesNotMatch(renderer, /className="connectionNotice"/);
  const styles = fs.readFileSync(new URL("../src/renderer/styles/composer-controls.css", import.meta.url), "utf8");
  const rule = styles.slice(styles.indexOf(".connectionNotice {"));
  assert.match(rule.slice(0, rule.indexOf("\n}")), /position: absolute;/);
});

test("an error toast says its sentence and leaves", () => {
  const { ErrorToast, TOAST_LIFETIME_MS } = loadRendererFile("errorToast.tsx");
  assert.equal(TOAST_LIFETIME_MS, 5_000);
  const shown = renderToStaticMarkup(React.createElement(ErrorToast, { message: "Health check failed", onDismiss() {} }));
  assert.match(shown, /class="toast"/);
  assert.match(shown, /Health check failed/);
  assert.equal(renderToStaticMarkup(React.createElement(ErrorToast, { message: null, onDismiss() {} })), "");
  const source = fs.readFileSync(new URL("../src/renderer/errorToast.tsx", import.meta.url), "utf8");
  assert.match(source, /window\.setTimeout\(\(\) => dismiss\.current\(\), TOAST_LIFETIME_MS\)/);
  const renderer = fs.readFileSync(new URL("../src/renderer/main.tsx", import.meta.url), "utf8");
  assert.match(renderer, /<ErrorToast message=\{error\} onDismiss=\{\(\) => setError\(null\)\} \/>/);
});

test("only the prose nothing follows is the turn's answer", () => {
  const { composerTimelineFromEvents } = loadRendererFile("composerTimeline.ts");
  const at = (seconds) => `2026-01-01T00:00:0${seconds}.000Z`;

  // The shape the user actually sees: an opening sentence, a round of work,
  // then the reply.
  const turn = [
    { type: "user.message", taskId: "task-1", text: "tell me about this folder", at: at(0) },
    { type: "assistant.delta", taskId: "task-1", text: "I will explore the project layout.", at: at(1) },
    { type: "command.started", taskId: "task-1", id: "c1", command: "ls", cwd: ".", at: at(2) },
    { type: "command.finished", taskId: "task-1", id: "c1", exitCode: 0, at: at(3) },
    { type: "assistant.delta", taskId: "task-1", text: "This is a website project.", at: at(4) },
  ];
  const settled = JSON.parse(JSON.stringify(composerTimelineFromEvents(turn, undefined, "completed")));
  const assistants = settled.filter((item) => item.type === "assistant");
  // The opening sentence is narration, however much it reads like a reply, so
  // it is inside the block and the answer is the only message on the page.
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0].text, "This is a website project.");
  assert.equal(assistants[0].final, true);
  assert.deepEqual(settled.map((item) => item.type), ["user", "activity", "assistant"]);
  assert.equal(settled[1].segments[0].text, "I will explore the project layout.");

  // After tools, live prose streams as the answer from its first token — the
  // same page the settled derivation produces, so the end of the stream moves
  // nothing.
  const midStream = JSON.parse(JSON.stringify(composerTimelineFromEvents(turn, undefined, "running")));
  assert.deepEqual(midStream.map((item) => item.type), ["user", "activity", "assistant"]);
  assert.equal(midStream[2].text, "This is a website project.");
  assert.equal(midStream[2].streaming, true);
  assert.equal(midStream[2].final, true);

  // And a turn that answers without doing any work has an answer, not an
  // opening sentence.
  const direct = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    { type: "user.message", taskId: "task-1", text: "hi", at: at(0) },
    { type: "assistant.delta", taskId: "task-1", text: "Hello.", at: at(1) },
  ], undefined, "completed")));
  assert.equal(direct.at(-1).final, true);

  // An opening sentence with the work still open is inside that work, so there
  // is no assistant message on the page yet at all.
  const working = JSON.parse(JSON.stringify(composerTimelineFromEvents(turn.slice(0, 3), undefined, "running")));
  assert.deepEqual(working.map((item) => item.type), ["user", "activity"]);
  assert.equal(working[1].segments[0].text, "I will explore the project layout.");

  // "Nothing follows" stops at the next user message. A finished answer stays
  // the answer once the conversation moves on — it must not shrink into
  // narration the moment the reader sends the next message.
  const twoTurns = JSON.parse(JSON.stringify(composerTimelineFromEvents([
    ...turn,
    { type: "user.message", taskId: "task-1", text: "and the tests?", at: at(5) },
    { type: "assistant.delta", taskId: "task-1", text: "There are none yet.", at: at(6) },
  ], undefined, "completed")));
  const answers = twoTurns.filter((item) => item.type === "assistant");
  assert.deepEqual(answers.map((item) => item.final), [true, true]);
  assert.equal(answers[0].text, "This is a website project.");
});
