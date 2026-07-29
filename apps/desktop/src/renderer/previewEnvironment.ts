import {
  DEFAULT_CONTEXT_LENGTH,
  normalizeContextLength,
} from "../shared/contextWindow";
import type { DocumentReviewSnapshot } from "../shared/documentReview";
import {
  normalizeReviewFile,
  type ReviewFile,
} from "../shared/reviewDiff";
import type {
  BackendUiEvent,
  CapabilityProbeReport,
  CapabilityProbeResult,
  ChatAttachment,
  ChatRecord,
  CompanyConnectionStatus,
  DesktopApi,
  HarnessProfileId,
  IdeInfo,
  ModelEndpointMode,
  ModelEndpointSoftware,
  PermissionMode,
  PublicModelEndpointSettings,
  RepositoryInfo,
  SkillInfo,
  TaskInfo,
  UserNotes,
} from "../shared/desktopApi";

export type PreviewEnvironment = {
  api: DesktopApi;
  attachments: ChatAttachment[];
  events: BackendUiEvent[];
  params: URLSearchParams;
  prompt: string;
  repository: RepositoryInfo;
  reviewFiles: ReviewFile[];
  task: TaskInfo;
};

import {
  defaultHarnessProfileId,
  defaultIdeChoices,
  getPreviewPermissionMode,
  harnessSystemSkillIds,
  isHarnessProfileId,
  normalizeAttachment,
  normalizeEndpointSettings,
  publicPreviewEndpointSettings,
  readPreviewChats,
  readPreviewContextLength,
  readPreviewEndpointSettings,
  readPreviewHarnessProfile,
  readPreviewNotes,
  readPreviewProjects,
  setPreviewPermissionMode,
  writePreviewChats,
  writePreviewContextLength,
  writePreviewEndpointSettings,
  writePreviewHarnessProfile,
  writePreviewNotes,
  writePreviewProjects,
} from "./previewSupport";

export function createPreviewEnvironment() {
const composerTestParams = new URLSearchParams(window.location.search);
const composerTestRunning = composerTestParams.get("composerTest") === "running";
const composerTestDirectAnswer = composerTestParams.has("directAnswer");
const composerTestWaitingOnly = composerTestParams.has("waitingOnly");
const composerTestEscapedPlan = composerTestParams.has("escapedPlan");
const composerTestToolIssue = composerTestParams.has("toolIssue");
const composerTestAttachments: ChatAttachment[] = composerTestDirectAnswer || composerTestWaitingOnly || composerTestEscapedPlan ? [] : [
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
const composerTestEvents: BackendUiEvent[] = composerTestWaitingOnly ? [
  { type: "user.message", taskId: "composer-test", text: composerTestVisiblePrompt, at: new Date(Date.now() - 8_000).toISOString() },
] : composerTestEscapedPlan ? [
  { type: "user.message", taskId: "composer-test", text: composerTestVisiblePrompt, at: new Date(Date.now() - 11_000).toISOString() },
  { type: "assistant.delta", taskId: "composer-test", text: "I’ll write a bubble sort script, save it, then verify it runs correctly with test cases.", at: new Date(Date.now() - 10_000).toISOString() },
  { type: "command.started", taskId: "composer-test", id: "write-bubble-sort", command: "write bubble_sort.py", cwd: "/workspace/Umbratic", kind: "edit", commandClass: "edit", at: new Date(Date.now() - 9_000).toISOString() },
  { type: "command.finished", taskId: "composer-test", id: "write-bubble-sort", exitCode: 0, at: new Date(Date.now() - 8_000).toISOString() },
  { type: "command.started", taskId: "composer-test", id: "run-bubble-sort", command: "uv run bubble_sort.py", cwd: "/workspace/Umbratic", kind: "bash", commandClass: "package-manager", at: new Date(Date.now() - 7_000).toISOString() },
  { type: "command.output", taskId: "composer-test", id: "run-bubble-sort", stream: "stdout", text: "5 tests passed\n", at: new Date(Date.now() - 6_000).toISOString() },
  { type: "command.finished", taskId: "composer-test", id: "run-bubble-sort", exitCode: 0, at: new Date(Date.now() - 5_000).toISOString() },
  { type: "assistant.delta", taskId: "composer-test", text: "Done — saved `bubble_sort.py` and verified it with five test cases.", at: new Date(Date.now() - 2_000).toISOString() },
  { type: "assistant.done", taskId: "composer-test", at: new Date().toISOString() },
] : composerTestDirectAnswer ? [
  { type: "user.message", taskId: "composer-test", text: composerTestVisiblePrompt, at: new Date(Date.now() - 8_000).toISOString() },
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
    text: "Checking message scale, markdown rhythm, escaped pipes, and attachment chips before composing the answer.",
    at: new Date(Date.now() - 12_000).toISOString(),
    endedAt: new Date(Date.now() - 8_000).toISOString(),
  },
  {
    type: "command.started",
    taskId: "composer-test",
    id: "composer-fixture-search",
    command: "read apps/desktop/src/renderer/styles.css",
    cwd: "/workspace/Umbratic",
    kind: "read",
    commandClass: "read",
  },
  {
    type: "command.output",
    taskId: "composer-test",
    id: "composer-fixture-search",
    stream: "stdout",
    text: [
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
  schemaVersion: 1,
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
const composerTestReviewFiles: ReviewFile[] = composerTestParams.has("documents")
  ? [composerTestDocumentFile, ...composerTestCodeReviewFiles]
  : composerTestCodeReviewFiles;

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
  prompt: composerTestVisiblePrompt,
  workspaceKind: "git",
  workspaceMode: "local",
  state: composerTestRunning ? "running" : "review_ready",
  originalBranch: "main",
  baseCommit: "preview",
  agentBranch: "preview",
  worktreePath: composerTestRepository.rootPath,
  permissionMode: "normal",
  reasoningMode: "reasoning",
  createdAt: new Date(Date.now() - 20_000).toISOString(),
  changedFiles: composerTestReviewFiles.map((file) => file.path),
  reviewFiles: composerTestReviewFiles,
  reviewScope: "task",
  reviewBaselineLabel: "Turn changes",
  reviewBaselineOid: "task start",
  events: composerTestEvents,
};

function previewCapabilityReport(): CapabilityProbeReport {
  const checkedAt = new Date().toISOString();
  const probes: CapabilityProbeResult[] = [
    {
      id: "node-runtime",
      label: "Node runtime",
      category: "required",
      importance: "required",
      status: "available",
      version: "browser preview",
      purpose: "Runs the desktop and local harness code.",
      installHint: "Open the Electron app for real runtime probes.",
      workflows: ["desktop", "runner"],
      checkedAt,
    },
    {
      id: "runner-binary",
      label: "Umbratic runner",
      category: "required",
      importance: "required",
      status: "missing",
      purpose: "Starts local workspace tools for read, search, write, edit, and command execution.",
      installHint: "Open the Electron app to check the runner bundle.",
      workflows: ["runner", "workspace tools"],
      checkedAt,
      message: "Electron preload is not available in browser preview.",
    },
    {
      id: "rg",
      label: "ripgrep",
      category: "recommended",
      importance: "recommended",
      status: "unknown",
      purpose: "Fast text search in workspaces.",
      installHint: "Open the Electron app to run local command probes.",
      workflows: ["workspace search"],
      checkedAt,
    },
    {
      id: "uv",
      label: "uv",
      category: "recommended",
      importance: "recommended",
      status: "unknown",
      purpose: "Creates repeatable Python environments.",
      installHint: "Open the Electron app to run local command probes.",
      workflows: ["Python", "artifacts"],
      checkedAt,
    },
    {
      id: "pdftoppm",
      label: "Poppler pdftoppm",
      category: "optional-artifacts",
      importance: "optional",
      status: "unknown",
      purpose: "Renders PDF pages to images for visual QA.",
      installHint: "Open the Electron app to run local command probes.",
      workflows: ["PDF artifact", "visual QA"],
      checkedAt,
    },
    {
      id: "tesseract",
      label: "Tesseract OCR",
      category: "optional-artifacts",
      importance: "optional",
      status: "unknown",
      purpose: "Runs local OCR for image and scanned-PDF attachment digests.",
      installHint: "Open the Electron app to run local command probes.",
      workflows: ["OCR artifact", "image attachment", "scanned PDF"],
      checkedAt,
    },
  ];
  const summary = probes.reduce<CapabilityProbeReport["summary"]>(
    (total, probe) => {
      total[probe.status] += 1;
      if (probe.status !== "available") {
        if (probe.importance === "required") total.requiredMissing += 1;
        if (probe.importance === "recommended") total.recommendedMissing += 1;
        if (probe.importance === "optional") total.optionalMissing += 1;
      }
      return total;
    },
    { available: 0, missing: 0, error: 0, unknown: 0, requiredMissing: 0, recommendedMissing: 0, optionalMissing: 0 },
  );
  return { checkedAt, probes, summary };
}

const previewDefaultSkills: SkillInfo[] = [
  {
    id: "umbratic-skill-creator",
    name: "Skill Creator",
    description: "Use to create, revise, structure, and validate reusable Umbratic personal skills and their bundled resources.",
    enabled: true,
    source: "system",
    readOnly: false,
  },
  {
    id: "umbratic-git-worktree",
    name: "Git Worktree",
    description: "Use for Git worktree isolation, branch/base awareness, review diffs, merge safety, and Umbratic task worktree behavior.",
    enabled: true,
    source: "system",
    readOnly: false,
  },
  {
    id: "umbratic-markdown",
    name: "Markdown",
    description: "Use for Markdown structure, readable formatting, tables, docs, and plain-text artifact source.",
    enabled: true,
    source: "system",
    readOnly: false,
  },
  {
    id: "umbratic-python",
    name: "Python",
    description: "Use for Python scripts, packages, tests, virtual environments, dependency setup, and Python-based verification.",
    enabled: true,
    source: "system",
    readOnly: false,
  },
  {
    id: "umbratic-data-analysis",
    name: "Data Analysis",
    description: "Use for source-grounded analysis with pandas, data cleaning, validation, summaries, charts, and reproducible outputs.",
    enabled: true,
    source: "system",
    readOnly: false,
  },
  {
    id: "umbratic-pdf",
    name: "PDF & OCR",
    description: "Use for PDF reading, page-aware review, polished PDF artifacts, and OCR of images or scanned documents.",
    enabled: true,
    source: "system",
    readOnly: false,
  },
  {
    id: "umbratic-presentations",
    name: "Presentations",
    description: "Use for PowerPoint/PPTX outlines, slide copy, speaker notes, proposals, and customer-facing decks.",
    enabled: true,
    source: "system",
    readOnly: false,
  },
  {
    id: "umbratic-documents",
    name: "Documents",
    description: "Use for DOCX/Word drafts, redlines, memos, proposals, and rendered document QA.",
    enabled: true,
    source: "system",
    readOnly: false,
  },
  {
    id: "umbratic-spreadsheets",
    name: "Spreadsheets",
    description: "Use for XLSX/Excel workbooks, spreadsheet-ready tables, formulas, forecasts, and chart specs.",
    enabled: true,
    source: "system",
    readOnly: false,
  },
];
let previewSkills = previewDefaultSkills.map((skill) => ({
  ...skill,
  enabled: harnessSystemSkillIds[readPreviewHarnessProfile()].has(skill.id),
}));

const previewDefaultSkillGuidance: Record<string, string[]> = {
  "umbratic-skill-creator": [
    "Capture the intended triggers, workflow, outputs, and success criteria before drafting a skill.",
    "Keep SKILL.md concise, put detailed material in explicitly referenced resources, and validate the finished folder before handoff.",
    "Draft personal skills in the current workspace, then explain how to import and enable them from Umbratic's Skills settings.",
  ],
  "umbratic-git-worktree": [
    "Use the current worktree path as authoritative when an engineering run is isolated.",
    "Keep original branch, task branch, and base commit distinct when explaining Git state.",
    "Inspect status and diffs with non-destructive Git commands before summarizing or changing branch state.",
  ],
  "umbratic-markdown": [
    "Use clean Markdown when the user asks for docs, README content, tables, briefs, or paste-ready formatted text.",
    "Prefer simple headings, short paragraphs, bullets, and tables only when they improve scanning.",
    "Inspect nearby docs and config before using repository-local Markdown tooling.",
  ],
  "umbratic-python": [
    "Keep Python work inside the current workspace and prefer a workspace `.venv`.",
    "Prefer `uv` when available. Bare Python commands are allowed; if one fails because of the interpreter, environment, or dependencies, retry it through `uv run`.",
    "State runtime or dependency gaps when they affect verification.",
  ],
  "umbratic-data-analysis": [
    "Inspect columns, types, missing values, duplicates, ranges, and category cardinality before drawing conclusions.",
    "Use reproducible pandas scripts for cleaning, joins, aggregations, statistics, and chart-ready tables.",
    "Keep source data unchanged, label assumptions, and save derived outputs separately with validation checks.",
  ],
  "umbratic-pdf": [
    "Use local PDFs as page-aware source material; use extraction for text checks and rendered pages for layout fidelity.",
    "Use local OCR digests for images and scanned PDFs, preserving page locations, confidence warnings, and uncertain text.",
    "Generate PDFs with the configured Python artifact runtime and keep final files under `.umbratic/artifacts/pdf/` unless directed otherwise.",
    "Render with Poppler and inspect pages before claiming visual QA; state extraction, generation, or render gaps plainly.",
  ],
  "umbratic-presentations": [
    "Use this default for local PowerPoint/PPTX work only; do not route to Google Slides workflows from this guidance.",
    "Define audience, narrative, slide sequence, visual system, and speaker notes while keeping slide copy concise.",
    "Export or render with LibreOffice and inspect every slide before claiming visual QA; state PPTX runtime or export gaps plainly.",
  ],
  "umbratic-documents": [
    "Use this default for local DOCX/Word work only; do not route to Google Docs workflows from this guidance.",
    "Create documents with explicit styles, numbering, margins, table geometry, headers, footers, and stable page behavior.",
    "Render or export with LibreOffice and inspect every page before claiming visual QA; state DOCX runtime or render gaps plainly.",
  ],
  "umbratic-spreadsheets": [
    "Produce stable columns, short cell values, explicit formulas, and clear assumptions.",
    "Separate provided values, derived values, assumptions, and formulas.",
    "Provide paste-ready tables when an XLSX runtime is unavailable.",
  ],
};

function previewSkillContent(skill: SkillInfo): string {
  const guidance = previewDefaultSkillGuidance[skill.id] ?? [skill.description];
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n# ${skill.name}\n\n${guidance.map((line) => `- ${line}`).join("\n")}\n`;
}

function createPreviewApi(): DesktopApi {
  let previewCompanyConnection: CompanyConnectionStatus = { state: "not_enrolled" };
  const previewApi: DesktopApi = {
  listProjects: async () => readPreviewProjects(),
  listChats: async () => readPreviewChats(),
  createChat: async (input) => {
    const now = new Date().toISOString();
    const chat: ChatRecord = {
      id: input?.id ?? `preview-${Date.now().toString(36)}`,
      title: input?.title?.trim() || "New chat",
      createdAt: now,
      updatedAt: now,
      modelEndpointMode: readPreviewEndpointSettings().mode,
      repositoryName: input?.repositoryName,
      repositoryPath: input?.repositoryPath,
      draftPrompt: "",
      attachedFiles: [],
    };
    writePreviewChats([chat, ...readPreviewChats().filter((row) => row.id !== chat.id)]);
    return chat;
  },
  updateChatDraft: async (input) => {
    const chats = readPreviewChats();
    const existing = chats.find((chat) => chat.id === input.chatId);
    if (!existing) throw new Error("Chat was not found.");
    const next = {
      ...existing,
      draftPrompt: input.draftPrompt,
      attachedFiles: input.attachedFiles.map(normalizeAttachment),
      updatedAt: new Date().toISOString(),
    };
    writePreviewChats([next, ...chats.filter((chat) => chat.id !== input.chatId)]);
    return next;
  },
  updateChatProject: async (input) => {
    const chats = readPreviewChats();
    const existing = chats.find((chat) => chat.id === input.chatId);
    if (!existing) throw new Error("Chat was not found.");
    const next = {
      ...existing,
      repositoryName: input.repositoryName,
      repositoryPath: input.repositoryPath,
    };
    writePreviewChats([next, ...chats.filter((chat) => chat.id !== input.chatId)]);
    return next;
  },
  deleteChat: async (input) => {
    writePreviewChats(readPreviewChats().filter((chat) => chat.id !== input.chatId));
    return { ok: true };
  },
  deleteProjectChats: async (input) => {
    const project = readPreviewProjects().find((row) => row.id === input.projectId);
    const repositoryPath = project?.rootPath;
    const deletedChatIds = readPreviewChats()
      .filter((chat) => repositoryPath && chat.repositoryPath === repositoryPath)
      .map((chat) => chat.id);
    if (repositoryPath) {
      writePreviewChats(readPreviewChats().filter((chat) => chat.repositoryPath !== repositoryPath));
    }
    return { ok: true, deletedChatIds };
  },
  deleteProject: async (input) => {
    const project = readPreviewProjects().find((row) => row.id === input.projectId);
    const repositoryPath = project?.rootPath;
    const deletedChatIds = readPreviewChats()
      .filter((chat) => repositoryPath && chat.repositoryPath === repositoryPath)
      .map((chat) => chat.id);
    if (repositoryPath) {
      writePreviewChats(readPreviewChats().filter((chat) => chat.repositoryPath !== repositoryPath));
      writePreviewProjects(readPreviewProjects().filter((row) => row.rootPath !== repositoryPath));
    }
    return { ok: true, deletedChatIds };
  },
  getNotes: async () => readPreviewNotes(),
  updateNotes: async (input) => writePreviewNotes(input.content),
  getTask: async () => null,
  listTaskCheckpoints: async () => ({
    supported: true,
    changedFileCount: composerTestReviewFiles.length,
    checkpoints: [],
  }),
  createTaskCheckpoint: async () => ({
    id: "preview-checkpoint",
    source: "manual",
    createdAt: new Date().toISOString(),
    state: "ready",
    pinned: false,
  }),
  setTaskCheckpointPinned: async (input) => ({
    id: input.checkpointId,
    source: "manual",
    createdAt: new Date().toISOString(),
    state: "ready",
    pinned: input.pinned,
  }),
  deleteTaskCheckpoint: async () => undefined,
  forkTaskCheckpoint: async () => composerTestTask,
  restoreTaskCheckpoint: async () => composerTestTask,
  refreshTaskReview: async (input) => {
    const scope = input.scope === "worktree" ? "worktree" : "task";
    const reviewFiles = scope === "worktree" ? composerTestWholeDiffFiles : composerTestReviewFiles;
    return {
      ...composerTestTask,
      changedFiles: reviewFiles.map((file) => file.path),
      reviewFiles,
      reviewScope: scope,
      reviewBaselineLabel: scope === "worktree" ? "Whole diff" : "Turn changes",
      reviewBaselineOid: scope === "worktree" ? "HEAD" : "task start",
    };
  },
  refreshWorkspaceReview: async () => ({ reviewFiles: composerTestWholeDiffFiles, baselineOid: "HEAD" }),
  readDocumentReview: async (input) => input.documentPath === composerTestDocumentPath
    ? { ok: true, preview: composerTestDocumentPreview }
    : { ok: false, code: "not_available", message: "This document does not include a review preview." },
  searchFiles: async (input) =>
    [
      { path: "apps/desktop/src/renderer/main.tsx", name: "main.tsx", match: "path" as const },
      { path: "apps/desktop/src/renderer/styles.css", name: "styles.css", match: "path" as const },
      { path: "apps/desktop/src/main/main.ts", name: "main.ts", match: "content" as const },
    ].filter((file) => file.path.toLowerCase().includes(input.query.toLowerCase())),
  pickRepository: async () => {
    const repository = {
      id: "preview-umbratic",
      name: "Umbratic",
      rootPath: "/workspace/Umbratic",
      kind: "folder",
      originalBranch: "folder",
      baseCommit: "preview",
      dirty: false,
      statusSummary: "preview",
    } satisfies RepositoryInfo;
    writePreviewProjects([repository, ...readPreviewProjects().filter((project) => project.id !== repository.id)]);
    return {
      canceled: false,
      repository,
    };
  },
  pickAttachmentFiles: async () => ({
    canceled: false,
    files: [{ path: "apps/desktop/src/renderer/main.tsx", name: "main.tsx", source: "workspace" }],
  }),
  savePastedAttachments: async (input) => ({
    files: input.files.map((file, index) =>
      normalizeAttachment({
        path: `attachments/preview-${index}-${file.name || "pasted-file"}`,
        name: file.name || "pasted-file",
        source: "chat",
        originalPath: "clipboard",
        previewDataUrl: file.dataUrl.startsWith("data:image/") ? file.dataUrl : undefined,
      }),
    ),
  }),
  openChatAttachment: async () => ({ ok: false, message: "Electron preload is not available." }),
  getRepository: async (input) =>
    input.repositoryPath
      ? {
          id: `preview-${input.repositoryPath}`,
          name: input.repositoryPath.split(/[\\/]/).filter(Boolean).pop() || input.repositoryPath,
          rootPath: input.repositoryPath,
          kind: "folder",
          originalBranch: "folder",
          baseCommit: "preview",
          dirty: false,
          statusSummary: "preview",
        }
      : null,
  listRepositoryBranches: async () => ({ ok: true, current: "main", branches: ["main", "develop"] }),
  checkoutRepositoryBranch: async () => ({ ok: false, message: "Open the Electron app to switch branches." }),
  getBackendStatus: async () => ({
    runner: "unavailable",
    endpoint: "unavailable",
    model: null,
    models: [],
    providers: [],
    permissionMode: getPreviewPermissionMode(),
    endpointConfig: {
      source: "local-default",
      endpointEditingAllowed: true,
    },
    privacy: {
      share: "disabled",
      enabledProviders: [],
      webTools: "disabled",
    },
    diagnostics: {
      runnerName: "UmbraticRunner",
      runnerVersion: "package-adapter-1",
      runnerContractVersion: "umbratic-runner-1",
      policyVersion: "umbratic-enterprise-mvp-1",
      runnerBinary: "missing",
      configAssertions: "enabled",
      providerAllowlist: ["company-endpoint"],
      localhostOnlyModels: false,
      commandClassifier: "enabled",
      runnerDiagnosticsDirectory: "Umbratic/logs/runner",
      localLogs: { bytes: 0, entries: 0 },
      telemetry: {
        mode: readPreviewEndpointSettings().mode === "local" ? "managed_disabled" : "managed_required",
        localEnabled: false,
        syncEnabled: readPreviewEndpointSettings().mode === "server",
        retentionDays: readPreviewEndpointSettings().mode === "server" ? 30 : 0,
        exportFormat: "redacted-json",
        storage: readPreviewEndpointSettings().mode === "server" ? "company-managed-telemetry" : "task-event-snapshots",
      },
      runtimes: {
        python: {
          runtimeVersion: "python-uv-venv-1",
          barePythonVerification: "allowed_uv_preferred",
          generatedPaths: [".venv", "__pycache__", ".pyc", ".umbratic/runtime"],
        },
        markdown: { docsOnlyClassification: "enabled" },
        cmake: { runtimeVersion: "cmake-umbratic-build-1", buildDir: ".umbratic/build" },
        toolchain: {
          bundledHelperCommands: ["rg", "fd/fdfind", "tree-sitter", "bat/batcat"],
          optionalCapabilityCommands: ["jq", "yq", "cmake", "compiler", "build backend"],
        },
        shell: { platform: navigator.platform, preferred: "posix", nonInteractive: true },
      },
      capabilities: previewCapabilityReport(),
    },
    message: "Electron preload is not available in this browser preview.",
  }),
  getStartupSettings: async () => ({
    permissionMode: getPreviewPermissionMode(),
    modelEndpoint: readPreviewEndpointSettings(),
    companyConnection: previewCompanyConnection,
    harnessProfile: readPreviewHarnessProfile(),
    contextLength: readPreviewContextLength(),
  }),
  getCapabilityProbes: async () => previewCapabilityReport(),
  getHarnessProfile: async () => readPreviewHarnessProfile(),
  saveHarnessProfile: async (input) => {
    const settings = isHarnessProfileId(input) ? input : defaultHarnessProfileId;
    writePreviewHarnessProfile(settings);
    previewSkills = previewSkills.map((skill) => ({ ...skill, enabled: harnessSystemSkillIds[settings].has(skill.id) }));
    return { settings, status: await previewApi.getBackendStatus() };
  },
  getContextLength: async () => readPreviewContextLength(),
  saveContextLength: async (input) => {
    const contextLength = normalizeContextLength(input);
    writePreviewContextLength(contextLength);
    return { contextLength, status: await previewApi.getBackendStatus() };
  },
  getModelEndpointSettings: async () => readPreviewEndpointSettings(),
  probeLocalModels: async () => ({ status: "ready", models: ["llama3.2", "qwen3:8b"] }),
  saveModelEndpointSettings: async (input) => {
    const settings = publicPreviewEndpointSettings(normalizeEndpointSettings(input));
    writePreviewEndpointSettings(settings);
    return { settings, status: await previewApi.getBackendStatus() };
  },
  getCompanyConnectionStatus: async () => previewCompanyConnection,
  enrollCompanyConnection: async (input) => {
    const settings = publicPreviewEndpointSettings(normalizeEndpointSettings({
      ...readPreviewEndpointSettings(),
      mode: "server",
      software: "vllm",
      baseUrl: input.baseUrl,
      modelId: "veil-managed",
      secret: "",
    }));
    writePreviewEndpointSettings(settings);
    previewCompanyConnection = {
      state: "enrolled",
      baseUrl: input.baseUrl,
      orgName: "Preview organization",
      deviceLabel: "Preview device",
    };
    return { connection: previewCompanyConnection, settings, status: await previewApi.getBackendStatus() };
  },
  disconnectCompanyConnection: async () => {
    previewCompanyConnection = { state: "not_enrolled" };
    return {
      connection: previewCompanyConnection,
      settings: readPreviewEndpointSettings(),
      status: await previewApi.getBackendStatus(),
    };
  },
  exportTelemetry: async () => ({ ok: false, message: "Electron preload is not available." }),
  exportLocalDiagnostics: async () => ({ ok: false, message: "Electron preload is not available." }),
  clearLocalDiagnostics: async () => ({ bytes: 0, entries: 0 }),
  recordProductEvent: async () => undefined,
  listSkills: async () => ({ skills: previewSkills, directory: "~/.umbratic/skills" }),
  saveSkillSettings: async (input) => {
    previewSkills = previewSkills.map((skill) => ({ ...skill, enabled: input[skill.id] ?? skill.enabled }));
    return { skills: previewSkills, directory: "~/.umbratic/skills" };
  },
  openSkillsFolder: async () => ({ ok: false, message: "Electron preload is not available." }),
  openRunnerDiagnosticsFolder: async () => ({ ok: false, message: "Electron preload is not available." }),
  openSkillInEditor: async () => ({ ok: false, message: "Electron preload is not available." }),
  importSkill: async () => ({ ok: false, message: "Electron preload is not available." }),
  createSkill: async () => ({ ok: false, message: "Electron preload is not available." }),
  getSkillDocument: async (input) => {
    const skill = previewSkills.find((row) => row.id === input.id);
    return skill
      ? { ok: true, skill: { ...skill, path: `~/.umbratic/skills/${skill.id}.md`, content: previewSkillContent(skill) }, directory: "~/.umbratic/skills" }
      : { ok: false, message: "Electron preload is not available." };
  },
  saveSkillDocument: async () => ({ ok: false, message: "Electron preload is not available." }),
  resetSystemSkill: async () => ({ ok: false, message: "Electron preload is not available." }),
  setPermissionMode: async (mode) => {
    setPreviewPermissionMode(mode);
    return getPreviewPermissionMode();
  },
  listAvailableIdes: async () => defaultIdeChoices,
  startTask: async () => {
    throw new Error("Open the Electron app to run a task.");
  },
  approveWorktreeCreation: async () => undefined,
  respondToToolPermission: async () => undefined,
  openRepositoryInIde: async () => ({ ok: false, message: "Electron preload is not available." }),
  openTaskInIde: async () => ({ ok: false, message: "Electron preload is not available." }),
  approveTaskMerge: async () => ({ ok: false, message: "Electron preload is not available." }),
  rejectTask: async () => undefined,
  keepWorktree: async () => undefined,
  cancelTask: async () => undefined,
  setResponseFeedback: async () => undefined,
  setWindowChromeTheme: async () => ({ ok: true }),
  onBackendEvent: () => () => undefined,
  };
  return previewApi;
}

  return {
    api: createPreviewApi(),
    attachments: composerTestAttachments,
    events: composerTestEvents,
    params: composerTestParams,
    prompt: composerTestPrompt,
    repository: composerTestRepository,
    reviewFiles: composerTestReviewFiles,
    task: composerTestTask,
  };
}
