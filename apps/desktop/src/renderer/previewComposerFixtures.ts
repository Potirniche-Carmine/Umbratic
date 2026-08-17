import type { DocumentReviewSnapshot } from "../shared/documentReview";
import {
  buildTextDiff,
  normalizeReviewFile,
  type ReviewFile,
} from "../shared/reviewDiff";
import type {
  AppUpdateStatus,
  BackendUiEvent,
  ChatAttachment,
  ReasoningEffort,
  RepositoryInfo,
  TaskInfo,
} from "../shared/desktopApi";

export function createPreviewComposerFixtures() {
const composerTestParams = new URLSearchParams(window.location.search);
const composerTestRunning = composerTestParams.get("composerTest") === "running";
const composerTestDirectAnswer = composerTestParams.has("directAnswer");
const composerTestWaitingOnly = composerTestParams.has("waitingOnly");
const composerTestEscapedPlan = composerTestParams.has("escapedPlan");
// A conversation that has moved on. The answer to the first question has to
// still read as an answer once the second one is asked.
const composerTestTwoTurns = composerTestParams.has("twoTurns");
const composerTestStage = ["orienting", "working", "answering"].includes(composerTestParams.get("stage") ?? "")
  ? composerTestParams.get("stage") as "orienting" | "working" | "answering"
  : null;
const composerTestParallelWeb = composerTestParams.has("parallelWeb");
const composerTestToolIssue = composerTestParams.has("toolIssue");
const composerTestLiveWork = composerTestParams.has("liveWork");
const composerTestTurnOutcome = ["model_gave_up", "safety_limit"].includes(composerTestParams.get("turnOutcome") ?? "")
  ? composerTestParams.get("turnOutcome") as "model_gave_up" | "safety_limit"
  : null;
const composerTestAttachments: ChatAttachment[] = composerTestDirectAnswer || composerTestWaitingOnly || composerTestEscapedPlan || composerTestParallelWeb ? [] : [
  { path: "apps/desktop/src/renderer/main.tsx", name: "main.tsx", source: "workspace" },
  { path: "apps/desktop/src/renderer/styles.css", name: "styles.css", source: "workspace" },
];
const composerTestPrompt =
  composerTestEscapedPlan
    ? "write me bubble sort algorithm in python and verify that it runs"
    : composerTestDirectAnswer || composerTestWaitingOnly
    ? composerTestWaitingOnly ? "Summarize this conversation." : "Hey, tell me about yourself."
    : 'Make the composer feel fluid using @main.tsx and @styles.css. Keep escaped text safe: `a\\|b`, "<tag>", and {"ok":true}.';
const composerTestVisiblePrompt = composerTestParams.has("reviewFeedback")
  ? `${composerTestPrompt}\n\nPlease address this review feedback:\n\n**apps/desktop/src/renderer/review-panel.tsx · Lines 14-16**\n\n> <h2>Review</h2>\n> <p className="reviewHint">Inspect focused changes before accepting.</p>\n\nKeep this feedback easy to revisit from the conversation.`
  : composerTestPrompt;
const composerTestRepository: RepositoryInfo = {
  id: "preview-umbratic",
  name: "Umbratic",
  rootPath: "/workspace/Umbratic",
  kind: "git",
  originalBranch: "main",
  baseCommit: "preview",
  dirty: false,
  statusSummary: "preview",
};
// The reported shape: a model that writes a full summary, keeps working, writes
// another, keeps working, and only then answers. Three rounds of tools with two
// essays between them — the case that used to render as three separate Working
// summaries with loose paragraphs stranded between them.
const composerTestTourEvents: BackendUiEvent[] = [
  { type: "user.message", taskId: "composer-test", text: "tell me more about this folder", at: new Date(Date.now() - 60_000).toISOString() },
  { type: "assistant.progress.delta", taskId: "composer-test", text: "I'll map the workspace root and read the landing page before describing it.", at: new Date(Date.now() - 58_000).toISOString(), endedAt: new Date(Date.now() - 57_000).toISOString() },
  { type: "command.started", taskId: "composer-test", id: "tour-ls", command: "list directory", cwd: "/workspace/Website", kind: "read", toolKind: "read", commandClass: "read", at: new Date(Date.now() - 56_000).toISOString() },
  { type: "command.finished", taskId: "composer-test", id: "tour-ls", exitCode: 0, at: new Date(Date.now() - 52_000).toISOString() },
  { type: "command.started", taskId: "composer-test", id: "tour-readme", command: "read README.md", cwd: "/workspace/Website", kind: "read", toolKind: "read", commandClass: "read", at: new Date(Date.now() - 51_000).toISOString() },
  { type: "command.finished", taskId: "composer-test", id: "tour-readme", exitCode: 0, at: new Date(Date.now() - 48_000).toISOString() },
  { type: "assistant.delta", taskId: "composer-test", text: "I am starting a tour of the Umbratic Website project, which is a simple static site. I have reviewed the root directory and the main landing page (`index.html`) and found that it uses only HTML and CSS without any build steps.\n\nNext, I will examine the contents of the `brand/` directory to see what visual assets are available.", at: new Date(Date.now() - 44_000).toISOString() },
  { type: "command.started", taskId: "composer-test", id: "tour-brand", command: "list brand/", cwd: "/workspace/Website", kind: "read", toolKind: "read", commandClass: "read", at: new Date(Date.now() - 40_000).toISOString() },
  { type: "command.finished", taskId: "composer-test", id: "tour-brand", exitCode: 0, at: new Date(Date.now() - 36_000).toISOString() },
  { type: "assistant.delta", taskId: "composer-test", text: "The folder is a static website for \"Umbratic AI\". Root files hold the entry point and navigation pages, `assets/` holds the styling, and `brand/` holds the logo icons.\n\nTo provide a complete tour, I will now examine the main informational pages and the `.agents/` directory.", at: new Date(Date.now() - 32_000).toISOString() },
  { type: "command.started", taskId: "composer-test", id: "tour-agents", command: "list .agents/", cwd: "/workspace/Website", kind: "read", toolKind: "read", commandClass: "read", at: new Date(Date.now() - 28_000).toISOString() },
  { type: "command.finished", taskId: "composer-test", id: "tour-agents", exitCode: 0, at: new Date(Date.now() - 24_000).toISOString() },
  { type: "command.started", taskId: "composer-test", id: "tour-how", command: "read how-it-works.html", cwd: "/workspace/Website", kind: "read", toolKind: "read", commandClass: "read", at: new Date(Date.now() - 23_000).toISOString() },
  { type: "command.finished", taskId: "composer-test", id: "tour-how", exitCode: 0, at: new Date(Date.now() - 18_000).toISOString() },
  {
    type: "assistant.delta",
    taskId: "composer-test",
    text: [
      "This folder is a static website project for Umbratic AI, marketing private AI infrastructure for businesses.",
      "",
      "### Project overview",
      "",
      "- **Purpose:** to explain how Umbratic runs confidential, customizable AI inside a company's own environment.",
      "- **Technology:** HTML and CSS only — no build step, framework, or package manager.",
      "",
      "### Organization",
      "",
      "- **Root files:** `index.html` plus the informational pages, and a `README.md` confirming the dependency-free setup.",
      "- **`assets/`:** the stylesheet, client-side JavaScript, and Open Graph images.",
      "- **`brand/`:** logo files and icons used across the site.",
    ].join("\n"),
    at: new Date(Date.now() - 12_000).toISOString(),
  },
  { type: "assistant.done", taskId: "composer-test", at: new Date(Date.now() - 8_000).toISOString() },
];
const composerTestTour = composerTestParams.has("tour");

const composerTestStagePrompt = "add a health check endpoint and make sure it responds";
const composerTestStageEvents: BackendUiEvent[] = composerTestStage ? [
  { type: "user.message", taskId: "composer-test", text: composerTestStagePrompt, at: new Date(Date.now() - 14_000).toISOString() },
  // Orient's sentence, then thinking, then the model's own preamble.
  { type: "assistant.progress.delta", taskId: "composer-test", kind: "thinking", text: "The user wants a health endpoint. Add the route, then call it to prove it answers.", at: new Date(Date.now() - 13_000).toISOString() },
  { type: "assistant.progress.delta", taskId: "composer-test", text: "I'll add the endpoint and then call it to confirm it answers.", at: new Date(Date.now() - 12_000).toISOString() },
  ...(composerTestStage === "orienting" ? [] : [
    { type: "assistant.progress.delta" as const, taskId: "composer-test", text: "Starting with the route file, then a request against the running server.", at: new Date(Date.now() - 9_000).toISOString() },
    { type: "command.started" as const, taskId: "composer-test", id: "stage-edit", command: "write src/routes/health.ts", cwd: "/workspace/Umbratic", kind: "edit" as const, commandClass: "edit" as const, at: new Date(Date.now() - 8_000).toISOString() },
  ]),
  ...(composerTestStage === "answering" ? [
    { type: "command.finished" as const, taskId: "composer-test", id: "stage-edit", exitCode: 0, at: new Date(Date.now() - 6_000).toISOString() },
    { type: "command.started" as const, taskId: "composer-test", id: "stage-curl", command: "curl -s localhost:3000/health", cwd: "/workspace/Umbratic", kind: "bash" as const, commandClass: "network" as const, at: new Date(Date.now() - 5_000).toISOString() },
    { type: "command.output" as const, taskId: "composer-test", id: "stage-curl", stream: "stdout" as const, text: "{\"status\":\"ok\"}\n", at: new Date(Date.now() - 4_000).toISOString() },
    { type: "command.finished" as const, taskId: "composer-test", id: "stage-curl", exitCode: 0, at: new Date(Date.now() - 3_000).toISOString() },
    // No `assistant.done`: the answer is still arriving, which is what puts the
    // caret at the end of it and keeps the actions off it.
    { type: "assistant.delta" as const, taskId: "composer-test", text: "The endpoint is live at `/health` and returns `{\"status\":\"ok\"}`.\n\nIt is registered before the auth middleware, so an uptime check can reach it without a", at: new Date(Date.now() - 1_000).toISOString() },
  ] : []),
] : [];
const composerTestParallelWebPrompt = "What's in the news?";
const composerTestParallelWebEvents: BackendUiEvent[] = [
  { type: "user.message", taskId: "composer-test", text: composerTestParallelWebPrompt, at: new Date(Date.now() - 8_000).toISOString() },
  { type: "assistant.progress.delta", taskId: "composer-test", text: "I'll search and read a few sources.", at: new Date(Date.now() - 6_000).toISOString() },
  { type: "command.started", taskId: "composer-test", id: "web-search-1", command: "web_search latest news", cwd: "/workspace/Umbratic", kind: "read", toolKind: "web_search", commandClass: "network", at: new Date(Date.now() - 5_000).toISOString() },
  { type: "command.started", taskId: "composer-test", id: "web-search-2", command: "web_search headlines", cwd: "/workspace/Umbratic", kind: "read", toolKind: "web_search", commandClass: "network", at: new Date(Date.now() - 5_000).toISOString() },
  { type: "command.started", taskId: "composer-test", id: "web-fetch-1", command: "web_fetch https://www.notizie.it/latest", cwd: "/workspace/Umbratic", kind: "read", toolKind: "web_fetch", commandClass: "network", at: new Date(Date.now() - 4_000).toISOString() },
  { type: "command.started", taskId: "composer-test", id: "web-fetch-2", command: "web_fetch https://www.publicnews.world/today", cwd: "/workspace/Umbratic", kind: "read", toolKind: "web_fetch", commandClass: "network", at: new Date(Date.now() - 4_000).toISOString() },
  { type: "command.started", taskId: "composer-test", id: "web-fetch-3", command: "web_fetch https://www.livemint.com/news", cwd: "/workspace/Umbratic", kind: "read", toolKind: "web_fetch", commandClass: "network", at: new Date(Date.now() - 4_000).toISOString() },
];
const composerTestEvents: BackendUiEvent[] = composerTestTour ? composerTestTourEvents : composerTestStage ? composerTestStageEvents : composerTestParallelWeb ? composerTestParallelWebEvents : composerTestTwoTurns ? [
  { type: "user.message", taskId: "composer-test", text: "hey there", at: new Date(Date.now() - 60_000).toISOString() },
  { type: "assistant.delta", taskId: "composer-test", text: "Hello! How can I help you today? Whether it’s debugging code, analyzing data, drafting documentation, or anything else, feel free to let me know what you need assistance with.", at: new Date(Date.now() - 58_000).toISOString() },
  { type: "user.message", taskId: "composer-test", text: "tell me about C vs C# and the different industries they each apply to", at: new Date(Date.now() - 30_000).toISOString() },
  // No orientation on either turn, because neither is a guided run: a question
  // answered from knowledge never reaches orient's guided branch, so nothing
  // narrates it and no working block opens.
  {
    type: "assistant.delta",
    taskId: "composer-test",
    text: [
      "C and C# are both powerful programming languages, but they were designed with fundamentally different philosophies and target very different domains.",
      "",
      "### 1. Core Philosophy and Design",
      "",
      "**C (The Systems Language)**",
      "",
      "- **Philosophy:** C was designed to be \"portable\" and close to the hardware.",
      "- **Memory Management:** Manual (using `malloc` and `free`).",
      "",
      "**C# (The Managed Language)**",
      "",
      "- **Philosophy:** A modern, object-oriented language that prioritizes developer productivity.",
      "- **Memory Management:** Automatic via garbage collection.",
    ].join("\n"),
    at: new Date(Date.now() - 20_000).toISOString(),
  },
  { type: "assistant.done", taskId: "composer-test", at: new Date().toISOString() },
] : composerTestWaitingOnly ? [
  { type: "user.message", taskId: "composer-test", text: composerTestVisiblePrompt, at: new Date(Date.now() - 8_000).toISOString() },
] : composerTestEscapedPlan ? [
  { type: "user.message", taskId: "composer-test", text: composerTestVisiblePrompt, at: new Date(Date.now() - 11_000).toISOString() },
  // Orientation and other run narration land inside the Working block.
  { type: "assistant.progress.delta", taskId: "composer-test", text: "I’ll write a bubble sort script, save it, then verify it runs correctly with test cases.", at: new Date(Date.now() - 10_500).toISOString(), endedAt: new Date(Date.now() - 10_000).toISOString() },
  { type: "command.started", taskId: "composer-test", id: "write-bubble-sort", command: "write bubble_sort.py", cwd: "/workspace/Umbratic", kind: "edit", commandClass: "edit", at: new Date(Date.now() - 9_000).toISOString() },
  { type: "command.finished", taskId: "composer-test", id: "write-bubble-sort", exitCode: 0, at: new Date(Date.now() - 8_000).toISOString() },
  { type: "command.started", taskId: "composer-test", id: "run-bubble-sort", command: "uv run bubble_sort.py", cwd: "/workspace/Umbratic", kind: "bash", commandClass: "package-manager", at: new Date(Date.now() - 7_000).toISOString() },
  { type: "command.output", taskId: "composer-test", id: "run-bubble-sort", stream: "stdout", text: "5 tests passed\n", at: new Date(Date.now() - 6_000).toISOString() },
  { type: "command.finished", taskId: "composer-test", id: "run-bubble-sort", exitCode: 0, at: new Date(Date.now() - 5_000).toISOString() },
  { type: "assistant.delta", taskId: "composer-test", text: "Done — saved `bubble_sort.py` and verified it with five test cases.", at: new Date(Date.now() - 2_000).toISOString() },
  { type: "assistant.done", taskId: "composer-test", at: new Date().toISOString() },
] : composerTestDirectAnswer ? [
  { type: "user.message", taskId: "composer-test", text: composerTestVisiblePrompt, at: new Date(Date.now() - 8_000).toISOString() },
  { type: "assistant.progress.delta", taskId: "composer-test", text: "I’m using my role and the current conversation to give a concise introduction.", at: new Date(Date.now() - 4_000).toISOString() },
  { type: "assistant.delta", taskId: "composer-test", text: "I’m Umbratic, a private AI assistant that can answer questions and complete practical work.", at: new Date(Date.now() - 1_000).toISOString() },
  { type: "assistant.done", taskId: "composer-test", at: new Date().toISOString() },
] : [
  {
    type: "user.message",
    taskId: "composer-test",
    text: composerTestVisiblePrompt,
    attachedFiles: composerTestAttachments,
    at: new Date(Date.now() - 18_000).toISOString(),
  },
  {
    type: "assistant.progress.delta",
    taskId: "composer-test",
    text: [
      "**Reviewing the composer surface**",
      "",
      "- Check the Markdown rhythm and attachment chips.",
      "- Keep tool calls in chronological order.",
      "- Verify `main.tsx` before composing the answer.",
    ].join("\n"),
    at: new Date(Date.now() - 12_000).toISOString(),
    endedAt: new Date(Date.now() - 8_000).toISOString(),
  },
  {
    type: "skill.loaded",
    taskId: "composer-test",
    sessionId: "session-composer-test",
    runId: "run-composer-test",
    requestId: "skill-req-composer-test",
    skillId: "umbratic-markdown",
    source: "system",
    origin: "harness",
    contentHash: "abcdef0123456789",
    bytes: 128,
  },
  {
    type: "command.started",
    taskId: "composer-test",
    id: "composer-fixture-search",
    command: composerTestToolIssue
      ? "read infrastructure/veil/internal/prompt_skills.go"
      : "read apps/desktop/src/renderer/styles.css",
    cwd: "/workspace/Umbratic",
    kind: "read",
    toolKind: "read",
    commandClass: "read",
  },
  {
    type: "command.output",
    taskId: "composer-test",
    id: "composer-fixture-search",
    stream: "stdout",
    text: composerTestToolIssue
      ? "Path not found: infrastructure/veil/internal/prompt_skills.go.\nNearby workspace entries:\n- infrastructure/veil/internal/prompts/"
      : [
          "Read composer styles",
          "1: .timelineActivity {",
          "2:   display: grid;",
          "3:   gap: 0.5rem;",
          "4:   min-width: 0;",
          "5:   color: var(--text);",
          "6: }",
        ].join("\n"),
  },
  {
    type: "command.finished",
    taskId: "composer-test",
    id: "composer-fixture-search",
    exitCode: composerTestToolIssue ? 1 : 0,
    ...(composerTestToolIssue ? {
      status: "validation_error" as const,
      errorCode: "invalid_arguments" as const,
      errorMessage: "Path not found: infrastructure/veil/internal/prompt_skills.go.",
    } : {}),
  },
  // Mid-plan prose, once a tool has already returned. It arrives as an ordinary
  // delta because the runner cannot know yet whether it is the answer, and the
  // tool below is what settles it as narration — so it joins this same block
  // rather than closing it and starting another.
  {
    type: "assistant.delta",
    taskId: "composer-test",
    text: "The message layout is clear. I will run the focused composer checks next.",
  },
  {
    type: "command.started",
    taskId: "composer-test",
    id: "composer-fixture-test",
    command: "npm --workspace @umbratic/desktop run test:composer",
    cwd: "/workspace/Umbratic",
    kind: "bash",
    commandClass: "package-manager",
  },
  {
    type: "command.output",
    taskId: "composer-test",
    id: "composer-fixture-test",
    stream: "stdout",
    text: "composer text tests passed\n",
  },
  {
    type: "command.finished",
    taskId: "composer-test",
    id: "composer-fixture-test",
    exitCode: 0,
  },
  {
    type: "assistant.progress.delta",
    taskId: "composer-test",
    text: "Work complete",
  },
  {
    type: "assistant.delta",
    taskId: "composer-test",
    text: [
      "## Composer Fixture",
      "",
      "This response is intentionally plain text with a calmer visual rhythm. It checks **bold copy**, *italic copy*, inline `code`, escaped characters like `<tag>`, and a path reference to @main.tsx.",
      "",
      "### Surface Notes",
      "",
      "- Prompt chips should feel soft, not like raised badges.",
      "- Planning should stay compact and secondary.",
      "- Code blocks should arrive smoothly without dominating the page.",
      "",
      "| Check | Render target |",
      "| --- | --- |",
      "| Escaped pipe | A\\|B stays in one cell |",
      "| Inline code | `const value = \"A|B\";` |",
      "",
      "```tsx",
      'const tone = "quiet";',
      'const escaped = "A\\\\|B <safe> & visible";',
      "return <Composer mood={tone} label={escaped} />;",
      "```",
      "",
      "A final paragraph gives the stream a normal ending so spacing after code blocks can be checked against ordinary prose.",
    ].join("\n"),
    at: new Date(Date.now() - 5_000).toISOString(),
  },
];
const composerTestBaseVisibleEvents = composerTestLiveWork
  ? composerTestEvents.filter((event) =>
      event.type !== "assistant.delta"
      && event.type !== "assistant.done"
      && !(event.type === "assistant.progress.delta" && event.text === "Work complete")
    )
  : composerTestEvents;
const composerTestVisibleEvents: BackendUiEvent[] = [
  ...composerTestBaseVisibleEvents,
  ...(composerTestTurnOutcome ? [{
    type: "turn.outcome" as const,
    taskId: "composer-test",
    outcome: composerTestTurnOutcome,
    at: new Date().toISOString(),
  }] : []),
];

const composerTestCodeReviewFiles: ReviewFile[] = [
  {
    path: "apps/desktop/src/features/review/new-panel.ts",
    status: "added",
    patch: [
      "diff --git a/apps/desktop/src/features/review/new-panel.ts b/apps/desktop/src/features/review/new-panel.ts",
      "new file mode 100644",
      "index 0000000..f4a17de",
      "--- /dev/null",
      "+++ b/apps/desktop/src/features/review/new-panel.ts",
      "@@ -0,0 +1,11 @@",
      "+export type ReviewPanelTone = \"calm\" | \"focused\";",
      "+",
      "+export function reviewPanelTitle(fileCount: number) {",
      "+  if (fileCount === 0) return \"No active review\";",
      "+  if (fileCount === 1) return \"1 file ready\";",
      "+  return `${fileCount} files ready`;",
      "+}",
      "+",
      "+export const reviewPanelTone: ReviewPanelTone = \"calm\";",
      "+export const reviewPanelDensity = \"comfortable\";",
      "+",
    ].join("\n"),
  },
  {
    path: "apps/desktop/src/removed/review-banner.ts",
    status: "deleted",
    patch: [
      "diff --git a/apps/desktop/src/removed/review-banner.ts b/apps/desktop/src/removed/review-banner.ts",
      "deleted file mode 100644",
      "index 24c118a..0000000",
      "--- a/apps/desktop/src/removed/review-banner.ts",
      "+++ /dev/null",
      "@@ -1,9 +0,0 @@",
      "-export function reviewBanner() {",
      "-  return {",
      "-    tone: \"warning\",",
      "-    label: \"Pending patch\",",
      "-    showRawMarkers: true,",
      "-  };",
      "-}",
      "-",
      "-export const reviewBannerVersion = 1;",
    ].join("\n"),
  },
  {
    path: "apps/desktop/src/renderer/review-panel.tsx",
    status: "modified",
    patch: [
      "diff --git a/apps/desktop/src/renderer/review-panel.tsx b/apps/desktop/src/renderer/review-panel.tsx",
      "index 9ac21d0..b7f53ce 100644",
      "--- a/apps/desktop/src/renderer/review-panel.tsx",
      "+++ b/apps/desktop/src/renderer/review-panel.tsx",
      "@@ -12,13 +12,16 @@ export function ReviewPanel({ files }: ReviewPanelProps) {",
      "   return (",
      "     <section className=\"reviewPanel\">",
      "-      <h2>Patch review</h2>",
      "-      <p className=\"reviewHint\">Inspect the raw diff below.</p>",
      "+      <h2>Review</h2>",
      "+      <p className=\"reviewHint\">Inspect focused changes before accepting.</p>",
      "       <div className=\"reviewFiles\">",
      "         {files.map((file) => (",
      "-          <RawDiff key={file.path} file={file} />",
      "+          <ReviewFileCard key={file.path} file={file} />",
      "         ))}",
      "       </div>",
      "+      <ReviewActions compact />",
      "     </section>",
      "   );",
      " }",
    ].join("\n"),
  },
].map((file) => normalizeReviewFile(file as { path: string; status: ReviewFile["status"]; patch: string }));

const composerTestDocumentPath = ".umbratic/artifacts/docx/narrative-proposal.docx";
const composerTestDocumentPreview: DocumentReviewSnapshot = {
  documentPath: composerTestDocumentPath,
  title: "Narrative Proposal",
  blocks: [
    { id: "title", style: "title", text: "Narrative Proposal" },
    { id: "subtitle", style: "subtitle", text: "A calmer document review workflow" },
    {
      id: "overview",
      style: "heading1",
      text: "Executive overview",
    },
    {
      id: "opening",
      style: "paragraph",
      text: "Umbratic keeps document review close to the conversation. Reviewers can select one sentence or an entire paragraph without opening another application.",
    },
    {
      id: "workflow",
      style: "paragraph",
      text: "Selected feedback is attached to the next prompt with the relevant excerpt. The document remains the source of truth while the review experience stays focused.",
    },
    { id: "benefit-one", style: "bullet", text: "Keep feedback specific and easy to revisit." },
    { id: "benefit-two", style: "bullet", text: "Use the same interaction pattern as code review." },
    {
      id: "close",
      style: "quote",
      text: "The result is a lightweight review loop that feels native to the composer.",
    },
  ],
};
const composerTestDocumentFile = normalizeReviewFile({
  path: composerTestDocumentPath,
  status: "binary",
  patch: [
    `diff --git a/${composerTestDocumentPath} b/${composerTestDocumentPath}`,
    "new file mode 100644",
    `Binary files /dev/null and b/${composerTestDocumentPath} differ`,
  ].join("\n"),
});
// `?perfDiff` adds a synthetic multi-thousand-line change so the review panel
// can be exercised (and profiled) against a file the size of real refactors.
function composerTestPerfDiffFile(): ReviewFile {
  const before: string[] = [];
  for (let index = 0; index < 4_200; index += 1) {
    before.push(
      index % 8 === 0
        ? `export function previewCase${index}(input: PreviewInput): PreviewResult {`
        : index % 8 === 7
          ? "}"
          : `  const derived${index} = refine(input.rows[${index % 37}], ${index});`,
    );
  }
  const after = [...before];
  for (let index = 12; index < after.length; index += 24) {
    after[index] = after[index].replace("refine(", "refineWithPolicy(");
  }
  after.splice(1_400, 0, ...Array.from({ length: 80 }, (_, index) => `  const injected${index} = audit(rows[${index}]);`));
  after.splice(600, 40);
  const file = buildTextDiff("apps/desktop/src/renderer/perf-fixture.ts", `${before.join("\n")}\n`, `${after.join("\n")}\n`);
  if (!file) throw new Error("perf fixture produced no diff");
  return file;
}

const composerTestReviewFiles: ReviewFile[] = [
  ...(composerTestParams.has("documents") ? [composerTestDocumentFile] : []),
  ...(composerTestParams.has("perfDiff") ? [composerTestPerfDiffFile()] : []),
  ...composerTestCodeReviewFiles,
];

const composerTestWholeDiffFiles: ReviewFile[] = [
  ...composerTestReviewFiles,
  normalizeReviewFile({
    path: "apps/desktop/.env.example",
    status: "modified",
    patch: [
      "diff --git a/apps/desktop/.env.example b/apps/desktop/.env.example",
      "index 711bd13..fc94e20 100644",
      "--- a/apps/desktop/.env.example",
      "+++ b/apps/desktop/.env.example",
      "@@ -2,2 +2,3 @@",
      " UMBRATIC_LOG_LEVEL=info",
      "+UMBRATIC_PREVIEW_PORT=5173",
      " UMBRATIC_TELEMETRY=off",
    ].join("\n"),
  }),
];

const composerTestTask: TaskInfo = {
  id: "composer-test",
  chatId: "composer-test-chat",
  repositoryId: composerTestRepository.id,
  prompt: composerTestTour ? "tell me more about this folder" : composerTestStage ? composerTestStagePrompt : composerTestParallelWeb ? composerTestParallelWebPrompt : composerTestVisiblePrompt,
  workspaceKind: "git",
  workspaceMode: "local",
  // A frozen stage is a run in flight, so it carries the running state that
  // drives the live block, the caret, and the withheld message actions.
  state: composerTestTurnOutcome ? "failed" : composerTestRunning || composerTestStage || composerTestWaitingOnly || composerTestParallelWeb ? "running" : "review_ready",
  originalBranch: "main",
  baseCommit: "preview",
  agentBranch: "preview",
  worktreePath: composerTestRepository.rootPath,
  permissionMode: "normal",
  createdAt: new Date(Date.now() - 20_000).toISOString(),
  changedFiles: composerTestReviewFiles.map((file) => file.path),
  reviewFiles: composerTestReviewFiles,
  reviewScope: "task",
  reviewBaselineLabel: "Turn changes",
  reviewBaselineOid: "task start",
  events: composerTestEvents,
};

/**
 * The model the preview says is answering: the catalog's reasoning model, so
 * the composer's effort dial is on screen here as it is in the app.
 */
const previewChatModel = {
  providerId: "company-endpoint" as const,
  providerName: "Local Veil",
  modelId: "qwen38-27b",
  displayName: "Qwen3.8 27B",
  baseUrl: "http://127.0.0.1:8080",
  contextLength: 262_144,
  capabilities: {
    parallelToolCalls: true,
    vision: false,
    reasoning: true,
    reasoningEfforts: ["off", "low", "medium", "high"] as ReasoningEffort[],
  },
};

const previewUpdateStatus: AppUpdateStatus = {
  installedVersion: "0.0.0-preview",
  automatic: true,
  checkedAt: null,
  state: { phase: "unsupported" },
};

  return {
    composerTestParams,
    composerTestAttachments,
    composerTestPrompt,
    composerTestRepository,
    composerTestVisibleEvents,
    composerTestDocumentPath,
    composerTestDocumentPreview,
    composerTestReviewFiles,
    composerTestWholeDiffFiles,
    composerTestTask,
    previewChatModel,
    previewUpdateStatus,
  };
}
