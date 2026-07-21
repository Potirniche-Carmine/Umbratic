import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BackendUiEventInput } from "../shared/backendEvents";
import { chatTitleFromFirstMessage, stableChatTitle } from "../shared/chatTitle";
import {
  CONTEXT_LENGTH_OPTIONS,
  DEFAULT_CONTEXT_LENGTH,
  estimateContextUsage,
  formatTokenCount,
  normalizeContextLength,
  shouldShowContextMeter,
  type ContextEstimateMessage,
  type ContextUsageEstimate,
} from "../shared/contextWindow";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  AtSign,
  BarChart3,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  CircleDashed,
  Cloud,
  Copy,
  Ellipsis,
  ExternalLink,
  File,
  FileText,
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
  Play,
  Plus,
  RefreshCw,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  SquarePen,
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
  continueNumberedList,
  markdownPreview,
  parseMarkdown,
} from "./composerText";
import { normalizeReviewFile, type ReviewFile as NormalizedReviewFile } from "../shared/reviewDiff";
import { ReviewPanel } from "./review/ReviewPanel";
import { appendReviewFeedback, reviewCommentLineLabel, visibleReviewPrompt, type ReviewCommentDraft, type ReviewFeedbackReference } from "./review/reviewComments";

type ServiceStatus = "ready" | "degraded" | "unavailable";
type CapabilityProbeStatus = "available" | "missing" | "error" | "unknown";
type CapabilityProbeCategory = "required" | "recommended" | "optional-engineering" | "optional-artifacts";
type CapabilityProbeImportance = "required" | "recommended" | "optional";
type CapabilityProbeResult = {
  id: string;
  label: string;
  category: CapabilityProbeCategory;
  importance: CapabilityProbeImportance;
  status: CapabilityProbeStatus;
  version?: string;
  executablePath?: string;
  detectedCommand?: string;
  purpose: string;
  installHint: string;
  workflows: string[];
  checkedAt: string;
  message?: string;
};
type CapabilityProbeReport = {
  checkedAt: string;
  probes: CapabilityProbeResult[];
  summary: {
    available: number;
    missing: number;
    error: number;
    unknown: number;
    requiredMissing: number;
    recommendedMissing: number;
    optionalMissing: number;
  };
};
type PermissionMode = "normal" | "auto_safe";
type ReasoningMode = "fast" | "reasoning";
type AppearanceTheme = "system" | "light" | "dark";
type WorkspaceKind = "git" | "folder";
type WorkspaceMode = "local" | "worktree";
type RunnerToolId = "read" | "write" | "edit" | "search" | "command";
type RequiredToolContractRequirement = "file_change";
type RequiredToolContractReason =
  | "file_tools_disabled"
  | "missing_tool_call"
  | "agent_reported_blocker"
  | "attempted_tool_failed"
  | "no_review_changes";
type HarnessProfileId = "marketing" | "sales" | "engineering";
type LocalProviderId = "company-endpoint";
type ModelEndpointMode = "local" | "server";
type ModelEndpointSoftware = "ollama" | "vllm";
type ModelEndpointSettings = {
  mode: ModelEndpointMode;
  software: ModelEndpointSoftware;
  baseUrl: string;
  modelId: string;
  secret: string;
  secretConfigured: boolean;
  headers: Array<{ name: string; value: string; valueConfigured: boolean }>;
};
type CommandClass =
  | "read"
  | "edit"
  | "shell"
  | "python-runtime"
  | "markdown"
  | "cmake-build"
  | "compiler"
  | "package-manager"
  | "git-read"
  | "git-write"
  | "destructive-file"
  | "network"
  | "external-directory"
  | "unknown";
type ToolResultStatus = "success" | "permission_denied" | "policy_blocked" | "validation_error" | "runtime_error" | "timeout";
type ToolErrorCode =
  | "tool_disabled"
  | "unknown_tool"
  | "invalid_arguments"
  | "permission_denied"
  | "policy_blocked"
  | "workspace_boundary"
  | "blocked_path"
  | "command_exit_nonzero"
  | "process_timeout"
  | "process_error"
  | "missing_dependency"
  | "runtime_error";
type TaskState =
  | "awaiting_worktree_approval"
  | "running"
  | "completed"
  | "review_ready"
  | "approving"
  | "approved"
  | "merged"
  | "rejected"
  | "failed";

type RepositoryInfo = {
  id: string;
  name: string;
  rootPath: string;
  kind: WorkspaceKind;
  originalBranch: string;
  baseCommit: string;
  dirty: boolean;
  statusSummary: string;
};

type BackendStatus = {
  runner: ServiceStatus;
  endpoint: ServiceStatus;
  model: LocalModelInfo | null;
  models: LocalModelInfo[];
  providers: LocalModelProvider[];
  permissionMode: PermissionMode;
  endpointConfig: {
    source: "local-default" | "server-default" | "stored" | "managed";
    endpointEditingAllowed: boolean;
  };
  privacy: {
    share: "disabled";
    enabledProviders: LocalProviderId[];
    webTools: "disabled";
  };
  diagnostics: BackendDiagnostics;
  message?: string;
};

type BackendDiagnostics = {
  runnerName: string;
  runnerVersion: string;
  runnerContractVersion: string;
  policyVersion: string;
  runnerBinary: "present" | "missing";
  configAssertions: "enabled";
  providerAllowlist: LocalProviderId[];
  localhostOnlyModels: boolean;
  commandClassifier: "enabled";
  runnerDiagnosticsDirectory: string;
  localLogs: LocalDiagnosticInfo;
  telemetry: TelemetryPolicyInfo;
  runtimes: {
    python: {
      runtimeVersion: string;
      barePythonVerification: "allowed_uv_preferred";
      generatedPaths: string[];
    };
    markdown: {
      docsOnlyClassification: "enabled";
    };
    cmake: {
      runtimeVersion: string;
      buildDir: ".umbratic/build";
    };
    toolchain: {
      bundledHelperCommands: string[];
      optionalCapabilityCommands: string[];
    };
    shell: {
      platform: string;
      preferred: "pwsh" | "powershell" | "posix";
      nonInteractive: boolean;
    };
  };
  capabilities: CapabilityProbeReport;
};

type LocalDiagnosticInfo = { bytes: number; entries: number };

type TelemetryPolicyInfo = {
  mode: "developer_toggle" | "managed_required" | "managed_disabled";
  localEnabled: boolean;
  syncEnabled: boolean;
  retentionDays: number;
  exportFormat: "redacted-json";
  storage: "company-managed-telemetry" | "task-event-snapshots";
};

type LocalModelInfo = {
  providerId: LocalProviderId;
  providerName: string;
  modelId: string;
  displayName: string;
  baseUrl: string;
  contextLength?: number;
};

type LocalModelProvider = {
  providerId: LocalProviderId;
  providerName: string;
  baseUrl: string;
  status: ServiceStatus;
  models: LocalModelInfo[];
  message?: string;
};

type TestResult = {
  command: string;
  output: string;
  passed: boolean;
  exitCode: number | null;
  completedAt: string;
};

type ReviewFile = NormalizedReviewFile;

type IdeChoice = {
  id: string;
  label: string;
  icon: "vscode" | "visualstudio" | "explorer" | "finder" | "files";
};

type ChatAttachment = {
  path: string;
  name: string;
  source?: "workspace" | "chat";
  storedPath?: string;
  originalPath?: string;
  previewDataUrl?: string;
  contextTokens?: number;
};

type PastedAttachmentInput = {
  name?: string;
  mimeType?: string;
  dataUrl: string;
};

type FileSearchResult = ChatAttachment & {
  match: "path" | "content";
};

type TaskInfo = {
  id: string;
  chatId?: string;
  worktreeRootTaskId?: string;
  repositoryId: string;
  prompt: string;
  workspaceKind: WorkspaceKind;
  workspaceMode: WorkspaceMode;
  state: TaskState;
  originalBranch: string;
  baseCommit: string;
  agentBranch: string;
  worktreePath: string;
  permissionMode: PermissionMode;
  reasoningMode?: ReasoningMode;
  runnerName?: string;
  runnerVersion?: string;
  policyVersion?: string;
  createdAt: string;
  changedFiles: string[];
  reviewFiles: ReviewFile[];
  events: BackendUiEvent[];
  latestTest?: TestResult;
  reviewPatchHash?: string;
  reviewScope?: "task" | "worktree";
  reviewBaselineLabel?: string;
  reviewBaselineOid?: string;
  patchHash?: string;
  error?: string;
};

type ChatRecord = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  repositoryName?: string;
  repositoryPath?: string;
  taskId?: string;
  taskState?: TaskState;
  changedFiles?: number;
  worktreeRootTaskId?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeBaseCommit?: string;
  draftPrompt?: string;
  attachedFiles?: ChatAttachment[];
};

type WorktreeChatGroup = {
  key: string;
  rootTaskId: string;
  branch: string;
  path: string;
  baseCommit?: string;
  chats: ChatRecord[];
};

type ChatProjectGroup = {
  key: string;
  name: string;
  path?: string;
  chats: ChatRecord[];
  worktrees: WorktreeChatGroup[];
};
type ProjectDeleteTarget = {
  key: string;
  name: string;
  path: string;
  chatCount: number;
};
type DeleteCandidate =
  | { kind: "chat"; chat: ChatRecord }
  | { kind: "projectChats"; project: ProjectDeleteTarget }
  | { kind: "project"; project: ProjectDeleteTarget };

type UserNotes = {
  content: string;
  updatedAt: string;
};

type AppearanceSettings = {
  theme: AppearanceTheme;
  uiFont: string;
  monoFont: string;
};

type PermissionRequest = {
  id: string;
  kind: "read" | "edit" | "bash";
  summary: string;
  command: string;
  commandClass?: CommandClass;
  cwd: string;
  consequence?: string;
  riskyFragment?: string;
  suggestion?: string;
};

type BackendUiEvent = BackendUiEventInput;

type ApprovalCheck = {
  name: string;
  status: "running" | "passed" | "failed";
  detail?: string;
};

type CommandRun = {
  id: string;
  command: string;
  kind?: PermissionRequest["kind"];
  commandClass?: CommandClass;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  status: "running" | "passed" | "failed";
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
};

type ComposerActivitySegment =
  | { type: "reasoning"; id: string; text: string; durationMs: number | null; finished: boolean }
  | { type: "command"; id: string; run: CommandRun };

type ComposerTimelineItem =
  | { type: "user"; id: string; text: string; rawText: string; reviewFeedback: ReviewFeedbackReference[]; attachedFiles: ChatAttachment[] }
  | {
      type: "activity";
      id: string;
      segments: ComposerActivitySegment[];
      startedAt?: string;
      endedAt?: string;
      finished: boolean;
    }
  | { type: "assistant"; id: string; text: string; streaming?: boolean };

type SkillInfo = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  source?: "system" | "local";
  readOnly?: boolean;
  checksum?: string;
  checksumStatus?: "known_good" | "modified" | "untracked";
  modified?: boolean;
  provenance?: "bundled" | "created" | "imported";
};
type SkillDocument = SkillInfo & { path: string; content: string };
type SkillSourceFilter = "local" | "system";
type PromptMention = { kind: "file" | "skill"; query: string; start: number; end: number };

type DesktopApi = {
  listProjects(): Promise<RepositoryInfo[]>;
  listChats(): Promise<ChatRecord[]>;
  createChat(input?: { id?: string; title?: string; repositoryName?: string; repositoryPath?: string; worktreeTaskId?: string }): Promise<ChatRecord>;
  updateChatDraft(input: { chatId: string; draftPrompt: string; attachedFiles: ChatAttachment[] }): Promise<ChatRecord>;
  updateChatProject(input: { chatId: string; repositoryName: string; repositoryPath: string }): Promise<ChatRecord>;
  deleteChat(input: { chatId: string }): Promise<{ ok: true }>;
  deleteProjectChats(input: { repositoryPath: string }): Promise<{ ok: true; deletedChatIds: string[] }>;
  deleteProject(input: { repositoryPath: string }): Promise<{ ok: true; deletedChatIds: string[] }>;
  getNotes(): Promise<UserNotes>;
  updateNotes(input: { content: string }): Promise<UserNotes>;
  getTask(input: { taskId: string }): Promise<TaskInfo | null>;
  refreshTaskReview(input: { taskId: string; scope?: "task" | "worktree"; repositoryPath?: string }): Promise<TaskInfo | null>;
  refreshWorkspaceReview(input: { repositoryPath: string }): Promise<{ reviewFiles: ReviewFile[]; baselineOid: string }>;
  searchFiles(input: { repositoryId: string; query: string; limit?: number }): Promise<FileSearchResult[]>;
  pickRepository(): Promise<{ canceled: true } | { canceled: false; repository: RepositoryInfo }>;
  pickAttachmentFiles(input: { chatId: string; repositoryId?: string }): Promise<{ canceled: true } | { canceled: false; files: ChatAttachment[] }>;
  savePastedAttachments(input: { chatId: string; files: PastedAttachmentInput[] }): Promise<{ files: ChatAttachment[] }>;
  openChatAttachment(input: { attachment: ChatAttachment; repositoryId?: string }): Promise<{ ok: true } | { ok: false; message: string }>;
  getRepository(input: { repositoryId?: string; repositoryPath?: string }): Promise<RepositoryInfo | null>;
  listRepositoryBranches(input: { repositoryId?: string; repositoryPath?: string }): Promise<
    { ok: true; current: string; branches: string[] } | { ok: false; message: string }
  >;
  checkoutRepositoryBranch(input: { repositoryId?: string; repositoryPath?: string; branch: string }): Promise<
    { ok: true; repository: RepositoryInfo } | { ok: false; message: string }
  >;
  getBackendStatus(): Promise<BackendStatus>;
  getCapabilityProbes(input?: { force?: boolean }): Promise<CapabilityProbeReport>;
  getHarnessProfile(): Promise<HarnessProfileId>;
  saveHarnessProfile(input: HarnessProfileId): Promise<{
    settings: HarnessProfileId;
    status: BackendStatus;
  }>;
  getContextLength(): Promise<number>;
  saveContextLength(input: number): Promise<{
    contextLength: number;
    status: BackendStatus;
  }>;
  getModelEndpointSettings(): Promise<ModelEndpointSettings>;
  saveModelEndpointSettings(input: ModelEndpointSettings): Promise<{
    settings: ModelEndpointSettings;
    status: BackendStatus;
  }>;
  exportTelemetry(): Promise<{ ok: true; path: string } | { ok: false; message: string }>;
  exportLocalDiagnostics(): Promise<{ ok: true; path: string } | { ok: false; message: string }>;
  clearLocalDiagnostics(): Promise<LocalDiagnosticInfo>;
  recordProductEvent(input: {
    type: "review.opened" | "ide.selected";
    taskId?: string;
    repositoryId?: string;
    scope?: "task" | "worktree";
    target?: "task" | "project";
    ideId?: string;
    surface?: "composer" | "review";
  }): Promise<void>;
  listSkills(): Promise<{ skills: SkillInfo[]; directory: string }>;
  saveSkillSettings(input: Record<string, boolean>): Promise<{ skills: SkillInfo[]; directory: string }>;
  openSkillsFolder(): Promise<{ ok: true; directory: string } | { ok: false; message: string }>;
  openRunnerDiagnosticsFolder(): Promise<{ ok: true; directory: string } | { ok: false; message: string }>;
  openSkillInEditor(input: { id: string }): Promise<{ ok: true; path: string } | { ok: false; message: string }>;
  importSkill(input?: { sourcePath?: string }): Promise<
    | { ok: true; skill: SkillInfo; skills: SkillInfo[]; directory: string }
    | { ok: false; message: string }
  >;
  createSkill(input: { name: string }): Promise<
    | { ok: true; skill: SkillInfo; directory: string }
    | { ok: false; message: string }
  >;
  getSkillDocument(input: { id: string }): Promise<
    | { ok: true; skill: SkillDocument; directory: string }
    | { ok: false; message: string }
  >;
  saveSkillDocument(input: { id: string; content: string }): Promise<
    | { ok: true; skill: SkillDocument; skills: SkillInfo[]; directory: string }
    | { ok: false; message: string }
  >;
  resetSystemSkill(input: { id: string }): Promise<
    | { ok: true; skill: SkillDocument; skills: SkillInfo[]; directory: string }
    | { ok: false; message: string }
  >;
  setPermissionMode(mode: PermissionMode): Promise<BackendStatus>;
  listAvailableIdes(): Promise<IdeChoice[]>;
  startTask(input: {
    repositoryId?: string;
    prompt: string;
    chatId?: string;
    attachedFiles?: ChatAttachment[];
    reasoningMode?: ReasoningMode;
    useWorktree?: boolean;
    worktreeTaskId?: string;
  }): Promise<TaskInfo>;
  approveWorktreeCreation(input: { taskId: string; approved: boolean }): Promise<void>;
  respondToToolPermission(input: { taskId: string; id: string; decision: "allow" | "deny" }): Promise<void>;
  openRepositoryInIde(input: { repositoryId?: string; repositoryPath?: string; ideId: string }): Promise<{ ok: true } | { ok: false; message: string }>;
  openTaskInIde(input: { taskId: string; ideId: string; filePath?: string }): Promise<{ ok: true } | { ok: false; message: string }>;
  approveTaskMerge(input: { taskId: string }): Promise<
    | { ok: true; targetBranch: string; commit: string; patchHash: string; metadataPath: string }
    | { ok: false; message: string }
  >;
  rejectTask(input: { taskId: string; cleanup: boolean }): Promise<void>;
  keepWorktree(input: { taskId: string }): Promise<void>;
  cancelTask(input: { taskId: string }): Promise<void>;
  setResponseFeedback(input: { taskId: string; messageId: string; rating: "good" | "bad"; comment?: string }): Promise<void>;
  setWindowChromeTheme(theme: "dark" | "light"): Promise<{ ok: true }>;
  onBackendEvent(callback: (event: BackendUiEvent) => void): () => void;
};

const previewProjectsKey = "umbratic-preview-projects";
const previewChatsKey = "umbratic-preview-chats";
const previewNotesKey = "umbratic-preview-notes";
const appearanceSettingsKey = "umbratic-ui-appearance";
const workspaceModeKey = "umbratic-ui-workspace-mode";
const previewHarnessProfileKey = "umbratic-preview-harness-profile";
const previewContextLengthKey = "umbratic-preview-context-length";
const previewEndpointSettingsKey = "umbratic-preview-endpoint-settings";
const markdownPreviewCharacterLimit = 60000;
export const streamingMarkdownRenderBatchIntervalMs = 50;
const maxCachedTaskEventGroups = 24;
const commandOutputPreviewCharacterLimit = 12000;
let previewPermissionMode: PermissionMode = "normal";
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
const defaultModelEndpointSettings: ModelEndpointSettings = {
  mode: "local",
  software: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  modelId: "",
  secret: "",
  secretConfigured: false,
  headers: [
    { name: "", value: "", valueConfigured: false },
    { name: "", value: "", valueConfigured: false },
  ],
};
const savedEndpointSecretPlaceholder = "••••••••••••  Saved securely";
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
const harnessSystemSkillIds: Record<HarnessProfileId, ReadonlySet<string>> = {
  engineering: new Set(["umbratic-skill-creator", "umbratic-git-worktree", "umbratic-markdown", "umbratic-python"]),
  marketing: new Set([
    "umbratic-markdown",
    "umbratic-python",
    "umbratic-pdf",
    "umbratic-data-analysis",
    "umbratic-presentations",
    "umbratic-documents",
    "umbratic-spreadsheets",
  ]),
  sales: new Set([
    "umbratic-markdown",
    "umbratic-python",
    "umbratic-pdf",
    "umbratic-data-analysis",
    "umbratic-presentations",
    "umbratic-documents",
    "umbratic-spreadsheets",
  ]),
};
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

function readPreviewProjects(): RepositoryInfo[] {
  try {
    return JSON.parse(window.localStorage.getItem(previewProjectsKey) ?? "[]") as RepositoryInfo[];
  } catch {
    return [];
  }
}

function writePreviewProjects(projects: RepositoryInfo[]) {
  window.localStorage.setItem(previewProjectsKey, JSON.stringify(projects));
}

function readPreviewChats(): ChatRecord[] {
  try {
    return JSON.parse(window.localStorage.getItem(previewChatsKey) ?? "[]") as ChatRecord[];
  } catch {
    return [];
  }
}

function writePreviewChats(chats: ChatRecord[]) {
  window.localStorage.setItem(previewChatsKey, JSON.stringify(chats));
}

function readPreviewNotes(): UserNotes {
  try {
    const notes = JSON.parse(window.localStorage.getItem(previewNotesKey) ?? "{}") as Partial<UserNotes>;
    return {
      content: typeof notes.content === "string" ? notes.content : "",
      updatedAt: typeof notes.updatedAt === "string" ? notes.updatedAt : "",
    };
  } catch {
    return { content: "", updatedAt: "" };
  }
}

function writePreviewNotes(content: string): UserNotes {
  const notes = { content, updatedAt: new Date().toISOString() };
  window.localStorage.setItem(previewNotesKey, JSON.stringify(notes));
  return notes;
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

function readPreviewHarnessProfile(): HarnessProfileId {
  const profileId = window.localStorage.getItem(previewHarnessProfileKey);
  return isHarnessProfileId(profileId) ? profileId : defaultHarnessProfileId;
}

function writePreviewHarnessProfile(profileId: HarnessProfileId) {
  window.localStorage.setItem(previewHarnessProfileKey, profileId);
}

function readPreviewContextLength(): number {
  return normalizeContextLength(window.localStorage.getItem(previewContextLengthKey) ?? DEFAULT_CONTEXT_LENGTH);
}

function writePreviewContextLength(contextLength: number) {
  window.localStorage.setItem(previewContextLengthKey, String(normalizeContextLength(contextLength)));
}

function normalizeEndpointHeaders(value: unknown): Array<{ name: string; value: string; valueConfigured: boolean }> {
  const rows = Array.isArray(value) ? value : [];
  const headers = rows.slice(0, 2).map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return { name: "", value: "", valueConfigured: false };
    const record = row as Record<string, unknown>;
    return {
      name: typeof record.name === "string" ? record.name : "",
      value: typeof record.value === "string" ? record.value : "",
      valueConfigured: record.valueConfigured === true,
    };
  });
  while (headers.length < 2) headers.push({ name: "", value: "", valueConfigured: false });
  return headers;
}

function defaultEndpointBaseUrlForMode(mode: ModelEndpointMode, software: ModelEndpointSoftware): string {
  if (mode === "local") return "http://127.0.0.1:11434";
  return "https://your-veil-server.example";
}

function normalizeEndpointSettings(value: unknown): ModelEndpointSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...defaultModelEndpointSettings };
  const settings = value as Partial<ModelEndpointSettings>;
  const mode = settings.mode === "local" || settings.mode === "server" ? settings.mode : defaultModelEndpointSettings.mode;
  const software = mode === "local"
    ? "ollama"
    : settings.software === "ollama" || settings.software === "vllm"
      ? settings.software
      : "vllm";
  const baseUrl =
    typeof settings.baseUrl === "string" ? settings.baseUrl : defaultEndpointBaseUrlForMode(mode, software);
  return {
    mode,
    software,
    baseUrl,
    modelId: typeof settings.modelId === "string" ? settings.modelId : mode === "local" ? "" : "veil-managed",
    secret: typeof settings.secret === "string" ? settings.secret : "",
    secretConfigured: settings.secretConfigured === true,
    headers: normalizeEndpointHeaders(settings.headers),
  };
}

function endpointDefaultsForMode(mode: ModelEndpointMode): ModelEndpointSettings {
  const software: ModelEndpointSoftware = mode === "local" ? "ollama" : "vllm";
  return {
    mode,
    software,
    baseUrl: defaultEndpointBaseUrlForMode(mode, software),
    modelId: mode === "local" ? "" : "veil-managed",
    secret: "",
    secretConfigured: false,
    headers: normalizeEndpointHeaders([]),
  };
}

function endpointValidationMessage(settings: ModelEndpointSettings): string | null {
  try {
    const url = new URL(settings.baseUrl.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return "Use an HTTP or HTTPS URL.";
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (settings.mode === "local" && hostname !== "localhost" && hostname !== "::1" && !hostname.startsWith("127.")) {
      return "Local mode only connects to a model runtime on this computer.";
    }
  } catch {
    return `${settings.mode === "local" ? "Runtime" : "Server"} URL is invalid.`;
  }
  if (settings.mode === "local" && !settings.modelId.trim()) return "Enter the model name installed in your local runtime.";
  return null;
}

function readPreviewEndpointSettings(): ModelEndpointSettings {
  try {
    return normalizeEndpointSettings(JSON.parse(window.localStorage.getItem(previewEndpointSettingsKey) ?? "{}"));
  } catch {
    return { ...defaultModelEndpointSettings };
  }
}

function writePreviewEndpointSettings(settings: ModelEndpointSettings) {
  window.localStorage.setItem(previewEndpointSettingsKey, JSON.stringify(settings));
}

function publicPreviewEndpointSettings(settings: ModelEndpointSettings): ModelEndpointSettings {
  return {
    ...settings,
    secret: "",
    secretConfigured: settings.secretConfigured || !!settings.secret,
    headers: settings.headers.map((header) => ({
      name: header.name,
      value: "",
      valueConfigured: header.valueConfigured || !!header.value,
    })),
  };
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
const composerTestParams = new URLSearchParams(window.location.search);
const composerTestMode = composerTestParams.has("composerTest");
const composerTestRunning = composerTestParams.get("composerTest") === "running";
const composerTestToolIssue = composerTestParams.has("toolIssue");
const composerTestAttachments: ChatAttachment[] = [
  { path: "apps/desktop/src/renderer/main.tsx", name: "main.tsx", source: "workspace" },
  { path: "apps/desktop/src/renderer/styles.css", name: "styles.css", source: "workspace" },
];
const composerTestPrompt =
  'Make the composer feel fluid using @main.tsx and @styles.css. Keep escaped text safe: `a\\|b`, "<tag>", and {"ok":true}.';
const composerTestVisiblePrompt = composerTestParams.has("reviewFeedback")
  ? `${composerTestPrompt}\n\nPlease address this review feedback:\n\n**apps/desktop/src/renderer/review-panel.tsx · Lines 14-16**\n\n> <h2>Review</h2>\n> <p className="reviewHint">Inspect focused changes before accepting.</p>\n\nKeep this feedback easy to revisit from the conversation.`
  : composerTestPrompt;
const composerTestRepository: RepositoryInfo = {
  id: "preview-umbratic",
  name: "Umbratic",
  rootPath: "/Users/carminep/Projects/Umbratic",
  kind: "git",
  originalBranch: "main",
  baseCommit: "preview",
  dirty: false,
  statusSummary: "preview",
};
const composerTestEvents: BackendUiEvent[] = [
  {
    type: "user.message",
    taskId: "composer-test",
    text: composerTestVisiblePrompt,
    attachedFiles: composerTestAttachments,
    at: new Date(Date.now() - 18_000).toISOString(),
  },
  {
    type: "assistant.reasoning.delta",
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
    cwd: "/Users/carminep/Projects/Umbratic",
    kind: "read",
    commandClass: "read",
  },
  {
    type: "command.output",
    taskId: "composer-test",
    id: "composer-fixture-search",
    stream: "stdout",
    text: ".timelineActivity {\n  display: grid;\n}\n",
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
    cwd: "/Users/carminep/Projects/Umbratic",
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
      "- Thinking should stay compact and secondary.",
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

const composerTestReviewFiles: ReviewFile[] = [
  {
    path: "apps/desktop/src/features/review/new-panel.ts",
    status: "added",
    diff: [
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
    path: "apps/desktop/src/legacy/review-banner.ts",
    status: "deleted",
    diff: [
      "diff --git a/apps/desktop/src/legacy/review-banner.ts b/apps/desktop/src/legacy/review-banner.ts",
      "deleted file mode 100644",
      "index 24c118a..0000000",
      "--- a/apps/desktop/src/legacy/review-banner.ts",
      "+++ /dev/null",
      "@@ -1,9 +0,0 @@",
      "-export function legacyReviewBanner() {",
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
    diff: [
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
].map((file) => normalizeReviewFile(file as { path: string; status: ReviewFile["status"]; diff: string }));

const composerTestWholeDiffFiles: ReviewFile[] = [
  ...composerTestReviewFiles,
  normalizeReviewFile({
    path: "apps/desktop/.env.example",
    status: "modified",
    diff: [
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

const fallbackApi: DesktopApi = {
  listProjects: async () => readPreviewProjects(),
  listChats: async () => readPreviewChats(),
  createChat: async (input) => {
    const now = new Date().toISOString();
    const chat: ChatRecord = {
      id: input?.id ?? `preview-${Date.now().toString(36)}`,
      title: input?.title?.trim() || "New chat",
      createdAt: now,
      updatedAt: now,
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
    const deletedChatIds = readPreviewChats()
      .filter((chat) => chat.repositoryPath === input.repositoryPath)
      .map((chat) => chat.id);
    writePreviewChats(readPreviewChats().filter((chat) => chat.repositoryPath !== input.repositoryPath));
    return { ok: true, deletedChatIds };
  },
  deleteProject: async (input) => {
    const deletedChatIds = readPreviewChats()
      .filter((chat) => chat.repositoryPath === input.repositoryPath)
      .map((chat) => chat.id);
    writePreviewChats(readPreviewChats().filter((chat) => chat.repositoryPath !== input.repositoryPath));
    writePreviewProjects(readPreviewProjects().filter((project) => project.rootPath !== input.repositoryPath));
    return { ok: true, deletedChatIds };
  },
  getNotes: async () => readPreviewNotes(),
  updateNotes: async (input) => writePreviewNotes(input.content),
  getTask: async () => null,
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
      rootPath: "C:\\Users\\potir\\Documents\\Umbratic",
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
    permissionMode: previewPermissionMode,
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
      runnerDiagnosticsDirectory: "~/.umbratic/runner-diagnostics",
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
  getCapabilityProbes: async () => previewCapabilityReport(),
  getHarnessProfile: async () => readPreviewHarnessProfile(),
  saveHarnessProfile: async (input) => {
    const settings = isHarnessProfileId(input) ? input : defaultHarnessProfileId;
    writePreviewHarnessProfile(settings);
    previewSkills = previewSkills.map((skill) => ({ ...skill, enabled: harnessSystemSkillIds[settings].has(skill.id) }));
    return { settings, status: await fallbackApi.getBackendStatus() };
  },
  getContextLength: async () => readPreviewContextLength(),
  saveContextLength: async (input) => {
    const contextLength = normalizeContextLength(input);
    writePreviewContextLength(contextLength);
    return { contextLength, status: await fallbackApi.getBackendStatus() };
  },
  getModelEndpointSettings: async () => readPreviewEndpointSettings(),
  saveModelEndpointSettings: async (input) => {
    const settings = publicPreviewEndpointSettings(normalizeEndpointSettings(input));
    writePreviewEndpointSettings(settings);
    return { settings, status: await fallbackApi.getBackendStatus() };
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
    previewPermissionMode = mode;
    return fallbackApi.getBackendStatus();
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

const api = window.umbratic ?? fallbackApi;

function VsCodeLogo(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false" {...props}>
      <mask id="vscodeMask" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
        <path
          fill="#fff"
          fillRule="evenodd"
          clipRule="evenodd"
          d="M70.9 99.3a6.2 6.2 0 0 0 5-.2L96 89.5a6.3 6.3 0 0 0 3.6-5.7V16.2a6.3 6.3 0 0 0-3.6-5.7L75.9 1A6.3 6.3 0 0 0 68.7 2L30.2 37.1 13.4 24.4a4.2 4.2 0 0 0-5.4.2L2.6 29.5a4.2 4.2 0 0 0 0 6.2L17.2 50 2.6 64.3a4.2 4.2 0 0 0 0 6.2L8 75.4a4.2 4.2 0 0 0 5.4.2l16.8-12.7L68.7 98a6.3 6.3 0 0 0 2.2 1.3Zm4.4-72.4L46.1 50l29.2 23.1V26.9Z"
        />
      </mask>
      <g mask="url(#vscodeMask)">
        <path fill="#0065A9" d="M96.1 10.5 75.9 1A6.3 6.3 0 0 0 68.7 2L2.5 64.3a4.2 4.2 0 0 0 0 6.2L8 75.4a4.2 4.2 0 0 0 5.4.2l79.7-60.4a4.2 4.2 0 0 1 6.7 3.3v-.2a6.3 6.3 0 0 0-3.7-5.8Z" />
        <path fill="#007ACC" d="m96.1 89.5-20.2 9.6a6.3 6.3 0 0 1-7.2-1L2.5 35.7a4.2 4.2 0 0 1 0-6.2L8 24.6a4.2 4.2 0 0 1 5.4-.2l79.7 60.4a4.2 4.2 0 0 0 6.7-3.3v.2a6.3 6.3 0 0 1-3.7 5.8Z" />
        <path fill="#1F9CF0" d="M75.9 99.1A6.3 6.3 0 0 1 68.7 98c2.1 2 5.5.6 5.5-2.4V4.4c0-3-3.4-4.4-5.5-2.4A6.3 6.3 0 0 1 75.9 1L96 10.5a6.3 6.3 0 0 1 3.6 5.7v67.6a6.3 6.3 0 0 1-3.6 5.7l-20.2 9.6Z" />
      </g>
    </svg>
  );
}

function VisualStudioLogo(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
      <defs>
        <linearGradient id="vsGrad" x1="2" y1="12" x2="22" y2="12" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#52218a" />
          <stop offset=".5" stopColor="#682dac" />
          <stop offset="1" stopColor="#9b4ddc" />
        </linearGradient>
      </defs>
      <path fill="url(#vsGrad)" d="M16.7 2.5 22 4.6v14.8l-5.3 2.1-7.4-7.1-5.3 4.1L2 17.2V6.8L4 5.5l5.3 4.1 7.4-7.1Z" />
      <path fill="#fff" d="M16.7 7.4 11.7 12l5 4.6V7.4ZM4 9.5v5l3-2.5L4 9.5Z" />
    </svg>
  );
}

function ExplorerLogo(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
      <defs>
        <linearGradient id="folderTop" x1="12" y1="5" x2="12" y2="9" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f0a93a" />
          <stop offset="1" stopColor="#d68a1a" />
        </linearGradient>
        <linearGradient id="folderFront" x1="12" y1="9" x2="12" y2="19" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffd06b" />
          <stop offset="1" stopColor="#e8a83a" />
        </linearGradient>
      </defs>
      <path fill="url(#folderTop)" d="M3 7.2A2.2 2.2 0 0 1 5.2 5h3.6a2 2 0 0 1 1.5.7L12 7.5h6.8A2.2 2.2 0 0 1 21 9.7v1.6H3V7.2Z" />
      <path fill="url(#folderFront)" d="M3 10.4h18v6.4a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 16.8v-6.4Z" />
      <path fill="#ffffff" opacity=".18" d="M3 10.4h18v1.2H3z" />
    </svg>
  );
}

function FinderLogo(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
      <path fill="#38a8ff" d="M4.2 3.2h7.6v17.6H5.8a2.6 2.6 0 0 1-2.6-2.6V4.2a1 1 0 0 1 1-1Z" />
      <path fill="#d8f0ff" d="M11.8 3.2h8a1 1 0 0 1 1 1v14a2.6 2.6 0 0 1-2.6 2.6h-6.4V3.2Z" />
      <path fill="#14304a" d="M8 8.4a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6Zm8 0a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6Z" />
      <path fill="none" stroke="#14304a" strokeLinecap="round" strokeWidth="1.2" d="M9 15.4c1.7 1 4.3 1 6 0M11.8 4.5c-.6 2.8-.6 5.6 0 8.4" />
    </svg>
  );
}

function IdeIcon({ icon }: { icon: IdeChoice["icon"] }) {
  if (icon === "vscode") return <VsCodeLogo className="ideLogo" />;
  if (icon === "visualstudio") return <VisualStudioLogo className="ideLogo" />;
  if (icon === "finder") return <FinderLogo className="ideLogo" />;
  if (icon === "files") return <FolderOpen className="ideLogo" />;
  return <ExplorerLogo className="ideLogo" />;
}

function isReviewReadyText(text: string): boolean {
  return text.trim() === "Ready for review.";
}

function eventSignature(event: BackendUiEvent): string {
  if (event.type === "user.message") {
    return JSON.stringify({
      type: event.type,
      taskId: event.taskId,
      at: event.at,
      text: event.text,
      attachedFiles: (event.attachedFiles ?? []).map((file) => ({
        path: file.path,
        name: file.name,
        storedPath: file.storedPath,
        originalPath: file.originalPath,
      })),
    });
  }
  if (event.type === "assistant.delta" || event.type === "assistant.reasoning.delta") {
    return JSON.stringify({
      type: event.type,
      taskId: event.taskId,
      text: event.text,
    });
  }
  if (event.type === "assistant.done") {
    return JSON.stringify({
      type: event.type,
      taskId: event.taskId,
    });
  }
  return JSON.stringify(event);
}

function appendBackendEvent(events: BackendUiEvent[], event: BackendUiEvent, limit = 500): BackendUiEvent[] {
  if (event.type === "response.feedback") {
    return [
      ...events.filter(
        (existing) =>
          !(existing.type === "response.feedback" && existing.taskId === event.taskId && existing.messageId === event.messageId),
      ),
      event,
    ].slice(-limit);
  }
  if (
    event.type === "user.message" &&
    event.at &&
    events.some(
      (existing) =>
        existing.type === "user.message" &&
        existing.at === event.at &&
        eventSignature(existing) === eventSignature(event),
    )
  ) {
    return events;
  }
  const last = events.at(-1);
  if (
    last &&
    event.type === "user.message" &&
    last.type === "user.message" &&
    event.at &&
    last.at === event.at &&
    eventSignature(last) === eventSignature(event)
  ) {
    return events;
  }
  if (
    last &&
    (event.type === "assistant.delta" || event.type === "assistant.reasoning.delta") &&
    last.type === event.type &&
    last.taskId === event.taskId
  ) {
    return [
      ...events.slice(0, -1),
      {
        ...last,
        text: `${last.text}${event.text}`,
        endedAt: event.endedAt ?? event.at ?? last.endedAt ?? last.at,
      },
    ].slice(-limit);
  }
  if (
    last &&
    event.type === "command.output" &&
    last.type === "command.output" &&
    last.taskId === event.taskId &&
    last.id === event.id &&
    last.stream === event.stream
  ) {
    return [
      ...events.slice(0, -1),
      {
        ...last,
        text: `${last.text}${event.text}`,
        endedAt: event.endedAt ?? event.at ?? last.endedAt ?? last.at,
      },
    ].slice(-limit);
  }
  return [...events, event].slice(-limit);
}

export function compactBackendEvents(events: BackendUiEvent[], limit = 500): BackendUiEvent[] {
  return events.reduce<BackendUiEvent[]>((current, event) => appendBackendEvent(current, event, limit), []);
}

export function takeBatchedBackendEvents(pendingEvents: BackendUiEvent[]): BackendUiEvent[] {
  return pendingEvents.splice(0);
}

function eventTimelineTime(event: BackendUiEvent): string {
  return event.endedAt ?? event.at ?? "";
}

function shortHash(value: string): string {
  return value ? value.slice(0, 12) : "unknown";
}

function stateLabel(state?: TaskState): string {
  if (!state) return "idle";
  if (state === "awaiting_worktree_approval") return "awaiting worktree";
  if (state === "completed") return "answered";
  if (state === "review_ready") return "ready for review";
  if (state === "rejected") return "undone";
  return state.replace(/_/g, " ");
}

function titleFromPrompt(prompt: string): string {
  return chatTitleFromFirstMessage(prompt);
}

function chatDisplayTitle(chat: ChatRecord): string {
  return chat.title === "New chat" ? chat.title : titleFromPrompt(chat.title);
}

function draftMatchesTaskPrompt(draftPrompt: string, taskPrompt: string): boolean {
  const draft = draftPrompt.trim();
  const prompt = taskPrompt.trim();
  return !!draft && (prompt === draft || prompt.startsWith(`${draft}\n\nAttached files:`));
}

function relativeChatAge(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const elapsedMs = Math.max(0, Date.now() - timestamp);
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 1) return "<1m";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMs / 3_600_000);
  if (elapsedHours < 24) return `${elapsedHours}h`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}d`;
  return `${Math.floor(elapsedDays / 7)}w`;
}

function chatSubline(chat: ChatRecord): string {
  return chat.updatedAt ? relativeChatAge(chat.updatedAt) : "";
}

function closedChatMessage(state?: TaskState): string | undefined {
  if (state === "merged") {
    return "This chat was closed after its approved merge. Start a new chat for more changes.";
  }
  return undefined;
}

function folderName(pathValue?: string): string {
  if (!pathValue) return "No folder";
  return pathValue.split(/[\\/]/).filter(Boolean).pop() ?? pathValue;
}

function chatProjectKey(chat: ChatRecord): string {
  return chat.repositoryPath || "__unassigned__";
}

function chatWorktreeKey(chat: ChatRecord): string {
  if (!chat.worktreePath) return "";
  return `worktree:${chat.worktreeRootTaskId || chat.worktreePath}`;
}

function worktreeTitle(group: WorktreeChatGroup): string {
  return group.branch || folderName(group.path);
}

function worktreeSubline(group: WorktreeChatGroup): string {
  const count = chatCountLabel(group.chats.length);
  const base = group.baseCommit ? `base ${group.baseCommit.slice(0, 7)}` : folderName(group.path);
  return `${count} - ${base}`;
}

function chatCountLabel(count: number): string {
  return `${count} chat${count === 1 ? "" : "s"}`;
}

function deleteCandidateTitle(candidate: DeleteCandidate): string {
  if (candidate.kind === "chat") return "Delete chat?";
  if (candidate.kind === "projectChats") return `Delete all chats in ${candidate.project.name}?`;
  return `Delete project ${candidate.project.name}?`;
}

function deleteCandidateDescription(candidate: DeleteCandidate): string {
  if (candidate.kind === "chat") {
    return `This removes "${chatDisplayTitle(candidate.chat)}" from the chat archive and deletes app-managed chat files. Project folders and task worktrees are left alone.`;
  }
  if (candidate.kind === "projectChats") {
    return `This removes all ${chatCountLabel(candidate.project.chatCount)} in "${candidate.project.name}" from the chat archive and deletes app-managed chat files. The project folder and task worktrees are left alone.`;
  }
  if (candidate.project.chatCount === 0) {
    return `This removes "${candidate.project.name}" from saved projects. The project folder and task worktrees are left alone.`;
  }
  return `This removes "${candidate.project.name}" from saved projects and deletes its ${chatCountLabel(candidate.project.chatCount)} from the chat archive. The project folder and task worktrees are left alone.`;
}

function deleteCandidateActionLabel(candidate: DeleteCandidate): string {
  if (candidate.kind === "chat") return "Delete chat";
  if (candidate.kind === "projectChats") return "Delete chats";
  return "Delete project";
}

function chatAttachmentsMatch(left: ChatAttachment[], right: ChatAttachment[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((file, index) => {
    const other = right[index];
    return (
      !!other &&
      file.path === other.path &&
      file.name === other.name &&
      file.source === other.source &&
      file.storedPath === other.storedPath &&
      file.originalPath === other.originalPath
    );
  });
}

function chatAttachmentsSignature(files: ChatAttachment[]): string {
  return JSON.stringify(
    files.map((file) => ({
      path: file.path,
      name: file.name,
      source: file.source,
      storedPath: file.storedPath,
      originalPath: file.originalPath,
    })),
  );
}

function attachmentDetail(file: ChatAttachment): string {
  if (file.source === "workspace") return "Workspace file";
  return "Attached file";
}

function isImageAttachment(file: ChatAttachment): boolean {
  return !!file.previewDataUrl || /\.(png|jpe?g|webp|gif)$/i.test(file.name || file.path);
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

function isEscapedMarkdownAt(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
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

function eventTitle(event: BackendUiEvent): string {
  switch (event.type) {
    case "user.message":
      return "user";
    case "assistant.delta":
      return "assistant";
    case "assistant.reasoning.delta":
      return "thinking";
    case "assistant.done":
      return "assistant done";
    case "worktree.requested":
      return "worktree requested";
    case "worktree.created":
      return "worktree created";
    case "command.started":
      return "command started";
    case "command.output":
      return event.stream;
    case "command.finished":
      return "command finished";
    case "permission.requested":
      return "permission requested";
    case "permission.resolved":
      return `permission ${event.decision}`;
    case "review.ready":
      return "review ready";
    case "review.changed_since_ready":
      return "review changed";
    case "approval.check":
      return `check ${event.status}`;
    case "merge.approval":
      return event.decision === "approved" ? "accepted" : "rejected";
    case "approval.completed":
      return "approved";
    case "merge.completed":
      return "merged";
    case "ide.opened":
      return event.result === "success" ? "opened editor" : "editor open failed";
    case "response.feedback":
      return event.rating === "good" ? "liked response" : "disliked response";
    case "skill.selected":
      return "skill selected";
    case "required_tool.failed":
      return "required tool failed";
    case "task.error":
      return "task event";
    default:
      return "context";
  }
}

function eventDetail(event: BackendUiEvent): string {
  switch (event.type) {
    case "user.message":
      return event.text.trim();
    case "assistant.delta":
      return event.text.trim();
    case "assistant.reasoning.delta":
      return event.text.trim();
    case "assistant.done":
      return "stream complete";
    case "worktree.requested":
      return `${event.branch} at ${event.path}`;
    case "worktree.created":
      return `${event.branch} at ${event.path}`;
    case "command.started":
      return `${event.command}${event.commandClass ? ` - ${event.commandClass}` : ""} - ${event.cwd}`;
    case "command.output":
      return event.text.trim();
    case "command.finished":
      return `exit ${event.exitCode ?? "unknown"}`;
    case "permission.requested":
      return event.request.summary;
    case "permission.resolved":
      return event.id;
    case "review.ready":
      return `${event.changedFiles.length} changed file${event.changedFiles.length === 1 ? "" : "s"}`;
    case "review.changed_since_ready":
      return `${event.changedFileCount} file${event.changedFileCount === 1 ? "" : "s"} changed after review became ready`;
    case "approval.check":
      return event.detail ?? event.name;
    case "merge.approval":
      return event.reason ?? (event.cleanup === undefined ? event.decision : `${event.decision}, cleanup ${event.cleanup ? "on" : "off"}`);
    case "approval.completed":
      return `${event.target} ${shortHash(event.patchHash)}`;
    case "merge.completed":
      return `${event.targetBranch} ${shortHash(event.commit)}`;
    case "ide.opened":
      return [event.ideId, event.target, event.filePath, event.message].filter(Boolean).join(" - ");
    case "response.feedback":
      return event.messageId;
    case "skill.selected":
      return `${event.skillId} - ${event.reason}${event.fullContent ? " - full instructions" : " - metadata only"}`;
    case "required_tool.failed":
      return [event.requirement, event.reason, event.detail].filter(Boolean).join(" - ");
    case "task.error":
      return event.message;
    default:
      return "Workspace context updated.";
  }
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
              <File size={14} />
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

function ContextMeter({ estimate }: { estimate: ContextUsageEstimate }) {
  const displayedPercentage = Math.min(100, Math.max(0, estimate.percentage));
  const roundedPercentage = Math.round(estimate.percentage);
  const valueText = `Context input: ${formatTokenCount(estimate.contentTokens)} / ${formatTokenCount(estimate.contextLength)}, ${roundedPercentage}%`;
  return (
    <div
      className={`contextMeter is-${estimate.level}`}
      role="meter"
      aria-label="Model context input usage"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.min(100, roundedPercentage)}
      aria-valuetext={valueText}
      aria-describedby="context-meter-detail"
      tabIndex={0}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle className="contextMeterTrack" cx="12" cy="12" r="9" pathLength="100" />
        <circle
          className="contextMeterValue"
          cx="12"
          cy="12"
          r="9"
          pathLength="100"
          strokeDasharray={`${displayedPercentage} 100`}
        />
      </svg>
      <div className="contextMeterTooltip" id="context-meter-detail" role="tooltip">
        <span>
          Context input: <b>{formatTokenCount(estimate.contentTokens)} / {formatTokenCount(estimate.contextLength)}</b> · {roundedPercentage}%
        </span>
      </div>
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

export function commandLabel(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "Workspace action";
  if (/^search(?:\s|$)/i.test(trimmed)) return "Search workspace";
  if (/^read(?:\s|$)/i.test(trimmed)) return "Read workspace";
  if (/^write(?:\s|$)/i.test(trimmed)) return "Write file";
  if (/^edit(?:\s|$)/i.test(trimmed)) return "Edit files";
  if (/^(rg|grep|find|fd)\b/i.test(trimmed)) return "Search";
  if (/^npm\b.+\brun\b/i.test(trimmed)) return "Run script";
  if (/^git\b/i.test(trimmed)) return "Git";
  if (/^(node|python|python3)\b/i.test(trimmed)) return "Runtime";
  return trimmed.split(/\s+/).slice(0, 2).join(" ");
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function previewTail(value: string, limit: number): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: value.slice(-limit), truncated: true };
}

function isShellLikeCommand(command: string): boolean {
  return !/^(read|search|write|edit|glob|grep|task|question|todowrite|skill)(?:\s|$)/i.test(command.trim());
}

function workspaceActivityLabel(command: string): string {
  const label = commandLabel(command);
  return label;
}

export function commandSummary(run: CommandRun): string {
  if (run.status === "running") return "running";
  const outputPreview = previewTail(run.stdout || run.stderr, commandOutputPreviewCharacterLimit);
  const output = stripAnsi(outputPreview.text).trim();
  const lastLine = output.split(/\r?\n/).filter(Boolean).slice(-1)[0];
  if (run.status === "failed") {
    const exit = `exit ${run.exitCode ?? "unknown"}`;
    return lastLine ? `${exit}: ${lastLine}` : exit;
  }
  return output ? output.split(/\r?\n/).filter(Boolean).slice(-1)[0] : `exit ${run.exitCode ?? 0}`;
}

export function commandShellText(run: CommandRun): string {
  const isTool = !!run.kind && run.kind !== "bash" && !isShellLikeCommand(run.command);
  const parts = isTool ? [] : [`$ ${run.command}`];
  const outputPreview = previewTail([run.stdout, run.stderr].filter(Boolean).join("\n"), commandOutputPreviewCharacterLimit);
  const output = stripAnsi(outputPreview.text).trimEnd();
  if (outputPreview.truncated) {
    parts.push(`[Showing the last ${commandOutputPreviewCharacterLimit.toLocaleString()} characters of command output.]`);
  }
  if (output) parts.push(output);
  if (isTool && !parts.length) parts.push(commandSummary(run));
  return parts.join("\n\n");
}

export function commandDetailLabel(run: CommandRun): string {
  const isTool = !!run.kind && run.kind !== "bash" && !isShellLikeCommand(run.command);
  const label = isTool ? `${workspaceActivityLabel(run.command)} results` : "Shell";
  return run.commandClass ? `${label} - ${run.commandClass}` : label;
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
        existing.commandClass = event.commandClass;
        existing.cwd = event.cwd;
        continue;
      }
      runs.set(event.id, {
        id: event.id,
        command: event.command,
        kind: event.kind,
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

function eventTimeMs(value?: string): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function thoughtDurationMs(startedAt?: string, endedAt?: string, finished = true): number | null {
  const start = eventTimeMs(startedAt);
  if (start === undefined) return null;
  const end = eventTimeMs(endedAt) ?? (finished ? start : Date.now());
  return Math.max(0, end - start);
}

function formatDuration(value: number | null): string {
  if (value === null) return "";
  const totalSeconds = Math.max(1, Math.round(value / 1000));
  if (totalSeconds < 60) return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const minuteLabel = `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return seconds ? `${minuteLabel} ${seconds} second${seconds === 1 ? "" : "s"}` : minuteLabel;
}

function formatFileSize(bytes: number): string {
  const value = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 2 : 1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function activityDurationMs(item: Extract<ComposerTimelineItem, { type: "activity" }>, now = Date.now()): number | null {
  const start = eventTimeMs(item.startedAt);
  if (start === undefined) return null;
  const end = item.finished ? eventTimeMs(item.endedAt) ?? start : now;
  return Math.max(0, end - start);
}

export function activitySummary(item: Extract<ComposerTimelineItem, { type: "activity" }>, now = Date.now()): string {
  const duration = formatDuration(activityDurationMs(item, now));
  if (!item.finished) {
    return ["Working", duration].filter(Boolean).join(" · ");
  }
  return duration ? `Worked for ${duration}` : "Work complete";
}

function activityToolLabel(command: string): { key: string; label: string } {
  const trimmed = command.trim();
  const fileTool = trimmed.match(/^(read|write|edit)\s+([^\s]+)/i);
  if (fileTool) {
    const target = fileTool[2].replaceAll("\\", "/");
    const name = target.split("/").filter(Boolean).at(-1) ?? target;
    const action = `${fileTool[1][0].toUpperCase()}${fileTool[1].slice(1).toLowerCase()}`;
    return { key: `${action.toLowerCase()}:${target.toLowerCase()}`, label: `${action} ${name}` };
  }
  const label = commandLabel(command);
  return { key: label.toLowerCase(), label };
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
    const { key, label } = activityToolLabel(segment.run.command);
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

export function assistantTextFromEvents(events: BackendUiEvent[]): string {
  const text = events
    .filter((event): event is Extract<BackendUiEvent, { type: "assistant.delta" }> => event.type === "assistant.delta")
    .map((event) => event.text)
    .filter((text) => !isReviewReadyText(text))
    .join("")
    .trim();
  return stripAssistantSpeakerPrefix(text).trim();
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
  const prompt = taskPrompt?.trim();
  const hasUserMessages = events.some((event) => event.type === "user.message");

  if (prompt && !hasUserMessages) {
    const visiblePrompt = visibleReviewPrompt(prompt);
    items.push({ type: "user", id: "user-prompt", text: visiblePrompt.text, rawText: prompt, reviewFeedback: visiblePrompt.feedback, attachedFiles: [] });
  }

  const flushAssistant = (streaming = false) => {
    const text = stripAssistantSpeakerPrefix(assistantBuffer).trim();
    if (!text) {
      assistantBuffer = "";
      assistantNeedsSeparator = false;
      return;
    }
    assistantIndex += 1;
    items.push({ type: "assistant", id: `assistant-${assistantIndex}`, text, streaming: streaming || undefined });
    assistantBuffer = "";
    assistantNeedsSeparator = false;
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
    if (
      !activitySegments.length
      && (!activityStartedAt || (finished && !activityEndedAt))
    ) {
      activityStartedAt = undefined;
      activityEndedAt = undefined;
      return;
    }
    const reasoningSegments = activitySegments.filter((segment) => segment.type === "reasoning");
    const commandSegments = activitySegments.filter((segment) => segment.type === "command");
    const combinedReasoning = reasoningSegments.length
      ? [{
          ...reasoningSegments[0],
          text: reasoningSegments.map((segment) => segment.text.trim()).filter(Boolean).join("\n\n"),
          durationMs: reasoningSegments.reduce<number | null>((total, segment) => (
            segment.durationMs === null ? total : (total ?? 0) + segment.durationMs
          ), null),
          finished: reasoningSegments.every((segment) => segment.finished),
        }]
      : [];
    activityIndex += 1;
    items.push({
      type: "activity",
      id: `activity-${activityIndex}`,
      // Some providers deliver their reasoning summary after tool events. Keep the
      // explanation at the top of the activity so the UI reads as intent, then action.
      segments: [...combinedReasoning, ...commandSegments],
      startedAt: activityStartedAt,
      endedAt: activityEndedAt,
      finished,
    });
    activitySegments = [];
    activityStartedAt = undefined;
    activityEndedAt = undefined;
  };

  const flushReasoning = (finished = true) => {
    if (!reasoningBuffer.trim()) {
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
      text: reasoningBuffer,
      durationMs: thoughtDurationMs(reasoningStartedAt, reasoningEndedAt, finished),
      finished,
    });
    reasoningBuffer = "";
    reasoningStartedAt = undefined;
    reasoningEndedAt = undefined;
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
      markActivityTime(undefined, event.at);
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
    if (event.type === "assistant.reasoning.delta") {
      if (assistantBuffer.trim()) assistantNeedsSeparator = true;
      reasoningStartedAt = reasoningStartedAt ?? event.at;
      reasoningEndedAt = event.endedAt ?? event.at ?? reasoningEndedAt;
      reasoningBuffer = `${reasoningBuffer}${event.text}`;
      continue;
    }
    if (event.type === "assistant.done") {
      flushReasoning();
      markActivityTime(undefined, event.at);
      flushActivity();
      flushAssistant();
      continue;
    }
    if (event.type === "command.started") {
      flushReasoning();
      if (assistantBuffer.trim()) assistantNeedsSeparator = true;
      const existingRun = runs.get(event.id);
      if (existingRun) {
        existingRun.command = event.command;
        existingRun.kind = event.kind;
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
  flushReasoning(taskState !== "running");
  flushActivity(taskState !== "running");
  flushAssistant(taskState === "running");
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
    if (!activity.finished && !nextAutoOpenedKeys.has(key)) {
      nextAutoOpenedKeys.add(key);
      nextExpandedIds.add(activity.id);
      newlyOpenedIds.push(activity.id);
      continue;
    }
    if (activity.finished && nextAutoOpenedKeys.delete(key)) {
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
      {blocks.map((block, index) => {
        const isLast = index === blocks.length - 1;
        if (block.type === "code") {
          return <MarkdownCodeBlock content={block.content} key={index} language={block.language} />;
        }
        if (block.type === "heading") {
          const headingContent = (
            <>
              {renderInlineMarkdown(block.text, referenceOptions)}
              {isLast ? trailingInline : null}
            </>
          );
          if (block.level === 1) return <h3 key={index}>{headingContent}</h3>;
          if (block.level === 2) return <h4 key={index}>{headingContent}</h4>;
          return <h5 key={index}>{headingContent}</h5>;
        }
        if (block.type === "list") {
          const listItems = block.items.map((item, itemIndex) => (
            <li key={itemIndex}>
              {renderInlineMarkdown(item, referenceOptions)}
              {isLast && itemIndex === block.items.length - 1 ? trailingInline : null}
            </li>
          ));
          return block.ordered ? <ol key={index}>{listItems}</ol> : <ul key={index}>{listItems}</ul>;
        }
        if (block.type === "table") {
          return (
            <div className="markdownTableWrapper" key={index}>
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
          <p key={index}>
            {renderInlineMarkdown(block.text, referenceOptions)}
            {isLast ? trailingInline : null}
          </p>
        );
      })}
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

function StreamingTextContent({ content }: { content: string }) {
  return (
    <div className="streamingTextContent">
      <MarkdownContent
        content={content || "\u200b"}
        trailingInline={<span className="streamingTextCaret" aria-hidden="true" />}
      />
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

function App() {
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  const [repository, setRepository] = useState<RepositoryInfo | null>(composerTestMode ? composerTestRepository : null);
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>("normal");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(() => readWorkspaceMode());
  const reasoningMode: ReasoningMode = "reasoning";
  const [projects, setProjects] = useState<RepositoryInfo[]>(composerTestMode ? [composerTestRepository] : []);
  const [chats, setChats] = useState<ChatRecord[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [task, setTask] = useState<TaskInfo | null>(composerTestMode ? composerTestTask : null);
  const [prompt, setPrompt] = useState(composerTestMode ? composerTestPrompt : initialPrompt);
  const [reviewPromptFeedback, setReviewPromptFeedback] = useState<ReviewCommentDraft[]>([]);
  const [reviewFeedbackDialogOpen, setReviewFeedbackDialogOpen] = useState(false);
  const [reviewFeedbackPreview, setReviewFeedbackPreview] = useState<ReviewFeedbackReference[] | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<ChatAttachment[]>(composerTestMode ? composerTestAttachments : []);
  const [previewAttachment, setPreviewAttachment] = useState<ChatAttachment | null>(null);
  const [fileMatches, setFileMatches] = useState<FileSearchResult[]>([]);
  const [mention, setMention] = useState<PromptMention | null>(null);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [selectedSkillIndex, setSelectedSkillIndex] = useState(0);
  const [promptScrollTop, setPromptScrollTop] = useState(0);
  const [deleteCandidate, setDeleteCandidate] = useState<DeleteCandidate | null>(null);
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<Set<string>>(() => new Set());
  const [collapsedWorktreeKeys, setCollapsedWorktreeKeys] = useState<Set<string>>(() => new Set());
  const [projectActionMenuKey, setProjectActionMenuKey] = useState<string | null>(null);
  const [events, setEvents] = useState<BackendUiEvent[]>(composerTestMode ? composerTestEvents : []);
  const [feedbackDrafts, setFeedbackDrafts] = useState<Map<string, string>>(() => new Map());
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [approvalChecks, setApprovalChecks] = useState<ApprovalCheck[]>([]);
  const [expandedReviewPaths, setExpandedReviewPaths] = useState<Set<string>>(() =>
    composerTestMode ? new Set(composerTestReviewFiles.map((file) => file.path)) : new Set(),
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
  const [accountMessage, setAccountMessage] = useState<string | null>(null);
  const [endpointSettings, setEndpointSettings] = useState<ModelEndpointSettings>(() => ({ ...defaultModelEndpointSettings }));
  const [endpointDraftSettings, setEndpointDraftSettings] = useState<ModelEndpointSettings>(() => ({ ...defaultModelEndpointSettings }));
  const [endpointSettingsLoaded, setEndpointSettingsLoaded] = useState(false);
  const [endpointSaving, setEndpointSaving] = useState(false);
  const [endpointRefreshing, setEndpointRefreshing] = useState(false);
  const [harnessProfile, setHarnessProfile] = useState<HarnessProfileId>(defaultHarnessProfileId);
  const [harnessDraftProfile, setHarnessDraftProfile] = useState<HarnessProfileId>(defaultHarnessProfileId);
  const [contextLength, setContextLength] = useState(DEFAULT_CONTEXT_LENGTH);
  const [harnessDraftContextLength, setHarnessDraftContextLength] = useState(DEFAULT_CONTEXT_LENGTH);
  const [harnessMessage, setHarnessMessage] = useState<string | null>(null);
  const [harnessSaving, setHarnessSaving] = useState(false);
  const [appearanceSettings, setAppearanceSettings] = useState<AppearanceSettings>(() => {
    const saved = readAppearanceSettings();
    const fixtureTheme = composerTestParams.get("theme");
    return composerTestMode && (fixtureTheme === "light" || fixtureTheme === "dark")
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
  const skillsSaveSequenceRef = useRef(0);
  const skillsLoadedRef = useRef(false);
  const endpointSaveSequenceRef = useRef(0);
  const endpointModeDraftsRef = useRef<Partial<Record<ModelEndpointMode, ModelEndpointSettings>>>({});
  const suppressDraftSaveRef = useRef(false);
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
  const visibleTaskIdRef = useRef<string | null>(composerTestMode ? composerTestTask.id : null);
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
  const reviewDiffs = useMemo(
    () => new Map(reviewFiles.map((file) => [file.path, parseUnifiedDiff(file.diff)])),
    [reviewFiles],
  );
  const reviewTotals = useMemo(
    () =>
      reviewFiles.reduce(
        (total, file) => {
          const stats = reviewDiffs.get(file.path) ?? emptyParsedDiff;
          total.additions += stats.additions;
          total.deletions += stats.deletions;
          return total;
        },
        { additions: 0, deletions: 0 },
      ),
    [reviewDiffs, reviewFiles],
  );
  const selectedIde = availableIdes.find((ide) => ide.id === selectedIdeId) ?? availableIdes[0] ?? defaultIdeChoices[0];
  const selectedModel = backend?.model ?? null;
  const connectionState = backend?.endpoint ?? "checking";
  const connectionDisplayState = connectionState === "degraded" ? "ready" : connectionState;
  const connectionStatusLabel =
    backend?.endpoint === "ready" || backend?.endpoint === "degraded" ? "Connected" : backend ? "Unavailable" : "Checking";
  const endpointDirty = JSON.stringify(endpointDraftSettings) !== JSON.stringify(endpointSettings);
  const endpointValidation = endpointValidationMessage(endpointDraftSettings);
  const endpointEditingEnabled = backend?.endpointConfig.endpointEditingAllowed ?? true;
  const endpointFormDisabled = endpointSaving || !endpointEditingEnabled;
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
  const canStart = (prompt.trim().length > 0 || reviewPromptFeedback.length > 0) && !busy && !isGenerating && !closedChatNotice;
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
  const attachmentMenuOpen = mention?.kind === "file";
  const skillMenuOpen = mention?.kind === "skill";
  const promptReferenceMenuOpen = attachmentMenuOpen || skillMenuOpen;
  const attachmentSearchQuery = attachmentMenuOpen ? mention?.query ?? "" : "";
  const skillSearchQuery = skillMenuOpen ? mention?.query ?? "" : "";
  const skillMatches = useMemo(() => {
    const query = skillSearchQuery.trim().toLowerCase();
    const candidates = skills.filter((skill) => {
      if (!query) return true;
      return (
        skill.id.toLowerCase().includes(query) ||
        skill.name.toLowerCase().includes(query) ||
        skill.description.toLowerCase().includes(query)
      );
    });
    return candidates.slice(0, 10);
  }, [skillSearchQuery, skills]);
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
  const responseFeedbackComments = useMemo(() => {
    const comments = new Map<string, string>();
    for (const event of visibleEvents) {
      if (event.type === "response.feedback" && event.comment) comments.set(event.messageId, event.comment);
    }
    return comments;
  }, [visibleEvents]);
  const composerItems = useMemo(
    () => composerTimelineFromEvents(visibleEvents, task?.prompt, task?.state),
    [task?.prompt, task?.state, visibleEvents],
  );
  const runnerContextUsage = useMemo(() => {
    for (let index = visibleEvents.length - 1; index >= 0; index -= 1) {
      const event = visibleEvents[index];
      if (event.type === "context.usage") return event;
    }
    return null;
  }, [visibleEvents]);
  const contextEstimateMessages = useMemo<ContextEstimateMessage[]>(() => {
    const messages = runnerContextUsage ? [] : composerItems.map((item): ContextEstimateMessage => {
      if (item.type === "user") return { text: item.rawText, attachments: item.attachedFiles };
      if (item.type === "assistant") return { text: item.text };
      return {
        text: item.segments
          .map((segment) =>
            segment.type === "reasoning"
              ? segment.text
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
    setFeedbackDrafts(new Map());
    if (nextTask) setWorkspaceReview(null);
    setTask(nextTask);
  }

  function prepareVisibleTaskLoad(taskId: string | null) {
    visibleTaskIdRef.current = taskId;
    setFeedbackDrafts(new Map());
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
      for (const group of activityToolGroups(item.segments)) {
        activeActivityToolIds.add(`${item.id}:${group.id}`);
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
    void loadEndpointSettings();
    void loadHarnessProfile();
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
        if (event.type === "assistant.done") {
          if (isVisibleTaskEvent) {
            setTask((current) =>
              current && current.id === event.taskId && current.state === "running" ? { ...current, state: "completed" } : current,
            );
          }
          void loadChats();
        }
        if (event.type === "permission.requested" && isVisibleTaskEvent) setPendingPermission(event.request);
        if (event.type === "permission.resolved" && isVisibleTaskEvent) {
          setPendingPermission((current) => (current?.id === event.id ? null : current));
        }
        if (event.type === "worktree.requested") {
          if (isVisibleTaskEvent) {
            setTask((current) =>
              current && current.id === event.taskId
                ? { ...current, state: "awaiting_worktree_approval", workspaceMode: "worktree", worktreePath: event.path, agentBranch: event.branch }
                : current,
            );
          }
          void loadChats();
        }
        if (event.type === "worktree.created") {
          if (isVisibleTaskEvent) {
            setTask((current) =>
              current && current.id === event.taskId
                ? { ...current, state: "running", workspaceMode: "worktree", worktreePath: event.path, agentBranch: event.branch }
                : current,
            );
          }
          void loadChats();
        }
        if (event.type === "review.ready") {
          if (isVisibleTaskEvent) {
            setTask((current) =>
              current && current.id === event.taskId
                ? {
                    ...current,
                    state: "review_ready",
                    changedFiles: event.changedFiles,
                    reviewFiles: event.reviewFiles,
                    latestTest: event.latestTest,
                }
                : current,
            );
            setExpandedReviewPaths(new Set());
            window.setTimeout(() => {
              if (visibleTaskIdRef.current === event.taskId) {
                void refreshTaskReviewById(event.taskId);
              }
            }, 120);
          }
          void loadChats();
        }
        if (event.type === "approval.check" && isVisibleTaskEvent) {
          setApprovalChecks((current) => {
            const next = current.filter((check) => check.name !== event.name);
            next.push({ name: event.name, status: event.status, detail: event.detail });
            return next;
          });
        }
        if (event.type === "approval.completed") {
          if (isVisibleTaskEvent) {
            setTask((current) =>
              current && current.id === event.taskId ? { ...current, state: "approved", patchHash: event.patchHash } : current,
            );
          }
          void loadChats();
        }
        if (event.type === "merge.completed") {
          if (isVisibleTaskEvent) {
            setTask((current) =>
              current && current.id === event.taskId ? { ...current, state: "merged", patchHash: event.patchHash } : current,
            );
          }
          void loadChats();
        }
        if (event.type === "task.error") {
          if (isVisibleTaskEvent) {
            setError(event.message);
            setTask((current) =>
              current && current.id === event.taskId ? { ...current, state: "failed", error: event.message } : current,
            );
          }
          void loadChats();
        }
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
    const isOpen = settingsOpen || !!previewAttachment?.previewDataUrl || !!deleteCandidate || showElevatedPermissionsDialog || approvalPending;
    if (!isOpen) {
      modalTriggerRef.current?.focus();
      modalTriggerRef.current = null;
      return;
    }
    if (!modalTriggerRef.current && document.activeElement instanceof HTMLElement) modalTriggerRef.current = document.activeElement;
    const focusModal = () => {
      const modal = modalRef.current;
      if (!modal) return;
      const target = modal.querySelector<HTMLElement>("[autofocus], button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])");
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
  }, [settingsOpen, previewAttachment, deleteCandidate, showElevatedPermissionsDialog, approvalPending]);

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
  }, [activeChat?.taskId, composerItems, task, reviewFiles.length, expandedReviewPaths, reviewOpen]);

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
    if (!activeChatId || suppressDraftSaveRef.current) return undefined;
    if (draftSaveRef.current) window.clearTimeout(draftSaveRef.current);
    const chatId = activeChatId;
    const draftPrompt = prompt;
    const files = attachedFiles;
    draftSaveRef.current = window.setTimeout(() => {
      void persistDraft(chatId, draftPrompt, files, { updateLocal: false });
    }, 250);
    return () => {
      if (draftSaveRef.current) window.clearTimeout(draftSaveRef.current);
    };
  }, [activeChatId, prompt, attachedFiles]);

  useEffect(() => {
    if (!attachmentMenuOpen || !repository) {
      setFileMatches([]);
      setSelectedFileIndex(0);
      return undefined;
    }
    let canceled = false;
    const timer = window.setTimeout(async () => {
      try {
        const matches = await api.searchFiles({ repositoryId: repository.id, query: attachmentSearchQuery, limit: 10 });
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
  }, [attachmentMenuOpen, attachmentSearchQuery, repository?.id]);

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

  function resetUnsavedChat() {
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

  async function loadEndpointSettings() {
    try {
      const settings = normalizeEndpointSettings(await api.getModelEndpointSettings());
      setEndpointSettings(settings);
      setEndpointDraftSettings(settings);
      endpointModeDraftsRef.current = { [settings.mode]: settings };
      setAccountMessage(null);
    } catch (cause) {
      setAccountMessage(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setEndpointSettingsLoaded(true);
    }
  }

  function updateEndpointDraft(patch: Partial<ModelEndpointSettings>) {
    endpointSaveSequenceRef.current += 1;
    setEndpointSaving(false);
    setEndpointRefreshing(false);
    setEndpointDraftSettings((current) => {
      if ("mode" in patch) {
        const mode = patch.mode === "server" ? "server" : "local";
        endpointModeDraftsRef.current[current.mode] = current;
        const next = endpointModeDraftsRef.current[mode] ?? endpointDefaultsForMode(mode);
        endpointModeDraftsRef.current[mode] = next;
        return next;
      }
      let next = normalizeEndpointSettings({ ...current, ...patch });
      if ("software" in patch && current.mode === "local") {
        const wasDefault = current.baseUrl === defaultEndpointBaseUrlForMode("local", current.software);
        if (wasDefault) next = { ...next, baseUrl: defaultEndpointBaseUrlForMode("local", next.software) };
      }
      endpointModeDraftsRef.current[next.mode] = next;
      return next;
    });
    setAccountMessage(null);
  }

  function updateEndpointHeader(index: number, patch: Partial<{ name: string; value: string; valueConfigured: boolean }>) {
    endpointSaveSequenceRef.current += 1;
    setEndpointSaving(false);
    setEndpointRefreshing(false);
    setEndpointDraftSettings((current) => {
      const headers = normalizeEndpointHeaders(current.headers);
      headers[index] = { ...headers[index], ...patch };
      const next = normalizeEndpointSettings({ ...current, headers });
      endpointModeDraftsRef.current[next.mode] = next;
      return next;
    });
    setAccountMessage(null);
  }

  function closeSettingsDialog() {
    setEndpointDraftSettings(endpointSettings);
    endpointModeDraftsRef.current = { [endpointSettings.mode]: endpointSettings };
    setHarnessDraftProfile(harnessProfile);
    setHarnessDraftContextLength(contextLength);
    setHarnessMessage(null);
    setAccountMessage(null);
    setSettingsOpen(false);
  }

  async function refreshConnectionStatus() {
    if (endpointSaving || endpointRefreshing || endpointDirty) return;
    const requestId = endpointSaveSequenceRef.current + 1;
    endpointSaveSequenceRef.current = requestId;
    const startedAt = Date.now();
    setEndpointRefreshing(true);
    setAccountMessage(null);
    try {
      await refreshStatus();
      const remainingAnimationMs = Math.max(0, 300 - (Date.now() - startedAt));
      if (remainingAnimationMs > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, remainingAnimationMs));
      }
      if (requestId !== endpointSaveSequenceRef.current) return;
    } finally {
      if (requestId === endpointSaveSequenceRef.current) setEndpointRefreshing(false);
    }
  }

  async function saveEndpointSettings() {
    if (endpointSaving || endpointRefreshing || !endpointDirty || !endpointEditingEnabled) return;
    const validationMessage = endpointValidationMessage(endpointDraftSettings);
    if (validationMessage) {
      setAccountMessage(validationMessage);
      return;
    }
    const requestId = endpointSaveSequenceRef.current + 1;
    endpointSaveSequenceRef.current = requestId;
    const nextDraft = normalizeEndpointSettings({
      ...endpointDraftSettings,
      headers: endpointDraftSettings.mode === "local" ? defaultModelEndpointSettings.headers : endpointDraftSettings.headers,
    });
    setEndpointSaving(true);
    setAccountMessage(null);
    try {
      const result = await api.saveModelEndpointSettings(nextDraft);
      if (requestId !== endpointSaveSequenceRef.current) return;
      const normalized = normalizeEndpointSettings(result.settings);
      setEndpointSettings(normalized);
      setEndpointDraftSettings(normalized);
      setBackend(result.status);
      setPermissionModeState(result.status.permissionMode);
      endpointModeDraftsRef.current[normalized.mode] = normalized;
    } catch (cause) {
      if (requestId !== endpointSaveSequenceRef.current) return;
      setAccountMessage(String(cause instanceof Error ? cause.message : cause));
    } finally {
      if (requestId === endpointSaveSequenceRef.current) setEndpointSaving(false);
    }
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
    setHarnessMessage(null);
    setHarnessSaving(true);
    try {
      let nextProfile = harnessProfile;
      let nextContextLength = contextLength;
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
      await loadHarnessProfile();
      setHarnessMessage(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setHarnessSaving(false);
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
      const status = await api.setPermissionMode(mode);
      setBackend(status);
      setPermissionModeState(status.permissionMode);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function confirmElevatedPermissionsMode() {
    setShowElevatedPermissionsDialog(false);
    setError(null);
    setPermissionModeState("auto_safe");
    try {
      const status = await api.setPermissionMode("auto_safe");
      setBackend(status);
      setPermissionModeState(status.permissionMode);
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

  async function startTask() {
    if (closedChatNotice) {
      setError(closedChatNotice);
      return;
    }
    const trimmedPrompt = appendReviewFeedback(prompt, reviewPromptFeedback).trim();
    if (!trimmedPrompt) return;
    if (startTaskInFlightRef.current) return;
    startTaskInFlightRef.current = true;
    let status: BackendStatus | null = null;
    try {
      status = selectedModel && backend?.endpoint === "ready" ? backend : await refreshStatus();
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
      startTaskInFlightRef.current = false;
      return;
    }
    if (!status?.model || status.endpoint !== "ready") {
      try {
        await showConnectionErrorInChat(trimmedPrompt, status);
      } catch (cause) {
        setError(String(cause instanceof Error ? cause.message : cause));
      } finally {
        startTaskInFlightRef.current = false;
      }
      return;
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
      }
      const nextTask = await api.startTask({
        repositoryId: repository?.id,
        prompt: trimmedPrompt,
        chatId,
        attachedFiles: attachedFiles.map(normalizeAttachment),
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
      suppressDraftSaveBriefly();
      setPrompt("");
      setReviewPromptFeedback([]);
      setAttachedFiles([]);
      setMention(null);
      setFileMatches([]);
      await persistDraft(nextTask.chatId ?? chatId, "", []);
      if (!isContinuingChat) {
        setExpandedReviewPaths(new Set());
      }
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      startTaskInFlightRef.current = false;
      setBusy(false);
    }
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

  async function rateResponse(messageId: string, rating: "good" | "bad", comment?: string) {
    if (!latestTaskId) return;
    setError(null);
    const taskId = latestTaskId;
    const previousFeedback = [...visibleEvents].reverse().find(
      (event): event is Extract<BackendUiEvent, { type: "response.feedback" }> =>
        event.type === "response.feedback" && event.taskId === taskId && event.messageId === messageId,
    );
    const nextComment = (comment ?? previousFeedback?.comment ?? "").trim().slice(0, 1000);
    const feedbackEvent: BackendUiEvent = {
      type: "response.feedback",
      taskId,
      messageId,
      rating,
      ...(nextComment ? { comment: nextComment } : {}),
      at: new Date().toISOString(),
    };
    setEvents((current) => appendBackendEvent(current, feedbackEvent, 500));
    try {
      await api.setResponseFeedback({ taskId, messageId, rating, ...(nextComment ? { comment: nextComment } : {}) });
    } catch (cause) {
      setEvents((current) => {
        const withoutFailedRating = current.filter(
          (event) => !(event.type === "response.feedback" && event.taskId === taskId && event.messageId === messageId),
        );
        return previousFeedback
          ? appendBackendEvent(withoutFailedRating, { ...previousFeedback, at: new Date().toISOString() }, 500)
          : withoutFailedRating;
      });
      setError(String(cause instanceof Error ? cause.message : cause));
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
    const result = await api.openRepositoryInIde({ repositoryId: repository.id, repositoryPath: repository.rootPath, ideId });
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

  function insertSkillMention(skill: SkillInfo) {
    const node = textareaRef.current;
    const activeMention = mention?.kind === "skill" ? mention : null;
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
    if (!files.length) return;
    event.preventDefault();
    void attachPastedFiles(files);
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
        setFileMatches([]);
        setSelectedFileIndex(0);
        setSelectedSkillIndex(0);
        return;
      }
      if (attachmentMenuOpen && (event.key === "ArrowDown" || event.key === "ArrowUp") && fileMatches.length) {
        event.preventDefault();
        setSelectedFileIndex((current) => {
          const direction = event.key === "ArrowDown" ? 1 : -1;
          return (current + direction + fileMatches.length) % fileMatches.length;
        });
        return;
      }
      if (skillMenuOpen && (event.key === "ArrowDown" || event.key === "ArrowUp") && skillMatches.length) {
        event.preventDefault();
        setSelectedSkillIndex((current) => {
          const direction = event.key === "ArrowDown" ? 1 : -1;
          return (current + direction + skillMatches.length) % skillMatches.length;
        });
        return;
      }
      if (attachmentMenuOpen && ((!event.shiftKey && event.key === "Enter") || event.key === "Tab") && fileMatches.length) {
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
    void startTask();
  }

  async function newChat() {
    setError(null);
    try {
      if (activeChatId) await persistDraft(activeChatId, prompt, attachedFiles);
      setRepository(null);
      resetUnsavedChat();
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
        resetUnsavedChat();
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
      resetUnsavedChat();
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
      resetUnsavedChat();
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
    const worktreeChatCount = group.worktrees.reduce((count, worktree) => count + worktree.chats.length, 0);
    return {
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
        const result = await api.deleteProjectChats({ repositoryPath: target.project.path });
        const localDeletedChatIds = chats.filter((chat) => chat.repositoryPath === target.project.path).map((chat) => chat.id);
        removeDeletedChats(Array.from(new Set([...result.deletedChatIds, ...localDeletedChatIds])));
      } else {
        const result = await api.deleteProject({ repositoryPath: target.project.path });
        const localDeletedChatIds = chats.filter((chat) => chat.repositoryPath === target.project.path).map((chat) => chat.id);
        removeDeletedChats(Array.from(new Set([...result.deletedChatIds, ...localDeletedChatIds])));
        setProjects((current) => current.filter((project) => project.rootPath !== target.project.path));
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
    return (
      <div
        className={`chatRow ${activeChatId === chat.id ? "active" : ""} ${
          closedChatMessage(chat.taskState) ? "closed" : ""
        }`}
        key={chat.id}
      >
        <button className="chatRowMain" type="button" onClick={() => selectChat(chat)}>
          <span>
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
              setAccountMessage(null);
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
                    ) : item.type === "assistant" ? (
                      (() => {
                        const rating = responseFeedback.get(item.id);
                        const feedbackNote = feedbackDrafts.get(item.id) ?? responseFeedbackComments.get(item.id) ?? "";
                        return (
                          <article className="timelineMessage assistantMessage" key={item.id}>
                            {item.streaming ? (
                              <StreamingTextContent content={item.text} />
                            ) : (
                              <LongMarkdownContent
                                content={item.text}
                                onReviewFileClick={openReviewReference}
                                reviewFiles={reviewFiles}
                              />
                            )}
                            <div className="messageActions">
                              <button
                                className="messageAction"
                                type="button"
                                onClick={() => void copyText(assistantCopyText || item.text)}
                                title="Copy response"
                              >
                                <Copy size={14} />
                              </button>
                              <button
                                className={`messageAction feedbackGood ${rating === "good" ? "active" : ""}`}
                                type="button"
                                onClick={() => void rateResponse(item.id, "good")}
                                aria-pressed={rating === "good"}
                                title="Good response"
                              >
                                <ThumbsUp size={14} />
                              </button>
                              <button
                                className={`messageAction feedbackBad ${rating === "bad" ? "active" : ""}`}
                                type="button"
                                onClick={() => void rateResponse(item.id, "bad")}
                                aria-pressed={rating === "bad"}
                                title="Bad response"
                              >
                                <ThumbsDown size={14} />
                              </button>
                            </div>
                            {rating ? (
                              <form
                                className="responseFeedbackNote"
                                onSubmit={(event) => {
                                  event.preventDefault();
                                  void rateResponse(item.id, rating, feedbackNote);
                                }}
                              >
                                <input
                                  type="text"
                                  value={feedbackNote}
                                  maxLength={1000}
                                  placeholder="Add a note (optional)"
                                  aria-label="Response feedback note"
                                  onChange={(event) => {
                                    const value = event.target.value;
                                    setFeedbackDrafts((current) => new Map(current).set(item.id, value));
                                  }}
                                />
                                <button type="submit" disabled={!feedbackNote.trim()}>
                                  Send
                                </button>
                              </form>
                            ) : null}
                          </article>
                        );
                      })()
                    ) : (
                      (() => {
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
                              {expanded ? (
                                <ChevronDown className="activityChevron" size={13} />
                              ) : (
                                <ChevronRight className="activityChevron" size={13} />
                              )}
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
                                {item.segments
                                  .filter((segment): segment is Extract<ComposerActivitySegment, { type: "reasoning" }> => segment.type === "reasoning")
                                  .map((segment) => (
                                    <section className="activityLogEntry reasoningLog" key={segment.id}>
                                      <div className="activityLogHeader">
                                        <span>Thinking</span>
                                      </div>
                                      <pre>{segment.text.trim()}</pre>
                                    </section>
                                  ))}
                                {activityToolGroups(item.segments).map((group) => {
                                  const toolDisclosureId = `${item.id}:${group.id}`;
                                  const toolExpanded = expandedActivityToolIds.has(toolDisclosureId);
                                  return (
                                    <section
                                      className={`activityLogEntry commandLog ${group.status} ${
                                        toolExpanded ? "isExpanded" : ""
                                      }`}
                                      key={group.id}
                                    >
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
                                        <span title={group.runs.map((run) => run.command).join("\n")}>{group.label}</span>
                                        {toolExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                      </button>
                                      {toolExpanded ? (
                                        <div className="activityToolGroupDetails">
                                          {group.runs.map((run) => (
                                            <div key={run.id}>
                                              <pre>{commandShellText(run)}</pre>
                                            </div>
                                          ))}
                                        </div>
                                      ) : null}
                                    </section>
                                  );
                                })}
                              </div>
                            </div>
                          </article>
                        );
                      })()
                    ),
                  )}
                  {reviewFiles.length &&
                  (task?.state === "review_ready" ||
                    task?.state === "approving" ||
                    task?.state === "approved" ||
                    task?.state === "merged" ||
                    task?.state === "rejected") ? (
                    <ReviewSummaryCard
                      diffs={reviewDiffs}
                      files={reviewFiles}
                      onOpenReview={(filePath) => openReviewPanel(filePath)}
                      totals={reviewTotals}
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
              {showContextMeter ? <ContextMeter estimate={contextEstimate} /> : null}
            </div>
          </div>
          {closedChatNotice ? (
            <div className="closedChatNotice">
              <CheckCircle2 size={15} />
              <span>{closedChatNotice}</span>
            </div>
          ) : null}
          <div className="composer" onDrop={handleComposerDrop} onDragOver={handleComposerDragOver}>
            {promptReferenceMenuOpen && !closedChatNotice ? (
              <div className="attachmentMenu" ref={attachmentMenuRef}>
                <div className="attachmentMenuHeader">
                  {skillMenuOpen ? <Sparkles size={14} /> : <AtSign size={14} />}
                  <span>
                    {skillMenuOpen
                      ? "Use a skill for this turn"
                      : repository
                        ? `Attach from ${repository.name}`
                        : "Search files after selecting a folder"}
                  </span>
                </div>
                {skillMenuOpen ? (
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
                          <strong>{skill.name}</strong>
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
                        <File size={14} />
                        <span>
                          <strong>{file.name}</strong>
                          <em>{file.path}</em>
                        </span>
                        <small>{file.match}</small>
                      </button>
                    ))
                  ) : (
                    <div className="attachmentMenuEmpty">No matches yet</div>
                  )
                ) : null}
              </div>
            ) : null}
            <div className="promptInputShell">
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
            {isGenerating ? (
              <button
                className="sendButton stopButton"
                type="button"
                onClick={() => void stopTask()}
                disabled={stopPending}
                aria-label={stopPending ? "Stopping generation" : "Stop generation"}
                title={stopPending ? "Stopping generation" : "Stop generation"}
              >
                {stopPending ? <Loader2 className="spin" size={18} /> : <Square aria-hidden="true" fill="currentColor" size={14} />}
              </button>
            ) : (
              <button className="sendButton" type="button" onClick={startTask} disabled={!canStart} aria-label="Send prompt" title="Send prompt">
                {busy ? <Loader2 className="spin" size={18} /> : <Send aria-hidden="true" size={18} />}
              </button>
            )}
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
        />
      </aside>

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
                {settingsTab === "account" ? (
                  <div className="settingsPanel">
                    <div className="settingsPanelHead connectionPanelHead">
                      <div>
                        <h3>Connection</h3>
                        <p>Run through local Ollama, or connect to a Veil server managing Ollama or vLLM.</p>
                      </div>
                      {endpointSettingsLoaded ? (
                        <div className="connectionCompactStatus">
                          <span
                            className={`serverHealthText ${connectionDisplayState}`}
                            role="status"
                            aria-label={connectionStatusLabel}
                            title={connectionStatusLabel}
                          >
                            <span className="serverStatusDot" aria-hidden="true" />
                          </span>
                          <button
                            className="settingsIconButton connectionRefreshButton"
                            type="button"
                            onClick={() => void refreshConnectionStatus()}
                            disabled={endpointRefreshing || endpointSaving || endpointDirty}
                            title={endpointDirty ? "Save changes before checking" : "Check connection"}
                            aria-label="Check connection"
                          >
                            <RefreshCw className={endpointRefreshing ? "spin" : ""} size={14} />
                          </button>
                        </div>
                      ) : null}
                    </div>

                    {!endpointSettingsLoaded ? (
                      <div className="connectionLoading" aria-label="Loading connection settings">
                        <Loader2 className="spin" size={16} />
                        <span>Loading connection settings</span>
                      </div>
                    ) : (
                      <>
                        <div className="settingsGroup">
                          <h4>Run mode</h4>
                          <div className="connectionModeGrid" aria-label="Model connection type">
                            <button
                              className={endpointDraftSettings.mode === "local" ? "isActive" : ""}
                              type="button"
                              disabled={endpointFormDisabled}
                              aria-pressed={endpointDraftSettings.mode === "local"}
                              onClick={() => updateEndpointDraft({ mode: "local" })}
                            >
                              <span className="connectionModeIcon"><Monitor size={16} /></span>
                              <strong>Local</strong>
                              {endpointDraftSettings.mode === "local" ? <Check size={14} /> : null}
                            </button>
                            <button
                              className={endpointDraftSettings.mode === "server" ? "isActive" : ""}
                              type="button"
                              disabled={endpointFormDisabled}
                              aria-pressed={endpointDraftSettings.mode === "server"}
                              onClick={() => updateEndpointDraft({ mode: "server" })}
                            >
                              <span className="connectionModeIcon"><Cloud size={16} /></span>
                              <strong>Server</strong>
                              {endpointDraftSettings.mode === "server" ? <Check size={14} /> : null}
                            </button>
                          </div>
                        </div>

                        <div className="settingsGroup">
                          <h4>{endpointDraftSettings.mode === "local" ? "Local model" : "Server connection"}</h4>
                          {endpointDraftSettings.mode === "local" ? (
                            <>
                              <label className="settingsField">
                                <span>Ollama URL</span>
                                <input
                                  value={endpointDraftSettings.baseUrl}
                                  disabled={endpointFormDisabled}
                                  onChange={(event) => updateEndpointDraft({ baseUrl: event.currentTarget.value })}
                                  placeholder="http://127.0.0.1:11434"
                                  spellCheck={false}
                                />
                              </label>
                              <label className="settingsField">
                                <span>Model</span>
                                <input
                                  value={endpointDraftSettings.modelId}
                                  disabled={endpointFormDisabled}
                                  onChange={(event) => updateEndpointDraft({ modelId: event.currentTarget.value })}
                                  placeholder="llama3.2"
                                  spellCheck={false}
                                />
                              </label>
                            </>
                          ) : (
                            <>
                              <label className="settingsField">
                                <span>Veil server URL</span>
                                <input
                                  value={endpointDraftSettings.baseUrl}
                                  disabled={endpointFormDisabled}
                                  onChange={(event) => updateEndpointDraft({ baseUrl: event.currentTarget.value })}
                                  placeholder="https://veil.example.com"
                                  spellCheck={false}
                                />
                              </label>
                              <label className="settingsField">
                                <span>Bearer token</span>
                                <input
                                  value={endpointDraftSettings.secret}
                                  disabled={endpointFormDisabled}
                                  onChange={(event) => updateEndpointDraft({ secret: event.currentTarget.value })}
                                  placeholder={endpointDraftSettings.secretConfigured ? savedEndpointSecretPlaceholder : "Bearer token from your Veil server"}
                                  type="password"
                                  spellCheck={false}
                                />
                              </label>
                              <div className="endpointHeaders">
                                {normalizeEndpointHeaders(endpointDraftSettings.headers).map((header, index) => (
                                  <div className="endpointHeaderRow" key={index}>
                                    <label className="settingsField">
                                      <span>{`Custom header ${index + 1}`}</span>
                                      <input
                                        value={header.name}
                                        disabled={endpointFormDisabled}
                                        onChange={(event) => updateEndpointHeader(index, { name: event.currentTarget.value })}
                                        placeholder="Header name"
                                        spellCheck={false}
                                      />
                                    </label>
                                    <label className="settingsField">
                                      <span>Value</span>
                                      <input
                                        value={header.value}
                                        disabled={endpointFormDisabled}
                                        onChange={(event) => updateEndpointHeader(index, { value: event.currentTarget.value })}
                                        placeholder={header.valueConfigured ? savedEndpointSecretPlaceholder : "Header value"}
                                        type="password"
                                        spellCheck={false}
                                      />
                                    </label>
                                  </div>
                                ))}
                              </div>
                            </>
                          )}
                          <div className="connectionActions">
                            <button
                              className="settingsInlineButton connectionSaveButton"
                              type="button"
                              onClick={() => void saveEndpointSettings()}
                              disabled={endpointSaving || endpointRefreshing || !endpointDirty || !!endpointValidation || !endpointEditingEnabled}
                            >
                              {endpointSaving ? <Loader2 className="spin" size={13} /> : <Check size={13} />}
                              <span>{endpointSaving ? "Connecting" : "Save & connect"}</span>
                            </button>
                            {endpointDirty ? <span className="connectionUnsaved">Unsaved changes</span> : null}
                          </div>
                          <div className="connectionFeedback" aria-live="polite">
                            {!endpointEditingEnabled ? <p className="settingsMessage">This connection is managed by your organization.</p> : null}
                            {endpointDirty && endpointValidation ? <p className="settingsMessage settingsMessageError">{endpointValidation}</p> : null}
                            {accountMessage ? <p className="settingsMessage">{accountMessage}</p> : null}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                ) : null}

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
                        className="settingsInlineButton"
                        type="button"
                        onClick={() => void saveHarnessProfile()}
                        disabled={harnessSaving || !harnessDirty}
                      >
                        {harnessSaving ? <Loader2 className="spin" size={13} /> : <Check size={13} />}
                        <span>{harnessSaving ? "Saving" : "Save harness"}</span>
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
                            SQLite logs, successful tool output, and assistant reasoning stay on this computer.
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
          <button type="button" onClick={() => setError(null)}>
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
  rootElement.umbraticRoot ??= createRoot(rootElement);
  rootElement.umbraticRoot.render(<App />);
}
