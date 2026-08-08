import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  BackendStatus,
  BackendUiEvent,
  CapabilityProbeCategory,
  CapabilityProbeImportance,
  CapabilityProbeReport,
  CapabilityProbeResult,
  CapabilityProbeStatus,
  ChatAttachment,
  ChatRecord,
  DesktopStartupSettings,
  DesktopApi,
  FileSearchKind,
  FileSearchResult,
  HarnessProfileId,
  IdeInfo,
  LocalModelInfo,
  PastedAttachmentInput,
  PermissionMode,
  ReasoningMode,
  RepositoryInfo,
  SkillDocument,
  SkillInfo,
  TaskInfo,
  TaskState,
  UserNotes,
  WorkspaceMode,
} from "../shared/desktopApi";
import { chatTitleFromFirstMessage, stableChatTitle } from "../shared/chatTitle";
import {
  attachmentDetail,
  chatAttachmentsMatch,
  chatAttachmentsSignature,
  chatCountLabel,
  chatDisplayTitle,
  chatProjectKey,
  chatSubline,
  chatWorktreeKey,
  closedChatMessage,
  deleteCandidateActionLabel,
  deleteCandidateDescription,
  deleteCandidateTitle,
  draftMatchesTaskPrompt,
  eventTimelineTime,
  folderName,
  isImageAttachment,
  relativeChatAge,
  shortHash,
  stateLabel,
  titleFromPrompt,
  worktreeSubline,
  worktreeTitle,
  type ChatProjectGroup,
  type DeleteCandidate,
  type ProjectDeleteTarget,
  type WorktreeChatGroup,
} from "./chatListPresentation";
import type {
  AppearanceSettings, AppearanceTheme, ComposerActivitySegment, ComposerSubmission,
  ComposerTimelineItem, IdeChoice, PermissionRequest, PromptMention, QueuedComposerPrompt,
  RequiredToolContractReason, RequiredToolContractRequirement, ResponseFeedbackDialogState,
  ReviewFile, RunnerToolId, SkillSourceFilter, ToolErrorCode, ToolResultStatus,
} from "./rendererTypes";
import { readQueuedPrompts } from "./queuedPrompts";
import {
  CONTEXT_LENGTH_OPTIONS,
  DEFAULT_CONTEXT_LENGTH,
  contextMeterState,
  estimateContextUsage,
  formatTokenCount,
  normalizeContextLength,
  shouldShowContextMeter,
  type ContextEstimateMessage,
} from "../shared/contextWindow";
import { ContextMeter } from "./contextMeter";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { eventDetail, eventTitle } from "./eventDisplay";
import {
  AtSign,
  BarChart3,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  CircleDashed,
  Cloud,
  Copy,
  CornerUpRight,
  Ellipsis,
  ExternalLink,
  File,
  FileText,
  Folder,
  FolderPlus,
  FolderX,
  FolderOpen,
  GitBranch,
  Hand,
  Loader2,
  MessageSquareX,
  MessageSquareText,
  Monitor,
  Moon,
  PanelRight,
  Paperclip,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  SquarePen,
  SquareTerminal,
  Sun,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  TriangleAlert,
  Type,
  Undo2,
  User,
  X,
} from "lucide-react";
import {
  attachmentLabel,
  attachmentMention,
  composerPromptForSend,
  continueNumberedList,
  insertPastedComposerText,
  markdownPreview,
  matchHighlightSegments,
  parseMarkdown,
  rankSkillMatches,
  isEscapedMarkdownAt,
  stabilizeStreamingInlineText,
  type MarkdownBlock,
} from "./composerText";
import { restoreUnsavedDraft, unsavedDraftScopeFor } from "./unsavedDraft";
import { AssistantMessage } from "./assistantMessage";
import { normalizeReviewFile, type ReviewFile as NormalizedReviewFile } from "../shared/reviewDiff";
import { isDocumentReviewArtifactPath, type DocumentReviewSnapshot } from "../shared/documentReview";
import { safeExternalUrl } from "../shared/externalLink";
import { InlineLink, readMarkdownLink } from "./inlineLink";
import { appendTaskEvent, compactTaskEvents, removeResponseFeedback } from "../shared/taskEvents";
import {
  responseFeedbackReasons,
  type ResponseFeedbackReason,
  type ResponseRating,
} from "../shared/responseFeedback";
import { ReviewPanel } from "./review/ReviewPanel";
import { defaultModelEndpointSettings } from "./endpointSettings";
import { ConnectionSettingsPanel, useConnectionSettings } from "./ConnectionSettings";
import { appendReviewFeedback, reviewCommentLineLabel, visibleReviewPrompt, type ReviewCommentDraft, type ReviewFeedbackReference } from "./review/reviewComments";
import {
  reduceApprovalChecks,
  reducePendingPermission,
  reduceVisibleTask,
  taskEventEffects,
  type ApprovalCheck,
  type TaskPermissionRequest,
} from "./taskEventReducer";
import { activityHasTools, activitySummary, thoughtDurationMs } from "./activityTiming";
import { CompactionRow } from "./compactionRow";
import { providerReconnectFromEvents } from "./connectionStatus";
export { providerReconnectFromEvents } from "./connectionStatus";
import { IdeIcon } from "./ideLogos";
import {
  activityToolLabel,
  commandDetailLabel,
  commandHasVisibleDetails,
  commandLabel,
  commandShellText,
  commandSummary,
  commandVisibleOutput,
  type CommandClass,
  type CommandRun,
} from "./commandDisplay";
export { activityHasTools, activitySummary, compactionElapsedLabel } from "./activityTiming";
export { commandDetailLabel, commandHasVisibleDetails, commandLabel, commandShellText, commandSummary, commandVisibleOutput };

const appearanceSettingsKey = "umbratic-ui-appearance";
const workspaceModeKey = "umbratic-ui-workspace-mode";
const markdownPreviewCharacterLimit = 60000;
export const streamingMarkdownRenderBatchIntervalMs = 50;
const maxCachedTaskEventGroups = 24;
const commandOutputPreviewCharacterLimit = 12000;
const commandOutputPreviewLineLimit = 5;
const isMacLike = /Mac|iPhone|iPad/i.test(navigator.platform);
const defaultAppearanceSettings: AppearanceSettings = {
  theme: "system",
  uiFont: "System UI",
  monoFont: "System UI",
};
const defaultUiFontChoices = [
  "System UI",
  "Segoe UI",
  "SF Pro Text",
  "Inter",
  "Arial",
  "Roboto",
  "Helvetica Neue",
  "Verdana",
];
const defaultMonoFontChoices = [
  "System UI",
  "Cascadia Code",
  "SF Mono",
  "Consolas",
  "Menlo",
  "Monaco",
  "JetBrains Mono",
  "Fira Code",
  "Source Code Pro",
  "ui-monospace",
];
const defaultHarnessProfileId: HarnessProfileId = "engineering";
const defaultStartupSettings: DesktopStartupSettings = {
  permissionMode: "normal",
  modelEndpoint: defaultModelEndpointSettings,
  localModels: [],
  companyConnection: { state: "not_enrolled" },
  harnessProfile: defaultHarnessProfileId,
  contextLength: DEFAULT_CONTEXT_LENGTH,
};
const harnessProfiles: Array<{ id: HarnessProfileId; name: string; description: string }> = [
  {
    id: "marketing",
    name: "Marketing",
    description: "Campaigns, content, positioning, launch work, site copy, brand context, and lightweight implementation support.",
  },
  {
    id: "sales",
    name: "Sales",
    description: "Customer-facing workflows, enablement, proposals, demos, objections, CRM-style notes, and pipeline support.",
  },
  {
    id: "engineering",
    name: "Engineering",
    description: "Codebase inspection, implementation, debugging, tests, verification, and precise repository changes.",
  },
];
type LocalFontDescriptor = {
  family?: string;
  fullName?: string;
};

type LocalFontWindow = Window & {
  queryLocalFonts?: () => Promise<LocalFontDescriptor[]>;
};

function isAppearanceTheme(value: unknown): value is AppearanceTheme {
  return value === "system" || value === "light" || value === "dark";
}

function readAppearanceSettings(): AppearanceSettings {
  try {
    const settings = JSON.parse(window.localStorage.getItem(appearanceSettingsKey) ?? "{}") as Partial<AppearanceSettings>;
    return {
      theme: isAppearanceTheme(settings.theme) ? settings.theme : defaultAppearanceSettings.theme,
      uiFont: typeof settings.uiFont === "string" && settings.uiFont.trim() ? settings.uiFont : defaultAppearanceSettings.uiFont,
      monoFont: typeof settings.monoFont === "string" && settings.monoFont.trim() ? settings.monoFont : defaultAppearanceSettings.monoFont,
    };
  } catch {
    return defaultAppearanceSettings;
  }
}

function writeAppearanceSettings(settings: AppearanceSettings) {
  window.localStorage.setItem(appearanceSettingsKey, JSON.stringify(settings));
}

function readWorkspaceMode(): WorkspaceMode {
  return window.localStorage.getItem(workspaceModeKey) === "worktree" ? "worktree" : "local";
}

function writeWorkspaceMode(mode: WorkspaceMode) {
  window.localStorage.setItem(workspaceModeKey, mode);
}

function isHarnessProfileId(value: unknown): value is HarnessProfileId {
  return value === "marketing" || value === "sales" || value === "engineering";
}

function uniqueFonts(fonts: string[]): string[] {
  return Array.from(new Set(fonts.map((font) => font.trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

function cssFontValue(font: string, fallback: string): string {
  if (font === "System UI") return `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  if (/^(system-ui|ui-monospace|serif|sans-serif|monospace)$/i.test(font)) return `${font}, ${fallback}`;
  return `"${font.replace(/"/g, "")}", ${fallback}`;
}

function localFontAccessAvailable(): boolean {
  return typeof (window as LocalFontWindow).queryLocalFonts === "function";
}

function normalizeAttachment(file: ChatAttachment): ChatAttachment {
  const normalized: ChatAttachment = { path: file.path, name: file.name || file.path.split(/[\\/]/).pop() || file.path };
  if (file.kind === "file" || file.kind === "folder") normalized.kind = file.kind;
  if (file.source === "chat" || file.source === "workspace") normalized.source = file.source;
  if (file.storedPath) normalized.storedPath = file.storedPath;
  if (file.originalPath) normalized.originalPath = file.originalPath;
  if (file.previewDataUrl?.startsWith("data:image/")) normalized.previewDataUrl = file.previewDataUrl;
  if (Number.isSafeInteger(file.contextTokens) && (file.contextTokens ?? -1) >= 0) normalized.contextTokens = file.contextTokens;
  return normalized;
}

const initialPrompt = "";
const emptyReviewFiles: ReviewFile[] = [];
const defaultIdeChoices: IdeChoice[] = [
  { id: "code", label: "VS Code", icon: "vscode" },
  { id: "visualstudio", label: "Visual Studio", icon: "visualstudio" },
  { id: "explorer", label: isMacLike ? "Finder" : "Explorer", icon: isMacLike ? "finder" : "explorer" },
];
const previewBuildEnabled =
  typeof __UMBRATIC_PREVIEW_BUILD__ !== "undefined" && __UMBRATIC_PREVIEW_BUILD__;
const composerTestMode =
  previewBuildEnabled && window.__UMBRATIC_PREVIEW__ === true;

const previewEnvironment = composerTestMode
  ? window.__UMBRATIC_PREVIEW_ENVIRONMENT__ ?? null
  : null;
let api: DesktopApi;

function isReviewReadyText(text: string): boolean {
  return text.trim() === "Ready for review.";
}

function appendBackendEvent(events: BackendUiEvent[], event: BackendUiEvent, limit = 500): BackendUiEvent[] {
  return appendTaskEvent(events, event, limit) as BackendUiEvent[];
}

export function compactBackendEvents(events: BackendUiEvent[], limit = 500): BackendUiEvent[] {
  return compactTaskEvents(events, limit) as BackendUiEvent[];
}

export function takeBatchedBackendEvents(pendingEvents: BackendUiEvent[]): BackendUiEvent[] {
  return pendingEvents.splice(0);
}

export function mentionAtCursor(value: string, cursor: number): PromptMention | null {
  const beforeCursor = value.slice(0, cursor);
  const match = beforeCursor.match(/(^|\s)([@$])([^\s@$]*)$/);
  if (!match || match.index === undefined) return null;
  const start = match.index + match[1].length;
  return { kind: match[2] === "$" ? "skill" : "file", query: match[3], start, end: cursor };
}

export function skillMention(skill: SkillInfo): string {
  return `$${skill.id}`;
}

type MentionCategoryId = "file" | "folder" | "skill";

type MentionCategory = { id: MentionCategoryId; label: string; hint: string };

const mentionCategories: MentionCategory[] = [
  { id: "file", label: "Files", hint: "Attach a file from the project" },
  { id: "folder", label: "Folders", hint: "Reference a folder and everything in it" },
  { id: "skill", label: "Skills", hint: "Use a skill for this turn" },
];

function mentionCategoryIcon(id: MentionCategoryId): React.ReactNode {
  if (id === "folder") return <Folder size={14} />;
  if (id === "skill") return <Sparkles size={14} />;
  return <File size={14} />;
}

function MentionMatchText({ text, query }: { text: string; query: string }) {
  return (
    <>
      {matchHighlightSegments(text, query).map((segment, index) =>
        segment.hit ? <mark key={index}>{segment.text}</mark> : <React.Fragment key={index}>{segment.text}</React.Fragment>,
      )}
    </>
  );
}

export function renderPromptHighlights(value: string, files: ChatAttachment[], skills: SkillInfo[]): React.ReactNode[] {
  const tokens = [
    ...files.map(normalizeAttachment).map(attachmentMention),
    ...skills.map(skillMention),
  ]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  if (!tokens.length) return [value || "\u200b"];
  const segments: Array<{ text: string; mention: boolean }> = [];
  let index = 0;
  while (index < value.length) {
    const token = tokens.find(
      (candidate) =>
        value.startsWith(candidate, index) &&
        (index === 0 || /\s/.test(value[index - 1])) &&
        (index + candidate.length === value.length || /\s|[.,;:!?)]/.test(value[index + candidate.length])),
    );
    if (token) {
      segments.push({ text: token, mention: true });
      index += token.length;
      continue;
    }
    const nextMention = tokens
      .map((candidate) => value.indexOf(candidate, index + 1))
      .filter((position) => position >= 0)
      .sort((left, right) => left - right)[0];
    const end = nextMention ?? value.length;
    segments.push({ text: value.slice(index, end), mention: false });
    index = end;
  }
  if (value.endsWith("\n")) segments.push({ text: "\u200b", mention: false });
  return segments.map((segment, index) =>
    segment.mention ? (
      <span className="promptMentionToken" key={`${index}-${segment.text}`}>
        {segment.text}
      </span>
    ) : (
      segment.text
    ),
  );
}

type ReviewReferenceOptions = {
  reviewFiles?: ReviewFile[];
  onReviewFileClick?: (filePath: string) => void;
};

export function normalizeReviewReference(value: string): string {
  return value
    .replace(/^@/, "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^[`"']+|[`"',.:;!?]+$/g, "")
    .trim();
}

function fileNameFromPath(value: string): string {
  return value.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? value;
}

export function reviewFileForReference(value: string, reviewFiles?: ReviewFile[]): ReviewFile | undefined {
  if (!reviewFiles?.length) return undefined;
  const reference = normalizeReviewReference(value);
  if (!reference) return undefined;
  const normalizedFiles = reviewFiles.map((file) => ({ file, path: normalizeReviewReference(file.path) }));
  const exact = normalizedFiles.find(({ path }) => path === reference);
  if (exact) return exact.file;
  if (reference.includes("/")) {
    const suffix = normalizedFiles.find(({ path }) => path.endsWith(`/${reference}`));
    if (suffix) return suffix.file;
  }
  const basenameMatches = normalizedFiles.filter(({ path }) => fileNameFromPath(path) === reference);
  return basenameMatches.length === 1 ? basenameMatches[0].file : undefined;
}

function renderReferenceToken(part: string, key: string, options?: ReviewReferenceOptions): React.ReactNode {
  const reviewFile = reviewFileForReference(part, options?.reviewFiles);
  if (reviewFile && options?.onReviewFileClick) {
    return (
      <button className="inlineMentionToken reviewReferenceToken" key={key} type="button" onClick={() => options.onReviewFileClick?.(reviewFile.path)}>
        {normalizeReviewReference(part)}
      </button>
    );
  }
  if (part.startsWith("@") || /[\\/].+\.[A-Za-z0-9]{1,8}$/.test(part)) {
    return (
      <span className="inlineMentionToken" key={key}>
        {part}
      </span>
    );
  }
  return <React.Fragment key={key}>{part}</React.Fragment>;
}

function renderPlainInlineText(text: string, keyPrefix: string, options?: ReviewReferenceOptions): React.ReactNode[] {
  return text
    .split(/(@[A-Za-z0-9][A-Za-z0-9._/-]*|(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}|[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8})/g)
    .map((part, index) => renderReferenceToken(part, `${keyPrefix}-ref-${index}`, options));
}

function findClosingBacktickRun(text: string, startIndex: number, runLength: number): number {
  for (let index = startIndex; index < text.length; index += 1) {
    if (text[index] !== "`" || isEscapedMarkdownAt(text, index)) continue;
    let nextIndex = index;
    while (nextIndex < text.length && text[nextIndex] === "`") nextIndex += 1;
    if (nextIndex - index === runLength) return index;
    index = nextIndex - 1;
  }
  return -1;
}

type DiffRow =
  { kind: "add" | "remove" | "context"; content: string; oldLine: number | null; newLine: number | null; marker: "+" | "-" | "" };

type ParsedDiff = {
  additions: number;
  deletions: number;
  rows: DiffRow[];
};

const emptyParsedDiff: ParsedDiff = { additions: 0, deletions: 0, rows: [] };
const sidebarDefaultWidth = 230;
const sidebarMinWidth = 168;
const sidebarMaxWidth = 230;
const reviewMinWidth = 360;
const reviewDefaultWidth = 440;
const reviewOpenWidthRatio = 0.65;
const reviewMaxWidthRatio = 0.95;
const sidebarMaxRatio = 0.28;

function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!match) return null;
  return { oldStart: Number(match[1]), newStart: Number(match[2]) };
}

export function parseUnifiedDiff(diff: string): ParsedDiff {
  const rows: DiffRow[] = [];
  let additions = 0;
  let deletions = 0;
  let oldLine = 0;
  let newLine = 0;
  let insideHunk = false;

  for (const line of diff.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if (line.startsWith("@@")) {
      const hunk = parseHunkHeader(line);
      if (!hunk) continue;
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      insideHunk = true;
      continue;
    }

    if (!insideHunk || line.startsWith("\\ No newline")) {
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++ ")) {
      rows.push({ kind: "add", content: line.slice(1), oldLine: null, newLine, marker: "+" });
      additions += 1;
      newLine += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("--- ")) {
      rows.push({ kind: "remove", content: line.slice(1), oldLine, newLine: null, marker: "-" });
      deletions += 1;
      oldLine += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
  }

  if (rows.length === 0 && /Binary files|GIT binary patch/.test(diff)) {
    rows.push({ kind: "context", content: "Binary file changed", oldLine: null, newLine: null, marker: "" });
  }

  return { additions, deletions, rows };
}

export function formatDiffStats(stats: ParsedDiff): string {
  return `+${stats.additions} -${stats.deletions}`;
}

function AttachmentPreviewList({
  files,
  mode,
  onRemove,
  onOpen,
}: {
  files: ChatAttachment[];
  mode: "composer" | "message";
  onRemove?: (file: ChatAttachment) => void;
  onOpen?: (file: ChatAttachment) => void;
}) {
  if (!files.length) return null;
  return (
    <div
      className={`attachmentPreviewList ${mode === "composer" ? "composerAttachmentList" : "messageAttachmentList"} hasAttachments`}
    >
      {files.map((file) => {
        const key = file.storedPath || file.path;
        const label = attachmentLabel(file);
        const image = isImageAttachment(file) && file.previewDataUrl;
        const interactive = !!onOpen && !onRemove;
        const previewContent = image ? (
          <img alt={label} src={file.previewDataUrl} />
        ) : (
          <>
            <span className="attachmentPreviewFileIcon">
              {file.kind === "folder" ? <Folder size={14} /> : <File size={14} />}
            </span>
            <span className="attachmentPreviewFileName">{label}</span>
          </>
        );
        const className = `attachmentPreview ${image ? "imageAttachment" : "fileAttachment"} ${
          interactive ? "interactiveAttachment" : ""
        }`;
        return (
          <React.Fragment key={key}>
            {interactive ? (
              <button className={className} type="button" onClick={() => onOpen(file)} title={label}>
                {previewContent}
              </button>
            ) : (
              <div className={className} title={label}>
                {previewContent}
                {onRemove ? (
                  <button className="attachmentPreviewRemove" type="button" onClick={() => onRemove(file)} title={`Remove ${label}`}>
                    <X size={13} />
                  </button>
                ) : null}
              </div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

async function copyPlainText(value: string) {
  const text = value.trimEnd();
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    throw new Error("Clipboard API unavailable.");
  } catch {
    const node = document.createElement("textarea");
    node.value = text;
    node.setAttribute("readonly", "");
    node.style.position = "fixed";
    node.style.left = "-9999px";
    document.body.appendChild(node);
    node.select();
    document.execCommand("copy");
    document.body.removeChild(node);
  }
}

export function codeBlockLabel(language: string, content: string): string {
  const normalized = language.trim().toLowerCase();
  if (/^(bash|sh|zsh|shell|console|terminal|powershell|ps1|pwsh|cmd|bat)$/i.test(normalized)) return normalized || "command";
  if (!normalized && looksLikeCommandBlock(content)) return "command";
  return normalized || "code";
}

export function looksLikeCommandBlock(content: string): boolean {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return false;
  return lines.every((line) =>
    /^[$>]/.test(line) ||
    /^(npm|pnpm|yarn|bun|node|git|cmake|ctest|make|ninja|python|uv|cargo|go|dotnet|winget|brew|sudo|apt-get|dnf|pacman|rg|fd|tree-sitter)\b/i.test(line),
  );
}

function MarkdownCodeBlock({ language, content }: { language: string; content: string }) {
  const [copied, setCopied] = useState(false);
  const label = codeBlockLabel(language, content);
  const isCommand = label === "command" || /^(bash|sh|zsh|shell|console|terminal|powershell|ps1|pwsh|cmd|bat)$/i.test(label);
  async function copyBlock() {
    await copyPlainText(content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }
  return (
    <figure className={`markdownCodeBlock ${isCommand ? "isCommand" : ""}`}>
      <figcaption>
        <span>{label}</span>
        <button type="button" onClick={() => void copyBlock()} title="Copy code">
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </figcaption>
      <pre className="markdownCode">
        <code>{content}</code>
      </pre>
    </figure>
  );
}

function ApprovalIcon({ status }: { status: ApprovalCheck["status"] }) {
  if (status === "passed") return <CheckCircle2 size={15} />;
  if (status === "failed") return <TriangleAlert size={15} />;
  return <Loader2 className="spin" size={15} />;
}

function taskStatusTitle(task: TaskInfo): string {
  if (task.state === "completed") return "Answered";
  if (task.state === "review_ready") return "Ready to review";
  if (task.state === "approved") return "Approved";
  if (task.state === "merged") return task.workspaceMode === "worktree" ? "Merged" : "Approved";
  if (task.state === "approving") return "Running approval checks";
  if (task.state === "running") return "Working";
  if (task.state === "failed") return "Needs attention";
  if (task.state === "rejected") return "Undone";
  if (task.state === "awaiting_worktree_approval") return "Waiting for setup approval";
  return stateLabel(task.state);
}

function taskStatusDetail(task: TaskInfo): string {
  if (task.state === "review_ready") {
    const changed = task.changedFiles.length;
    return `${changed} changed file${changed === 1 ? "" : "s"} ready in Review.`;
  }
  if (task.state === "merged") {
    return task.workspaceMode === "worktree"
      ? "This chat was closed after its approved merge."
      : "This chat was closed after its workspace changes were approved.";
  }
  if (task.state === "approved") return "Changes are saved on disk.";
  if (task.state === "completed") return "No file changes for this turn.";
  if (task.state === "rejected") return "Changes were undone.";
  if (task.latestTest?.passed) return `Verified: ${task.latestTest.output.trim() || task.latestTest.command}`;
  if (task.error) return task.error;
  if (task.state === "running") return "Umbratic is working.";
  return task.workspaceMode === "worktree" ? task.agentBranch : task.worktreePath;
}

export function commandRunsFromEvents(events: BackendUiEvent[]): CommandRun[] {
  const runs = new Map<string, CommandRun>();
  for (const event of events) {
    if (event.type === "command.started") {
      const existing = runs.get(event.id);
      if (existing) {
        existing.command = event.command;
        existing.kind = event.kind;
        existing.toolKind = event.toolKind;
        existing.commandClass = event.commandClass;
        existing.cwd = event.cwd;
        continue;
      }
      runs.set(event.id, {
        id: event.id,
        command: event.command,
        kind: event.kind,
        toolKind: event.toolKind,
        commandClass: event.commandClass,
        cwd: event.cwd,
        stdout: "",
        stderr: "",
        exitCode: null,
        status: "running",
        startedAt: event.at,
        endedAt: event.at,
      });
      continue;
    }
    if (event.type === "command.output") {
      let run = runs.get(event.id);
      if (!run) {
        run = {
          id: event.id,
          command: event.id,
          kind: "bash",
          commandClass: "unknown",
          cwd: "",
          stdout: "",
          stderr: "",
          exitCode: null,
          status: "running",
          startedAt: event.at,
          endedAt: event.at,
        };
        runs.set(event.id, run);
      }
      run.endedAt = event.endedAt ?? event.at ?? run.endedAt;
      if (event.stream === "stdout") {
        run.stdout = `${run.stdout}${event.text}`;
      } else {
        run.stderr = `${run.stderr}${event.text}`;
      }
      continue;
    }
    if (event.type === "command.finished") {
      let run = runs.get(event.id);
      if (!run) {
        run = {
          id: event.id,
          command: event.id,
          kind: "bash",
          commandClass: "unknown",
          cwd: "",
          stdout: "",
          stderr: "",
          exitCode: null,
          status: "running",
          startedAt: event.at,
          endedAt: event.at,
        };
        runs.set(event.id, run);
      }
      run.exitCode = event.exitCode;
      run.status = event.exitCode === 0 ? "passed" : "failed";
      run.resultStatus = event.status;
      run.errorCode = event.errorCode;
      if (event.errorMessage && !run.stderr.trim()) run.stderr = event.errorMessage;
      run.endedAt = event.at ?? run.endedAt;
      run.durationMs = event.durationMs;
    }
  }
  return Array.from(runs.values());
}

export function pendingPermissionFromEvents(events: BackendUiEvent[]): PermissionRequest | null {
  const requests = new Map<string, PermissionRequest>();
  for (const event of events) {
    if (event.type === "permission.requested") {
      requests.set(event.request.id, event.request);
      continue;
    }
    if (event.type === "permission.resolved") {
      requests.delete(event.id);
    }
  }
  return Array.from(requests.values()).at(-1) ?? null;
}

function formatFileSize(bytes: number): string {
  const value = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 2 : 1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function activityToolGroups(segments: ComposerActivitySegment[]): Array<{
  id: string;
  label: string;
  runs: CommandRun[];
  status: CommandRun["status"];
}> {
  const groups = new Map<string, { id: string; label: string; runs: CommandRun[]; status: CommandRun["status"] }>();
  for (const segment of segments) {
    if (segment.type !== "command") continue;
    const { key, label } = activityToolLabel(segment.run);
    const group = groups.get(key) ?? { id: `tool-group-${groups.size + 1}`, label, runs: [], status: "passed" as const };
    group.runs.push(segment.run);
    group.status = group.runs.some((run) => run.status === "running")
      ? "running"
      : group.runs.some((run) => run.status === "failed")
        ? "failed"
        : "passed";
    groups.set(key, group);
  }
  return Array.from(groups.values());
}

function stripAssistantSpeakerPrefix(text: string): string {
  return text.replace(/^\s*(?:\*\*)?Umbratic(?: AI)?(?:\*\*)?\s*:\s*/i, "");
}

/// The answer, for copying: the last assistant message of the transcript.
///
/// Prose now renders in place rather than being demoted into the activity log,
/// so a turn can show several assistant messages — the preambles that
/// introduced each round of work, then the answer. Copying every one of them
/// would hand back the narration too; the closing message is the response.
export function assistantTextFromEvents(events: BackendUiEvent[]): string {
  const answer = composerTimelineFromEvents(events)
    .filter((item): item is Extract<ComposerTimelineItem, { type: "assistant" }> => item.type === "assistant")
    .at(-1)?.text ?? "";
  return stripAssistantSpeakerPrefix(answer.trim()).trim();
}

export function composerTimelineFromEvents(events: BackendUiEvent[], taskPrompt?: string, taskState?: TaskState): ComposerTimelineItem[] {
  const runs = new Map<string, CommandRun>();
  const items: ComposerTimelineItem[] = [];
  let assistantBuffer = "";
  let assistantNeedsSeparator = false;
  let assistantIndex = 0;
  let activitySegments: ComposerActivitySegment[] = [];
  let activityStartedAt: string | undefined;
  let activityEndedAt: string | undefined;
  let activityIndex = 0;
  const commandSegmentIds = new Set<string>();
  let reasoningBuffer = "";
  let reasoningStartedAt: string | undefined;
  let reasoningEndedAt: string | undefined;
  let reasoningIndex = 0;
  let skillIndex = 0;
  let compactionIndex = 0;
  const prompt = taskPrompt?.trim();
  const hasUserMessages = events.some((event) => event.type === "user.message");

  if (prompt && !hasUserMessages) {
    const visiblePrompt = visibleReviewPrompt(prompt);
    items.push({ type: "user", id: "user-prompt", text: visiblePrompt.text, rawText: prompt, reviewFeedback: visiblePrompt.feedback, attachedFiles: [] });
  }

  // Assistant prose renders where it first appeared and never moves again.
  //
  // Classifying it required knowing whether another tool call was coming, which
  // is unknowable at the first token — so the old rule streamed everything
  // inside the open Working block and moved the answer out once the run
  // settled. That move is exactly what made the final answer arrive as a jump
  // instead of a stream. Text now closes the Working block and streams in
  // place, so a turn reads Working → text → Working → answer, and nothing is
  // ever relocated after the user has read it.
  const flushAssistant = (streaming = false) => {
    const text = stripAssistantSpeakerPrefix(assistantBuffer).trim();
    if (!text) { assistantBuffer = ""; assistantNeedsSeparator = false; return; }
    assistantIndex += 1;
    items.push({
      type: "assistant",
      id: `assistant-${assistantIndex}`,
      text,
      streaming: streaming || undefined,
    });
    assistantBuffer = ""; assistantNeedsSeparator = false;
  };

  const markActivityTime = (startedAt?: string, endedAt?: string) => {
    if (startedAt && !activityStartedAt) {
      activityStartedAt = startedAt;
    }
    const end = endedAt ?? startedAt;
    if (end) {
      activityEndedAt = end;
    }
  };

  const activeCommandSegment = (id: string) =>
    activitySegments.some((segment) => segment.type === "command" && segment.run.id === id);

  const ensureCommandSegment = (run: CommandRun) => {
    if (!commandSegmentIds.has(run.id)) {
      commandSegmentIds.add(run.id);
      activitySegments.push({ type: "command", id: run.id, run });
      return true;
    }
    return activeCommandSegment(run.id);
  };

  const flushActivity = (finished = true) => {
    if (!activitySegments.length) {
      if (activityStartedAt && !finished) {
        activityIndex += 1;
        items.push({
          type: "activity",
          id: `activity-${activityIndex}`,
          segments: [],
          startedAt: activityStartedAt,
          endedAt: activityEndedAt,
          finished: false,
        });
      }
      activityStartedAt = undefined;
      activityEndedAt = undefined;
      return;
    }
    // Thinking-only turns (no tools/skills) never settle into a timed Working
    // block.
    if (finished && !activityHasTools(activitySegments)) {
      activitySegments = [];
      activityStartedAt = undefined;
      activityEndedAt = undefined;
      return;
    }
    activityIndex += 1;
    items.push({
      type: "activity",
      id: `activity-${activityIndex}`,
      segments: activitySegments,
      startedAt: activityStartedAt,
      endedAt: activityEndedAt,
      finished,
    });
    activitySegments = [];
    activityStartedAt = undefined;
    activityEndedAt = undefined;
  };

  const flushReasoning = (finished = true) => {
    const text = reasoningBuffer.trim();
    const redundantCompletion = /^(?:#{1,6}\s*)?work(?:\s+is)?\s+complete(?:d)?[.!:]*$/i.test(text);
    if (!text || redundantCompletion) {
      reasoningBuffer = "";
      reasoningStartedAt = undefined;
      reasoningEndedAt = undefined;
      return;
    }
    reasoningIndex += 1;
    markActivityTime(reasoningStartedAt, reasoningEndedAt);
    activitySegments.push({
      type: "reasoning",
      id: `reasoning-${reasoningIndex}`,
      text,
      durationMs: thoughtDurationMs(reasoningStartedAt, reasoningEndedAt, finished),
      finished,
    });
    reasoningBuffer = "";
    reasoningStartedAt = undefined;
    reasoningEndedAt = undefined;
  };

  // New workspace activity settles whatever prose preceded it: the text stays
  // an assistant message, and the tools open a fresh Working block beneath it.
  const closeAssistantForActivity = () => {
    flushAssistant();
    flushReasoning();
  };

  for (const event of events) {
    if (event.type === "user.message") {
      flushReasoning();
      flushActivity();
      flushAssistant();
      const visiblePrompt = visibleReviewPrompt(event.text);
      items.push({
        type: "user",
        id: `user-${items.length}-${event.text.length}`,
        text: visiblePrompt.text,
        rawText: event.text,
        reviewFeedback: visiblePrompt.feedback,
        attachedFiles: (event.attachedFiles ?? []).map(normalizeAttachment),
      });
      activityStartedAt = event.at;
      activityEndedAt = undefined;
      continue;
    }
    if (event.type === "assistant.delta") {
      if (isReviewReadyText(event.text)) continue;
      flushReasoning();
      // The work is over once the model starts speaking, so the first token of a
      // burst closes the elapsed window. Later tokens of the same answer must not
      // keep inflating it.
      if (!assistantBuffer) markActivityTime(undefined, event.at);
      // Prose ends the Working block, always. A block with tools settles into a
      // timed summary; a thinking-only block simply drops. Either way the text
      // that follows streams outside it, which is what makes the final answer
      // arrive live instead of surfacing after the run settles.
      flushActivity();
      const separator = assistantNeedsSeparator
        && assistantBuffer.trim()
        && !/\s$/.test(assistantBuffer)
        && !/^\s/.test(event.text)
        ? "\n\n"
        : "";
      assistantBuffer = `${assistantBuffer}${separator}${event.text}`;
      assistantNeedsSeparator = false;
      continue;
    }
    if (event.type === "context.compaction") {
      // Compaction happens between the model's turns, not inside its thinking,
      // so it opens the Working block itself rather than waiting for a tool. A
      // finish updates the row that started it: the elapsed time the user
      // watched is the elapsed time that settles.
      if (event.phase === "started") {
        closeAssistantForActivity();
        flushActivity();
        compactionIndex += 1;
        items.push({
          type: "compaction",
          id: `compaction-${compactionIndex}`,
          status: "running",
          startedAt: event.at,
        });
        continue;
      }
      const open = [...items].reverse().find(
        (item): item is Extract<ComposerTimelineItem, { type: "compaction" }> =>
          item.type === "compaction" && item.status === "running",
      );
      // A finish with no open marker means the start was never seen — a resumed
      // chat replaying a truncated event log. Nothing is invented for it.
      if (!open) continue;
      open.status = event.outcome ?? "unchanged";
      open.endedAt = event.at;
      if (event.reclaimedTokens !== undefined) open.reclaimedTokens = event.reclaimedTokens;
      continue;
    }
    if (event.type === "assistant.progress.delta") {
      if (assistantBuffer.trim()) assistantNeedsSeparator = true;
      reasoningStartedAt = reasoningStartedAt ?? event.at;
      reasoningEndedAt = event.endedAt ?? event.at ?? reasoningEndedAt;
      reasoningBuffer = `${reasoningBuffer}${reasoningBuffer ? "\n\n" : ""}${event.text}`;
      continue;
    }
    if (event.type === "turn.outcome") {
      // A stopped turn ends where it was: whatever had streamed stays exactly
      // where the user saw it, and the Working block settles around the tools
      // that did run.
      if (event.outcome === "aborted" && activityHasTools(activitySegments)) {
        closeAssistantForActivity();
        flushActivity();
      }
      continue;
    }
    if (event.type === "assistant.done") {
      flushReasoning();
      // Streaming the answer is not work, so completing it does not extend the
      // elapsed window either.
      flushActivity();
      flushAssistant();

      continue;
    }
    if (event.type === "skill.requested") {
      closeAssistantForActivity();
      skillIndex += 1;
      activitySegments.push({
        type: "skill",
        id: `skill-${skillIndex}`,
        skillId: event.skillId,
        source: event.source,
        origin: event.origin,
        status: "requested",
        requestId: event.requestId,
      });
      markActivityTime(event.at, event.endedAt ?? event.at);
      continue;
    }
    if (event.type === "skill.loaded" || event.type === "skill.failed") {
      closeAssistantForActivity();
      const existing = [...activitySegments].reverse().find(
        (segment): segment is Extract<ComposerActivitySegment, { type: "skill" }> =>
          segment.type === "skill" && segment.requestId === event.requestId,
      );
      if (existing) {
        existing.status = event.type === "skill.loaded" ? "loaded" : "failed";
        if (event.type === "skill.loaded") {
          existing.contentHash = event.contentHash;
          existing.bytes = event.bytes;
        } else {
          existing.code = event.code;
          existing.message = event.message;
        }
      } else {
        skillIndex += 1;
        activitySegments.push({
          type: "skill",
          id: `skill-${skillIndex}`,
          skillId: event.skillId,
          source: event.source,
          origin: event.origin,
          status: event.type === "skill.loaded" ? "loaded" : "failed",
          requestId: event.requestId,
          ...(event.type === "skill.loaded"
            ? { contentHash: event.contentHash, bytes: event.bytes }
            : { code: event.code, message: event.message }),
        });
      }
      markActivityTime(event.at, event.endedAt ?? event.at);
      continue;
    }
    if (event.type === "command.started") {
      closeAssistantForActivity();
      const existingRun = runs.get(event.id);
      if (existingRun) {
        existingRun.command = event.command;
        existingRun.kind = event.kind;
        existingRun.toolKind = event.toolKind;
        existingRun.commandClass = event.commandClass;
        existingRun.cwd = event.cwd;
        existingRun.startedAt = existingRun.startedAt ?? event.at;
        existingRun.endedAt = event.at ?? existingRun.endedAt;
        if (ensureCommandSegment(existingRun)) {
          markActivityTime(event.at, event.at);
        }
        continue;
      }
      const run: CommandRun = {
        id: event.id,
        command: event.command,
        kind: event.kind,
        toolKind: event.toolKind,
        commandClass: event.commandClass,
        cwd: event.cwd,
        stdout: "",
        stderr: "",
        exitCode: null,
        status: "running",
        startedAt: event.at,
        endedAt: event.at,
      };
      runs.set(event.id, run);
      if (ensureCommandSegment(run)) {
        markActivityTime(event.at, event.at);
      }
      continue;
    }
    if (event.type === "command.output") {
      closeAssistantForActivity();
      let run = runs.get(event.id);
      if (!run) {
        run = {
          id: event.id,
          command: event.id,
          kind: "bash",
          cwd: "",
          stdout: "",
          stderr: "",
          exitCode: null,
          status: "running",
          startedAt: event.at,
          endedAt: event.endedAt ?? event.at,
        };
        runs.set(event.id, run);
      }
      run.endedAt = event.endedAt ?? event.at ?? run.endedAt;
      if (ensureCommandSegment(run)) {
        markActivityTime(event.at, event.endedAt ?? event.at);
      }
      if (event.stream === "stdout") {
        run.stdout = `${run.stdout}${event.text}`;
      } else {
        run.stderr = `${run.stderr}${event.text}`;
      }
      continue;
    }
    if (event.type === "command.finished") {
      closeAssistantForActivity();
      let run = runs.get(event.id);
      if (!run) {
        run = {
          id: event.id,
          command: event.id,
          kind: "bash",
          cwd: "",
          stdout: "",
          stderr: "",
          exitCode: null,
          status: "running",
          startedAt: event.at,
          endedAt: event.at,
        };
        runs.set(event.id, run);
      }
      run.exitCode = event.exitCode;
      run.status = event.exitCode === 0 ? "passed" : "failed";
      run.resultStatus = event.status;
      run.errorCode = event.errorCode;
      if (event.errorMessage && !run.stderr.trim()) run.stderr = event.errorMessage;
      run.endedAt = event.at ?? run.endedAt;
      run.durationMs = event.durationMs;
      if (ensureCommandSegment(run)) {
        markActivityTime(event.at, event.at);
      }
      continue;
    }
    if (event.type === "task.error") {
      flushReasoning();
      if (activitySegments.length) {
        markActivityTime(undefined, event.at);
      } else {
        activityStartedAt = undefined;
        activityEndedAt = undefined;
      }
      flushActivity();
      assistantBuffer = `${assistantBuffer}${assistantBuffer.trim() ? "\n\n" : ""}I couldn't complete this request.\n\n${event.message}`;
      flushAssistant();
    }
  }
  // Trailing text is flushed as an assistant message whether or not the run has
  // settled, so a streaming answer renders outside the Working block from its
  // first token rather than appearing there once the run finishes.
  flushReasoning(taskState !== "running");
  flushActivity(taskState !== "running");
  flushAssistant(taskState === "running");

  // The turn's answer is the prose nothing follows. Deciding it by position
  // rather than by the run having settled is what keeps it stable: a message
  // stops being the answer the moment work opens beneath it, and the real
  // answer is the answer from its first streamed token — it never restyles
  // under the reader.
  const closing = items.at(-1);
  if (closing?.type === "assistant") {
    closing.final = true;
  }

  return items;
}

export function reconcileActivityDisclosureState(
  currentExpandedIds: Set<string>,
  items: ComposerTimelineItem[],
  taskId: string | undefined,
  currentAutoOpenedKeys: Set<string>,
): { expandedIds: Set<string>; autoOpenedKeys: Set<string>; newlyOpenedIds: string[] } {
  const activities = items.filter(
    (item): item is Extract<ComposerTimelineItem, { type: "activity" }> => item.type === "activity",
  );
  const activityKey = (id: string) => `${taskId ?? "no-task"}:${id}`;
  const activeIds = new Set(activities.map((item) => item.id));
  const activeKeys = new Set(activities.map((item) => activityKey(item.id)));
  const nextExpandedIds = new Set(currentExpandedIds);
  const nextAutoOpenedKeys = new Set(currentAutoOpenedKeys);
  const newlyOpenedIds: string[] = [];

  for (const activity of activities) {
    const key = activityKey(activity.id);
    // A live compaction block auto-opens for the same reason a tool block does:
    // the row explaining the pause is the point of showing the block at all.
    const opensLive = activityHasTools(activity.segments);
    if (!activity.finished && opensLive && !nextAutoOpenedKeys.has(key)) {
      nextAutoOpenedKeys.add(key);
      nextExpandedIds.add(activity.id);
      newlyOpenedIds.push(activity.id);
      continue;
    }
    if ((!opensLive || activity.finished) && nextAutoOpenedKeys.delete(key)) {
      nextExpandedIds.delete(activity.id);
    }
  }

  for (const id of nextExpandedIds) {
    if (!activeIds.has(id)) nextExpandedIds.delete(id);
  }
  for (const key of nextAutoOpenedKeys) {
    if (!activeKeys.has(key)) nextAutoOpenedKeys.delete(key);
  }

  return { expandedIds: nextExpandedIds, autoOpenedKeys: nextAutoOpenedKeys, newlyOpenedIds };
}

export function renderInlineMarkdown(text: string, options?: ReviewReferenceOptions): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let plain = "";
  let keyIndex = 0;

  const flushPlain = () => {
    if (!plain) return;
    const key = `inline-${keyIndex}`;
    nodes.push(<React.Fragment key={key}>{renderPlainInlineText(plain, key, options)}</React.Fragment>);
    keyIndex += 1;
    plain = "";
  };

  const pushCode = (code: string) => {
    flushPlain();
    const key = `code-${keyIndex}`;
    keyIndex += 1;
    if (reviewFileForReference(code, options?.reviewFiles) || code.startsWith("@") || /[\\/].+\.[A-Za-z0-9]{1,8}$/.test(code)) {
      nodes.push(renderReferenceToken(code, key, options));
      return;
    }
    nodes.push(<code key={key}>{code}</code>);
  };

  const pushFormatted = (node: React.ReactNode) => {
    flushPlain();
    nodes.push(node);
    keyIndex += 1;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && /[`*_\\]/.test(text[index + 1] ?? "")) {
      plain += text[index + 1];
      index += 1;
      continue;
    }
    if (char === "`" && !isEscapedMarkdownAt(text, index)) {
      let endOfRun = index;
      while (endOfRun < text.length && text[endOfRun] === "`") endOfRun += 1;
      const runLength = endOfRun - index;
      const closingIndex = findClosingBacktickRun(text, endOfRun, runLength);
      if (closingIndex >= 0) {
        pushCode(text.slice(endOfRun, closingIndex));
        index = closingIndex + runLength - 1;
        continue;
      }
    }
    if (char === "[" && !isEscapedMarkdownAt(text, index)) {
      const link = readMarkdownLink(text, index);
      if (link) {
        const safeUrl = safeExternalUrl(link.url);
        if (safeUrl) {
          pushFormatted(
            <InlineLink href={safeUrl} key={`link-${keyIndex}`}>
              {renderInlineMarkdown(link.label, options)}
            </InlineLink>,
          );
          index = link.end;
          continue;
        }
        // An unsafe or unparseable URL is left exactly as written. Rendering
        // just the label would hide where a hostile link points.
        plain += text.slice(index, link.end + 1);
        index = link.end;
        continue;
      }
    }
    if (text.startsWith("**", index) && !isEscapedMarkdownAt(text, index)) {
      const closingIndex = text.indexOf("**", index + 2);
      if (closingIndex > index + 2) {
        pushFormatted(<strong key={`strong-${keyIndex}`}>{text.slice(index + 2, closingIndex)}</strong>);
        index = closingIndex + 1;
        continue;
      }
    }
    if ((char === "*" || char === "_") && !isEscapedMarkdownAt(text, index)) {
      const closingIndex = text.indexOf(char, index + 1);
      if (closingIndex > index + 1 && !text.slice(index + 1, closingIndex).includes("\n")) {
        pushFormatted(<em key={`em-${keyIndex}`}>{text.slice(index + 1, closingIndex)}</em>);
        index = closingIndex;
        continue;
      }
    }
    plain += char;
  }

  flushPlain();
  return nodes;
}

function MarkdownBlockView({
  block,
  referenceOptions,
  trailingInline,
}: {
  block: MarkdownBlock;
  blockKey?: string;
  referenceOptions?: ReviewReferenceOptions;
  trailingInline?: React.ReactNode;
}) {
  if (block.type === "code") {
    return <MarkdownCodeBlock content={block.content} language={block.language} />;
  }
  if (block.type === "heading") {
    const headingContent = (
      <>
        {renderInlineMarkdown(block.text, referenceOptions)}
        {trailingInline ?? null}
      </>
    );
    if (block.level === 1) return <h3>{headingContent}</h3>;
    if (block.level === 2) return <h4>{headingContent}</h4>;
    return <h5>{headingContent}</h5>;
  }
  if (block.type === "list") {
    const listItems = block.items.map((item, itemIndex) => (
      <li key={itemIndex}>
        {renderInlineMarkdown(item, referenceOptions)}
        {itemIndex === block.items.length - 1 ? trailingInline ?? null : null}
      </li>
    ));
    return block.ordered ? <ol>{listItems}</ol> : <ul>{listItems}</ul>;
  }
  if (block.type === "table") {
    return (
      <div className="markdownTableWrapper">
        <table>
          <thead>
            <tr>
              {block.headers.map((header, headerIndex) => (
                <th key={headerIndex}>{renderInlineMarkdown(header, referenceOptions)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{renderInlineMarkdown(cell, referenceOptions)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <p>
      {renderInlineMarkdown(block.text, referenceOptions)}
      {trailingInline ?? null}
    </p>
  );
}

// Settled blocks never change once streamed past, so a stable serialized key
// lets every block before the live tail skip re-rendering entirely.
const MemoizedMarkdownBlockView = React.memo(
  MarkdownBlockView,
  (previous, next) => previous.blockKey === next.blockKey && previous.referenceOptions === next.referenceOptions,
);

export function MarkdownContent({
  content,
  onReviewFileClick,
  reviewFiles,
  trailingInline,
}: { content: string; trailingInline?: React.ReactNode } & ReviewReferenceOptions) {
  const blocks = useMemo(() => parseMarkdown(content), [content]);
  const referenceOptions = useMemo(() => ({ onReviewFileClick, reviewFiles }), [onReviewFileClick, reviewFiles]);
  return (
    <div className="markdownContent">
      {blocks.map((block, index) => (
        <MarkdownBlockView
          key={index}
          block={block}
          referenceOptions={referenceOptions}
          trailingInline={index === blocks.length - 1 ? trailingInline : undefined}
        />
      ))}
    </div>
  );
}

export function LongMarkdownContent({
  content,
  onReviewFileClick,
  reviewFiles,
  trailingInline,
}: { content: string; trailingInline?: React.ReactNode } & ReviewReferenceOptions) {
  const [expanded, setExpanded] = useState(false);
  const preview = useMemo(() => markdownPreview(content, markdownPreviewCharacterLimit), [content]);
  const displayContent = expanded || !preview.truncated ? content : preview.text;
  return (
    <>
      <MarkdownContent content={displayContent} onReviewFileClick={onReviewFileClick} reviewFiles={reviewFiles} trailingInline={trailingInline} />
      {preview.truncated ? (
        <div className="messageOverflowNotice">
          <span>
            Showing a preview of a long response ({content.length.toLocaleString()} characters).
          </span>
          <button type="button" onClick={() => setExpanded((current) => !current)}>
            {expanded ? "Show preview" : "Show full response"}
          </button>
        </div>
      ) : null}
    </>
  );
}

// The live tail block re-renders as markdown with unfinished inline syntax
// stabilized first, so styling appears progressively instead of popping from
// plain text to formatted at each paragraph boundary. Everything before the
// tail is memoized per block and never re-parsed into DOM. parseMarkdown
// already renders an unterminated ``` fence as a code block, so the split is
// fence-safe by construction.
function stabilizedStreamingBlock(block: MarkdownBlock): MarkdownBlock {
  if (block.type === "paragraph" || block.type === "heading") {
    return { ...block, text: stabilizeStreamingInlineText(block.text) };
  }
  if (block.type === "list" && block.items.length) {
    const items = [...block.items];
    items[items.length - 1] = stabilizeStreamingInlineText(items[items.length - 1]);
    return { ...block, items };
  }
  return block;
}

function StreamingMarkdownContent({ content, caretClassName }: { content: string; caretClassName: string }) {
  const blocks = useMemo(() => parseMarkdown(content), [content]);
  const blockKeys = useMemo(() => blocks.map((block) => JSON.stringify(block)), [blocks]);
  const caret = <span className={caretClassName} aria-hidden="true" />;
  const lastBlock = blocks.at(-1);
  const caretInline =
    !!lastBlock && (lastBlock.type === "paragraph" || lastBlock.type === "heading" || lastBlock.type === "list");
  return (
    <div className="markdownContent">
      {blocks.map((block, index) =>
        index < blocks.length - 1 ? (
          <MemoizedMarkdownBlockView key={index} block={block} blockKey={blockKeys[index]} />
        ) : (
          <MarkdownBlockView
            key={index}
            block={stabilizedStreamingBlock(block)}
            trailingInline={caretInline ? caret : undefined}
          />
        ),
      )}
      {caretInline ? null : caret}
    </div>
  );
}

function StreamingTextContent({ content }: { content: string }) {
  return (
    <div className="streamingTextContent">
      <StreamingMarkdownContent content={content} caretClassName="streamingTextCaret" />
    </div>
  );
}
export function WorkMarkdownContent({ content, streaming = false }: { content: string; streaming?: boolean }) {
  if (streaming) {
    return (
      <div className="workMarkdownContent isStreaming">
        <StreamingMarkdownContent content={content} caretClassName="workStreamingCaret" />
      </div>
    );
  }
  return (
    <div className="workMarkdownContent">
      <MarkdownContent content={content} />
    </div>
  );
}
function normalizeSkillPreviewHeading(value: string): string {
  return value.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function skillPreviewMarkdown(content: string, skillName: string): string {
  const lines = content.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "").trim().split(/\r?\n/);
  if (lines[0]?.startsWith("# ") && normalizeSkillPreviewHeading(lines[0]) === normalizeSkillPreviewHeading(skillName)) {
    lines.shift();
    while (lines[0]?.trim() === "") lines.shift();
  }
  return lines.join("\n").trim();
}

export function filterSkillsBySource(skills: SkillInfo[], filter: SkillSourceFilter): SkillInfo[] {
  return skills.filter((skill) => skill.source === filter);
}

export function skillGovernanceLabel(skill: SkillInfo): string {
  if (skill.checksumStatus === "modified" || skill.modified) return "Modified";
  if (skill.checksumStatus === "untracked") return "Untracked";
  return "";
}

function SkillGovernance({ skill }: { skill: SkillInfo }) {
  const label = skillGovernanceLabel(skill);
  if (!label) return null;
  return <span className={`skillGovernance ${label === "Modified" ? "isModified" : ""}`}>{label}</span>;
}

function ReviewSummaryCard({
  files,
  diffs,
  onOpenReview,
  totals,
}: {
  files: ReviewFile[];
  diffs: Map<string, ParsedDiff>;
  onOpenReview(filePath?: string): void;
  totals: { additions: number; deletions: number };
}) {
  if (!files.length) return null;
  return (
    <article className="reviewSummaryCard">
      <button className="reviewSummaryHeader" type="button" onClick={() => onOpenReview()}>
        <span className="reviewSummaryTitle">
          <FileText size={15} />
          <strong>
            {files.length} file{files.length === 1 ? "" : "s"} changed
          </strong>
          <span className="additions">+{totals.additions}</span>
          <span className="deletions">-{totals.deletions}</span>
        </span>
        <span className="reviewSummaryReviewButton">
          <span>Review</span>
          <ExternalLink size={13} />
        </span>
      </button>
      <div className="reviewSummaryFiles">
        {files.map((file) => {
          const stats = diffs.get(file.path) ?? emptyParsedDiff;
          return (
            <section className={`reviewSummaryFile status-${file.status}`} key={file.path}>
              <button
                className="reviewSummaryFileButton"
                type="button"
                onClick={() => onOpenReview(file.path)}
              >
                <span className="reviewSummaryPath">{file.path}</span>
                <span className="changeStats" aria-label={formatDiffStats(stats)}>
                  <span className="additions">+{stats.additions}</span>
                  <span className="deletions">-{stats.deletions}</span>
                </span>
                <PanelRight className="reviewSummaryOpenIcon" size={14} />
              </button>
            </section>
          );
        })}
      </div>
    </article>
  );
}

export function documentReviewDisplayName(filePath: string): string {
  const fileName = filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
  const stem = fileName.replace(/\.docx$/i, "");
  const title = stem
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
  return title || fileName;
}

function DocumentReviewResponseLink({
  file,
  onOpenReview,
}: {
  file: ReviewFile;
  onOpenReview(filePath: string): void;
}) {
  const fileName = file.path.replace(/\\/g, "/").split("/").pop() ?? file.path;
  return (
    <button
      className="documentResponseLink"
      type="button"
      onClick={() => onOpenReview(file.path)}
      aria-label={`Review ${documentReviewDisplayName(file.path)} document`}
    >
      <span className="documentResponseIcon"><FileText size={17} aria-hidden="true" /></span>
      <span className="documentResponseIdentity">
        <strong>{documentReviewDisplayName(file.path)}</strong>
        <small>{fileName}</small>
      </span>
      <span className="documentResponseAction">Review <ChevronRight size={13} aria-hidden="true" /></span>
    </button>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function elementDistanceFromBottom(node: HTMLElement) {
  return node.scrollHeight - node.scrollTop - node.clientHeight;
}

function isElementNearBottom(node: HTMLElement, threshold = 72) {
  return elementDistanceFromBottom(node) < threshold;
}

function isElementAtBottom(node: HTMLElement) {
  return elementDistanceFromBottom(node) < 4;
}

function scrollElementToBottom(node: HTMLElement, behavior: ScrollBehavior = "auto") {
  const scrollBehavior = behavior === "smooth" && prefersReducedMotion() ? "auto" : behavior;
  const scroll = () => {
    if (scrollBehavior === "auto") {
      node.scrollTop = node.scrollHeight;
      return;
    }
    node.scrollTo({ top: node.scrollHeight, behavior: scrollBehavior });
  };
  scroll();
  window.requestAnimationFrame(() => {
    scroll();
  });
}

function placeElementAtBottom(node: HTMLElement) {
  node.scrollTop = node.scrollHeight;
}

function App({ startupSettings }: { startupSettings: DesktopStartupSettings }) {
  const initialHarnessProfile = isHarnessProfileId(startupSettings.harnessProfile) ? startupSettings.harnessProfile : defaultHarnessProfileId;
  const initialContextLength = normalizeContextLength(startupSettings.contextLength);
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  const [repository, setRepository] = useState<RepositoryInfo | null>(previewEnvironment?.repository ?? null);
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>(startupSettings.permissionMode);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(() => readWorkspaceMode());
  const reasoningMode: ReasoningMode = "reasoning";
  const [projects, setProjects] = useState<RepositoryInfo[]>(previewEnvironment ? [previewEnvironment.repository] : []);
  const [chats, setChats] = useState<ChatRecord[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [task, setTask] = useState<TaskInfo | null>(previewEnvironment?.task ?? null);
  const [prompt, setPrompt] = useState(previewEnvironment?.prompt ?? initialPrompt);
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedComposerPrompt[]>([]);
  const unsavedDraftScope = unsavedDraftScopeFor(repository?.rootPath);
  const [steerPending, setSteerPending] = useState(false);
  const [reviewPromptFeedback, setReviewPromptFeedback] = useState<ReviewCommentDraft[]>([]);
  const [reviewFeedbackDialogOpen, setReviewFeedbackDialogOpen] = useState(false);
  const [reviewFeedbackPreview, setReviewFeedbackPreview] = useState<ReviewFeedbackReference[] | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<ChatAttachment[]>(previewEnvironment?.attachments ?? []);
  const [previewAttachment, setPreviewAttachment] = useState<ChatAttachment | null>(null);
  const [fileMatches, setFileMatches] = useState<FileSearchResult[]>([]);
  const [mention, setMention] = useState<PromptMention | null>(null);
  const [mentionScope, setMentionScope] = useState<MentionCategoryId | null>(null);
  const [selectedCategoryIndex, setSelectedCategoryIndex] = useState(0);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [selectedSkillIndex, setSelectedSkillIndex] = useState(0);
  const [promptScrollTop, setPromptScrollTop] = useState(0);
  const [deleteCandidate, setDeleteCandidate] = useState<DeleteCandidate | null>(null);
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<Set<string>>(() => new Set());
  const [collapsedWorktreeKeys, setCollapsedWorktreeKeys] = useState<Set<string>>(() => new Set());
  const [projectActionMenuKey, setProjectActionMenuKey] = useState<string | null>(null);
  const [events, setEvents] = useState<BackendUiEvent[]>(previewEnvironment?.events ?? []);
  const [responseFeedbackDialog, setResponseFeedbackDialog] = useState<ResponseFeedbackDialogState | null>(null);
  const [responseFeedbackSubmitting, setResponseFeedbackSubmitting] = useState(false);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [approvalChecks, setApprovalChecks] = useState<ApprovalCheck[]>([]);
  const [expandedReviewPaths, setExpandedReviewPaths] = useState<Set<string>>(() =>
    previewEnvironment ? new Set(previewEnvironment.reviewFiles.map((file) => file.path)) : new Set(),
  );
  const [expandedActivityIds, setExpandedActivityIds] = useState<Set<string>>(() => new Set());
  const autoOpenedActivityIdsRef = useRef<Set<string>>(new Set());
  const [expandedActivityToolIds, setExpandedActivityToolIds] = useState<Set<string>>(() => new Set());
  const [activityClock, setActivityClock] = useState(() => Date.now());
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewClosing, setReviewClosing] = useState(false);
  const [reviewOffset, setReviewOffset] = useState(0);
  const [reviewTargetPath, setReviewTargetPath] = useState<string | undefined>();
  const [workspaceReview, setWorkspaceReview] = useState<{ reviewFiles: ReviewFile[]; baselineOid: string } | null>(null);
  const [tasklessReviewScope, setTasklessReviewScope] = useState<"task" | "worktree">("task");
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [checkoutPending, setCheckoutPending] = useState(false);
  const [workspaceModeMenuOpen, setWorkspaceModeMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"account" | "harness" | "appearance" | "skills" | "telemetry">("account");
  const [harnessProfile, setHarnessProfile] = useState<HarnessProfileId>(initialHarnessProfile);
  const [harnessDraftProfile, setHarnessDraftProfile] = useState<HarnessProfileId>(initialHarnessProfile);
  const [contextLength, setContextLength] = useState(initialContextLength);
  const [harnessDraftContextLength, setHarnessDraftContextLength] = useState(initialContextLength);
  const [harnessMessage, setHarnessMessage] = useState<string | null>(null);
  const [harnessSaving, setHarnessSaving] = useState(false);
  const [harnessSaveFeedback, setHarnessSaveFeedback] = useState<"idle" | "saved">("idle");
  const [appearanceSettings, setAppearanceSettings] = useState<AppearanceSettings>(() => {
    const saved = readAppearanceSettings();
    const fixtureTheme = previewEnvironment?.params.get("theme");
    return previewEnvironment && (fixtureTheme === "light" || fixtureTheme === "dark")
      ? { ...saved, theme: fixtureTheme }
      : saved;
  });
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true);
  const [availableFontFamilies, setAvailableFontFamilies] = useState<string[]>(() =>
    uniqueFonts([...defaultUiFontChoices, ...defaultMonoFontChoices]),
  );
  const [fontScanMessage, setFontScanMessage] = useState<string | null>(null);
  const [fontScanPending, setFontScanPending] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [skillsEnabled, setSkillsEnabled] = useState<Record<string, boolean>>({});
  const [skillsMessage, setSkillsMessage] = useState<string | null>(null);
  const [localLogsBusy, setLocalLogsBusy] = useState(false);
  const [newSkillFormOpen, setNewSkillFormOpen] = useState(false);
  const [newSkillName, setNewSkillName] = useState("");
  const [creatingSkill, setCreatingSkill] = useState(false);
  const [skillSourceFilter, setSkillSourceFilter] = useState<SkillSourceFilter>("local");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [skillDocument, setSkillDocument] = useState<SkillDocument | null>(null);
  const [skillPreviewLoading, setSkillPreviewLoading] = useState(false);
  const [ideMenuOpen, setIdeMenuOpen] = useState<"composer" | "review" | null>(null);
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [availableIdes, setAvailableIdes] = useState<IdeChoice[]>(defaultIdeChoices);
  const [selectedIdeId, setSelectedIdeId] = useState(defaultIdeChoices[0].id);
  const [sidebarWidth, setSidebarWidth] = useState(sidebarDefaultWidth);
  const [reviewWidth, setReviewWidth] = useState(reviewDefaultWidth);
  const [reviewHasSessionWidth, setReviewHasSessionWidth] = useState(false);
  const [showElevatedPermissionsDialog, setShowElevatedPermissionsDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connectionSettings = useConnectionSettings({
    api,
    backend,
    initialSettings: startupSettings.modelEndpoint,
    initialLocalModels: startupSettings.localModels,
    initialConnection: startupSettings.companyConnection,
    settingsOpen,
    active: settingsTab === "account",
    onBackendStatus: (status) => {
      setBackend(status);
      setPermissionModeState(status.permissionMode);
    },
  });
  const endpointSettings = connectionSettings.settings;
  const endpointDraftSettings = connectionSettings.draft;
  const streamRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentMenuRef = useRef<HTMLDivElement | null>(null);
  const draftSaveRef = useRef<number | null>(null);
  const lastPersistedDraftRef = useRef<Map<string, { draftPrompt: string; filesSignature: string }>>(new Map());
  const reviewAnimationRef = useRef<number | null>(null);
  const reviewOffsetRef = useRef(0);
  const reviewVelocityRef = useRef(0);
  const reviewScopeRequestRef = useRef(0);
  const modalTriggerRef = useRef<HTMLElement | null>(null);
  const modalRef = useRef<HTMLElement | null>(null);
  const responseFeedbackInputRef = useRef<HTMLTextAreaElement | null>(null);
  const skillsSaveSequenceRef = useRef(0);
  const skillsLoadedRef = useRef(false);
  const suppressDraftSaveRef = useRef(false);
  // Read by the async unsaved-draft restore, which must see the live value
  // rather than the one captured when it started.
  const activeChatIdRef = useRef<string | null>(null);
  activeChatIdRef.current = activeChatId;
  const reviewRefreshRef = useRef(false);
  const appBlurredRef = useRef(false);
  const startTaskInFlightRef = useRef(false);
  const chatSelectionSequenceRef = useRef(0);
  const focusRefreshTimerRef = useRef<number | null>(null);
  const followComposerScrollRef = useRef(true);
  const forceComposerBottomScrollRef = useRef(false);
  const composerScrollInputRef = useRef(false);
  const activityBodyRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const activityFollowScrollRef = useRef<Map<string, boolean>>(new Map());
  const activityScrollInputRef = useRef<Set<string>>(new Set());
  const visibleTaskIdRef = useRef<string | null>(previewEnvironment?.task.id ?? null);
  const taskEventsByTaskIdRef = useRef<Map<string, BackendUiEvent[]>>(new Map());

  const latestTaskId = task?.id;
  const rawReviewFiles = task?.reviewFiles ?? workspaceReview?.reviewFiles ?? emptyReviewFiles;
  const reviewFiles = useMemo(() => {
    const byPath = new Map<string, ReviewFile>();
    for (const file of rawReviewFiles) {
      const normalized = normalizeReviewFile(file);
      byPath.set(normalized.path, normalized);
    }
    return Array.from(byPath.values());
  }, [rawReviewFiles]);
  const documentReviewFiles = useMemo(
    () => reviewFiles.filter((file) => isDocumentReviewArtifactPath(file.path)),
    [reviewFiles],
  );
  const codeReviewFiles = useMemo(
    () => reviewFiles.filter((file) => !isDocumentReviewArtifactPath(file.path)),
    [reviewFiles],
  );
  const reviewDiffs = useMemo(
    () => new Map(reviewFiles.map((file) => [file.path, parseUnifiedDiff(file.patch)])),
    [reviewFiles],
  );
  const codeReviewTotals = useMemo(
    () =>
      codeReviewFiles.reduce(
        (total, file) => {
          const stats = reviewDiffs.get(file.path) ?? emptyParsedDiff;
          total.additions += stats.additions;
          total.deletions += stats.deletions;
          return total;
        },
        { additions: 0, deletions: 0 },
      ),
    [codeReviewFiles, reviewDiffs],
  );
  const selectedIde = availableIdes.find((ide) => ide.id === selectedIdeId) ?? availableIdes[0] ?? defaultIdeChoices[0];
  const selectedModel = backend?.model ?? null;
  const harnessDirty = harnessDraftProfile !== harnessProfile || harnessDraftContextLength !== contextLength;
  const harnessDraftContextIndex = Math.max(
    0,
    CONTEXT_LENGTH_OPTIONS.findIndex((option) => option === harnessDraftContextLength),
  );
  const telemetrySyncEnabled = backend?.diagnostics.telemetry.syncEnabled ?? endpointSettings.mode === "server";
  const localLogInfo = backend?.diagnostics.localLogs ?? { bytes: 0, entries: 0 };
  const activeChat = activeChatId ? chats.find((chat) => chat.id === activeChatId) : undefined;
  const closedChatNotice = closedChatMessage(task?.state ?? activeChat?.taskState);
  const isGenerating = task?.state === "running";
  const hasComposerMessage = prompt.trim().length > 0 || reviewPromptFeedback.length > 0;
  const activeQueuedPrompts = task ? queuedPrompts.filter((item) => item.taskId === task.id) : [];
  const canStart = (prompt.trim().length > 0 || reviewPromptFeedback.length > 0) && !busy && !isGenerating && !closedChatNotice;
  const canQueue = hasComposerMessage && isGenerating && !busy && !steerPending && !closedChatNotice;
  const canApprove = task?.state === "review_ready" && reviewFiles.length > 0 && !busy;
  const canUndo =
    !!task && task.state !== "approved" && task.state !== "merged" && task.state !== "rejected" && task.state !== "completed" && !busy;
  const canOpenIde = !!task && task.state !== "merged" && task.state !== "rejected" && task.state !== "completed";
  const approvalPending = task?.state === "awaiting_worktree_approval" || !!pendingPermission;
  const reviewEmptyLabel = !task
    ? "No active review"
    : task.state === "review_ready"
      ? "No file changes found"
      : stateLabel(task.state);
  const mentionQuery = mention?.query ?? "";
  // The @ menu walks through modes: "category" (just pressed @ — pick Files,
  // Folders, or Skills), a scoped search, or "all" (typed straight through the
  // category list). The $ trigger jumps directly to skills.
  const mentionMode: "category" | FileSearchKind | "skill" | null = !mention
    ? null
    : mention.kind === "skill" || mentionScope === "skill"
      ? "skill"
      : mentionScope === "file" || mentionScope === "folder"
        ? mentionScope
        : mentionQuery
          ? "all"
          : "category";
  const promptReferenceMenuOpen = mentionMode !== null;
  const categoryMenuOpen = mentionMode === "category";
  const fileSearchKind: FileSearchKind | null =
    mentionMode === "file" || mentionMode === "folder" || mentionMode === "all" ? mentionMode : null;
  const attachmentSearchQuery = fileSearchKind ? mentionQuery : "";
  const skillMenuOpen = mentionMode === "skill";
  const skillSearchQuery = skillMenuOpen ? mentionQuery : "";
  const skillMatches = useMemo(() => rankSkillMatches(skills, skillSearchQuery, 10), [skillSearchQuery, skills]);
  const selectedSkillPreview = useMemo(
    () => (skillDocument ? skillPreviewMarkdown(skillDocument.content, skillDocument.name) : ""),
    [skillDocument],
  );
  const visibleSkills = useMemo(
    () => filterSkillsBySource(skills, skillSourceFilter),
    [skillSourceFilter, skills],
  );
  const canAttachFiles = !busy && !closedChatNotice;
  const canUseWorktreeMode = repository?.kind === "git";
  const activeTaskWorkspaceMode = task?.chatId === activeChatId ? task.workspaceMode : undefined;
  const activeChatWorktreeTaskId = activeChat?.worktreeRootTaskId || (activeChat?.worktreePath ? activeChat.taskId : undefined);
  const workspaceModeLocked = activeTaskWorkspaceMode === "worktree" || !!activeChatWorktreeTaskId;
  const useWorktreeForNextRun = canUseWorktreeMode && (workspaceModeLocked || workspaceMode === "worktree");
  const visibleEvents = events;
  const responseFeedback = useMemo(() => {
    const ratings = new Map<string, "good" | "bad">();
    for (const event of visibleEvents) {
      if (event.type === "response.feedback") {
        ratings.set(event.messageId, event.rating);
      }
    }
    return ratings;
  }, [visibleEvents]);
  const composerItems = useMemo(() => {
    const items = composerTimelineFromEvents(visibleEvents, task?.prompt, task?.state);
    // Soft bound for very long chats: keep the newest composer items without a full virtualizer rewrite.
    const composerItemSoftLimit = 120;
    return items.length <= composerItemSoftLimit ? items : items.slice(-composerItemSoftLimit);
  }, [task?.prompt, task?.state, visibleEvents]);
  const lastAssistantItemId = [...composerItems].reverse().find((item) => item.type === "assistant")?.id;
  const reviewReadyForDisplay =
    task?.state === "review_ready"
    || task?.state === "approving"
    || task?.state === "approved"
    || task?.state === "merged"
    || task?.state === "rejected";
  const runnerContextUsage = useMemo(() => {
    for (let index = visibleEvents.length - 1; index >= 0; index -= 1) {
      const event = visibleEvents[index];
      if (event.type === "context.usage") return event;
    }
    return null;
  }, [visibleEvents]);
  // The meter's own busy state, read from the compaction lifecycle rather than
  // inferred from a stale usage number: while the prefix is being rewritten the
  // figure on the ring describes a conversation that no longer exists.
  const contextCompacting = useMemo(() => {
    for (let index = visibleEvents.length - 1; index >= 0; index -= 1) {
      const event = visibleEvents[index];
      if (event.type === "context.compaction") return event.phase === "started";
    }
    return false;
  }, [visibleEvents]);
  const providerReconnect = useMemo(
    () => providerReconnectFromEvents(visibleEvents),
    [visibleEvents],
  );
  const contextMeterLabel = contextMeterState(runnerContextUsage);
  const contextEstimateMessages = useMemo<ContextEstimateMessage[]>(() => {
    const messages = runnerContextUsage ? [] : composerItems.map((item): ContextEstimateMessage => {
      if (item.type === "user") return { text: item.rawText, attachments: item.attachedFiles };
      if (item.type === "assistant") return { text: item.text };
      // A compaction marker is UI, not conversation: it contributes no tokens
      // to the context it is describing.
      if (item.type === "compaction") return { text: "" };
      return {
        text: item.segments
          .map((segment) =>
            segment.type === "reasoning"
              ? segment.text
              : segment.type === "skill"
                ? segment.skillId
                : [segment.run.command, segment.run.stdout, segment.run.stderr].filter(Boolean).join("\n"),
          )
          .filter(Boolean)
          .join("\n"),
      };
    });
    if (prompt.trim() || attachedFiles.length) messages.push({ text: prompt, attachments: attachedFiles });
    return messages;
  }, [attachedFiles, composerItems, prompt, runnerContextUsage]);
  const contextEstimate = useMemo(
    () => estimateContextUsage(
      contextEstimateMessages,
      runnerContextUsage?.contextLength ?? contextLength,
      runnerContextUsage
        ? {
            contentTokens: runnerContextUsage.contentTokens,
            reserveTokens: prompt.trim() || attachedFiles.length ? undefined : runnerContextUsage.reserveTokens,
            protectedTokens: runnerContextUsage.protectedTokens,
          }
        : undefined,
    ),
    [attachedFiles.length, contextEstimateMessages, contextLength, prompt, runnerContextUsage],
  );
  // What the composer adds on top of whatever the runner last reported. Before
  // the first response there is no measured base, and the local estimate folds
  // the protected reserve into contentTokens, so that reserve is subtracted
  // here — otherwise the draft row would report the system prompt as typing.
  const composerDraftTokens = Math.max(
    0,
    contextEstimate.contentTokens - (runnerContextUsage?.contentTokens ?? contextEstimate.protectedTokens),
  );
  const showContextMeter = shouldShowContextMeter({
    hasRunnerUsage: !!runnerContextUsage,
    timelineItemCount: composerItems.length,
    prompt,
    attachmentCount: attachedFiles.length,
  });
  const assistantCopyText = useMemo(() => assistantTextFromEvents(visibleEvents), [visibleEvents]);
  const chatProjectGroups = useMemo(() => {
    type ChatProjectGroupBuilder = ChatProjectGroup & { worktreeMap: Map<string, WorktreeChatGroup> };
    const groups = new Map<string, ChatProjectGroupBuilder>();
    for (const project of projects) {
      groups.set(project.rootPath, {
        key: project.rootPath,
        name: project.name,
        path: project.rootPath,
        chats: [],
        worktrees: [],
        worktreeMap: new Map(),
      });
    }
    for (const chat of chats) {
      const key = chatProjectKey(chat);
      let existing = groups.get(key);
      if (!existing) {
        existing = {
          key,
          name: chat.repositoryName || folderName(chat.repositoryPath),
          path: chat.repositoryPath,
          chats: [],
          worktrees: [],
          worktreeMap: new Map(),
        };
        groups.set(key, existing);
      }
      const worktreeKey = chatWorktreeKey(chat);
      if (worktreeKey && chat.worktreePath) {
        let worktree = existing.worktreeMap.get(worktreeKey);
        if (!worktree) {
          worktree = {
            key: worktreeKey,
            rootTaskId: chat.worktreeRootTaskId || chat.taskId || worktreeKey,
            branch: chat.worktreeBranch || folderName(chat.worktreePath),
            path: chat.worktreePath,
            baseCommit: chat.worktreeBaseCommit,
            chats: [],
          };
          existing.worktreeMap.set(worktreeKey, worktree);
        }
        worktree.chats.push(chat);
      } else {
        existing.chats.push(chat);
      }
    }
    return Array.from(groups.values())
      .map((group) => ({
        key: group.key,
        name: group.name,
        path: group.path,
        chats: [...group.chats].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
        worktrees: Array.from(group.worktreeMap.values())
          .map((worktree) => ({
            ...worktree,
            chats: [...worktree.chats].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
          }))
          .sort((left, right) => {
            const leftUpdated = left.chats[0]?.updatedAt ?? "";
            const rightUpdated = right.chats[0]?.updatedAt ?? "";
            return rightUpdated.localeCompare(leftUpdated) || worktreeTitle(left).localeCompare(worktreeTitle(right));
          }),
      }))
      .sort((left, right) => {
        if (left.key === "__unassigned__") return 1;
        if (right.key === "__unassigned__") return -1;
        return left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) || left.key.localeCompare(right.key);
      });
  }, [chats, projects]);
  const layoutStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    "--sidebar-reserved-width": `${sidebarDefaultWidth}px`,
    "--sidebar-visual-gap": `${Math.max(0, sidebarDefaultWidth - sidebarWidth)}px`,
    "--review-width": `${reviewWidth}px`,
    "--review-offset": `${reviewOffset}px`,
  } as React.CSSProperties;
  const reviewLayoutOpen = reviewOpen || reviewClosing;
  const todayPromptLabel = repository ? `What should we build in ${repository.name}?` : "What should we build today?";
  const composerHeaderTitle = activeChat
    ? chatDisplayTitle(activeChat)
    : task?.prompt
      ? titleFromPrompt(task.prompt)
      : "New chat";
  const composerHeaderMeta = repository?.name ?? "No folder selected";
  const effectiveTheme = appearanceSettings.theme === "system" ? (systemPrefersDark ? "dark" : "light") : appearanceSettings.theme;
  const uiFontOptions = useMemo(
    () => uniqueFonts([...defaultUiFontChoices, appearanceSettings.uiFont, ...availableFontFamilies]),
    [appearanceSettings.uiFont, availableFontFamilies],
  );
  const monoFontOptions = useMemo(
    () => uniqueFonts([...defaultMonoFontChoices, appearanceSettings.monoFont, ...availableFontFamilies]),
    [appearanceSettings.monoFont, availableFontFamilies],
  );

  function cacheTaskEvents(nextEvents: BackendUiEvent[]) {
    if (!nextEvents.length) return;
    const grouped = new Map<string, BackendUiEvent[]>();
    for (const event of nextEvents) {
      const group = grouped.get(event.taskId) ?? [];
      group.push(event);
      grouped.set(event.taskId, group);
    }
    for (const [taskId, group] of grouped) {
      const cached = taskEventsByTaskIdRef.current.get(taskId) ?? [];
      taskEventsByTaskIdRef.current.delete(taskId);
      taskEventsByTaskIdRef.current.set(taskId, compactBackendEvents([...cached, ...group], 500));
    }
    while (taskEventsByTaskIdRef.current.size > maxCachedTaskEventGroups) {
      const oldestTaskId = taskEventsByTaskIdRef.current.keys().next().value;
      if (!oldestTaskId) break;
      taskEventsByTaskIdRef.current.delete(oldestTaskId);
    }
  }

  function cachedEventsForTask(taskId?: string): BackendUiEvent[] {
    return taskId ? (taskEventsByTaskIdRef.current.get(taskId) ?? []) : [];
  }

  function visibleEventsForTask(nextTask: TaskInfo): BackendUiEvent[] {
    const cached = cachedEventsForTask(nextTask.id);
    const persisted = nextTask.events ?? [];
    if (nextTask.state === "running" && persisted.length && cached.length) {
      const latestPersistedTime = persisted.reduce((latest, event) => {
        const current = eventTimelineTime(event);
        return current > latest ? current : latest;
      }, "");
      return compactBackendEvents([
        ...persisted,
        ...cached.filter((event) => eventTimelineTime(event) > latestPersistedTime),
      ], 500);
    }
    if (persisted.length) {
      return compactBackendEvents(persisted, 500);
    }
    return compactBackendEvents(cached, 500);
  }

  function setVisibleTask(nextTask: TaskInfo | null) {
    visibleTaskIdRef.current = nextTask?.id ?? null;
    setResponseFeedbackDialog(null);
    if (nextTask) setWorkspaceReview(null);
    setTask(nextTask);
  }

  function prepareVisibleTaskLoad(taskId: string | null) {
    visibleTaskIdRef.current = taskId;
    setResponseFeedbackDialog(null);
    setWorkspaceReview(null);
    setTask(null);
  }

  useEffect(() => {
    if (task) return;
    setWorkspaceReview(null);
    setTasklessReviewScope("task");
  }, [repository?.rootPath]);

  useEffect(() => {
    writeAppearanceSettings(appearanceSettings);
    document.documentElement.dataset.theme = effectiveTheme;
    document.documentElement.style.colorScheme = effectiveTheme;
    document.documentElement.style.setProperty(
      "--app-font",
      cssFontValue(appearanceSettings.uiFont, "system-ui, sans-serif"),
    );
    document.documentElement.style.setProperty(
      "--mono-font",
      cssFontValue(appearanceSettings.monoFont, "ui-monospace, SFMono-Regular, Consolas, monospace"),
    );
    void api.setWindowChromeTheme(effectiveTheme);
  }, [appearanceSettings, effectiveTheme]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const sync = () => setSystemPrefersDark(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  const hasRunningActivity = composerItems.some((item) => item.type === "activity" && !item.finished);

  useEffect(() => {
    if (!hasRunningActivity) return undefined;
    const timer = window.setInterval(() => setActivityClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasRunningActivity]);

  useEffect(() => {
    const activeActivityToolIds = new Set<string>();
    for (const item of composerItems) {
      if (item.type !== "activity") continue;
      for (const segment of item.segments) {
        if (segment.type === "command") {
          activeActivityToolIds.add(`${item.id}:${segment.id}`);
        }
      }
    }
    setExpandedActivityIds((current) => {
      const next = reconcileActivityDisclosureState(
        current,
        composerItems,
        task?.id,
        autoOpenedActivityIdsRef.current,
      );
      autoOpenedActivityIdsRef.current = next.autoOpenedKeys;
      for (const id of next.newlyOpenedIds) {
        activityFollowScrollRef.current.set(id, true);
      }
      return next.expandedIds;
    });
    setExpandedActivityToolIds((current) => {
      let changed = false;
      const next = new Set(current);
      for (const id of next) {
        if (activeActivityToolIds.has(id)) continue;
        next.delete(id);
        changed = true;
      }
      return changed ? next : current;
    });
  }, [composerItems, task?.id]);

  useEffect(() => {
    void refreshStatus();
    void loadAvailableIdes();
    void loadProjects();
    void loadChats();
    void loadSkills();
    const statusTimer = window.setInterval(() => void refreshStatus(), 30000);
    const pendingBackendEvents: BackendUiEvent[] = [];
    let backendEventFlushTimer: number | null = null;
    let backendEventFlushDisposed = false;
    const scheduleBackendEventFlush = () => {
      if (backendEventFlushDisposed) return;
      if (backendEventFlushTimer) return;
      backendEventFlushTimer = window.setTimeout(flushBackendEvents, streamingMarkdownRenderBatchIntervalMs);
    };
    const flushBackendEvents = () => {
      backendEventFlushTimer = null;
      const batch = takeBatchedBackendEvents(pendingBackendEvents);
      if (batch.length === 0) return;
      const visibleBatch = batch.filter((event) => !(event.type === "assistant.delta" && isReviewReadyText(event.text)));
      cacheTaskEvents(visibleBatch);
      const visibleTaskId = visibleTaskIdRef.current;
      const visibleTaskEvents = visibleTaskId ? visibleBatch.filter((event) => event.taskId === visibleTaskId) : [];
      if (visibleTaskEvents.length) {
        setEvents((current) => visibleTaskEvents.reduce((next, event) => appendBackendEvent(next, event, 500), current));
      }
      for (const event of visibleBatch) {
        const isVisibleTaskEvent = event.taskId === visibleTaskIdRef.current;
        const effects = taskEventEffects(event);
        if (isVisibleTaskEvent) {
          setTask((current) => reduceVisibleTask(current, event));
          setPendingPermission((current) => reducePendingPermission(current, event));
          setApprovalChecks((current) => reduceApprovalChecks(current, event));
          if (effects.errorMessage) setError(effects.errorMessage);
          if (effects.resetExpandedReview) setExpandedReviewPaths(new Set());
          if (effects.refreshReview) {
            window.setTimeout(() => {
              if (visibleTaskIdRef.current === event.taskId) {
                void refreshTaskReviewById(event.taskId);
              }
            }, 120);
          }
        }
        if (effects.reloadChats) void loadChats();
      }
      if (pendingBackendEvents.length) scheduleBackendEventFlush();
    };
    const unsubscribe = api.onBackendEvent((event) => {
      pendingBackendEvents.push(event);
      scheduleBackendEventFlush();
    });
    return () => {
      window.clearInterval(statusTimer);
      backendEventFlushDisposed = true;
      if (backendEventFlushTimer) {
        window.clearTimeout(backendEventFlushTimer);
        backendEventFlushTimer = null;
        flushBackendEvents();
      }
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const markBlurred = () => {
      appBlurredRef.current = true;
    };
    const refreshOnFocus = () => {
      if (!appBlurredRef.current) return;
      appBlurredRef.current = false;
      if (!reviewOpen || busy || task?.state !== "review_ready") return;
      if (focusRefreshTimerRef.current) {
        window.clearTimeout(focusRefreshTimerRef.current);
      }
      focusRefreshTimerRef.current = window.setTimeout(() => {
        focusRefreshTimerRef.current = null;
        window.requestAnimationFrame(() => {
          void refreshActiveReview();
        });
      }, 450);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        markBlurred();
      } else {
        refreshOnFocus();
      }
    };
    window.addEventListener("blur", markBlurred);
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      if (focusRefreshTimerRef.current) {
        window.clearTimeout(focusRefreshTimerRef.current);
        focusRefreshTimerRef.current = null;
      }
      window.removeEventListener("blur", markBlurred);
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [task?.id, task?.state, busy, reviewOpen]);

  useEffect(() => {
    if (availableIdes.length > 0 && !availableIdes.some((ide) => ide.id === selectedIdeId)) {
      setSelectedIdeId(availableIdes[0].id);
    }
  }, [availableIdes, selectedIdeId]);

  useEffect(() => {
    if (!canOpenIde && ideMenuOpen === "review") setIdeMenuOpen(null);
  }, [canOpenIde, ideMenuOpen]);

  useEffect(
    () => () => {
      if (reviewAnimationRef.current !== null) window.cancelAnimationFrame(reviewAnimationRef.current);
    },
    [],
  );

  useEffect(() => {
    const hidePointerWhileTyping = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.length === 1 || event.key === "Backspace" || event.key === "Delete" || event.key === "Enter") {
        document.body.classList.add("isKeyboardTyping");
      }
    };
    const restorePointer = () => document.body.classList.remove("isKeyboardTyping");
    document.addEventListener("keydown", hidePointerWhileTyping);
    document.addEventListener("pointermove", restorePointer);
    document.addEventListener("focusout", restorePointer);
    return () => {
      restorePointer();
      document.removeEventListener("keydown", hidePointerWhileTyping);
      document.removeEventListener("pointermove", restorePointer);
      document.removeEventListener("focusout", restorePointer);
    };
  }, []);

  useEffect(() => {
    const isOpen = settingsOpen || !!previewAttachment?.previewDataUrl || !!deleteCandidate || showElevatedPermissionsDialog || approvalPending || !!responseFeedbackDialog;
    if (!isOpen) {
      modalTriggerRef.current?.focus();
      modalTriggerRef.current = null;
      return;
    }
    if (!modalTriggerRef.current && document.activeElement instanceof HTMLElement) modalTriggerRef.current = document.activeElement;
    const focusModal = () => {
      const modal = modalRef.current;
      if (!modal) return;
      const target = modal.querySelector<HTMLElement>("[data-modal-autofocus], [autofocus], button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])");
      (target ?? modal).focus();
    };
    const frame = window.requestAnimationFrame(focusModal);
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !modalRef.current) return;
      const focusable = Array.from(modalRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"));
      if (!focusable.length) { event.preventDefault(); modalRef.current.focus(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", trapFocus);
    return () => { window.cancelAnimationFrame(frame); document.removeEventListener("keydown", trapFocus); };
  }, [settingsOpen, previewAttachment, deleteCandidate, showElevatedPermissionsDialog, approvalPending, responseFeedbackDialog]);

  useEffect(() => {
    if (!responseFeedbackDialog) return undefined;
    const frame = window.requestAnimationFrame(() => responseFeedbackInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [responseFeedbackDialog?.messageId, responseFeedbackDialog?.rating]);

  useEffect(() => {
    if (!reviewOpen) return undefined;
    const resizeReview = () => {
      setReviewWidth((current) => reviewHasSessionWidth
        ? clamp(current, reviewMinWidthForViewport(), reviewMaxWidth())
        : Math.min(reviewOpenWidth(), reviewMaxWidth()));
    };
    window.addEventListener("resize", resizeReview);
    return () => window.removeEventListener("resize", resizeReview);
  }, [reviewHasSessionWidth, reviewOpen]);

  useLayoutEffect(() => {
    const node = streamRef.current;
    if (!node) return;
    if (forceComposerBottomScrollRef.current) {
      if (composerItems.length === 0 && (activeChat?.taskId || task)) return;
      forceComposerBottomScrollRef.current = false;
      followComposerScrollRef.current = true;
      placeElementAtBottom(node);
      return;
    }
    if (followComposerScrollRef.current) scrollElementToBottom(node);
  }, [activeChat?.taskId, composerItems, task, prompt, reviewFiles.length, expandedReviewPaths, reviewOpen]);

  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node || node.selectionEnd !== prompt.length) return;
    node.scrollTop = node.scrollHeight;
    setPromptScrollTop(node.scrollTop);
  }, [prompt]);

  useLayoutEffect(() => {
    const activeActivityIds = new Set<string>();
    for (const item of composerItems) {
      if (item.type !== "activity") continue;
      activeActivityIds.add(item.id);
      const expanded = expandedActivityIds.has(item.id);
      const node = activityBodyRefs.current.get(item.id);
      if (!node || !expanded || item.finished) continue;
      if (activityFollowScrollRef.current.get(item.id) ?? true) {
        // Streaming updates arrive many times per second; direct following avoids
        // accumulating smooth-scroll animations beneath active wheel input.
        scrollElementToBottom(node);
      }
    }
    for (const id of activityFollowScrollRef.current.keys()) {
      if (activeActivityIds.has(id)) continue;
      activityFollowScrollRef.current.delete(id);
      activityScrollInputRef.current.delete(id);
    }
  }, [composerItems, expandedActivityIds]);

  useEffect(() => {
    const closeMenus = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (!target.closest(".branchControl")) setBranchMenuOpen(false);
      if (!target.closest(".workspaceModeControl")) setWorkspaceModeMenuOpen(false);
      if (!target.closest(".permissionControl")) setPermissionMenuOpen(false);
      if (!target.closest(".idePicker")) setIdeMenuOpen(null);
      if (!target.closest(".chatProjectActions")) setProjectActionMenuKey(null);
      if (!target.closest(".attachmentMenu")) setMention(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setBranchMenuOpen(false);
      setWorkspaceModeMenuOpen(false);
      setPermissionMenuOpen(false);
      setIdeMenuOpen(null);
      setProjectActionMenuKey(null);
      setMention(null);
    };
    document.addEventListener("pointerdown", closeMenus);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenus);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  useEffect(() => {
    if (suppressDraftSaveRef.current) return undefined;
    if (draftSaveRef.current) window.clearTimeout(draftSaveRef.current);
    const chatId = activeChatId;
    const scope = unsavedDraftScope;
    const draftPrompt = prompt;
    const files = attachedFiles;
    draftSaveRef.current = window.setTimeout(() => {
      // A chat that exists keeps its draft in its own row. One that does not
      // exist yet has no row to keep it in, so it goes to main-process memory
      // instead of being dropped on the next chat switch.
      if (chatId) void persistDraft(chatId, draftPrompt, files, { updateLocal: false });
      else void api.setUnsavedDraft({ scope, draftPrompt, attachedFiles: files }).catch(() => undefined);
    }, 250);
    return () => {
      if (draftSaveRef.current) window.clearTimeout(draftSaveRef.current);
    };
  }, [activeChatId, unsavedDraftScope, prompt, attachedFiles]);

  useEffect(() => {
    if (!fileSearchKind || !repository) {
      setFileMatches([]);
      setSelectedFileIndex(0);
      return undefined;
    }
    let canceled = false;
    const timer = window.setTimeout(async () => {
      try {
        const matches = await api.searchFiles({
          repositoryId: repository.id,
          query: attachmentSearchQuery,
          limit: 25,
          kind: fileSearchKind,
        });
        if (!canceled) {
          setFileMatches(matches);
          setSelectedFileIndex(0);
        }
      } catch (cause) {
        if (!canceled) {
          setFileMatches([]);
          setSelectedFileIndex(0);
          setError(String(cause instanceof Error ? cause.message : cause));
        }
      }
    }, 120);
    return () => {
      canceled = true;
      window.clearTimeout(timer);
    };
  }, [fileSearchKind, attachmentSearchQuery, repository?.id]);

  // A different mention (new trigger position or trigger character) starts the
  // picker over at the category step; refining the query keeps the scope.
  const mentionIdentityRef = useRef<string | null>(null);
  useEffect(() => {
    const identity = mention ? `${mention.kind}:${mention.start}` : null;
    if (mentionIdentityRef.current === identity) return;
    mentionIdentityRef.current = identity;
    setMentionScope(null);
    setSelectedCategoryIndex(0);
  }, [mention]);

  useEffect(() => {
    const menu = attachmentMenuRef.current;
    if (!menu || !categoryMenuOpen) return;
    menu.querySelector<HTMLButtonElement>(`[data-category-index="${selectedCategoryIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [categoryMenuOpen, selectedCategoryIndex]);

  useEffect(() => {
    const menu = attachmentMenuRef.current;
    if (!menu || !fileMatches.length) return;
    menu.querySelector<HTMLButtonElement>(`[data-file-index="${selectedFileIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [fileMatches.length, selectedFileIndex]);

  useEffect(() => {
    const menu = attachmentMenuRef.current;
    if (!menu || !skillMatches.length) return;
    menu.querySelector<HTMLButtonElement>(`[data-skill-index="${selectedSkillIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedSkillIndex, skillMatches.length]);

  useEffect(() => {
    setSelectedSkillIndex(0);
  }, [skillSearchQuery]);

  useEffect(() => {
    if (!selectedSkillId || skills.some((skill) => skill.id === selectedSkillId)) return;
    setSelectedSkillId(null);
    setSkillDocument(null);
  }, [selectedSkillId, skills]);

  async function persistDraft(
    chatId: string,
    draftPrompt: string,
    files: ChatAttachment[],
    options: { updateLocal?: boolean } = {},
  ) {
    const filesSignature = chatAttachmentsSignature(files);
    const lastPersisted = lastPersistedDraftRef.current.get(chatId);
    if (lastPersisted?.draftPrompt === draftPrompt && lastPersisted.filesSignature === filesSignature) {
      if (options.updateLocal !== false) {
        setChats((current) =>
          current.map((chat) =>
            chat.id === chatId && ((chat.draftPrompt ?? "") !== draftPrompt || !chatAttachmentsMatch(chat.attachedFiles ?? [], files))
              ? { ...chat, draftPrompt, attachedFiles: files }
              : chat,
          ),
        );
      }
      return;
    }
    const existing = chats.find((chat) => chat.id === chatId);
    if (
      existing &&
      (existing.draftPrompt ?? "") === draftPrompt &&
      chatAttachmentsMatch(existing.attachedFiles ?? [], files)
    ) {
      lastPersistedDraftRef.current.set(chatId, { draftPrompt, filesSignature });
      return;
    }
    try {
      const next = await api.updateChatDraft({ chatId, draftPrompt, attachedFiles: files });
      lastPersistedDraftRef.current.set(chatId, { draftPrompt, filesSignature });
      if (options.updateLocal !== false) {
        setChats((current) =>
          current.map((chat) =>
            chat.id === chatId
              ? { ...chat, draftPrompt: next.draftPrompt, attachedFiles: next.attachedFiles, updatedAt: next.updatedAt }
              : chat,
          ),
        );
      }
    } catch {
      /* Draft persistence should not interrupt typing. */
    }
  }

  function mergeChat(chat: ChatRecord) {
    setChats((current) => [chat, ...current.filter((row) => row.id !== chat.id)]);
  }

  function mergeProject(project: RepositoryInfo) {
    setProjects((current) => [project, ...current.filter((row) => row.id !== project.id)]);
  }

  async function ensurePersistedChatForMessage(title: string): Promise<string> {
    if (activeChatId && chats.some((chat) => chat.id === activeChatId)) {
      return activeChatId;
    }
    const chat = await api.createChat({
      ...chatInputForCurrentProject(title),
      id: activeChatId ?? undefined,
    });
    mergeChat(chat);
    suppressDraftSaveBriefly();
    setActiveChatId(chat.id);
    return chat.id;
  }

  function upsertChatFromTask(nextTask: TaskInfo) {
    if (!nextTask.chatId) return;
    const now = new Date().toISOString();
    const chat: ChatRecord = {
      id: nextTask.chatId,
      title: titleFromPrompt(nextTask.prompt),
      createdAt: now,
      updatedAt: now,
      taskId: nextTask.id,
      taskState: nextTask.state,
      repositoryName: repository?.id === nextTask.repositoryId ? repository.name : undefined,
      repositoryPath: repository?.id === nextTask.repositoryId ? repository.rootPath : undefined,
      changedFiles: nextTask.changedFiles.length,
      worktreeRootTaskId: nextTask.workspaceMode === "worktree" ? nextTask.worktreeRootTaskId ?? nextTask.id : undefined,
      worktreePath: nextTask.workspaceMode === "worktree" ? nextTask.worktreePath : undefined,
      worktreeBranch: nextTask.workspaceMode === "worktree" ? nextTask.agentBranch : undefined,
      worktreeBaseCommit: nextTask.workspaceMode === "worktree" ? nextTask.baseCommit : undefined,
      draftPrompt: "",
      attachedFiles: [],
    };
    setChats((current) => {
      const existing = current.find((row) => row.id === nextTask.chatId);
      const existingDraft = existing?.draftPrompt ?? "";
      const nextDraft = draftMatchesTaskPrompt(existingDraft, nextTask.prompt) ? "" : existingDraft;
      return [
        {
          ...chat,
          title: stableChatTitle(existing?.title, nextTask.prompt),
          createdAt: existing?.createdAt ?? chat.createdAt,
          modelEndpointMode: existing?.modelEndpointMode ?? endpointSettings.mode,
          repositoryName: chat.repositoryName ?? existing?.repositoryName,
          repositoryPath: chat.repositoryPath ?? existing?.repositoryPath,
          worktreeRootTaskId: chat.worktreeRootTaskId ?? existing?.worktreeRootTaskId,
          worktreePath: chat.worktreePath ?? existing?.worktreePath,
          worktreeBranch: chat.worktreeBranch ?? existing?.worktreeBranch,
          worktreeBaseCommit: chat.worktreeBaseCommit ?? existing?.worktreeBaseCommit,
          draftPrompt: nextDraft,
          attachedFiles: nextDraft ? (existing?.attachedFiles ?? chat.attachedFiles) : [],
        },
        ...current.filter((row) => row.id !== nextTask.chatId),
      ];
    });
  }

  async function loadChats() {
    try {
      const nextChats = await api.listChats();
      setChats(nextChats);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function loadProjects() {
    try {
      setProjects(await api.listProjects());
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  function updateAppearanceSettings(patch: Partial<AppearanceSettings>) {
    setAppearanceSettings((current) => ({ ...current, ...patch }));
    setFontScanMessage(null);
  }

  async function scanSystemFonts() {
    setFontScanPending(true);
    setFontScanMessage(null);
    try {
      const queryLocalFonts = (window as LocalFontWindow).queryLocalFonts;
      if (!queryLocalFonts) {
        setFontScanMessage("System font scanning is not available in this runtime. The curated font list will still work.");
        return;
      }
      const fonts = await queryLocalFonts();
      const families = uniqueFonts(fonts.map((font) => font.family || font.fullName || ""));
      if (!families.length) {
        setFontScanMessage("No system fonts were returned.");
        return;
      }
      setAvailableFontFamilies((current) => uniqueFonts([...current, ...families]));
      setFontScanMessage(`Found ${families.length} font famil${families.length === 1 ? "y" : "ies"}.`);
    } catch (cause) {
      setFontScanMessage(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setFontScanPending(false);
    }
  }

  async function showConnectionErrorInChat(userText: string, status: BackendStatus | null) {
    const chatId = await ensurePersistedChatForMessage(titleFromPrompt(userText));
    const detail = status?.providers[0]?.message || status?.message;
    const message = [
      "I can't reach the LLM endpoint yet, so I didn't start this run.",
      "",
      "Check **Settings > Account** for the model server connection status.",
      detail ? `\nConnection detail: ${detail}` : "",
    ].join("\n");
    const taskId = `local-connection-${Date.now().toString(36)}`;
    const at = new Date().toISOString();
    const nextEvents: BackendUiEvent[] = [
      { type: "user.message", taskId, text: userText, at },
      { type: "assistant.delta", taskId, text: message, at },
      { type: "assistant.done", taskId, at },
    ];
    setVisibleTask(null);
    closeReviewPanel();
    setPendingPermission(null);
    setApprovalChecks([]);
    setEvents((current) => nextEvents.reduce((events, event) => appendBackendEvent(events, event), current));
    await persistDraft(chatId, prompt, attachedFiles);
  }

  function chatInputForCurrentProject(title: string) {
    return {
      title,
      repositoryName: repository?.name,
      repositoryPath: repository?.rootPath,
    };
  }

  function chatInputForProject(title: string, project: { name?: string; path?: string }) {
    return {
      title,
      repositoryName: project.name,
      repositoryPath: project.path,
    };
  }

  function toggleProjectGroup(projectKey: string) {
    setCollapsedProjectKeys((current) => {
      const next = new Set(current);
      if (next.has(projectKey)) {
        next.delete(projectKey);
      } else {
        next.add(projectKey);
      }
      return next;
    });
  }

  function toggleWorktreeGroup(worktreeKey: string) {
    setCollapsedWorktreeKeys((current) => {
      const next = new Set(current);
      if (next.has(worktreeKey)) {
        next.delete(worktreeKey);
      } else {
        next.add(worktreeKey);
      }
      return next;
    });
  }

  /** `scope` of null clears the composer without restoring anything, for the
   * callers that go straight on to create a real chat. */
  function resetUnsavedChat(scope: string | null = unsavedDraftScope) {
    suppressDraftSaveBriefly();
    if (scope !== null) {
      void restoreUnsavedDraft(api, scope, { activeChatId: () => activeChatIdRef.current, setPrompt, setAttachedFiles });
    }
    setActiveChatId(null);
    setVisibleTask(null);
    setEvents([]);
    setApprovalChecks([]);
    setExpandedActivityIds(new Set());
    setExpandedActivityToolIds(new Set());
    setPendingPermission(null);
    setExpandedReviewPaths(new Set());
    closeReviewPanel();
    setAttachedFiles([]);
    setMention(null);
    setFileMatches([]);
    setPrompt(initialPrompt);
  }

  async function refreshStatus(): Promise<BackendStatus | null> {
    try {
      const status = await api.getBackendStatus();
      setBackend(status);
      setPermissionModeState(status.permissionMode);
      return status;
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
      return null;
    }
  }

  function closeSettingsDialog() {
    connectionSettings.resetDraft();
    setHarnessDraftProfile(harnessProfile);
    setHarnessDraftContextLength(contextLength);
    setHarnessMessage(null);
    setSettingsOpen(false);
  }

  async function loadHarnessProfile() {
    try {
      const [profileId, configuredContextLength] = await Promise.all([
        api.getHarnessProfile(),
        api.getContextLength(),
      ]);
      const normalized = isHarnessProfileId(profileId) ? profileId : defaultHarnessProfileId;
      const normalizedContextLength = normalizeContextLength(configuredContextLength);
      setHarnessProfile(normalized);
      setHarnessDraftProfile(normalized);
      setContextLength(normalizedContextLength);
      setHarnessDraftContextLength(normalizedContextLength);
      setHarnessMessage(null);
    } catch (cause) {
      setHarnessMessage(String(cause instanceof Error ? cause.message : cause));
    }
  }

  function selectHarnessProfile(profileId: HarnessProfileId) {
    setHarnessDraftProfile(profileId);
    setHarnessMessage(null);
  }

  async function saveHarnessProfile() {
    if (!harnessDirty || harnessSaving) return;
    const profileChanged = harnessDraftProfile !== harnessProfile;
    const contextLengthChanged = harnessDraftContextLength !== contextLength;
    const optimisticProfile = harnessDraftProfile;
    const optimisticContextLength = harnessDraftContextLength;
    const feedbackStartedAt = Date.now();
    setHarnessMessage(null);
    setHarnessSaving(true);
    setHarnessSaveFeedback("saved");
    if (profileChanged) setHarnessProfile(optimisticProfile);
    if (contextLengthChanged) setContextLength(optimisticContextLength);
    try {
      let nextProfile = optimisticProfile;
      let nextContextLength = optimisticContextLength;
      let status: BackendStatus | null = null;
      if (profileChanged) {
        const result = await api.saveHarnessProfile(harnessDraftProfile);
        nextProfile = isHarnessProfileId(result.settings) ? result.settings : defaultHarnessProfileId;
        status = result.status;
      }
      if (contextLengthChanged) {
        const result = await api.saveContextLength(harnessDraftContextLength);
        nextContextLength = normalizeContextLength(result.contextLength);
        status = result.status;
      }
      setHarnessProfile(nextProfile);
      setHarnessDraftProfile(nextProfile);
      setContextLength(nextContextLength);
      setHarnessDraftContextLength(nextContextLength);
      if (profileChanged) await loadSkills();
      if (status) {
        setBackend(status);
        setPermissionModeState(status.permissionMode);
      }
    } catch (cause) {
      setHarnessSaveFeedback("idle");
      await loadHarnessProfile();
      setHarnessMessage(String(cause instanceof Error ? cause.message : cause));
    } finally {
      const remainingFeedbackMs = Math.max(0, 500 - (Date.now() - feedbackStartedAt));
      if (remainingFeedbackMs > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, remainingFeedbackMs));
      }
      setHarnessSaving(false);
      setHarnessSaveFeedback("idle");
    }
  }

  async function loadSkills() {
    setSkillsLoading(true);
    try {
      const result = await api.listSkills();
      setSkills(result.skills);
      setSkillsEnabled(Object.fromEntries(result.skills.map((skill) => [skill.id, skill.enabled])));
      setSelectedSkillId((current) => (current && result.skills.some((skill) => skill.id === current) ? current : null));
      skillsLoadedRef.current = true;
      setSkillsLoaded(true);
    } catch (cause) {
      if (!skillsLoadedRef.current) setSkills([]);
      console.warn("Failed to list skills", cause);
    } finally {
      setSkillsLoading(false);
    }
  }

  async function toggleSkillSetting(skillId: string) {
    let previous = skillsEnabled;
    let next = skillsEnabled;
    setSkillsEnabled((current) => {
      previous = current;
      next = { ...current, [skillId]: !current[skillId] };
      return next;
    });
    setSkillsMessage(null);
    const requestId = skillsSaveSequenceRef.current + 1;
    skillsSaveSequenceRef.current = requestId;
    try {
      const result = await api.saveSkillSettings(next);
      if (requestId !== skillsSaveSequenceRef.current) return;
      setSkills(result.skills);
      setSkillsEnabled(Object.fromEntries(result.skills.map((skill) => [skill.id, skill.enabled])));
      setSkillDocument((current) =>
        current && current.id === skillId ? { ...current, enabled: result.skills.find((skill) => skill.id === skillId)?.enabled ?? current.enabled } : current,
      );
    } catch (cause) {
      if (requestId !== skillsSaveSequenceRef.current) return;
      setSkillsEnabled(previous);
      setSkillsMessage(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function openSkillsFolder() {
    setSkillsMessage(null);
    try {
      const result = await api.openSkillsFolder();
      if (!result.ok) {
        setSkillsMessage(result.message);
      }
    } catch (cause) {
      setSkillsMessage(String(cause instanceof Error ? cause.message : cause));
    }
  }

  function selectSkillSourceFilter(filter: SkillSourceFilter) {
    setSkillSourceFilter(filter);
    setSelectedSkillId(null);
    setSkillDocument(null);
    setSkillsMessage(null);
  }

  async function toggleSkillPreview(skillId: string) {
    if (skillPreviewLoading) return;
    if (selectedSkillId === skillId) {
      setSelectedSkillId(null);
      setSkillDocument(null);
      setSkillsMessage(null);
      return;
    }
    setSelectedSkillId(skillId);
    setSkillsMessage(null);
    setSkillPreviewLoading(true);
    try {
      const result = await api.getSkillDocument({ id: skillId });
      if (!result.ok) {
        setSkillsMessage(result.message);
        setSkillDocument(null);
        return;
      }
      setSkillDocument(result.skill);
    } catch (cause) {
      setSkillsMessage(String(cause instanceof Error ? cause.message : cause));
      setSkillDocument(null);
    } finally {
      setSkillPreviewLoading(false);
    }
  }

  async function openSelectedSkillInEditor() {
    if (!skillDocument) return;
    setSkillsMessage(null);
    try {
      const result = await api.openSkillInEditor({ id: skillDocument.id });
      if (!result.ok) {
        setSkillsMessage(result.message);
        return;
      }
      setSkillsMessage("Opened skill file.");
    } catch (cause) {
      setSkillsMessage(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function resetSelectedSystemSkill() {
    if (!skillDocument || skillDocument.source !== "system") return;
    setSkillsMessage(null);
    setSkillPreviewLoading(true);
    try {
      const result = await api.resetSystemSkill({ id: skillDocument.id });
      if (!result.ok) {
        setSkillsMessage(result.message);
        return;
      }
      setSkills(result.skills);
      setSkillsEnabled(Object.fromEntries(result.skills.map((skill) => [skill.id, skill.enabled])));
      setSkillDocument(result.skill);
      setSkillsMessage(`Reset ${result.skill.name}.`);
    } catch (cause) {
      setSkillsMessage(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setSkillPreviewLoading(false);
    }
  }

  async function submitCreateSkill() {
    if (creatingSkill) return;
    setSkillsMessage(null);
    setCreatingSkill(true);
    try {
      const result = await api.createSkill({ name: newSkillName });
      if (!result.ok) {
        setSkillsMessage(result.message);
        return;
      }
      setNewSkillName("");
      setNewSkillFormOpen(false);
      await loadSkills();
      await toggleSkillPreview(result.skill.id);
    } catch (cause) {
      setSkillsMessage(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setCreatingSkill(false);
    }
  }

  async function importSkill() {
    if (skillsLoading) return;
    setSkillsMessage(null);
    setSkillsLoading(true);
    try {
      const result = await api.importSkill();
      if (!result.ok) {
        setSkillsMessage(result.message);
        return;
      }
      setSkills(result.skills);
      setSkillsEnabled(Object.fromEntries(result.skills.map((skill) => [skill.id, skill.enabled])));
      skillsLoadedRef.current = true;
      setSkillsLoaded(true);
      await toggleSkillPreview(result.skill.id);
      setSkillsMessage(`Imported ${result.skill.name}.`);
    } catch (cause) {
      setSkillsMessage(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setSkillsLoading(false);
    }
  }

  async function loadAvailableIdes() {
    try {
      const ides = (await api.listAvailableIdes()).filter((ide) => ide.id !== "cursor");
      if (ides.length > 0) {
        setAvailableIdes(ides);
        setSelectedIdeId((current) => (ides.some((ide) => ide.id === current) ? current : ides[0].id));
      }
    } catch {
      setAvailableIdes(defaultIdeChoices);
    }
  }

  async function refreshTaskReviewById(
    taskId: string,
    openWhenReady = false,
    scope?: "task" | "worktree",
    repositoryPath?: string,
  ) {
    if (reviewRefreshRef.current) return;
    reviewRefreshRef.current = true;
    try {
      const nextTask = await api.refreshTaskReview({ taskId, scope, repositoryPath });
      if (!nextTask) return;
      if (visibleTaskIdRef.current === nextTask.id) {
        setVisibleTask(nextTask);
        const nextEvents = visibleEventsForTask(nextTask);
        cacheTaskEvents(nextEvents);
        setEvents(nextEvents);
        setPendingPermission(pendingPermissionFromEvents(nextEvents));
        setExpandedReviewPaths((current) => {
          const availablePaths = new Set(nextTask.reviewFiles.map((file) => file.path));
          return new Set(Array.from(current).filter((filePath) => availablePaths.has(filePath)));
        });
        if (openWhenReady && nextTask.state === "review_ready") {
          openReviewPanel();
        }
      }
      upsertChatFromTask(nextTask);
      void loadChats();
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      reviewRefreshRef.current = false;
    }
  }

  async function refreshActiveReview() {
    if (!reviewOpen || !task || busy || task.state !== "review_ready") return;
    const scope = task.reviewScope ?? "task";
    await refreshTaskReviewById(
      task.id,
      false,
      scope,
      scope === "worktree" ? repository?.rootPath : undefined,
    );
  }

  async function pickRepository() {
    setError(null);
    setBusy(true);
    try {
      const result = await api.pickRepository();
      if (!result.canceled) {
        const nextRepository = result.repository;
        mergeProject(nextRepository);
        setRepository(nextRepository);
        const chatWithoutProject = activeChatId ? chats.find((chat) => chat.id === activeChatId && !chat.repositoryPath) : undefined;
        if (chatWithoutProject) {
          const nextChat = await api.updateChatProject({
            chatId: chatWithoutProject.id,
            repositoryName: nextRepository.name,
            repositoryPath: nextRepository.rootPath,
          });
          setChats((current) =>
            current.map((chat) =>
              chat.id === nextChat.id
                ? { ...chat, repositoryName: nextChat.repositoryName, repositoryPath: nextChat.repositoryPath }
                : chat,
            ),
          );
        }
        setBranches([]);
        setBranchError(null);
      }
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setBusy(false);
    }
  }

  async function refreshBranches() {
    if (!repository || repository.kind !== "git") return;
    setBranchesLoading(true);
    setBranchError(null);
    try {
      const result = await api.listRepositoryBranches({ repositoryId: repository.id, repositoryPath: repository.rootPath });
      if (result.ok) {
        setBranches(result.branches);
      } else {
        setBranchError(result.message);
        setBranches([]);
      }
    } catch (cause) {
      setBranchError(String(cause instanceof Error ? cause.message : cause));
      setBranches([]);
    } finally {
      setBranchesLoading(false);
    }
  }

  async function toggleBranchMenu() {
    if (!repository || repository.kind !== "git") return;
    const next = !branchMenuOpen;
    if (next) {
      setWorkspaceModeMenuOpen(false);
      setPermissionMenuOpen(false);
    }
    setBranchMenuOpen(next);
    if (next) await refreshBranches();
  }

  async function selectBranch(branch: string) {
    if (!repository || repository.kind !== "git") return;
    if (branch === repository.originalBranch) {
      setBranchMenuOpen(false);
      return;
    }
    setCheckoutPending(true);
    setBranchError(null);
    try {
      const result = await api.checkoutRepositoryBranch({
        repositoryId: repository.id,
        repositoryPath: repository.rootPath,
        branch,
      });
      if (result.ok) {
        mergeProject(result.repository);
        setRepository(result.repository);
        setBranchMenuOpen(false);
      } else {
        setBranchError(result.message);
      }
    } catch (cause) {
      setBranchError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setCheckoutPending(false);
    }
  }

  async function restoreChatRepository(chat: ChatRecord, selectionSequence: number) {
    // A chat's saved project is its only workspace authority. In particular, an
    // unassigned chat must never inherit the project that was selected previously.
    setRepository(null);
    if (!chat.repositoryPath) return;
    try {
      const nextRepository = await api.getRepository({ repositoryPath: chat.repositoryPath });
      if (chatSelectionSequenceRef.current !== selectionSequence) return;
      if (nextRepository) {
        mergeProject(nextRepository);
        setRepository(nextRepository);
      }
    } catch (cause) {
      if (chatSelectionSequenceRef.current !== selectionSequence) return;
      setRepository(null);
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function updatePermissionMode(mode: PermissionMode) {
    setPermissionMenuOpen(false);
    if (mode === "auto_safe" && permissionMode !== "auto_safe") {
      setShowElevatedPermissionsDialog(true);
      return;
    }
    setError(null);
    setPermissionModeState(mode);
    try {
      setPermissionModeState(await api.setPermissionMode(mode));
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function confirmElevatedPermissionsMode() {
    setShowElevatedPermissionsDialog(false);
    setError(null);
    setPermissionModeState("auto_safe");
    try {
      setPermissionModeState(await api.setPermissionMode("auto_safe"));
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  function toggleWorkspaceMode() {
    setWorkspaceModeMenuOpen((open) => {
      const next = !open;
      if (next) {
        setBranchMenuOpen(false);
        setPermissionMenuOpen(false);
      }
      return next;
    });
  }

  function selectWorkspaceMode(mode: WorkspaceMode) {
    setWorkspaceMode(mode);
    writeWorkspaceMode(mode);
    setWorkspaceModeMenuOpen(false);
  }

  function noteComposerScrollInput(node: HTMLElement, forcePause = false) {
    composerScrollInputRef.current = true;
    if (forcePause || !isElementNearBottom(node, 8)) {
      followComposerScrollRef.current = false;
    }
  }

  function handleComposerScroll(event: React.UIEvent<HTMLDivElement>) {
    const node = event.currentTarget;
    if (isElementAtBottom(node)) {
      followComposerScrollRef.current = true;
      composerScrollInputRef.current = false;
      return;
    }
    if (isElementNearBottom(node) && !composerScrollInputRef.current) {
      followComposerScrollRef.current = true;
      return;
    }
    if (composerScrollInputRef.current) {
      followComposerScrollRef.current = false;
    }
  }

  function handleComposerWheel(event: React.WheelEvent<HTMLDivElement>) {
    const shouldPause = event.deltaY < 0 || !isElementNearBottom(event.currentTarget);
    if (shouldPause) {
      noteComposerScrollInput(event.currentTarget, shouldPause);
    }
  }

  function handleComposerScrollPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    noteComposerScrollInput(event.currentTarget);
  }

  function handleComposerTouchMove(event: React.TouchEvent<HTMLDivElement>) {
    noteComposerScrollInput(event.currentTarget, true);
  }

  function setActivityBodyRef(id: string, node: HTMLDivElement | null) {
    if (!node) {
      activityBodyRefs.current.delete(id);
      return;
    }
    activityBodyRefs.current.set(id, node);
    if (!activityFollowScrollRef.current.has(id)) {
      activityFollowScrollRef.current.set(id, true);
    }
  }

  function noteActivityScrollInput(id: string, node: HTMLElement, forcePause = false) {
    activityScrollInputRef.current.add(id);
    if (forcePause || !isElementNearBottom(node, 8)) {
      activityFollowScrollRef.current.set(id, false);
    }
  }

  function handleActivityScroll(id: string, event: React.UIEvent<HTMLDivElement>) {
    const node = event.currentTarget;
    if (isElementAtBottom(node)) {
      activityFollowScrollRef.current.set(id, true);
      activityScrollInputRef.current.delete(id);
      return;
    }
    if (isElementNearBottom(node, 18) && !activityScrollInputRef.current.has(id)) {
      activityFollowScrollRef.current.set(id, true);
      return;
    }
    if (activityScrollInputRef.current.has(id)) {
      activityFollowScrollRef.current.set(id, false);
    }
  }

  function handleActivityWheel(id: string, event: React.WheelEvent<HTMLDivElement>) {
    // Keep wheel and trackpad input on Chromium's native scrolling path. The inner
    // scroller already allows scroll chaining through `overscroll-behavior: auto`,
    // so manually moving the composer here would apply the boundary delta twice.
    const shouldPause = event.deltaY < 0 || !isElementNearBottom(event.currentTarget, 8);
    if (shouldPause) {
      noteActivityScrollInput(id, event.currentTarget, shouldPause);
    }
  }

  function handleActivityPointerDown(id: string, event: React.PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.right - event.clientX <= 14) {
      noteActivityScrollInput(id, event.currentTarget, true);
    }
  }

  function handleActivityTouchMove(id: string, event: React.TouchEvent<HTMLDivElement>) {
    noteActivityScrollInput(id, event.currentTarget, true);
  }

  async function startTask(submission?: ComposerSubmission): Promise<boolean> {
    if (closedChatNotice) {
      setError(closedChatNotice);
      return false;
    }
    const sourcePrompt = submission?.prompt ?? prompt;
    const sourceFeedback = submission?.reviewFeedback ?? reviewPromptFeedback;
    const sourceAttachments = submission?.attachedFiles ?? attachedFiles;
    const trimmedPrompt = appendReviewFeedback(composerPromptForSend(sourcePrompt), sourceFeedback).trim();
    if (!trimmedPrompt) return false;
    if (startTaskInFlightRef.current) return false;
    startTaskInFlightRef.current = true;
    let status: BackendStatus | null = null;
    try {
      status = selectedModel && backend?.endpoint === "ready" ? backend : await refreshStatus();
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
      startTaskInFlightRef.current = false;
      return false;
    }
    if (!status?.model || status.endpoint !== "ready") {
      try {
        await showConnectionErrorInChat(trimmedPrompt, status);
      } catch (cause) {
        setError(String(cause instanceof Error ? cause.message : cause));
      } finally {
        startTaskInFlightRef.current = false;
      }
      return false;
    }
    const isContinuingChat = !!task && task.chatId === activeChatId;
    setError(null);
    setBusy(true);
    followComposerScrollRef.current = true;
    composerScrollInputRef.current = false;
    if (!isContinuingChat) {
      setVisibleTask(null);
      setEvents([]);
      setApprovalChecks([]);
      setExpandedActivityIds(new Set());
      setExpandedActivityToolIds(new Set());
      setExpandedReviewPaths(new Set());
      closeReviewPanel();
    }
    setPendingPermission(null);
    try {
      let chatId = activeChatId;
      if (!chatId) {
        const chat = await api.createChat(chatInputForCurrentProject(titleFromPrompt(trimmedPrompt)));
        mergeChat(chat);
        chatId = chat.id;
        setActiveChatId(chat.id);
        // The chat exists now and keeps its own draft, so the memory copy would
        // only reappear the next time this workspace opened a new chat.
        void api.clearUnsavedDraft({ scope: unsavedDraftScope }).catch(() => undefined);
      }
      const nextTask = await api.startTask({
        repositoryId: repository?.id,
        prompt: trimmedPrompt,
        chatId,
        attachedFiles: sourceAttachments.map(normalizeAttachment),
        reasoningMode,
        useWorktree: useWorktreeForNextRun,
        worktreeTaskId: activeChatWorktreeTaskId,
      });
      setVisibleTask(nextTask);
      const nextVisibleEvents = visibleEventsForTask(nextTask);
      cacheTaskEvents(nextVisibleEvents);
      setEvents(nextVisibleEvents);
      setPendingPermission(pendingPermissionFromEvents(nextVisibleEvents));
      if (nextTask.chatId) setActiveChatId(nextTask.chatId);
      upsertChatFromTask(nextTask);
      if (!submission) {
        suppressDraftSaveBriefly();
        setPrompt("");
        setReviewPromptFeedback([]);
        setAttachedFiles([]);
        setMention(null);
        setFileMatches([]);
        await persistDraft(nextTask.chatId ?? chatId, "", []);
      }
      if (!isContinuingChat) {
        setExpandedReviewPaths(new Set());
      }
      return true;
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
      return false;
    } finally {
      startTaskInFlightRef.current = false;
      setBusy(false);
    }
  }

  function currentComposerSubmission(): ComposerSubmission | null {
    const text = composerPromptForSend(prompt);
    if (!text && reviewPromptFeedback.length === 0) return null;
    return {
      prompt: text,
      attachedFiles: attachedFiles.map(normalizeAttachment),
      reviewFeedback: reviewPromptFeedback,
    };
  }

  function clearComposerInput() {
    suppressDraftSaveBriefly();
    setPrompt("");
    setReviewPromptFeedback([]);
    setAttachedFiles([]);
    setMention(null);
    setFileMatches([]);
    if (activeChatId) void persistDraft(activeChatId, "", []);
  }

  // The runner releases a queued message only after a turn answers, so the
  // mirror is re-read whenever the task settles or changes.
  useEffect(() => { void syncQueuedPrompts(task?.id); }, [task?.id, task?.state]);

  async function syncQueuedPrompts(taskId: string | undefined) {
    setQueuedPrompts(taskId ? await readQueuedPrompts(api, taskId).catch(() => []) : []);
  }

  async function queueCurrentPrompt() {
    if (!task || !canQueue) return;
    const submission = currentComposerSubmission();
    if (!submission) return;
    const taskId = task.id;
    // The runner owns the ordering and the release, so a rejection here (queue
    // full, or the turn already ended) must not leave a phantom row behind.
    try {
      const { prompt, attachedFiles } = submission;
      await api.queueFollowUpTask({ taskId, prompt, attachedFiles });
      clearComposerInput();
      await syncQueuedPrompts(taskId);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function steerSubmission(submission: ComposerSubmission, queuedId?: string) {
    if (!task || task.state !== "running" || steerPending) return;
    const steeredPrompt = appendReviewFeedback(submission.prompt, submission.reviewFeedback).trim();
    if (!steeredPrompt) return;
    setSteerPending(true);
    setError(null);
    try {
      await api.steerTask({
        taskId: task.id,
        prompt: steeredPrompt,
        attachedFiles: submission.attachedFiles,
      });
      // Sending a queued message now must also retract it from the runner's
      // queue, or it would run a second time once the turn answers.
      if (queuedId) removeQueuedPrompt(queuedId);
      else clearComposerInput();
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setSteerPending(false);
    }
  }

  function removeQueuedPrompt(id: string) {
    const item = queuedPrompts.find((queued) => queued.id === id);
    setQueuedPrompts((current) => current.filter((queued) => queued.id !== id));
    if (!item) return;
    void api.dropQueuedTaskPrompt({ taskId: item.taskId, actionId: item.actionId })
      .then(() => syncQueuedPrompts(item.taskId));
  }

  function editQueuedPrompt(item: QueuedComposerPrompt) {
    setPrompt(item.prompt);
    setAttachedFiles(item.attachedFiles);
    setReviewPromptFeedback(item.reviewFeedback);
    setMention(null);
    setFileMatches([]);
    setSelectedFileIndex(0);
    setSelectedSkillIndex(0);
    removeQueuedPrompt(item.id);
    window.requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(item.prompt.length, item.prompt.length);
    });
  }

  async function stopTask() {
    if (!task || task.state !== "running" || stopPending) return;
    const taskId = task.id;
    setStopPending(true);
    setError(null);
    try {
      await api.cancelTask({ taskId });
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setStopPending(false);
    }
  }

  async function approveWorktree(approved: boolean) {
    if (!task) return;
    try {
      await api.approveWorktreeCreation({ taskId: task.id, approved });
      setTask((current) =>
        current && current.id === task.id ? { ...current, state: approved ? "running" : "rejected" } : current,
      );
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function resolvePermission(decision: "allow" | "deny") {
    if (!pendingPermission || !latestTaskId) return;
    try {
      await api.respondToToolPermission({ taskId: latestTaskId, id: pendingPermission.id, decision });
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function copyText(value: string) {
    await copyPlainText(value);
  }

  function openResponseFeedbackDialog(
    messageId: string,
    rating: ResponseRating,
    trigger: HTMLButtonElement,
  ) {
    modalTriggerRef.current = trigger;
    const previousFeedback = [...visibleEvents].reverse().find(
      (event): event is Extract<BackendUiEvent, { type: "response.feedback" }> =>
        event.type === "response.feedback" && event.messageId === messageId,
    );
    setResponseFeedbackDialog({
      messageId,
      rating,
      ...(previousFeedback?.rating === rating && previousFeedback.reason
        ? { reason: previousFeedback.reason }
        : {}),
      comment: previousFeedback?.rating === rating ? previousFeedback.comment ?? "" : "",
    });
  }

  async function rateResponse(
    messageId: string,
    rating: ResponseRating,
    reason?: ResponseFeedbackReason,
    comment?: string,
  ): Promise<boolean> {
    if (!latestTaskId) return false;
    setError(null);
    const taskId = latestTaskId;
    const previousFeedback = [...visibleEvents].reverse().find(
      (event): event is Extract<BackendUiEvent, { type: "response.feedback" }> =>
        event.type === "response.feedback" && event.taskId === taskId && event.messageId === messageId,
    );
    const nextComment = (comment ?? "").trim().slice(0, 1000);
    setEvents((current) => appendBackendEvent(current, {
      type: "response.feedback",
      taskId,
      messageId,
      rating,
      ...(reason ? { reason } : {}),
      ...(nextComment ? { comment: nextComment } : {}),
      at: new Date().toISOString(),
    }, 500));
    try {
      await api.setResponseFeedback({
        taskId,
        messageId,
        rating,
        ...(reason ? { reason } : {}),
        ...(nextComment ? { comment: nextComment } : {}),
      });
      return true;
    } catch (cause) {
      setEvents((current) => {
        const withoutFailedRating = removeResponseFeedback(current, taskId, messageId) as BackendUiEvent[];
        return previousFeedback
          ? appendBackendEvent(withoutFailedRating, { ...previousFeedback, at: new Date().toISOString() }, 500)
          : withoutFailedRating;
      });
      setError(String(cause instanceof Error ? cause.message : cause));
      return false;
    }
  }

  async function submitResponseFeedback() {
    if (!responseFeedbackDialog || responseFeedbackSubmitting) return;
    setResponseFeedbackSubmitting(true);
    try {
      const submitted = await rateResponse(
        responseFeedbackDialog.messageId,
        responseFeedbackDialog.rating,
        responseFeedbackDialog.reason,
        responseFeedbackDialog.comment,
      );
      if (submitted) setResponseFeedbackDialog(null);
    } finally {
      setResponseFeedbackSubmitting(false);
    }
  }

  async function exportLocalLogs() {
    setLocalLogsBusy(true);
    try {
      await api.exportLocalDiagnostics();
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setLocalLogsBusy(false);
    }
  }

  async function clearLocalLogs() {
    setLocalLogsBusy(true);
    try {
      const info = await api.clearLocalDiagnostics();
      setBackend((current) => current ? {
        ...current,
        diagnostics: { ...current.diagnostics, localLogs: info },
      } : current);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setLocalLogsBusy(false);
    }
  }

  async function openIde(ideId: string) {
    if (!repository) return;
    setIdeMenuOpen(null);
    const result = await api.openRepositoryInIde({ repositoryId: repository.id, ideId });
    if (!result.ok) setError(result.message);
  }

  function toggleIdeMenu(owner: "composer" | "review") {
    setIdeMenuOpen((open) => {
      const next = open === owner ? null : owner;
      if (next) {
        setBranchMenuOpen(false);
        setWorkspaceModeMenuOpen(false);
        setPermissionMenuOpen(false);
      }
      return next;
    });
  }

  function renderIdePicker(owner: "composer" | "review") {
    const canOpen = owner === "composer" ? !!repository : canOpenIde;
    const expanded = ideMenuOpen === owner && canOpen;
    const disabledTitle = owner === "composer" ? "Select a folder first" : "No review folder yet";
    const openTitle =
      owner === "composer"
        ? `Open ${repository?.name ?? "folder"} in ${selectedIde.label}`
        : `Use ${selectedIde.label} for changed files`;
    return (
      <div className={`idePicker ${canOpen ? "" : "isDisabled"}`}>
        <button
          className="idePickerOpen"
          type="button"
          onClick={() => openIde(selectedIde.id)}
          disabled={!canOpen}
          title={canOpen ? openTitle : disabledTitle}
        >
          <IdeIcon icon={selectedIde.icon} />
        </button>
        <button
          className="idePickerToggle"
          type="button"
          onClick={() => toggleIdeMenu(owner)}
          disabled={!canOpen}
          aria-expanded={expanded}
          aria-haspopup="menu"
          title={canOpen ? "Choose editor" : disabledTitle}
        >
          <ChevronDown size={13} />
        </button>
        {expanded ? (
          <div className="ideMenu" role="menu" onKeyDown={(event) => {
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']"));
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
            } else if (event.key === "Home") { event.preventDefault(); items[0]?.focus(); }
            else if (event.key === "End") { event.preventDefault(); items.at(-1)?.focus(); }
          }}>
            {availableIdes.map((ide) => (
              <button
                className={ide.id === selectedIde.id ? "active" : ""}
                key={ide.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  void api.recordProductEvent({
                    type: "ide.selected",
                    taskId: task?.id,
                    repositoryId: repository?.id,
                    ideId: ide.id,
                    surface: owner,
                  }).catch(() => undefined);
                  setSelectedIdeId(ide.id);
                  setIdeMenuOpen(null);
                }}
              >
                <IdeIcon icon={ide.icon} />
                <span>{ide.label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  function sidebarMaxAvailableWidth() {
    return clamp(Math.round(window.innerWidth * sidebarMaxRatio), sidebarMinWidth, sidebarMaxWidth);
  }

  function reviewMaxWidth() {
    return Math.max(0, Math.floor(window.innerWidth * reviewMaxWidthRatio));
  }

  function reviewOpenWidth() {
    return Math.max(reviewDefaultWidth, Math.floor(window.innerWidth * reviewOpenWidthRatio));
  }

  function reviewMinWidthForViewport() {
    return Math.min(reviewMinWidth, reviewMaxWidth());
  }

  function cancelReviewClose() {
    if (reviewAnimationRef.current !== null) window.cancelAnimationFrame(reviewAnimationRef.current);
    setReviewClosing(false);
  }

  function animateReviewTo(target: number, initialVelocity = 0, onRest?: () => void) {
    if (reviewAnimationRef.current !== null) window.cancelAnimationFrame(reviewAnimationRef.current);
    let value = reviewOffsetRef.current;
    let velocity = initialVelocity;
    let previous = performance.now();
    const tick = (now: number) => {
      const elapsed = Math.min((now - previous) / 1000, 0.05);
      previous = now;
      // A critically damped spring: it starts from the presented position and can be retargeted at any time.
      velocity += (target - value) * 420 * elapsed - velocity * 38 * elapsed;
      value += velocity * elapsed;
      reviewOffsetRef.current = value;
      reviewVelocityRef.current = velocity;
      setReviewOffset(value);
      if (Math.abs(target - value) < 0.5 && Math.abs(velocity) < 3) {
        reviewOffsetRef.current = target;
        reviewVelocityRef.current = 0;
        setReviewOffset(target);
        reviewAnimationRef.current = null;
        onRest?.();
        return;
      }
      reviewAnimationRef.current = window.requestAnimationFrame(tick);
    };
    reviewAnimationRef.current = window.requestAnimationFrame(tick);
  }

  function closeReviewPanel() {
    if (!reviewOpen && !reviewClosing) return;
    setReviewClosing(true);
    animateReviewTo(reviewWidth + 18, reviewVelocityRef.current, () => {
      setReviewOpen(false);
      setReviewClosing(false);
    });
  }

  function openReviewPanel(filePath?: string) {
    if (!reviewOpen || reviewClosing) {
      void api.recordProductEvent({
        type: "review.opened",
        taskId: task?.id,
        repositoryId: repository?.id,
        scope: task?.reviewScope ?? tasklessReviewScope,
        target: task ? "task" : "project",
      }).catch(() => undefined);
    }
    cancelReviewClose();
    if (!reviewHasSessionWidth) setReviewWidth(Math.min(reviewOpenWidth(), reviewMaxWidth()));
    setReviewOpen(true);
    animateReviewTo(0, reviewVelocityRef.current);
    if (filePath) {
      setReviewTargetPath(filePath);
      setExpandedReviewPaths(new Set([filePath]));
    }
    if (task) {
      const taskId = task.id;
      const scope = task.reviewScope ?? "task";
      const request = ++reviewScopeRequestRef.current;
      void api.refreshTaskReview({ taskId, scope, repositoryPath: scope === "worktree" ? repository?.rootPath : undefined }).then((refreshed) => {
        if (refreshed && visibleTaskIdRef.current === taskId && reviewScopeRequestRef.current === request) setTask(refreshed);
      }).catch((cause) => {
        if (reviewScopeRequestRef.current === request) setError(String(cause instanceof Error ? cause.message : cause));
      });
    } else if (repository?.kind === "git") {
      const request = ++reviewScopeRequestRef.current;
      setTasklessReviewScope("worktree");
      void api.refreshWorkspaceReview({ repositoryPath: repository.rootPath }).then((refreshed) => {
        if (reviewScopeRequestRef.current === request) setWorkspaceReview(refreshed);
      }).catch((cause) => {
        if (reviewScopeRequestRef.current === request) setError(String(cause instanceof Error ? cause.message : cause));
      });
    }
  }

  function toggleReviewPanel() {
    if (reviewOpen) {
      closeReviewPanel();
      return;
    }
    openReviewPanel();
  }

  async function openReviewFile(filePath: string) {
    if (!canOpenIde || !task) return;
    setError(null);
    const result = await api.openTaskInIde({ taskId: task.id, ideId: selectedIde.id, filePath });
    if (!result.ok) setError(result.message);
  }

  function toggleReviewFile(filePath: string) {
    setExpandedReviewPaths((current) => {
      const next = new Set(current);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  }

  function openReviewReference(filePath: string) {
    openReviewPanel(filePath);
  }

  async function changeReviewScope(scope: "task" | "worktree") {
    if (!task) {
      if (tasklessReviewScope === scope && scope !== "worktree") return;
      setTasklessReviewScope(scope);
      if (scope === "task") {
        setWorkspaceReview(null);
        return;
      }
      if (!repository || repository.kind !== "git") return;
      const request = ++reviewScopeRequestRef.current;
      setError(null);
      try {
        const refreshed = await api.refreshWorkspaceReview({ repositoryPath: repository.rootPath });
        if (reviewScopeRequestRef.current === request) setWorkspaceReview(refreshed);
      } catch (cause) {
        if (reviewScopeRequestRef.current === request) {
          setTasklessReviewScope("task");
          setError(String(cause instanceof Error ? cause.message : cause));
        }
      }
      return;
    }
    if (task.reviewScope === scope && scope !== "worktree") return;
    const previousTask = task;
    const request = ++reviewScopeRequestRef.current;
    setError(null);
    setTask((current) => current && current.id === task.id ? {
      ...current,
      reviewScope: scope,
      reviewBaselineLabel: scope === "worktree" ? "Whole diff" : "Turn changes",
      reviewBaselineOid: scope === "worktree" ? "HEAD" : "task start",
    } : current);
    try {
      const refreshed = await api.refreshTaskReview({
        taskId: task.id,
        scope,
        repositoryPath: scope === "worktree" ? repository?.rootPath : undefined,
      });
      if (refreshed && reviewScopeRequestRef.current === request) setTask(refreshed);
    } catch (cause) {
      if (reviewScopeRequestRef.current === request) {
        setTask(previousTask);
        setError(String(cause instanceof Error ? cause.message : cause));
      }
    }
  }

  function addReviewFeedbackToPrompt(comments: ReviewCommentDraft[]) {
    const active = comments.filter((comment) => !comment.stale && comment.body.trim());
    if (!active.length) return;
    setReviewPromptFeedback((current) => {
      const merged = new Map(current.map((comment) => [comment.id, comment]));
      for (const comment of active) merged.set(comment.id, comment);
      return [...merged.values()];
    });
  }

  async function approveMerge() {
    if (!task) return;
    setBusy(true);
    setApprovalChecks([]);
    setTask((current) => (current ? { ...current, state: "approving" } : current));
    try {
      const result = await api.approveTaskMerge({ taskId: task.id });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setTask((current) => {
        const next = current ? { ...current, state: "approved" as const, patchHash: result.patchHash } : current;
        if (next) upsertChatFromTask(next);
        return next;
      });
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setBusy(false);
    }
  }

  async function undoTask() {
    if (!task || !canUndo) return;
    setBusy(true);
    setIdeMenuOpen(null);
    try {
      await api.rejectTask({ taskId: task.id, cleanup: true });
      setExpandedReviewPaths(new Set());
      setTask((current) => {
        const next = current
          ? { ...current, state: "rejected" as const, changedFiles: [], reviewFiles: [] }
          : current;
        if (next) upsertChatFromTask(next);
        return next;
      });
      void loadChats();
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setBusy(false);
    }
  }

  function suppressDraftSaveBriefly() {
    suppressDraftSaveRef.current = true;
    window.setTimeout(() => {
      suppressDraftSaveRef.current = false;
    }, 80);
  }

  function updateMention(value: string, cursor: number | null) {
    const nextMention = cursor === null ? null : mentionAtCursor(value, cursor);
    setMention(nextMention);
    if (!nextMention) setFileMatches([]);
    if (!nextMention || nextMention.kind !== "skill") setSelectedSkillIndex(0);
  }

  function handlePromptChange(event: React.ChangeEvent<HTMLTextAreaElement>) {
    const nextPrompt = event.target.value;
    followComposerScrollRef.current = true;
    setPrompt(nextPrompt);
    updateMention(nextPrompt, event.target.selectionStart);
  }

  function mergeAttachments(current: ChatAttachment[], files: ChatAttachment[]): ChatAttachment[] {
    const next = [...current];
    for (const file of files.map(normalizeAttachment)) {
      const key = file.storedPath || file.path;
      if (!next.some((attached) => (attached.storedPath || attached.path) === key)) {
        next.push(file);
      }
      if (next.length >= 16) break;
    }
    return next;
  }

  function removeAttachment(file: ChatAttachment) {
    const key = file.storedPath || file.path;
    setAttachedFiles((current) => current.filter((attached) => (attached.storedPath || attached.path) !== key));
  }

  async function openMessageAttachment(file: ChatAttachment) {
    if (isImageAttachment(file) && file.previewDataUrl) {
      setPreviewAttachment(file);
      return;
    }
    const result = await api.openChatAttachment({ attachment: file, repositoryId: repository?.id });
    if (!result.ok) {
      setError(result.message);
    }
  }

  function insertAttachmentMentions(files: ChatAttachment[]) {
    const normalized = files.map(normalizeAttachment);
    if (!normalized.length) return;
    const node = textareaRef.current;
    const cursor = node?.selectionStart ?? prompt.length;
    const before = prompt.slice(0, cursor);
    const after = prompt.slice(cursor);
    const leading = before && !/\s$/.test(before) ? " " : "";
    const trailing = after && !/^\s/.test(after) ? " " : "";
    const mentionText = normalized.map(attachmentMention).join(" ");
    const insertion = `${leading}${mentionText} ${trailing}`;
    const nextPrompt = `${before}${insertion}${after}`;
    const caret = cursor + insertion.length;
    setPrompt(nextPrompt);
    setMention(null);
    setFileMatches([]);
    setSelectedFileIndex(0);
    window.setTimeout(() => {
      const current = textareaRef.current;
      if (!current) return;
      current.focus();
      current.setSelectionRange(caret, caret);
    }, 0);
  }

  function addAttachment(file: ChatAttachment) {
    const normalized = normalizeAttachment(file);
    setAttachedFiles((current) => mergeAttachments(current, [normalized]));
    if (mention?.kind === "file") {
      const mentionText = `${attachmentMention(normalized)} `;
      const nextPrompt = `${prompt.slice(0, mention.start)}${mentionText}${prompt.slice(mention.end)}`;
      setPrompt(nextPrompt);
      setMention(null);
      setFileMatches([]);
      setSelectedFileIndex(0);
      window.setTimeout(() => {
        const node = textareaRef.current;
        if (!node) return;
        const caret = mention.start + mentionText.length;
        node.focus();
        node.setSelectionRange(caret, caret);
      }, 0);
      return;
    }

    insertAttachmentMentions([normalized]);
  }

  function selectMentionCategory(category: MentionCategoryId) {
    setMentionScope(category);
    setSelectedFileIndex(0);
    setSelectedSkillIndex(0);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function backToMentionCategories() {
    const index = mentionCategories.findIndex((category) => category.id === mentionScope);
    setMentionScope(null);
    setSelectedCategoryIndex(index >= 0 ? index : 0);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function insertSkillMention(skill: SkillInfo) {
    const node = textareaRef.current;
    // Skills commit from the $ trigger and from the @ menu's Skills scope;
    // either way the typed trigger text is replaced by the skill token.
    const activeMention = mention;
    const cursor = activeMention?.start ?? node?.selectionStart ?? prompt.length;
    const end = activeMention?.end ?? cursor;
    const before = prompt.slice(0, activeMention ? activeMention.start : cursor);
    const after = prompt.slice(end);
    const leading = before && !/\s$/.test(before) ? " " : "";
    const trailing = after && !/^\s/.test(after) ? " " : "";
    const mentionText = `${skillMention(skill)} `;
    const insertion = `${leading}${mentionText}${trailing}`;
    const nextPrompt = `${before}${insertion}${after}`;
    const caret = before.length + insertion.length;
    setPrompt(nextPrompt);
    setMention(null);
    setSelectedSkillIndex(0);
    window.setTimeout(() => {
      const current = textareaRef.current;
      if (!current) return;
      current.focus();
      current.setSelectionRange(caret, caret);
    }, 0);
  }

  async function pickAttachment() {
    if (busy || closedChatNotice) return;
    setError(null);
    try {
      const chatId = await ensureChatForAttachments();
      const result = await api.pickAttachmentFiles({ chatId, repositoryId: repository?.id });
      if (result.canceled) return;
      const files = result.files.map(normalizeAttachment);
      setAttachedFiles((current) => mergeAttachments(current, files));
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function ensureChatForAttachments(): Promise<string> {
    if (activeChatId) return activeChatId;
    const chat = await api.createChat({
      ...chatInputForCurrentProject(prompt.trim() ? titleFromPrompt(prompt) : "New chat"),
    });
    mergeChat(chat);
    suppressDraftSaveBriefly();
    setActiveChatId(chat.id);
    return chat.id;
  }

  function fileToPastedAttachment(file: File): Promise<PastedAttachmentInput> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== "string") {
          reject(new Error("Could not read pasted file."));
          return;
        }
        resolve({
          name: file.name || (file.type.startsWith("image/") ? "pasted-image.png" : "pasted-file"),
          mimeType: file.type || undefined,
          dataUrl: reader.result,
        });
      };
      reader.onerror = () => reject(reader.error ?? new Error("Could not read pasted file."));
      reader.readAsDataURL(file);
    });
  }

  async function attachPastedFiles(files: File[]) {
    if (!files.length || !canAttachFiles) return;
    setError(null);
    try {
      const chatId = await ensureChatForAttachments();
      const payload = await Promise.all(files.slice(0, 16).map(fileToPastedAttachment));
      const result = await api.savePastedAttachments({ chatId, files: payload });
      setAttachedFiles((current) => mergeAttachments(current, result.files.map(normalizeAttachment)));
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  function handleComposerPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files).filter((file) => file.size > 0);
    if (files.length) {
      event.preventDefault();
      void attachPastedFiles(files);
      return;
    }
    const pastedText = event.clipboardData.getData("text/plain");
    const insertion = insertPastedComposerText(
      prompt,
      pastedText,
      event.currentTarget.selectionStart,
      event.currentTarget.selectionEnd,
    );
    event.preventDefault();
    setPrompt(insertion.value);
    updateMention(insertion.value, insertion.caret);
    window.requestAnimationFrame(() => textareaRef.current?.setSelectionRange(insertion.caret, insertion.caret));
  }

  function handleComposerDrop(event: React.DragEvent<HTMLDivElement>) {
    const files = Array.from(event.dataTransfer.files).filter((file) => file.size > 0);
    if (!files.length) return;
    event.preventDefault();
    void attachPastedFiles(files);
  }

  function handleComposerDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (event.dataTransfer.types.includes("Files")) {
      event.preventDefault();
    }
  }

  function handlePromptKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (promptReferenceMenuOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        setMentionScope(null);
        setFileMatches([]);
        setSelectedCategoryIndex(0);
        setSelectedFileIndex(0);
        setSelectedSkillIndex(0);
        return;
      }
      if (categoryMenuOpen) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setSelectedCategoryIndex((current) => {
            const direction = event.key === "ArrowDown" ? 1 : -1;
            return Math.max(0, Math.min(mentionCategories.length - 1, current + direction));
          });
          return;
        }
        if ((!event.shiftKey && event.key === "Enter") || event.key === "Tab") {
          event.preventDefault();
          selectMentionCategory(mentionCategories[selectedCategoryIndex].id);
          return;
        }
      }
      if (mentionScope && mention?.kind === "file" && !mentionQuery && event.key === "Backspace") {
        event.preventDefault();
        backToMentionCategories();
        return;
      }
      if (fileSearchKind && (event.key === "ArrowDown" || event.key === "ArrowUp") && fileMatches.length) {
        event.preventDefault();
        setSelectedFileIndex((current) => {
          const direction = event.key === "ArrowDown" ? 1 : -1;
          return Math.max(0, Math.min(fileMatches.length - 1, current + direction));
        });
        return;
      }
      if (skillMenuOpen && (event.key === "ArrowDown" || event.key === "ArrowUp") && skillMatches.length) {
        event.preventDefault();
        setSelectedSkillIndex((current) => {
          const direction = event.key === "ArrowDown" ? 1 : -1;
          return Math.max(0, Math.min(skillMatches.length - 1, current + direction));
        });
        return;
      }
      if (fileSearchKind && ((!event.shiftKey && event.key === "Enter") || event.key === "Tab") && fileMatches.length) {
        event.preventDefault();
        addAttachment(fileMatches[Math.min(selectedFileIndex, fileMatches.length - 1)]);
        return;
      }
      if (skillMenuOpen && ((!event.shiftKey && event.key === "Enter") || event.key === "Tab") && skillMatches.length) {
        event.preventDefault();
        insertSkillMention(skillMatches[Math.min(selectedSkillIndex, skillMatches.length - 1)]);
        return;
      }
    }
    if (event.key !== "Enter") {
      return;
    }
    if (event.shiftKey) {
      const target = event.currentTarget;
      const continuation = continueNumberedList(target.value, target.selectionStart, target.selectionEnd);
      if (!continuation) return;
      event.preventDefault();
      followComposerScrollRef.current = true;
      setPrompt(continuation.value);
      setMention(null);
      setFileMatches([]);
      setSelectedFileIndex(0);
      setSelectedSkillIndex(0);
      window.requestAnimationFrame(() => {
        textareaRef.current?.setSelectionRange(continuation.caret, continuation.caret);
      });
      return;
    }
    event.preventDefault();
    if (isGenerating) {
      queueCurrentPrompt();
    } else {
      void startTask();
    }
  }

  async function newChat() {
    setError(null);
    try {
      if (activeChatId) await persistDraft(activeChatId, prompt, attachedFiles);
      setRepository(null);
      resetUnsavedChat("");
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function newProject() {
    setError(null);
    setBusy(true);
    try {
      if (activeChatId) await persistDraft(activeChatId, prompt, attachedFiles);
      const result = await api.pickRepository();
      if (!result.canceled) {
        resetUnsavedChat(result.repository.rootPath);
        mergeProject(result.repository);
        setRepository(result.repository);
      }
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setBusy(false);
    }
  }

  async function newChatForProject(project: { name: string; path?: string }) {
    if (!project.path) return;
    setError(null);
    try {
      if (activeChatId) await persistDraft(activeChatId, prompt, attachedFiles);
      // Scoped to the folder being opened, not the one being left: the draft to
      // restore belongs to the new chat's workspace.
      resetUnsavedChat(project.path);
      const nextRepository = await api.getRepository({ repositoryPath: project.path });
      if (nextRepository) {
        mergeProject(nextRepository);
        setRepository(nextRepository);
      }
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function newChatForWorktree(project: { name: string; path?: string }, worktree: WorktreeChatGroup) {
    if (!project.path || !worktree.rootTaskId) return;
    setError(null);
    try {
      if (activeChatId) await persistDraft(activeChatId, prompt, attachedFiles);
      // This path creates a real chat immediately, so there is no unsaved draft
      // to restore into.
      resetUnsavedChat(null);
      const nextRepository = await api.getRepository({ repositoryPath: project.path });
      if (nextRepository) {
        mergeProject(nextRepository);
        setRepository(nextRepository);
      }
      const chat = await api.createChat({
        title: "New chat",
        repositoryName: project.name,
        repositoryPath: project.path,
        worktreeTaskId: worktree.rootTaskId,
      });
      mergeChat(chat);
      suppressDraftSaveBriefly();
      setActiveChatId(chat.id);
      setPrompt("");
      setCollapsedProjectKeys((current) => {
        if (!current.has(project.path ?? "")) return current;
        const next = new Set(current);
        next.delete(project.path ?? "");
        return next;
      });
      setCollapsedWorktreeKeys((current) => {
        if (!current.has(worktree.key)) return current;
        const next = new Set(current);
        next.delete(worktree.key);
        return next;
      });
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function selectChat(chat: ChatRecord) {
    const selectionSequence = chatSelectionSequenceRef.current + 1;
    chatSelectionSequenceRef.current = selectionSequence;
    if (activeChatId === chat.id) {
      const node = streamRef.current;
      if (node) {
        followComposerScrollRef.current = true;
        forceComposerBottomScrollRef.current = false;
        placeElementAtBottom(node);
      }
      void restoreChatRepository(chat, selectionSequence);
      return;
    }
    void restoreChatRepository(chat, selectionSequence);
    if (activeChatId) void persistDraft(activeChatId, prompt, attachedFiles);
    suppressDraftSaveBriefly();
    const cachedEvents = chat.taskId ? compactBackendEvents(cachedEventsForTask(chat.taskId), 500) : [];
    const canOpenImmediately = !chat.taskId || cachedEvents.length > 0;
    if (canOpenImmediately) {
      flushSync(() => {
        forceComposerBottomScrollRef.current = true;
        prepareVisibleTaskLoad(chat.taskId ?? null);
        setActiveChatId(chat.id);
        setEvents(cachedEvents);
        setApprovalChecks([]);
        setExpandedActivityIds(new Set());
        setExpandedActivityToolIds(new Set());
        setPendingPermission(null);
        setError(null);
        setExpandedReviewPaths(new Set());
        setAttachedFiles(chat.attachedFiles ?? []);
        setMention(null);
        setFileMatches([]);
      });
      const openedNode = streamRef.current;
      if (openedNode) placeElementAtBottom(openedNode);
    } else {
      setError(null);
      setMention(null);
      setFileMatches([]);
    }
    try {
      let nextTask = chat.taskId ? await api.getTask({ taskId: chat.taskId }) : null;
      if (reviewOpen && nextTask?.state === "review_ready") {
        nextTask = (await api.refreshTaskReview({ taskId: nextTask.id })) ?? nextTask;
      }
      if (chatSelectionSequenceRef.current !== selectionSequence) return;
      if (!chat.taskId) {
        flushSync(() => {
          setVisibleTask(null);
          closeReviewPanel();
          setPrompt(chat.draftPrompt ?? "");
        });
        const node = streamRef.current;
        if (node) placeElementAtBottom(node);
        return;
      }
      const nextEvents = nextTask ? visibleEventsForTask(nextTask) : [];
      const draftPrompt = chat.draftPrompt ?? "";
      const sentDraft = nextTask ? draftMatchesTaskPrompt(draftPrompt, nextTask.prompt) : false;
      flushSync(() => {
        forceComposerBottomScrollRef.current = true;
        setActiveChatId(chat.id);
        setVisibleTask(nextTask);
        setEvents(compactBackendEvents(nextEvents, 500));
        setApprovalChecks([]);
        setExpandedActivityIds(new Set());
        setExpandedActivityToolIds(new Set());
        setPendingPermission(pendingPermissionFromEvents(nextEvents));
        setError(null);
        setPrompt(sentDraft ? "" : draftPrompt);
        setAttachedFiles(!draftPrompt || sentDraft ? [] : (chat.attachedFiles ?? []));
        setMention(null);
        setFileMatches([]);
        setExpandedReviewPaths(new Set());
      });
      const node = streamRef.current;
      if (node) placeElementAtBottom(node);
      if (sentDraft) void persistDraft(chat.id, "", []);
    } catch (cause) {
      if (chatSelectionSequenceRef.current !== selectionSequence) return;
      if (canOpenImmediately) setVisibleTask(null);
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  function clearDeletedActiveChat() {
    suppressDraftSaveBriefly();
    setActiveChatId(null);
    setVisibleTask(null);
    setEvents([]);
    setApprovalChecks([]);
    setExpandedActivityIds(new Set());
    setExpandedActivityToolIds(new Set());
    setPendingPermission(null);
    setExpandedReviewPaths(new Set());
    closeReviewPanel();
    setAttachedFiles([]);
    setMention(null);
    setFileMatches([]);
    setPrompt("");
  }

  function chatProjectTarget(group: ChatProjectGroup): ProjectDeleteTarget | null {
    if (!group.path) return null;
    const project = projects.find((row) => row.rootPath === group.path);
    if (!project) return null;
    const worktreeChatCount = group.worktrees.reduce((count, worktree) => count + worktree.chats.length, 0);
    return {
      id: project.id,
      key: group.key,
      name: group.name,
      path: group.path,
      chatCount: group.chats.length + worktreeChatCount,
    };
  }

  function removeDeletedChats(deletedChatIds: string[]) {
    if (!deletedChatIds.length) return;
    const deleted = new Set(deletedChatIds);
    setChats((current) => current.filter((chat) => !deleted.has(chat.id)));
    if (activeChatId && deleted.has(activeChatId)) {
      clearDeletedActiveChat();
    }
  }

  function projectMatchesRepository(project: ProjectDeleteTarget, selectedRepository: RepositoryInfo | null): boolean {
    return !!selectedRepository && selectedRepository.rootPath === project.path;
  }

  async function confirmDeleteCandidate() {
    if (!deleteCandidate) return;
    const target = deleteCandidate;
    setDeleteCandidate(null);
    try {
      if (target.kind === "chat") {
        await api.deleteChat({ chatId: target.chat.id });
        removeDeletedChats([target.chat.id]);
      } else if (target.kind === "projectChats") {
        const result = await api.deleteProjectChats({ projectId: target.project.id });
        const localDeletedChatIds = chats.filter((chat) => chat.repositoryPath === target.project.path).map((chat) => chat.id);
        removeDeletedChats(Array.from(new Set([...result.deletedChatIds, ...localDeletedChatIds])));
      } else {
        const result = await api.deleteProject({ projectId: target.project.id });
        const localDeletedChatIds = chats.filter((chat) => chat.repositoryPath === target.project.path).map((chat) => chat.id);
        removeDeletedChats(Array.from(new Set([...result.deletedChatIds, ...localDeletedChatIds])));
        setProjects((current) => current.filter((project) => project.id !== target.project.id));
        if (projectMatchesRepository(target.project, repository)) {
          setRepository(null);
        }
      }
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  function beginSidebarResize(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    document.body.classList.add("isResizing");
    const move = (moveEvent: PointerEvent) => {
      const nextWidth = startWidth + moveEvent.clientX - startX;
      setSidebarWidth(clamp(nextWidth, sidebarMinWidth, sidebarMaxAvailableWidth()));
    };
    const stop = () => {
      setSidebarWidth((current) => clamp(current, sidebarMinWidth, sidebarMaxAvailableWidth()));
      document.body.classList.remove("isResizing");
      event.currentTarget.removeEventListener("pointermove", move);
      event.currentTarget.removeEventListener("pointerup", stop);
    };
    event.currentTarget.addEventListener("pointermove", move);
    event.currentTarget.addEventListener("pointerup", stop, { once: true });
  }

  function beginReviewResize(event: React.PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    cancelReviewClose();
    setReviewHasSessionWidth(true);
    const startX = event.clientX;
    const startWidth = reviewWidth;
    document.body.classList.add("isResizing");
    const move = (moveEvent: PointerEvent) => {
      if (!moveEvent.isPrimary || (moveEvent.buttons & 1) !== 1) {
        stop();
        return;
      }
      const nextWidth = startWidth - (moveEvent.clientX - startX);
      setReviewWidth(clamp(nextWidth, reviewMinWidthForViewport(), reviewMaxWidth()));
    };
    const stop = () => {
      setReviewWidth((current) => clamp(current, reviewMinWidthForViewport(), reviewMaxWidth()));
      document.body.classList.remove("isResizing");
      event.currentTarget.removeEventListener("pointermove", move);
      event.currentTarget.removeEventListener("pointerup", stop);
      event.currentTarget.removeEventListener("pointercancel", stop);
    };
    event.currentTarget.addEventListener("pointermove", move);
    event.currentTarget.addEventListener("pointerup", stop, { once: true });
    event.currentTarget.addEventListener("pointercancel", stop, { once: true });
  }

  function handleReviewResizeKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 24 : 8;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setReviewHasSessionWidth(true);
    setReviewWidth((width) => clamp(width + (event.key === "ArrowLeft" ? step : -step), reviewMinWidthForViewport(), reviewMaxWidth()));
  }

  function renderChatRow(chat: ChatRecord) {
    const connectionLabel = chat.modelEndpointMode === "server"
      ? "Company server"
      : chat.modelEndpointMode === "local"
        ? "Local model"
        : "";
    return (
      <div
        className={`chatRow ${activeChatId === chat.id ? "active" : ""} ${
          closedChatMessage(chat.taskState) ? "closed" : ""
        }`}
        key={chat.id}
      >
        <button className="chatRowMain" type="button" onClick={() => selectChat(chat)}>
          <span className={`chatRowContent ${connectionLabel ? "hasConnection" : ""}`}>
            {connectionLabel ? (
              <span className="chatConnectionIcon" role="img" aria-label={connectionLabel} title={connectionLabel}>
                {chat.modelEndpointMode === "server" ? <Cloud size={12} aria-hidden="true" /> : <Monitor size={12} aria-hidden="true" />}
              </span>
            ) : null}
            <strong>{chatDisplayTitle(chat)}</strong>
            <em>{chatSubline(chat)}</em>
          </span>
        </button>
        <button
          className="chatDeleteButton"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setDeleteCandidate({ kind: "chat", chat });
          }}
          title="Delete chat"
        >
          <Trash2 size={14} />
        </button>
      </div>
    );
  }

  return (
    <div
      className={`appShell ${isMacLike ? "macChrome" : ""} sidebarOpen ${
        reviewLayoutOpen ? "" : "reviewClosed"
      } ${reviewLayoutOpen ? "reviewOpen" : ""} ${reviewClosing ? "reviewClosing" : ""}`}
      style={layoutStyle}
    >
      <header className="topbar">
        <div className="topbarTitle" aria-hidden="true">
          <span className="topbarLogo" />
          <span>Umbratic</span>
        </div>
        <div className="topbarSpacer" />
      </header>

      <aside className="sidebar">
        <div className="sidebarResizeHandle" role="separator" tabIndex={0} aria-orientation="vertical" aria-valuemin={sidebarMinWidth} aria-valuemax={sidebarMaxAvailableWidth()} aria-valuenow={Math.round(sidebarWidth)} aria-label="Sidebar width" onPointerDown={beginSidebarResize} onKeyDown={(event) => { const step = event.shiftKey ? 24 : 8; if (event.key === "ArrowLeft") { event.preventDefault(); setSidebarWidth((width) => clamp(width - step, sidebarMinWidth, sidebarMaxAvailableWidth())); } if (event.key === "ArrowRight") { event.preventDefault(); setSidebarWidth((width) => clamp(width + step, sidebarMinWidth, sidebarMaxAvailableWidth())); } }} />
        <div className="sidebarStack">
          <section className="chatArchive">
            <div className="sideHeader">
              <h2>Chats</h2>
              <div className="newActionSplit" role="toolbar" aria-label="Create">
                <button className="newActionButton" type="button" onClick={newChat} aria-label="New chat" title="New chat">
                  <SquarePen size={13} />
                </button>
                <button
                  className="newActionButton"
                  type="button"
                  onClick={() => void newProject()}
                  disabled={busy}
                  aria-label="New project"
                  title="New project"
                >
                  <FolderPlus size={13} />
                </button>
              </div>
            </div>
            <div className="chatList">
              {chatProjectGroups.length ? (
                chatProjectGroups.map((group) => {
                  const collapsed = collapsedProjectKeys.has(group.key);
                  const projectTarget = chatProjectTarget(group);
                  return (
                    <section className="chatProject" key={group.key}>
                      <div className="chatProjectHeader">
                        <button
                          className="chatProjectToggle"
                          type="button"
                          onClick={() => toggleProjectGroup(group.key)}
                          aria-expanded={!collapsed}
                          title={group.path ?? group.name}
                        >
                          <ChevronDown className={collapsed ? "collapsed" : ""} size={14} />
                          <span>
                            <strong>{group.name}</strong>
                          </span>
                        </button>
                        {group.path ? (
                          <button
                            className="chatProjectNewButton"
                            type="button"
                            onClick={() => void newChatForProject({ name: group.name, path: group.path })}
                            title={`Start a new chat in "${group.name}"`}
                          >
                            <SquarePen size={14} />
                          </button>
                        ) : null}
                        {projectTarget ? (
                          <div className="chatProjectActions">
                            <button
                              className="chatProjectActionButton"
                              type="button"
                              onClick={() => {
                                setProjectActionMenuKey((current) => (current === group.key ? null : group.key));
                              }}
                              aria-expanded={projectActionMenuKey === group.key}
                              aria-haspopup="menu"
                              title={`Project actions for "${group.name}"`}
                            >
                              <Ellipsis size={14} />
                            </button>
                            {projectActionMenuKey === group.key ? (
                              <div className="chatProjectMenu" role="menu">
                                {projectTarget.chatCount > 0 ? (
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      setProjectActionMenuKey(null);
                                      setDeleteCandidate({ kind: "projectChats", project: projectTarget });
                                    }}
                                  >
                                    <MessageSquareX size={14} />
                                    <span>Delete all chats</span>
                                  </button>
                                ) : null}
                                <button
                                  className="danger"
                                  type="button"
                                  role="menuitem"
                                  onClick={() => {
                                    setProjectActionMenuKey(null);
                                    setDeleteCandidate({ kind: "project", project: projectTarget });
                                  }}
                                >
                                  <FolderX size={14} />
                                  <span>Delete project</span>
                                </button>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      {!collapsed ? (
                        <div className={`chatProjectChats ${group.worktrees.length ? "hasWorktrees" : ""}`}>
                          {group.chats.map((chat) => renderChatRow(chat))}
                          {group.worktrees.map((worktree) => {
                            const worktreeCollapsed = collapsedWorktreeKeys.has(worktree.key);
                            const canCreateWorktreeChat = /^task-[A-Za-z0-9_-]+$/.test(worktree.rootTaskId);
                            return (
                              <section className="chatWorktree" key={worktree.key}>
                                <div className="chatWorktreeHeader">
                                  <button
                                    className="chatWorktreeToggle"
                                    type="button"
                                    onClick={() => toggleWorktreeGroup(worktree.key)}
                                    aria-expanded={!worktreeCollapsed}
                                    title={worktree.path}
                                  >
                                    <ChevronDown className={worktreeCollapsed ? "collapsed" : ""} size={13} />
                                    <GitBranch size={13} />
                                    <span>
                                      <strong>{worktreeTitle(worktree)}</strong>
                                      <em>{worktreeSubline(worktree)}</em>
                                    </span>
                                  </button>
                                  <button
                                    className="chatWorktreeNewButton"
                                    type="button"
                                    onClick={() => void newChatForWorktree(group, worktree)}
                                    disabled={!canCreateWorktreeChat}
                                    title={`Start a new chat in "${worktreeTitle(worktree)}"`}
                                  >
                                    <SquarePen size={13} />
                                  </button>
                                </div>
                                {!worktreeCollapsed ? (
                                  <div className="chatWorktreeChats">
                                    {worktree.chats.map((chat) => renderChatRow(chat))}
                                  </div>
                                ) : null}
                              </section>
                            );
                          })}
                          {!group.chats.length && !group.worktrees.length ? <div className="chatProjectEmpty">No chats yet.</div> : null}
                        </div>
                      ) : null}
                    </section>
                  );
                })
              ) : (
                <div className="archiveEmpty">
                  <CircleDashed size={17} />
                  <span>No chats yet.</span>
                </div>
              )}
            </div>
          </section>
        </div>

        <div className="sidebarFooter">
          <div className="sidebarBrand" aria-hidden="true">
            <span className="sidebarBrandLogo" />
            <span className="confidentialMark">Private and Confidential</span>
          </div>
          <button
            className="settingsPlaceholder"
            type="button"
            onClick={() => {
              setSettingsOpen(true);
              connectionSettings.clearMessage();
              setFontScanMessage(null);
              void refreshStatus();
              void loadSkills();
            }}
          >
            <Settings size={16} />
            <span>Settings</span>
          </button>
        </div>
      </aside>

      <main className={`workspace ${approvalPending ? "approvalPending" : ""}`}>
        <section className="workArea">
          <section className="composerPanel">
            <div className="composerHeader">
              <div className="composerHeaderTitle">
                <strong>{composerHeaderTitle}</strong>
                <span>{composerHeaderMeta}</span>
              </div>
              <div className="composerHeaderActions">
                {renderIdePicker("composer")}
                <button
                  className="chromeButton composerReviewToggle"
                  type="button"
                  onClick={reviewClosing ? () => openReviewPanel() : toggleReviewPanel}
                  aria-pressed={reviewOpen && !reviewClosing}
                  title={reviewOpen && !reviewClosing ? "Hide review" : reviewClosing ? "Keep review open" : "Open review"}
                >
                  <PanelRight size={15} />
                </button>
              </div>
            </div>
            <div
              className="composerBody"
              ref={streamRef}
              onPointerDown={handleComposerScrollPointerDown}
              onScroll={handleComposerScroll}
              onTouchMove={handleComposerTouchMove}
              onWheel={handleComposerWheel}
            >
              {composerItems.length ? (
                <div className="timeline">
                  {composerItems.map((item) =>
                    item.type === "user" ? (
                      <article className="timelineMessage userMessage" key={item.id}>
                        <AttachmentPreviewList files={item.attachedFiles} mode="message" onOpen={openMessageAttachment} />
                        <div className="userMessageBubble">
                          {item.text ? <MarkdownContent content={item.text} /> : null}
                          {item.reviewFeedback.length ? (
                            <button
                              className="messageReviewFeedback"
                              type="button"
                              onClick={() => {
                                setReviewFeedbackPreview(item.reviewFeedback);
                                setReviewFeedbackDialogOpen(true);
                              }}
                              aria-haspopup="dialog"
                            >
                              <span className="messageReviewFeedbackIcon"><MessageSquareText size={13} /></span>
                              <span><strong>Review feedback</strong><small>{item.reviewFeedback.length} {item.reviewFeedback.length === 1 ? "comment" : "comments"}</small></span>
                              <ChevronRight size={13} aria-hidden="true" />
                            </button>
                          ) : null}
                        </div>
                        <div className="messageActions">
                          <button className="messageAction" type="button" onClick={() => void copyText(item.rawText)} title="Copy prompt">
                            <Copy size={14} />
                          </button>
                        </div>
                      </article>
                    ) : item.type === "compaction" ? (
                      <CompactionRow item={item} key={item.id} clock={activityClock} />
                    ) : item.type === "assistant" ? (
                      <AssistantMessage
                        key={item.id}
                        item={item}
                        settled={!isGenerating}
                        rating={responseFeedback.get(item.id)}
                        copyText={assistantCopyText}
                        onCopy={(text) => void copyText(text)}
                        onRate={openResponseFeedbackDialog}
                        documents={
                          item.final && reviewReadyForDisplay && documentReviewFiles.length ? (
                            <div className="documentResponseLinks" aria-label="Generated documents">
                              {documentReviewFiles.map((file) => (
                                <DocumentReviewResponseLink
                                  file={file}
                                  key={file.path}
                                  onOpenReview={openReviewPanel}
                                />
                              ))}
                            </div>
                          ) : null
                        }
                      >
                        {item.streaming ? (
                          <StreamingTextContent content={item.text} />
                        ) : (
                          <LongMarkdownContent
                            content={item.text}
                            onReviewFileClick={openReviewReference}
                            reviewFiles={reviewFiles}
                          />
                        )}
                      </AssistantMessage>
                    ) : (
                      (() => {
                        const hasTools = activityHasTools(item.segments);
                        if (!item.finished && !hasTools) {
                          return (
                            <article className="timelineActivity isGenerating isStatusOnly" key={item.id}>
                              <div className="activityHeader" role="status">
                                <span className="activityHeaderText">
                                  <strong>
                                    {activitySummary(item, activityClock)}
                                    <span className="activityDots" aria-hidden="true">
                                      <span>.</span><span>.</span><span>.</span>
                                    </span>
                                  </strong>
                                </span>
                              </div>
                            </article>
                          );
                        }
                        const expanded = expandedActivityIds.has(item.id);
                        return (
                          <article
                            className={`timelineActivity ${item.finished ? "isFinished" : "isGenerating"} ${expanded ? "isExpanded" : ""}`}
                            key={item.id}
                          >
                            <button
                              className="activityHeader"
                              type="button"
                              onClick={() => {
                                if (!expanded) {
                                  activityFollowScrollRef.current.set(item.id, true);
                                }
                                setExpandedActivityIds((current) => {
                                  const next = new Set(current);
                                  if (expanded) {
                                    next.delete(item.id);
                                  } else {
                                    next.add(item.id);
                                  }
                                  return next;
                                });
                              }}
                              aria-expanded={expanded}
                            >
                              <span className="activityHeaderText">
                                <strong>
                                  {activitySummary(item, activityClock)}
                                  {!item.finished ? (
                                    <span className="activityDots" aria-hidden="true">
                                      <span>.</span>
                                      <span>.</span>
                                      <span>.</span>
                                    </span>
                                  ) : null}
                                </strong>
                              </span>
                              <ChevronRight className="activityChevron" size={13} />
                            </button>
                            <div className={`activityBody ${expanded ? "open" : ""}`} aria-hidden={!expanded}>
                              <div
                                className="activityBodyInner"
                                ref={(node) => setActivityBodyRef(item.id, node)}
                                onPointerDown={(event) => handleActivityPointerDown(item.id, event)}
                                onScroll={(event) => handleActivityScroll(item.id, event)}
                                onTouchMove={(event) => handleActivityTouchMove(item.id, event)}
                                onWheel={(event) => handleActivityWheel(item.id, event)}
                              >
                                <div className="activityBodyContent">
                                  {item.segments.map((segment) => {
                                    if (segment.type === "reasoning") {
                                      return (
                                        <section
                                          className={`activityLogEntry reasoningLog ${segment.finished ? "" : "isStreaming"}`}
                                          key={segment.id}
                                        >
                                          <WorkMarkdownContent content={segment.text.trim()} streaming={!segment.finished} />
                                        </section>
                                      );
                                    }
                                    if (segment.type === "skill") {
                                      const skillName = skills.find((skill) => skill.id === segment.skillId)?.name ?? segment.skillId;
                                      return (
                                        <section className="activityLogEntry skillLog" key={segment.id}>
                                          <Sparkles size={12} aria-hidden="true" />
                                          <span>Skill</span>
                                          <strong>{skillName}</strong>
                                        </section>
                                      );
                                    }
                                    const { label } = activityToolLabel(segment.run);
                                    const toolDisclosureId = `${item.id}:${segment.id}`;
                                    const toolExpanded = expandedActivityToolIds.has(toolDisclosureId);
                                    const hasVisibleDetails = commandHasVisibleDetails(segment.run);
                                    const toolLabelContent = (
                                      <>
                                        <SquareTerminal className="activityToolKindIcon" size={11} aria-hidden="true" />
                                        <span title={segment.run.command}>{label}</span>
                                      </>
                                    );
                                    return (
                                      <section
                                        className={`activityLogEntry commandLog ${segment.run.status} ${
                                          toolExpanded ? "isExpanded" : ""
                                        }`}
                                        key={segment.id}
                                      >
                                        {hasVisibleDetails ? (
                                          <button
                                            className="activityToolToggle"
                                            type="button"
                                            onClick={() => {
                                              setExpandedActivityToolIds((current) => {
                                                const next = new Set(current);
                                                if (toolExpanded) {
                                                  next.delete(toolDisclosureId);
                                                } else {
                                                  next.add(toolDisclosureId);
                                                }
                                                return next;
                                              });
                                            }}
                                            aria-expanded={toolExpanded}
                                          >
                                            {toolLabelContent}
                                            {toolExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                                          </button>
                                        ) : (
                                          <div className="activityToolToggle activityToolStatic">
                                            {toolLabelContent}
                                          </div>
                                        )}
                                        {!toolExpanded && segment.run.status === "running" ? (
                                          <pre className="activityLiveOutput" aria-live="polite">
                                            {commandVisibleOutput(segment.run).slice(-1200)}
                                          </pre>
                                        ) : null}
                                        {hasVisibleDetails && toolExpanded ? (
                                          <div className="activityToolGroupDetails">
                                            <div>
                                              <pre>{commandShellText(segment.run)}</pre>
                                            </div>
                                          </div>
                                        ) : null}
                                      </section>
                                    );
                                  })}
                                </div>
                              </div>
                            </div>
                          </article>
                        );
                      })()
                    ),
                  )}
                  {codeReviewFiles.length && reviewReadyForDisplay ? (
                    <ReviewSummaryCard
                      diffs={reviewDiffs}
                      files={codeReviewFiles}
                      onOpenReview={(filePath) => openReviewPanel(filePath)}
                      totals={codeReviewTotals}
                    />
                  ) : null}
                </div>
              ) : (
                <ComposerGreeting label={todayPromptLabel} />
              )}
            </div>
          </section>
        </section>

        {task?.state === "awaiting_worktree_approval" ? (
          <section ref={modalRef} tabIndex={-1} className="floatingApproval" role="alertdialog" aria-modal="true" aria-label="Create isolated worktree" onKeyDown={(event) => { if (event.key === "Escape") void approveWorktree(false); }}>
            <div>
              <strong>Create isolated worktree?</strong>
              <span>{task.agentBranch} at {task.worktreePath}</span>
            </div>
            <button className="secondaryAction" type="button" onClick={() => approveWorktree(false)}>
              <X size={15} />
              Decline
            </button>
            <button className="primaryAction" type="button" onClick={() => approveWorktree(true)}>
              <Play size={15} />
              Create
            </button>
          </section>
        ) : pendingPermission ? (
          <section ref={modalRef} tabIndex={-1} className="floatingApproval" role="alertdialog" aria-modal="true" aria-label="Command permission request" onKeyDown={(event) => { if (event.key === "Escape") void resolvePermission("deny"); }}>
            <div>
              <strong>{pendingPermission.consequence ?? `${pendingPermission.kind} permission`}</strong>
              <span>{pendingPermission.command}</span>
              {pendingPermission.riskyFragment ? <span>Risky fragment: {pendingPermission.riskyFragment}</span> : null}
              {pendingPermission.suggestion ? <span>{pendingPermission.suggestion}</span> : null}
            </div>
            <button className="secondaryAction" type="button" onClick={() => resolvePermission("deny")}>
              <X size={15} />
              Deny
            </button>
            <button className="primaryAction" type="button" onClick={() => resolvePermission("allow")}>
              <ShieldCheck size={15} />
              Run once
            </button>
          </section>
        ) : null}

        <section className="promptDock">
          <div className={`floatingAttachmentTray ${attachedFiles.length || reviewPromptFeedback.length ? "hasAttachments" : ""}`}>
            <AttachmentPreviewList files={attachedFiles} mode="composer" onRemove={removeAttachment} />
            {reviewPromptFeedback.length ? <button className="composerReviewFeedback" type="button" onClick={() => { setReviewFeedbackPreview(null); setReviewFeedbackDialogOpen(true); }} aria-haspopup="dialog"><span className="composerReviewFeedbackIcon"><MessageSquareText size={12} /></span><span>Review feedback</span><small>{reviewPromptFeedback.length}</small><ChevronRight className="composerReviewFeedbackChevron" size={12} aria-hidden="true" /></button> : null}
          </div>
          <div className="promptControls">
            <div className={`workspaceCluster ${repository?.kind === "git" ? "hasBranch" : ""}`}>
              <button className="workspaceControl" type="button" onClick={pickRepository} disabled={busy}>
                <span className="controlIcon"><FolderOpen size={14} /></span>
                <span>
                  <strong>{repository ? repository.name : "Select folder"}</strong>
                </span>
              </button>
              {repository?.kind === "git" ? (
                <div className="branchControl">
                  <button
                    className="branchTrigger"
                    type="button"
                    onClick={() => void toggleBranchMenu()}
                    aria-expanded={branchMenuOpen}
                    aria-haspopup="menu"
                    disabled={busy || checkoutPending}
                    title={`Branch: ${repository.originalBranch}`}
                  >
                    <GitBranch size={12} />
                    <span>{repository.originalBranch}</span>
                    <ChevronDown size={12} />
                  </button>
                  {branchMenuOpen ? (
                    <div className="branchMenu" role="menu">
                      <div className="branchMenuHeader">
                        <span>Branches</span>
                        <button
                          className="branchRefreshButton"
                          type="button"
                          onClick={() => void refreshBranches()}
                          disabled={branchesLoading}
                        >
                          {branchesLoading ? <Loader2 className="spin" size={12} /> : <RefreshCw size={12} />}
                        </button>
                      </div>
                      {branchError ? <div className="branchMenuError">{branchError}</div> : null}
                      {branches.length ? (
                        branches.map((branch) => {
                          const active = branch === repository.originalBranch;
                          return (
                            <button
                              key={branch}
                              type="button"
                              className={active ? "active" : ""}
                              onClick={() => void selectBranch(branch)}
                              disabled={checkoutPending}
                            >
                              {active ? <Check size={13} /> : <span className="branchSpacer" />}
                              <span>{branch}</span>
                            </button>
                          );
                        })
                      ) : !branchesLoading && !branchError ? (
                        <div className="branchMenuEmpty">No branches found</div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            {canUseWorktreeMode ? (
              <div className={`workspaceModeControl ${useWorktreeForNextRun ? "isWorktree" : ""}`}>
                <button
                  className="workspaceModeTrigger"
                  type="button"
                  onClick={toggleWorkspaceMode}
                  disabled={busy || workspaceModeLocked}
                  aria-expanded={workspaceModeMenuOpen}
                  aria-haspopup="menu"
                  title={
                    workspaceModeLocked
                      ? "This chat is already running in an isolated worktree"
                      : useWorktreeForNextRun
                        ? "Run this chat in an isolated worktree"
                        : "Run this chat in the selected repository"
                  }
                >
                  {useWorktreeForNextRun ? <GitBranch size={14} /> : <FolderOpen size={14} />}
                  <span>{useWorktreeForNextRun ? "Worktree" : "Local"}</span>
                  <ChevronDown size={12} />
                </button>
                {workspaceModeMenuOpen ? (
                  <div className="workspaceModeMenu" role="menu">
                    <button
                      className={workspaceMode === "local" ? "active" : ""}
                      type="button"
                      onClick={() => selectWorkspaceMode("local")}
                    >
                      <FolderOpen size={14} />
                      <span>Local</span>
                    </button>
                    <button
                      className={workspaceMode === "worktree" ? "active" : ""}
                      type="button"
                      onClick={() => selectWorkspaceMode("worktree")}
                    >
                      <GitBranch size={14} />
                      <span>Worktree</span>
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className={`permissionControl ${permissionMode === "auto_safe" ? "isElevated" : ""}`}>
              <button
                className="permissionTrigger"
                type="button"
                onClick={() => {
                  setPermissionMenuOpen((open) => {
                    const next = !open;
                    if (next) {
                      setBranchMenuOpen(false);
                      setWorkspaceModeMenuOpen(false);
                    }
                    return next;
                  });
                }}
                aria-expanded={permissionMenuOpen}
                aria-haspopup="menu"
                title={permissionMode === "auto_safe" ? "Auto-run low-risk actions" : "Ask before running actions"}
              >
                {permissionMode === "auto_safe" ? (
                  <ShieldCheck className="elevatedPermissionsIcon" size={14} />
                ) : (
                  <Hand size={14} />
                )}
                <span className="permissionLabel">{permissionMode === "auto_safe" ? "Auto-run low risk" : "Ask first"}</span>
                <ChevronDown size={12} />
              </button>
              {permissionMenuOpen ? (
                <div className="permissionMenu" role="menu">
                  <button
                    className={permissionMode === "normal" ? "active" : ""}
                    type="button"
                    onClick={() => {
                      setPermissionMenuOpen(false);
                      void updatePermissionMode("normal");
                    }}
                  >
                    <Hand size={14} />
                    <span>Ask first</span>
                  </button>
                  <button
                    className={permissionMode === "auto_safe" ? "active" : ""}
                    type="button"
                    onClick={() => {
                      setPermissionMenuOpen(false);
                      void updatePermissionMode("auto_safe");
                    }}
                  >
                    <ShieldCheck className="elevatedPermissionsIcon" size={14} />
                    <span>Auto-run low risk</span>
                  </button>
                </div>
              ) : null}
            </div>

            <div className="attachmentControl">
              <button
                className="attachmentTrigger"
                type="button"
                onClick={() => void pickAttachment()}
                disabled={!canAttachFiles}
                title="Attach file"
              >
                <Paperclip size={14} />
                {attachedFiles.length ? <span className="attachmentCount">{attachedFiles.length}</span> : null}
              </button>
              {showContextMeter ? (
                <ContextMeter
                  estimate={contextEstimate}
                  state={contextMeterLabel}
                  breakdown={runnerContextUsage?.breakdown}
                  compactionBlocked={runnerContextUsage?.compactionBlocked}
                  compactionBlockedReason={runnerContextUsage?.compactionBlockedReason}
                  compacting={contextCompacting}
                  draftTokens={composerDraftTokens}
                />
              ) : null}
            </div>
          </div>
          {closedChatNotice ? (
            <div className="closedChatNotice">
              <CheckCircle2 size={15} />
              <span>{closedChatNotice}</span>
            </div>
          ) : null}
          {providerReconnect ? (
            <div className="connectionNotice" role="status" aria-live="polite">
              <Loader2 className="connectionNoticeSpinner" size={14} aria-hidden="true" />
              <span>Lost connection to the model server</span>
              <b>Retry {providerReconnect.attempt}/{providerReconnect.maxAttempts}</b>
            </div>
          ) : null}
          <div className="composer" onDrop={handleComposerDrop} onDragOver={handleComposerDragOver}>
            {promptReferenceMenuOpen && !closedChatNotice ? (
              <div className="attachmentMenu" ref={attachmentMenuRef}>
                <div className="attachmentMenuHeader">
                  {mentionScope && mention?.kind === "file" ? (
                    <button
                      className="attachmentMenuBack"
                      type="button"
                      aria-label="Back to categories"
                      title="Back (⌫)"
                      onMouseDown={(pointer) => pointer.preventDefault()}
                      onClick={backToMentionCategories}
                    >
                      <ChevronLeft size={13} />
                    </button>
                  ) : skillMenuOpen ? (
                    <Sparkles size={14} />
                  ) : (
                    <AtSign size={14} />
                  )}
                  <span>
                    {skillMenuOpen
                      ? "Use a skill for this turn"
                      : !repository
                        ? "Search files after selecting a folder"
                        : categoryMenuOpen
                          ? `Add context from ${repository.name}`
                          : mentionMode === "file"
                            ? `Files in ${repository.name}`
                            : mentionMode === "folder"
                              ? `Folders in ${repository.name}`
                              : `Files & folders in ${repository.name}`}
                  </span>
                </div>
                <div className="attachmentMenuList">
                {categoryMenuOpen ? (
                  mentionCategories.map((category, index) => (
                    <button
                      className={`attachmentMenuCategory${index === selectedCategoryIndex ? " active" : ""}`}
                      data-category-index={index}
                      key={category.id}
                      type="button"
                      onMouseDown={(pointer) => pointer.preventDefault()}
                      onClick={() => selectMentionCategory(category.id)}
                      onMouseEnter={() => setSelectedCategoryIndex(index)}
                    >
                      {mentionCategoryIcon(category.id)}
                      <span>
                        <strong>{category.label}</strong>
                        <em>{category.hint}</em>
                      </span>
                      <ChevronRight className="attachmentMenuCategoryChevron" size={13} />
                    </button>
                  ))
                ) : skillMenuOpen ? (
                  skillMatches.length ? (
                    skillMatches.map((skill, index) => (
                      <button
                        className={index === selectedSkillIndex ? "active" : ""}
                        data-skill-index={index}
                        key={skill.id}
                        type="button"
                        onClick={() => insertSkillMention(skill)}
                        onMouseEnter={() => setSelectedSkillIndex(index)}
                      >
                        <Sparkles size={14} />
                        <span>
                          <strong>
                            <MentionMatchText text={skill.name} query={skillSearchQuery} />
                          </strong>
                          <em>{skill.description || skill.id}</em>
                        </span>
                        <small>{skillsEnabled[skill.id] === false ? "Off" : skillMention(skill)}</small>
                      </button>
                    ))
                  ) : (
                    <div className="attachmentMenuEmpty">No matching skills</div>
                  )
                ) : repository ? (
                  fileMatches.length ? (
                    fileMatches.map((file, index) => (
                      <button
                        className={index === selectedFileIndex ? "active" : ""}
                        data-file-index={index}
                        key={file.path}
                        type="button"
                        onClick={() => addAttachment(file)}
                        onMouseEnter={() => setSelectedFileIndex(index)}
                      >
                        {file.kind === "folder" ? <Folder size={14} /> : <File size={14} />}
                        <span>
                          <strong>
                            <MentionMatchText text={file.name} query={attachmentSearchQuery} />
                          </strong>
                          <em>
                            <MentionMatchText text={file.path} query={attachmentSearchQuery} />
                          </em>
                        </span>
                      </button>
                    ))
                  ) : (
                    <div className="attachmentMenuEmpty">
                      {mentionMode === "file"
                        ? "No matching files"
                        : mentionMode === "folder"
                          ? "No matching folders"
                          : "No matching files or folders"}
                    </div>
                  )
                ) : null}
                </div>
                <div className="attachmentMenuHints">
                  <span>
                    <kbd>↑</kbd>
                    <kbd>↓</kbd> Navigate
                  </span>
                  <span>
                    <kbd>↵</kbd> Select
                  </span>
                  {mentionScope && mention?.kind === "file" ? (
                    <span>
                      <kbd>⌫</kbd> Back
                    </span>
                  ) : null}
                  <span>
                    <kbd>esc</kbd> Dismiss
                  </span>
                  {categoryMenuOpen ? <span className="attachmentMenuHintNote">or just type to search</span> : null}
                </div>
              </div>
            ) : null}
            {activeQueuedPrompts.length ? (
              <div className="queuedPromptList" aria-label="Queued prompts">
                {activeQueuedPrompts.map((item, index) => (
                  <div className="queuedPrompt" key={item.id}>
                    <button
                      className="queuedPromptEdit"
                      type="button"
                      onClick={() => editQueuedPrompt(item)}
                      disabled={steerPending}
                      aria-label={`Edit queued prompt ${index + 1}`}
                      title="Edit queued prompt"
                    >
                      <span className="queuedPromptOrder">{index + 1}</span>
                      <span className="queuedPromptText">{item.prompt}</span>
                      <Pencil className="queuedPromptEditIcon" aria-hidden="true" size={13} />
                    </button>
                    {isGenerating ? (
                      <button
                        className="queuedPromptSteer"
                        type="button"
                        onClick={() => void steerSubmission(item, item.id)}
                        disabled={steerPending}
                        aria-label={`Steer with queued prompt ${index + 1}`}
                      >
                        <CornerUpRight size={13} />
                        <span>Steer</span>
                      </button>
                    ) : null}
                    <button
                      className="queuedPromptDelete"
                      type="button"
                      onClick={() => removeQueuedPrompt(item.id)}
                      disabled={steerPending}
                      aria-label={`Delete queued prompt ${index + 1}`}
                      title="Delete queued prompt"
                    >
                      <Trash2 aria-hidden="true" size={13} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="promptInputShell">
              <div className="promptEditor">
                <div className="promptHighlight" aria-hidden="true">
                  <div style={{ transform: `translateY(-${promptScrollTop}px)` }}>
                    {renderPromptHighlights(prompt, attachedFiles, skills)}
                  </div>
                </div>
                <textarea
                  ref={textareaRef}
                  value={prompt}
                  onChange={handlePromptChange}
                  onKeyDown={handlePromptKeyDown}
                  onPaste={handleComposerPaste}
                  onKeyUp={(event) => updateMention(event.currentTarget.value, event.currentTarget.selectionStart)}
                  onClick={(event) => updateMention(event.currentTarget.value, event.currentTarget.selectionStart)}
                  onSelect={(event) => updateMention(event.currentTarget.value, event.currentTarget.selectionStart)}
                  onScroll={(event) => setPromptScrollTop(event.currentTarget.scrollTop)}
                  disabled={busy || !!closedChatNotice}
                  placeholder={
                    closedChatNotice ? "This chat is closed. Start a new chat for more changes." : todayPromptLabel
                  }
                />
              </div>
              <div className="promptActionRail">
                {isGenerating && !hasComposerMessage ? (
                  <button
                    className="sendButton stopButton"
                    type="button"
                    onClick={() => void stopTask()}
                    disabled={stopPending}
                    aria-label={stopPending ? "Stopping generation" : "Stop generation"}
                    title={stopPending ? "Stopping generation" : "Stop generation"}
                  >
                    {stopPending ? <Loader2 className="spin" size={17} /> : <Square aria-hidden="true" fill="currentColor" size={12} />}
                  </button>
                ) : isGenerating ? (
                  <button
                    className="sendButton queueButton"
                    type="button"
                    onClick={queueCurrentPrompt}
                    disabled={!canQueue}
                    aria-label="Queue prompt"
                    title="Queue prompt"
                  >
                    <Send aria-hidden="true" size={16} />
                  </button>
                ) : (
                  <button className="sendButton" type="button" onClick={() => void startTask()} disabled={!canStart} aria-label="Send prompt" title="Send prompt">
                    {busy ? <Loader2 className="spin" size={17} /> : <Send aria-hidden="true" size={17} />}
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>
      </main>

      <aside className="reviewSidebar">
        <ReviewPanel
          files={reviewFiles}
          initialSelectedPath={reviewTargetPath}
          taskId={task?.id ?? `workspace:${repository?.rootPath ?? "none"}`}
          patchHash={task?.reviewPatchHash}
          scope={task?.reviewScope ?? tasklessReviewScope}
          canUseWorktreeScope={repository?.kind === "git" || task?.workspaceKind === "git"}
          canOpenIde={canOpenIde}
          canUndo={canUndo}
          canApprove={canApprove}
          selectedIdeLabel={selectedIde.label}
          approvalVisible={task?.state === "review_ready" || task?.state === "approving" || task?.state === "merged"}
          onClose={closeReviewPanel}
          onUndo={undoTask}
          onApprove={approveMerge}
          onOpenFile={openReviewFile}
          onScopeChange={changeReviewScope}
          onResizePointerDown={beginReviewResize}
          onResizeKeyDown={handleReviewResizeKeyDown}
          onAddFeedback={addReviewFeedbackToPrompt}
          onLoadDocumentReview={(documentPath) => task
            ? api.readDocumentReview({ taskId: task.id, documentPath })
            : Promise.resolve({ ok: false, code: "not_available", message: "Document previews are available for task reviews." })}
        />
      </aside>

      {responseFeedbackDialog ? (
        <div
          className="modalScrim responseFeedbackScrim"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !responseFeedbackSubmitting) {
              setResponseFeedbackDialog(null);
            }
          }}
        >
          <form
            ref={modalRef as React.RefObject<HTMLFormElement>}
            tabIndex={-1}
            className="responseFeedbackDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="response-feedback-title"
            onSubmit={(event) => {
              event.preventDefault();
              void submitResponseFeedback();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !responseFeedbackSubmitting) {
                setResponseFeedbackDialog(null);
              }
            }}
          >
            <header>
              <span className={`responseFeedbackDialogIcon is${responseFeedbackDialog.rating === "good" ? "Good" : "Bad"}`}>
                {responseFeedbackDialog.rating === "good" ? <ThumbsUp size={16} /> : <ThumbsDown size={16} />}
              </span>
              <h3 id="response-feedback-title">
                {responseFeedbackDialog.rating === "good"
                  ? "What made this a good answer?"
                  : "What could be better?"}
              </h3>
              <button
                className="responseFeedbackClose"
                type="button"
                aria-label="Close response feedback"
                disabled={responseFeedbackSubmitting}
                onClick={() => setResponseFeedbackDialog(null)}
              >
                <X size={15} />
              </button>
            </header>
            <fieldset>
              <legend>Choose one (optional)</legend>
              <div className="responseFeedbackOptions">
                {responseFeedbackReasons[responseFeedbackDialog.rating].map((reason) => (
                  <button
                    type="button"
                    key={reason}
                    aria-pressed={responseFeedbackDialog.reason === reason}
                    onClick={() => setResponseFeedbackDialog((current) => current ? {
                      ...current,
                      reason: current.reason === reason ? undefined : reason,
                    } : current)}
                  >
                    {reason}
                  </button>
                ))}
              </div>
            </fieldset>
            <label>
              <span>Additional details (optional)</span>
              <textarea
                ref={responseFeedbackInputRef}
                autoFocus
                data-modal-autofocus
                value={responseFeedbackDialog.comment}
                maxLength={1000}
                placeholder="Add a note"
                onChange={(event) => {
                  const comment = event.target.value;
                  setResponseFeedbackDialog((current) => current ? { ...current, comment } : current);
                }}
              />
            </label>
            <footer>
              <button
                className="secondaryAction"
                type="button"
                disabled={responseFeedbackSubmitting}
                onClick={() => setResponseFeedbackDialog(null)}
              >
                Cancel
              </button>
              <button className="primaryAction" type="submit" disabled={responseFeedbackSubmitting}>
                {responseFeedbackSubmitting ? "Submitting…" : "Submit"}
              </button>
            </footer>
          </form>
        </div>
      ) : null}
      {reviewFeedbackDialogOpen ? (() => {
        const readOnly = reviewFeedbackPreview !== null;
        const dialogFeedback = readOnly
          ? reviewFeedbackPreview.map((comment, index) => ({ ...comment, id: `sent-${index}` }))
          : reviewPromptFeedback.map((comment) => ({ ...comment, lineLabel: reviewCommentLineLabel(comment) }));
        const closeDialog = () => {
          setReviewFeedbackDialogOpen(false);
          setReviewFeedbackPreview(null);
        };
        return (
          <div className="modalScrim reviewFeedbackScrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }}>
            <section className="reviewFeedbackDialog" role="dialog" aria-modal="true" aria-labelledby="review-feedback-title" onKeyDown={(event) => { if (event.key === "Escape") closeDialog(); }}>
              <header><span><MessageSquareText size={16} /><strong id="review-feedback-title">Review feedback</strong><small>{dialogFeedback.length}</small></span><button type="button" onClick={closeDialog} aria-label="Close review feedback"><X size={15} /></button></header>
              <div>{dialogFeedback.map((comment) => <article key={comment.id}><div><button className="reviewFeedbackFileLink" type="button" onClick={() => { closeDialog(); openReviewReference(comment.filePath); }} title={`Open ${comment.filePath} in review`}><strong>{comment.filePath}</strong></button><small>{comment.lineLabel}</small></div><p>{comment.body}</p>{!readOnly ? <button type="button" onClick={() => setReviewPromptFeedback((current) => current.filter((candidate) => candidate.id !== comment.id))} aria-label={`Remove feedback for ${comment.filePath}`}><X size={13} /></button> : null}</article>)}</div>
              <footer>{!readOnly ? <button type="button" onClick={() => { setReviewPromptFeedback([]); closeDialog(); }}>Remove all</button> : null}<button className="primaryAction" type="button" onClick={closeDialog}>Done</button></footer>
            </section>
          </div>
        );
      })() : null}

      {settingsOpen ? (
        <div className="modalScrim" role="presentation">
          <section ref={modalRef} tabIndex={-1} className="settingsDialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onKeyDown={(event) => { if (event.key === "Escape") closeSettingsDialog(); }}>
            <header className="settingsDialogHeader">
              <span>
                <Settings size={17} />
                <strong id="settings-title">Settings</strong>
              </span>
              <button className="chromeButton" type="button" onClick={closeSettingsDialog} title="Close settings">
                <X size={15} />
              </button>
            </header>

            <div className="settingsLayout">
              <nav className="settingsNav" aria-label="Settings sections">
                <button
                  type="button"
                  className={`settingsNavItem ${settingsTab === "account" ? "isActive" : ""}`}
                  onClick={() => setSettingsTab("account")}
                >
                  <User size={15} />
                  <span>Connection</span>
                </button>
                <button
                  type="button"
                  className={`settingsNavItem ${settingsTab === "harness" ? "isActive" : ""}`}
                  onClick={() => setSettingsTab("harness")}
                >
                  <Brain size={15} />
                  <span>Harness</span>
                </button>
                <button
                  type="button"
                  className={`settingsNavItem ${settingsTab === "appearance" ? "isActive" : ""}`}
                  onClick={() => setSettingsTab("appearance")}
                >
                  <Type size={15} />
                  <span>Appearance</span>
                </button>
                <button
                  type="button"
                  className={`settingsNavItem ${settingsTab === "skills" ? "isActive" : ""}`}
                  onClick={() => setSettingsTab("skills")}
                >
                  <Sparkles size={15} />
                  <span>Skills</span>
                </button>
                <button
                  type="button"
                  className={`settingsNavItem ${settingsTab === "telemetry" ? "isActive" : ""}`}
                  onClick={() => setSettingsTab("telemetry")}
                >
                  <BarChart3 size={15} />
                  <span>Telemetry</span>
                </button>
              </nav>

              <div className="settingsContent">
                {settingsTab === "account" ? <ConnectionSettingsPanel controller={connectionSettings} /> : null}

                {settingsTab === "harness" ? (
                  <div className="settingsPanel">
                    <div className="settingsPanelHead">
                      <h3>Harness</h3>
                      <p>Choose the working profile Umbratic uses when it starts a new run.</p>
                    </div>

                    <div className="settingsGroup">
                      <h4>Profile</h4>
                      <div className="harnessOptionGrid">
                        {harnessProfiles.map((profile) => (
                          <button
                            key={profile.id}
                            type="button"
                            className={`harnessOption ${harnessDraftProfile === profile.id ? "isActive" : ""}`}
                            aria-pressed={harnessDraftProfile === profile.id}
                            onClick={() => selectHarnessProfile(profile.id)}
                          >
                            <span className="harnessOptionHead">
                              <strong>{profile.name}</strong>
                              {harnessDraftProfile === profile.id ? <Check size={14} /> : null}
                            </span>
                            <em>{profile.description}</em>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className={`settingsGroup contextLengthGroup ${endpointDraftSettings.mode === "server" ? "isDisabled" : ""}`}>
                      <div className="contextLengthHead">
                        <div>
                          <h4>Model context</h4>
                          <p>Choose the context window requested from Ollama in Local mode.</p>
                        </div>
                      </div>
                      <div className="contextLengthSliderShell">
                        <input
                          className="contextLengthSlider"
                          type="range"
                          min={0}
                          max={CONTEXT_LENGTH_OPTIONS.length - 1}
                          step={1}
                          value={harnessDraftContextIndex}
                          disabled={endpointDraftSettings.mode === "server"}
                          aria-label="Model context length"
                          aria-valuetext={`${formatTokenCount(harnessDraftContextLength)} tokens${harnessDraftContextLength === DEFAULT_CONTEXT_LENGTH ? ", default" : ""}`}
                          style={{
                            "--context-slider-progress": `${(harnessDraftContextIndex / (CONTEXT_LENGTH_OPTIONS.length - 1)) * 100}%`,
                          } as React.CSSProperties}
                          onChange={(event) => {
                            const option = CONTEXT_LENGTH_OPTIONS[Number(event.currentTarget.value)] ?? DEFAULT_CONTEXT_LENGTH;
                            setHarnessDraftContextLength(option);
                            setHarnessMessage(null);
                          }}
                        />
                        <div className="contextLengthSliderLabels" aria-hidden="true">
                          {CONTEXT_LENGTH_OPTIONS.map((option, index) => (
                            <span
                              key={option}
                              className={harnessDraftContextLength === option ? "isActive" : ""}
                              style={{ left: `${(index / (CONTEXT_LENGTH_OPTIONS.length - 1)) * 100}%` }}
                            >
                              <strong>{formatTokenCount(option)}</strong>
                              {option === DEFAULT_CONTEXT_LENGTH ? <small>Default</small> : null}
                            </span>
                          ))}
                        </div>
                      </div>
                      <p className="contextLengthHint">
                        {endpointDraftSettings.mode === "server"
                          ? "Context length is managed by your Veil server. Switch to Local to configure it here."
                          : "64K is the default. Veil verifies the effective model limit when each new chat starts; larger windows use more memory."}
                      </p>
                    </div>

                    <div className="settingsActions harnessSettingsActions">
                      <button
                        className={`settingsInlineButton ${harnessSaveFeedback === "saved" ? "isSuccess" : ""}`}
                        type="button"
                        onClick={() => void saveHarnessProfile()}
                        disabled={harnessSaving || !harnessDirty}
                      >
                        <Check size={13} />
                        <span>{harnessSaveFeedback === "saved" ? "Saved" : "Save harness"}</span>
                      </button>
                      {harnessDirty ? <p className="settingsMessage">Unsaved harness changes.</p> : null}
                      {harnessMessage ? <p className="settingsMessage settingsMessageError">{harnessMessage}</p> : null}
                    </div>
                  </div>
                ) : null}

                {settingsTab === "appearance" ? (
                  <div className="settingsPanel">
                    <div className="settingsPanelHead">
                      <h3>Appearance</h3>
                      <p>Theme and typography used throughout Umbratic.</p>
                    </div>

                    <div className="settingsGroup">
                      <h4>Theme</h4>
                      <div className="appearanceOptionGrid">
                        {[
                          { id: "system" as const, label: "System", icon: <Monitor size={15} /> },
                          { id: "light" as const, label: "Light", icon: <Sun size={15} /> },
                          { id: "dark" as const, label: "Dark", icon: <Moon size={15} /> },
                        ].map((option) => (
                          <button
                            className={appearanceSettings.theme === option.id ? "isActive" : ""}
                            key={option.id}
                            type="button"
                            aria-pressed={appearanceSettings.theme === option.id}
                            onClick={() => updateAppearanceSettings({ theme: option.id })}
                          >
                            {option.icon}
                            <span>{option.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="settingsGroup">
                      <h4>Fonts</h4>
                      <label className="settingsField">
                        <span>Interface</span>
                        <select
                          value={appearanceSettings.uiFont}
                          onChange={(event) => updateAppearanceSettings({ uiFont: event.target.value })}
                        >
                          {uiFontOptions.map((font) => (
                            <option key={font} value={font}>
                              {font}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="settingsField">
                        <span>Code</span>
                        <select
                          value={appearanceSettings.monoFont}
                          onChange={(event) => updateAppearanceSettings({ monoFont: event.target.value })}
                        >
                          {monoFontOptions.map((font) => (
                            <option key={font} value={font}>
                              {font}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="settingsActions">
                        <button
                          className="settingsInlineButton"
                          type="button"
                          onClick={() => void scanSystemFonts()}
                          disabled={fontScanPending || !localFontAccessAvailable()}
                          title={localFontAccessAvailable() ? "Scan installed fonts" : "System font scanning is unavailable here"}
                        >
                          {fontScanPending ? <Loader2 className="spin" size={13} /> : <RefreshCw size={13} />}
                          <span>Scan system fonts</span>
                        </button>
                        {!localFontAccessAvailable() ? (
                          <p className="settingsMessage">System font scanning is unavailable here, so Umbratic is showing common system font choices.</p>
                        ) : null}
                        {fontScanMessage ? <p className="settingsMessage">{fontScanMessage}</p> : null}
                      </div>
                    </div>

                    <div className="appearancePreview">
                      <strong>Preview</strong>
                      <p>The quick brown fox jumps over a careful build log.</p>
                      <code>cmake --build .umbratic/build --parallel</code>
                    </div>
                  </div>
                ) : null}

                {settingsTab === "skills" ? (
                  <div className="settingsPanel">
                    <div className="settingsPanelHead">
                      <h3>Skills</h3>
                      <p>
                        Focused guidance for specific work.
                      </p>
                    </div>

                    <div className="settingsGroup">
                      <div className="skillSectionHeader">
                        <h4>Available skills</h4>
                        <div className="skillSectionActions">
                          <button
                            className="settingsInlineButton"
                            type="button"
                            onClick={() => {
                              setSkillsMessage(null);
                              void loadSkills();
                            }}
                            disabled={skillsLoading}
                            title="Refresh skills"
                          >
                            {skillsLoading ? <Loader2 className="spin" size={13} /> : <RefreshCw size={13} />}
                            <span>Refresh</span>
                          </button>
                          <button className="settingsInlineButton" type="button" onClick={() => void openSkillsFolder()}>
                            <FolderOpen size={13} />
                            <span>Open folder</span>
                          </button>
                          <button className="settingsInlineButton" type="button" onClick={() => void importSkill()} disabled={skillsLoading}>
                            <FileText size={13} />
                            <span>Import</span>
                          </button>
                          <button
                            className="settingsInlineButton"
                            type="button"
                            onClick={() => {
                              setNewSkillFormOpen((open) => !open);
                              setSkillsMessage(null);
                            }}
                          >
                            <Plus size={13} />
                            <span>New skill</span>
                          </button>
                        </div>
                      </div>
                      <div className="segmented skillFilter" aria-label="Skill source filter">
                        <button
                          type="button"
                          className={skillSourceFilter === "local" ? "active" : ""}
                          onClick={() => selectSkillSourceFilter("local")}
                        >
                          Personal
                        </button>
                        <button
                          type="button"
                          className={skillSourceFilter === "system" ? "active" : ""}
                          onClick={() => selectSkillSourceFilter("system")}
                        >
                          System
                        </button>
                      </div>

                      {newSkillFormOpen ? (
                        <form
                          className="skillCreateForm"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void submitCreateSkill();
                          }}
                        >
                          <input
                            type="text"
                            placeholder="Skill name (e.g. Personal style guide)"
                            value={newSkillName}
                            onChange={(event) => setNewSkillName(event.target.value)}
                            autoFocus
                            disabled={creatingSkill}
                          />
                          <button type="submit" className="settingsInlineButton" disabled={creatingSkill || !newSkillName.trim()}>
                            {creatingSkill ? <Loader2 className="spin" size={13} /> : <Check size={13} />}
                            <span>Create</span>
                          </button>
                          <button
                            type="button"
                            className="chromeButton"
                            onClick={() => {
                              setNewSkillFormOpen(false);
                              setNewSkillName("");
                            }}
                            disabled={creatingSkill}
                          >
                            <X size={13} />
                          </button>
                        </form>
                      ) : null}

                      {skillsLoading && !skillsLoaded ? (
                        <div className="settingsEmpty">
                          <Loader2 className="spin" size={16} />
                          <span>Loading skills…</span>
                        </div>
                      ) : skills.length === 0 ? (
                        <div className="settingsEmpty">
                          <Sparkles size={16} />
                          <span>No skills yet. Use New skill, or add a folder with a SKILL.md to the directory above.</span>
                        </div>
                      ) : visibleSkills.length === 0 ? (
                        <div className="settingsEmpty">
                          <Sparkles size={16} />
                          <span>No skills match this filter.</span>
                        </div>
                      ) : (
                        <ul className="skillList">
                          {visibleSkills.map((skill) => (
                            <li key={skill.id} className={`skillRow ${selectedSkillId === skill.id ? "isSelected" : ""}`}>
                              <div className="skillRowTop">
                                <button
                                  type="button"
                                  className="skillRowButton"
                                  onClick={() => void toggleSkillPreview(skill.id)}
                                  aria-expanded={selectedSkillId === skill.id}
                                >
                                  <ChevronRight className="skillExpandIcon" size={14} aria-hidden="true" />
                                  <div className="skillRowText">
                                    <strong>{skill.name}</strong>
                                    <em>{skill.description || skillMention(skill)}</em>
                                    <SkillGovernance skill={skill} />
                                  </div>
                                </button>
                                <button
                                  type="button"
                                  className={`toggle ${skillsEnabled[skill.id] ? "isOn" : ""}`}
                                  role="switch"
                                  aria-checked={!!skillsEnabled[skill.id]}
                                  aria-label={`Toggle ${skill.name}`}
                                  onClick={() => void toggleSkillSetting(skill.id)}
                                >
                                  <span className="toggleKnob" />
                                </button>
                              </div>
                              {selectedSkillId === skill.id ? (
                                <div className="skillPreviewPanel">
                                  <div className="skillPreviewHeader">
                                    <span>{skillPreviewLoading ? "Loading preview" : "Preview"}</span>
                                    <div className="skillPreviewActions">
                                      {skillDocument?.source === "system" && skillDocument.modified ? (
                                        <button
                                          type="button"
                                          className="settingsInlineButton"
                                          onClick={() => void resetSelectedSystemSkill()}
                                          disabled={skillPreviewLoading}
                                        >
                                          <Undo2 size={13} />
                                          <span>Reset</span>
                                        </button>
                                      ) : null}
                                      <button
                                        type="button"
                                        className="settingsInlineButton"
                                        onClick={() => void openSelectedSkillInEditor()}
                                        disabled={!skillDocument || skillPreviewLoading}
                                      >
                                        <ExternalLink size={13} />
                                        <span>Edit</span>
                                      </button>
                                    </div>
                                  </div>
                                  {skillPreviewLoading ? (
                                    <div className="skillPreviewEmpty">
                                      <Loader2 className="spin" size={14} />
                                      <span>Loading skill preview</span>
                                    </div>
                                  ) : selectedSkillPreview ? (
                                    <div className="skillPreviewBody">
                                      <MarkdownContent content={selectedSkillPreview} />
                                    </div>
                                  ) : (
                                    <p className="skillPreviewEmpty">No preview content.</p>
                                  )}
                                </div>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      )}

                      {skillsMessage ? <p className="settingsMessage">{skillsMessage}</p> : null}
                    </div>
                  </div>
                ) : null}

                {settingsTab === "telemetry" ? (
                  <div className="settingsPanel">
                    <div className="settingsPanelHead">
                      <h3>Telemetry</h3>
                      <p>
                        {telemetrySyncEnabled
                          ? "Your organization owns and controls telemetry stored on its configured Veil server."
                          : "Your organization owns and controls these logs. In local mode, they remain on this device."}
                      </p>
                    </div>

                    <div className="telemetryPrivacyNotice">
                      <ShieldCheck size={18} aria-hidden="true" />
                      <div>
                        <strong>Umbratic does not collect this data</strong>
                        <p>
                          Logs and telemetry can be shared with Umbratic only with explicit approval from you or your organization, and only to improve the platform.
                        </p>
                      </div>
                    </div>

                    <div className="settingsGroup">
                      <h4>Local logs</h4>
                      <div className="localLogsControl">
                        <strong>{formatFileSize(localLogInfo.bytes)}</strong>
                        <div>
                          <button className="settingsInlineButton" type="button" onClick={() => void exportLocalLogs()} disabled={localLogsBusy}>
                            Export
                          </button>
                          <button className="settingsInlineButton" type="button" onClick={() => void clearLocalLogs()} disabled={localLogsBusy || localLogInfo.entries === 0}>
                            Clear
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="settingsGroup">
                      <h4>{telemetrySyncEnabled ? "What your server receives" : "Local mode"}</h4>
                      <div className="settingsList telemetryDisclosureList">
                        {telemetrySyncEnabled ? (
                          <>
                            <div className="settingsListRow">
                              <span>Activity</span>
                              <p>
                                Review opens, editor choices, accept, undo, worktree actions, and context thresholds.
                              </p>
                            </div>
                            <div className="settingsListRow">
                              <span>Rated chats</span>
                              <p>
                                Only chats where you rate a response, plus the optional note. Unrated prompt text is not sent.
                              </p>
                            </div>
                            <div className="settingsListRow">
                              <span>Tool failures</span>
                              <p>
                                The attempted tool input and returned failure response, so your organization can diagnose problems.
                              </p>
                            </div>
                          </>
                        ) : (
                          <div className="settingsListRow">
                            <span>Uploads</span>
                            <p>Stored on this device under your organization&apos;s control. Nothing is sent to Umbratic without explicit permission.</p>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="settingsGroup">
                      <h4>{telemetrySyncEnabled ? "What stays private" : "What stays local"}</h4>
                      <div className="settingsList telemetryDisclosureList">
                        <div className="settingsListRow">
                          <span>Repository</span>
                          <p>
                            Source files, repository names and paths, ignored files, diffs, and attachments are never bulk-uploaded.
                          </p>
                        </div>
                        <div className="settingsListRow">
                          <span>Sensitive data</span>
                          <p>
                            Umbratic does not scan environment variables, credentials, keys, secret files, or ignored files for telemetry.
                          </p>
                        </div>
                        <div className="settingsListRow">
                          <span>Local diagnostics</span>
                          <p>
                            SQLite logs, successful tool output, and safe progress updates stay on this computer.
                          </p>
                        </div>
                      </div>
                      {telemetrySyncEnabled ? (
                        <p className="telemetryScopeNote">
                          Content included in a rated chat or present in a failed tool request or response is part of that specific telemetry item.
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {previewAttachment?.previewDataUrl ? (
        <div className="modalScrim imagePreviewScrim" role="presentation" onClick={() => setPreviewAttachment(null)}>
          <section
            ref={modalRef}
            tabIndex={-1}
            className="imagePreviewDialog"
            role="dialog"
            aria-modal="true"
            aria-label={attachmentLabel(previewAttachment)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => { if (event.key === "Escape") setPreviewAttachment(null); }}
          >
            <div className="imagePreviewHeader">
              <strong>{attachmentLabel(previewAttachment)}</strong>
              <button className="messageAction" type="button" onClick={() => setPreviewAttachment(null)} title="Close preview">
                <X size={15} />
              </button>
            </div>
            <div className="imagePreviewCanvas">
              <img alt={attachmentLabel(previewAttachment)} src={previewAttachment.previewDataUrl} />
            </div>
          </section>
        </div>
      ) : null}

      {deleteCandidate ? (
        <div className="modalScrim" role="presentation">
          <section ref={modalRef} tabIndex={-1} className="riskDialog deleteDialog" role="dialog" aria-modal="true" aria-labelledby="delete-title" onKeyDown={(event) => { if (event.key === "Escape") setDeleteCandidate(null); }}>
            <div className="dialogIcon deleteIcon">
              {deleteCandidate.kind === "project" ? (
                <FolderX size={18} />
              ) : deleteCandidate.kind === "projectChats" ? (
                <MessageSquareX size={18} />
              ) : (
                <Trash2 size={18} />
              )}
            </div>
            <div>
              <h3 id="delete-title">{deleteCandidateTitle(deleteCandidate)}</h3>
              <p>{deleteCandidateDescription(deleteCandidate)}</p>
            </div>
            <div className="dialogActions">
              <button className="secondaryAction" type="button" onClick={() => setDeleteCandidate(null)}>
                Cancel
              </button>
              <button className="dangerAction" type="button" onClick={confirmDeleteCandidate}>
                {deleteCandidate.kind === "project" ? (
                  <FolderX size={14} />
                ) : deleteCandidate.kind === "projectChats" ? (
                  <MessageSquareX size={14} />
                ) : (
                  <Trash2 size={14} />
                )}
                {deleteCandidateActionLabel(deleteCandidate)}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {showElevatedPermissionsDialog ? (
        <div className="modalScrim" role="presentation">
          <section ref={modalRef} tabIndex={-1} className="riskDialog safePermissionDialog" role="dialog" aria-modal="true" aria-labelledby="elevated-permissions-title" onKeyDown={(event) => { if (event.key === "Escape") setShowElevatedPermissionsDialog(false); }}>
            <div className="safePermissionIcon" aria-hidden="true">
              <ShieldCheck size={18} />
            </div>
            <div>
              <h3 id="elevated-permissions-title">Auto-run low-risk actions?</h3>
              <p>
                Verified non-destructive commands and routine workspace edits can continue without pausing.
                Umbratic will still ask before higher-risk or unrecognized actions.
              </p>
            </div>
            <div className="dialogActions">
              <button className="secondaryAction" type="button" onClick={() => setShowElevatedPermissionsDialog(false)}>
                Cancel
              </button>
              <button className="primaryAction" type="button" onClick={confirmElevatedPermissionsMode}>
                <ShieldCheck size={14} />
                Turn on auto-run
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {error ? (
        <div className="toast" role="alert">
          <TriangleAlert size={16} />
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">
            <X size={14} />
          </button>
        </div>
      ) : null}

    </div>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="emptyState">
      <CircleDashed size={18} />
      <span>{label}</span>
    </div>
  );
}

function ComposerGreeting({ label }: { label: string }) {
  return (
    <div className="composerGreeting">
      <span>{label}</span>
    </div>
  );
}

type RootElement = HTMLElement & {
  umbraticRoot?: ReturnType<typeof createRoot>;
};

const rootElement = typeof document === "undefined" ? null : document.getElementById("root") as RootElement | null;
if (rootElement) {
  api = window.umbratic
    ?? previewEnvironment?.api
    ?? (() => {
      throw new Error("The Umbratic preload API is not available. The desktop app cannot start.");
    })();
  const renderApp = (startupSettings: DesktopStartupSettings) => {
    rootElement.umbraticRoot ??= createRoot(rootElement);
    rootElement.umbraticRoot.render(<App startupSettings={startupSettings} />);
  };
  void api.getStartupSettings().then(renderApp, () => renderApp(defaultStartupSettings));
}
