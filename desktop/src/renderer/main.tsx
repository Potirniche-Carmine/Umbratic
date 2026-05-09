import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  AtSign,
  BarChart3,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  CircleDashed,
  Copy,
  ExternalLink,
  File,
  FileText,
  FolderOpen,
  GitBranch,
  Hand,
  Loader2,
  Minus,
  PanelLeft,
  PanelRight,
  Paperclip,
  Play,
  Plus,
  RefreshCw,
  Send,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  SquarePen,
  TerminalSquare,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  TriangleAlert,
  Undo2,
  User,
  X,
} from "lucide-react";

type ServiceStatus = "ready" | "degraded" | "unavailable";
type PermissionMode = "normal" | "bypass";
type ReasoningMode = "fast" | "reasoning";
type WorkspaceKind = "git" | "folder";
type LocalProviderId = "local-endpoint";
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
type RuntimeProfileId = "none" | "python" | "markdown" | "cmake" | "powershell" | "posix-shell" | "node";
type TaskState =
  | "awaiting_worktree_approval"
  | "running"
  | "completed"
  | "review_ready"
  | "approving"
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
  privacy: {
    share: "disabled";
    enabledProviders: LocalProviderId[];
    disabledProviders: string[];
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
  telemetry: {
    mode: "developer_toggle" | "managed_required" | "managed_disabled";
    localEnabled: boolean;
    syncEnabled: false;
    retentionDays: number;
    exportFormat: "redacted-json";
    storage: "task-event-snapshots";
  };
  runtimes: {
    python: {
      profileVersion: string;
      barePythonVerification: "denied";
      generatedPaths: string[];
    };
    markdown: {
      docsOnlyClassification: "enabled";
    };
    cmake: {
      profileVersion: string;
      buildDir: ".aegis/build";
    };
    shell: {
      platform: string;
      preferred: "pwsh" | "powershell" | "posix";
      nonInteractive: boolean;
    };
  };
};

type LocalModelInfo = {
  providerId: LocalProviderId;
  providerName: string;
  modelId: string;
  displayName: string;
  baseUrl: string;
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

type ReviewFile = {
  path: string;
  status: "added" | "modified" | "deleted";
  diff: string;
};

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
};

type FileSearchResult = ChatAttachment & {
  match: "path" | "content";
};

type TaskInfo = {
  id: string;
  chatId?: string;
  repositoryId: string;
  prompt: string;
  workspaceKind: WorkspaceKind;
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
  runtimeProfile?: RuntimeProfileId;
  createdAt: string;
  changedFiles: string[];
  reviewFiles: ReviewFile[];
  events: BackendUiEvent[];
  latestTest?: TestResult;
  reviewPatchHash?: string;
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
  draftPrompt?: string;
  attachedFiles?: ChatAttachment[];
};

type PermissionRequest = {
  id: string;
  kind: "edit" | "bash";
  summary: string;
  command: string;
  commandClass?: CommandClass;
  cwd: string;
};

type BackendEventMeta = { at?: string; endedAt?: string };
type BackendUiEvent = BackendEventMeta &
(
  | { type: "user.message"; taskId: string; text: string }
  | { type: "assistant.delta"; taskId: string; text: string }
  | { type: "assistant.reasoning.delta"; taskId: string; text: string }
  | { type: "assistant.done"; taskId: string }
  | { type: "worktree.requested"; taskId: string; branch: string; path: string; baseCommit: string }
  | { type: "worktree.created"; taskId: string; branch: string; path: string }
  | { type: "command.started"; taskId: string; id: string; command: string; cwd: string; kind?: PermissionRequest["kind"]; commandClass?: CommandClass }
  | { type: "command.output"; taskId: string; id: string; stream: "stdout" | "stderr"; text: string }
  | { type: "command.finished"; taskId: string; id: string; exitCode: number | null }
  | { type: "permission.requested"; taskId: string; request: PermissionRequest }
  | { type: "permission.resolved"; taskId: string; id: string; decision: "allow" | "deny" }
  | { type: "review.ready"; taskId: string; changedFiles: string[]; reviewFiles: ReviewFile[]; latestTest?: TestResult }
  | { type: "review.changed_since_ready"; taskId: string; previousPatchHash: string; currentPatchHash: string; changedFileCount: number }
  | { type: "approval.check"; taskId: string; name: string; status: "running" | "passed" | "failed"; detail?: string }
  | { type: "merge.approval"; taskId: string; decision: "approved" | "rejected"; cleanup?: boolean; reason?: string }
  | { type: "merge.completed"; taskId: string; targetBranch: string; commit: string; patchHash: string }
  | { type: "ide.opened"; taskId: string; ideId: string; target: "workspace" | "file"; filePath?: string; result: "success" | "failed"; message?: string }
  | { type: "response.feedback"; taskId: string; messageId: string; rating: "good" | "bad" }
  | { type: "task.error"; taskId: string; message: string }
);

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
};

type ComposerTimelineItem =
  | { type: "user"; id: string; text: string }
  | { type: "reasoning"; id: string; text: string; durationMs: number | null; finished: boolean }
  | { type: "assistant"; id: string; text: string }
  | { type: "command"; id: string; run: CommandRun };

type SkillInfo = { id: string; name: string; description: string };

type DesktopApi = {
  listChats(): Promise<ChatRecord[]>;
  createChat(input?: { title?: string; repositoryName?: string; repositoryPath?: string }): Promise<ChatRecord>;
  updateChatDraft(input: { chatId: string; draftPrompt: string; attachedFiles: ChatAttachment[] }): Promise<ChatRecord>;
  deleteChat(input: { chatId: string }): Promise<{ ok: true }>;
  getTask(input: { taskId: string }): Promise<TaskInfo | null>;
  refreshTaskReview(input: { taskId: string }): Promise<TaskInfo | null>;
  searchFiles(input: { repositoryId: string; query: string; limit?: number }): Promise<FileSearchResult[]>;
  pickRepository(): Promise<{ canceled: true } | { canceled: false; repository: RepositoryInfo }>;
  pickAttachmentFiles(input: { chatId: string; repositoryId?: string }): Promise<{ canceled: true } | { canceled: false; files: ChatAttachment[] }>;
  getRepository(input: { repositoryId?: string; repositoryPath?: string }): Promise<RepositoryInfo | null>;
  listRepositoryBranches(input: { repositoryId?: string; repositoryPath?: string }): Promise<
    { ok: true; current: string; branches: string[] } | { ok: false; message: string }
  >;
  checkoutRepositoryBranch(input: { repositoryId?: string; repositoryPath?: string; branch: string }): Promise<
    { ok: true; repository: RepositoryInfo } | { ok: false; message: string }
  >;
  getBackendStatus(): Promise<BackendStatus>;
  exportTelemetry(): Promise<{ ok: true; path: string } | { ok: false; message: string }>;
  listSkills(): Promise<{ skills: SkillInfo[]; directory: string }>;
  openSkillsFolder(): Promise<{ ok: true; directory: string } | { ok: false; message: string }>;
  createSkill(input: { name: string }): Promise<
    | { ok: true; skill: SkillInfo; directory: string }
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
  }): Promise<TaskInfo>;
  approveWorktreeCreation(input: { taskId: string; approved: boolean }): Promise<void>;
  respondToToolPermission(input: { taskId: string; id: string; decision: "allow" | "deny" }): Promise<void>;
  openTaskInIde(input: { taskId: string; ideId: string; filePath?: string }): Promise<{ ok: true } | { ok: false; message: string }>;
  approveTaskMerge(input: { taskId: string }): Promise<
    | { ok: true; targetBranch: string; commit: string; patchHash: string; metadataPath: string }
    | { ok: false; message: string }
  >;
  rejectTask(input: { taskId: string; cleanup: boolean }): Promise<void>;
  keepWorktree(input: { taskId: string }): Promise<void>;
  cancelTask(input: { taskId: string }): Promise<void>;
  setResponseFeedback(input: { taskId: string; messageId: string; rating: "good" | "bad" }): Promise<void>;
  onBackendEvent(callback: (event: unknown) => void): () => void;
};

const previewChatsKey = "aegis-preview-chats";
let previewPermissionMode: PermissionMode = "normal";
const isMacLike = /Mac|iPhone|iPad/i.test(navigator.platform);

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

function normalizeAttachment(file: ChatAttachment): ChatAttachment {
  const normalized: ChatAttachment = { path: file.path, name: file.name || file.path.split(/[\\/]/).pop() || file.path };
  if (file.source === "chat" || file.source === "workspace") normalized.source = file.source;
  if (file.storedPath) normalized.storedPath = file.storedPath;
  if (file.originalPath) normalized.originalPath = file.originalPath;
  return normalized;
}

const initialPrompt = "";
const emptyReviewFiles: ReviewFile[] = [];
const defaultIdeChoices: IdeChoice[] = [
  { id: "code", label: "VS Code", icon: "vscode" },
  { id: "visualstudio", label: "Visual Studio", icon: "visualstudio" },
  { id: "explorer", label: isMacLike ? "Finder" : "Explorer", icon: isMacLike ? "finder" : "explorer" },
];

const fallbackApi: DesktopApi = {
  listChats: async () => readPreviewChats(),
  createChat: async (input) => {
    const now = new Date().toISOString();
    const chat: ChatRecord = {
      id: `preview-${Date.now().toString(36)}`,
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
  deleteChat: async (input) => {
    writePreviewChats(readPreviewChats().filter((chat) => chat.id !== input.chatId));
    return { ok: true };
  },
  getTask: async () => null,
  refreshTaskReview: async () => null,
  searchFiles: async (input) =>
    [
      { path: "desktop/src/renderer/main.tsx", name: "main.tsx", match: "path" as const },
      { path: "desktop/src/renderer/styles.css", name: "styles.css", match: "path" as const },
      { path: "desktop/src/main/main.ts", name: "main.ts", match: "content" as const },
    ].filter((file) => file.path.toLowerCase().includes(input.query.toLowerCase())),
  pickRepository: async () => ({
    canceled: false,
    repository: {
      id: "preview-aegis",
      name: "Aegis",
      rootPath: "C:\\Users\\potir\\Documents\\Aegis",
      kind: "folder",
      originalBranch: "folder",
      baseCommit: "preview",
      dirty: false,
      statusSummary: "preview",
    },
  }),
  pickAttachmentFiles: async () => ({
    canceled: false,
    files: [{ path: "desktop/src/renderer/main.tsx", name: "main.tsx", source: "workspace" }],
  }),
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
    privacy: {
      share: "disabled",
      enabledProviders: [],
      disabledProviders: [],
      webTools: "disabled",
    },
    diagnostics: {
      runnerName: "AegisRunner",
      runnerVersion: "package-adapter-1",
      runnerContractVersion: "aegis-runner-1",
      policyVersion: "aegis-local-mvp-1",
      runnerBinary: "missing",
      configAssertions: "enabled",
      providerAllowlist: ["local-endpoint"],
      localhostOnlyModels: true,
      commandClassifier: "enabled",
      telemetry: {
        mode: "developer_toggle",
        localEnabled: true,
        syncEnabled: false,
        retentionDays: 30,
        exportFormat: "redacted-json",
        storage: "task-event-snapshots",
      },
      runtimes: {
        python: {
          profileVersion: "python-uv-venv-1",
          barePythonVerification: "denied",
          generatedPaths: [".venv", "__pycache__", ".pyc", ".aegis/runtime"],
        },
        markdown: { docsOnlyClassification: "enabled" },
        cmake: { profileVersion: "cmake-aegis-build-1", buildDir: ".aegis/build" },
        shell: { platform: navigator.platform, preferred: "posix", nonInteractive: true },
      },
    },
    message: "Electron preload is not available in this browser preview.",
  }),
  exportTelemetry: async () => ({ ok: false, message: "Electron preload is not available." }),
  listSkills: async () => ({ skills: [], directory: "~/.aegis/skills" }),
  openSkillsFolder: async () => ({ ok: false, message: "Electron preload is not available." }),
  createSkill: async () => ({ ok: false, message: "Electron preload is not available." }),
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
  openTaskInIde: async () => ({ ok: false, message: "Electron preload is not available." }),
  approveTaskMerge: async () => ({ ok: false, message: "Electron preload is not available." }),
  rejectTask: async () => undefined,
  keepWorktree: async () => undefined,
  cancelTask: async () => undefined,
  setResponseFeedback: async () => undefined,
  onBackendEvent: () => () => undefined,
};

const api = window.aegis ?? fallbackApi;

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

function asBackendEvent(value: unknown): BackendUiEvent | null {
  if (!value || typeof value !== "object" || !("type" in value)) return null;
  const event = value as BackendUiEvent;
  return typeof event.type === "string" ? event : null;
}

function isReviewReadyText(text: string): boolean {
  return text.trim() === "Ready for review.";
}

function eventSignature(event: BackendUiEvent): string {
  return JSON.stringify(event);
}

function appendBackendEvent(events: BackendUiEvent[], event: BackendUiEvent, limit = 500): BackendUiEvent[] {
  const last = events.at(-1);
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

function compactBackendEvents(events: BackendUiEvent[], limit = 500): BackendUiEvent[] {
  return events.reduce<BackendUiEvent[]>((current, event) => appendBackendEvent(current, event, limit), []);
}

function mergeEventSnapshots(...groups: BackendUiEvent[][]): BackendUiEvent[] {
  const merged: BackendUiEvent[] = [];
  const mergedCounts = new Map<string, number>();
  for (const group of groups) {
    const groupCounts = new Map<string, number>();
    for (const event of group) {
      const signature = eventSignature(event);
      const groupCount = (groupCounts.get(signature) ?? 0) + 1;
      groupCounts.set(signature, groupCount);
      if (groupCount <= (mergedCounts.get(signature) ?? 0)) continue;
      mergedCounts.set(signature, groupCount);
      merged.push(event);
    }
  }
  return compactBackendEvents(merged, 500);
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

const titleStopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "can",
  "could",
  "for",
  "i",
  "in",
  "is",
  "it",
  "let",
  "lets",
  "make",
  "my",
  "of",
  "on",
  "please",
  "should",
  "that",
  "the",
  "this",
  "to",
  "we",
  "with",
  "would",
  "you",
]);

function titleWord(word: string): string {
  if (!word) return word;
  if (word === word.toUpperCase() || word.includes("_") || word.includes("-")) return word;
  return `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}`;
}

function titleFromPrompt(prompt: string): string {
  const text = prompt
    .split(/\n\s*\nAttached files:/i)[0]
    .replace(/[`*_#[\]()>.,!?;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = text.match(/[A-Za-z0-9][A-Za-z0-9'_-]*/g) ?? [];
  const summaryWords = words
    .filter((word) => !titleStopWords.has(word.toLowerCase().replace(/'s$/, "")))
    .slice(0, 5);
  const title = (summaryWords.length >= 3 ? summaryWords : words.slice(0, 5)).map(titleWord).join(" ");
  return title ? title.slice(0, 72) : "New chat";
}

function chatDisplayTitle(chat: ChatRecord): string {
  return chat.title === "New chat" ? chat.title : titleFromPrompt(chat.title);
}

function draftMatchesTaskPrompt(draftPrompt: string, taskPrompt: string): boolean {
  const draft = draftPrompt.trim();
  const prompt = taskPrompt.trim();
  return !!draft && (prompt === draft || prompt.startsWith(`${draft}\n\nAttached files:`));
}

function chatSubline(chat: ChatRecord): string {
  if (chat.taskState === "merged") return "Closed after approved merge";
  if (chat.taskState === "rejected") return "Closed after undo";
  return chat.updatedAt ? new Date(chat.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
}

function closedChatMessage(state?: TaskState): string | undefined {
  if (state === "merged") {
    return "This chat was closed after its approved merge. Start a new chat for more changes.";
  }
  if (state === "rejected") {
    return "This chat was closed after its changes were undone. Start a new chat for more changes.";
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

function attachmentName(pathValue: string): string {
  return pathValue.split(/[\\/]/).filter(Boolean).pop() ?? pathValue;
}

function attachmentMention(file: ChatAttachment): string {
  return `@${file.name || attachmentName(file.path)}`;
}

function mentionAtCursor(value: string, cursor: number): { query: string; start: number; end: number } | null {
  const beforeCursor = value.slice(0, cursor);
  const match = beforeCursor.match(/(^|\s)@([^\s@]*)$/);
  if (!match || match.index === undefined) return null;
  const start = match.index + match[1].length;
  return { query: match[2], start, end: cursor };
}

function renderPromptHighlights(value: string, files: ChatAttachment[]): React.ReactNode[] {
  const tokens = files
    .map((file) => attachmentMention(normalizeAttachment(file)))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  if (!tokens.length) return [value || "\u200b"];
  const nodes: React.ReactNode[] = [];
  let index = 0;
  while (index < value.length) {
    const token = tokens.find(
      (candidate) =>
        value.startsWith(candidate, index) &&
        (index === 0 || /\s/.test(value[index - 1])) &&
        (index + candidate.length === value.length || /\s|[.,;:!?)]/.test(value[index + candidate.length])),
    );
    if (token) {
      nodes.push(
        <span className="promptMentionToken" key={`${index}-${token}`}>
          {token}
        </span>,
      );
      index += token.length;
      continue;
    }
    const nextMention = tokens
      .map((candidate) => value.indexOf(candidate, index + 1))
      .filter((position) => position >= 0)
      .sort((left, right) => left - right)[0];
    const end = nextMention ?? value.length;
    nodes.push(value.slice(index, end));
    index = end;
  }
  if (value.endsWith("\n")) nodes.push("\u200b");
  return nodes;
}

type ReviewReferenceOptions = {
  reviewFiles?: ReviewFile[];
  onReviewFileClick?: (filePath: string) => void;
};

function normalizeReviewReference(value: string): string {
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

function reviewFileForReference(value: string, reviewFiles?: ReviewFile[]): ReviewFile | undefined {
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
      return event.decision === "approved" ? "merge approved" : "merge rejected";
    case "merge.completed":
      return "approved";
    case "ide.opened":
      return event.result === "success" ? "opened editor" : "editor open failed";
    case "response.feedback":
      return event.rating === "good" ? "liked response" : "disliked response";
    case "task.error":
      return "task event";
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
    case "merge.completed":
      return `${event.targetBranch} ${shortHash(event.commit)}`;
    case "ide.opened":
      return [event.ideId, event.target, event.filePath, event.message].filter(Boolean).join(" - ");
    case "response.feedback":
      return event.messageId;
    case "task.error":
      return event.message;
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
const sidebarDefaultWidth = 248;
const sidebarMinWidth = 196;
const sidebarMaxWidth = 360;
const sidebarCloseThreshold = 150;
const reviewMinWidth = 365;
const reviewCloseThreshold = 260;
const composerMinWidth = 480;
const reviewOpenRatio = 0.7;
const compactSidebarRatio = 0.18;
const sidebarMaxRatio = 0.28;

function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!match) return null;
  return { oldStart: Number(match[1]), newStart: Number(match[2]) };
}

function parseUnifiedDiff(diff: string): ParsedDiff {
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

function formatDiffStats(stats: ParsedDiff): string {
  return `+${stats.additions} -${stats.deletions}`;
}

function ApprovalIcon({ status }: { status: ApprovalCheck["status"] }) {
  if (status === "passed") return <CheckCircle2 size={15} />;
  if (status === "failed") return <TriangleAlert size={15} />;
  return <Loader2 className="spin" size={15} />;
}

function commandLabel(command: string): string {
  return isShellLikeCommand(command) ? "Ran command" : `Ran ${command.split(/\s+/)[0] || "tool"}`;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function isShellLikeCommand(command: string): boolean {
  return !/^(read|write|edit|glob|grep|task|question|todowrite|skill)(?:\s|$)/i.test(command.trim());
}

function commandSummary(run: CommandRun): string {
  if (run.status === "running") return "running";
  if (run.status === "failed") return `failed${run.exitCode === null ? "" : `, exit ${run.exitCode}`}`;
  const output = stripAnsi(run.stdout || run.stderr).trim();
  return output ? output.split(/\r?\n/).filter(Boolean).slice(-1)[0] : `exit ${run.exitCode ?? 0}`;
}

function commandShellText(run: CommandRun): string {
  const parts = [run.kind === "edit" && !isShellLikeCommand(run.command) ? `tool ${run.command}` : `$ ${run.command}`];
  const output = stripAnsi([run.stdout, run.stderr].filter(Boolean).join("\n")).trimEnd();
  if (output) parts.push(output);
  return parts.join("\n\n");
}

function commandDetailLabel(run: CommandRun): string {
  const label = run.kind === "edit" && !isShellLikeCommand(run.command) ? "Tool" : "Shell";
  return run.commandClass ? `${label} - ${run.commandClass}` : label;
}

function taskStatusTitle(task: TaskInfo): string {
  if (task.state === "completed") return "Answered";
  if (task.state === "review_ready") return "Ready to review";
  if (task.state === "merged") return task.workspaceKind === "git" ? "Merged" : "Approved";
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
  if (task.state === "merged") return "This chat was closed after its approved merge.";
  if (task.state === "completed") return "No file changes for this turn.";
  if (task.state === "rejected") return "Changes were undone.";
  if (task.latestTest?.passed) return `Verified: ${task.latestTest.output.trim() || task.latestTest.command}`;
  if (task.error) return task.error;
  if (task.state === "running") return "Aegis is working.";
  return task.workspaceKind === "git" ? task.agentBranch : task.worktreePath;
}

function commandRunsFromEvents(events: BackendUiEvent[]): CommandRun[] {
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
        };
        runs.set(event.id, run);
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
          commandClass: "unknown",
          cwd: "",
          stdout: "",
          stderr: "",
          exitCode: null,
          status: "running",
        };
        runs.set(event.id, run);
      }
      run.exitCode = event.exitCode;
      run.status = event.exitCode === 0 ? "passed" : "failed";
    }
  }
  return Array.from(runs.values());
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
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function thoughtSummary(item: Extract<ComposerTimelineItem, { type: "reasoning" }>): string {
  if (!item.finished) return "Thinking";
  const duration = formatDuration(item.durationMs);
  return duration ? `Thought for ${duration}` : "Thought";
}

function assistantTextFromEvents(events: BackendUiEvent[]): string {
  return events
    .filter((event): event is Extract<BackendUiEvent, { type: "assistant.delta" }> => event.type === "assistant.delta")
    .map((event) => event.text)
    .filter((text) => !isReviewReadyText(text))
    .join("")
    .trim();
}

function composerTimelineFromEvents(events: BackendUiEvent[], taskPrompt?: string, taskState?: TaskState): ComposerTimelineItem[] {
  const runs = new Map<string, CommandRun>();
  const items: ComposerTimelineItem[] = [];
  let assistantBuffer = "";
  let assistantIndex = 0;
  let reasoningBuffer = "";
  let reasoningStartedAt: string | undefined;
  let reasoningEndedAt: string | undefined;
  let reasoningIndex = 0;
  const prompt = taskPrompt?.trim();
  const hasUserMessages = events.some((event) => event.type === "user.message");

  if (prompt && !hasUserMessages) {
    items.push({ type: "user", id: "user-prompt", text: prompt });
  }

  const flushAssistant = () => {
    if (!assistantBuffer.trim()) {
      assistantBuffer = "";
      return;
    }
    assistantIndex += 1;
    items.push({ type: "assistant", id: `assistant-${assistantIndex}`, text: assistantBuffer });
    assistantBuffer = "";
  };

  const flushReasoning = (finished = true) => {
    if (!reasoningBuffer.trim()) {
      reasoningBuffer = "";
      reasoningStartedAt = undefined;
      reasoningEndedAt = undefined;
      return;
    }
    reasoningIndex += 1;
    items.push({
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
      flushAssistant();
      items.push({ type: "user", id: `user-${items.length}-${event.text.length}`, text: event.text });
      continue;
    }
    if (event.type === "assistant.delta") {
      if (isReviewReadyText(event.text)) continue;
      flushReasoning();
      assistantBuffer = `${assistantBuffer}${event.text}`;
      continue;
    }
    if (event.type === "assistant.reasoning.delta") {
      flushAssistant();
      reasoningStartedAt = reasoningStartedAt ?? event.at;
      reasoningEndedAt = event.endedAt ?? event.at ?? reasoningEndedAt;
      reasoningBuffer = `${reasoningBuffer}${event.text}`;
      continue;
    }
    if (event.type === "assistant.done") {
      flushReasoning();
      flushAssistant();
      continue;
    }
    if (event.type === "command.started") {
      flushReasoning();
      flushAssistant();
      const existingRun = runs.get(event.id);
      if (existingRun) {
        existingRun.command = event.command;
        existingRun.kind = event.kind;
        existingRun.cwd = event.cwd;
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
      };
      runs.set(event.id, run);
      items.push({ type: "command", id: event.id, run });
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
        };
        runs.set(event.id, run);
        items.push({ type: "command", id: event.id, run });
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
        };
        runs.set(event.id, run);
        items.push({ type: "command", id: event.id, run });
      }
      run.exitCode = event.exitCode;
      run.status = event.exitCode === 0 ? "passed" : "failed";
    }
  }
  flushReasoning(taskState !== "running");
  flushAssistant();
  return items;
}

type MarkdownBlock =
  | { type: "code"; language: string; content: string }
  | { type: "heading"; level: number; text: string }
  | { type: "list"; items: string[] }
  | { type: "paragraph"; text: string };

function parseMarkdown(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let code: { language: string; lines: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: "paragraph", text: paragraph.join("\n") });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      blocks.push({ type: "list", items: list });
      list = [];
    }
  };

  for (const line of lines) {
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      if (code) {
        blocks.push({ type: "code", language: code.language, content: code.lines.join("\n") });
        code = null;
      } else {
        flushParagraph();
        flushList();
        code = { language: fence[1] ?? "", lines: [] };
      }
      continue;
    }
    if (code) {
      code.lines.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    const listItem = line.match(/^\s*[-*]\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      list.push(listItem[1]);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line);
  }

  if (code) blocks.push({ type: "code", language: code.language, content: code.lines.join("\n") });
  flushParagraph();
  flushList();
  return blocks;
}

function renderInlineMarkdown(text: string, options?: ReviewReferenceOptions): React.ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      const code = part.slice(1, -1);
      if (reviewFileForReference(code, options?.reviewFiles) || code.startsWith("@") || /[\\/].+\.[A-Za-z0-9]{1,8}$/.test(code)) {
        return renderReferenceToken(code, `code-ref-${index}`, options);
      }
      return <code key={index}>{code}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return <React.Fragment key={index}>{renderPlainInlineText(part, `inline-${index}`, options)}</React.Fragment>;
  });
}

function MarkdownContent({ content, onReviewFileClick, reviewFiles }: { content: string } & ReviewReferenceOptions) {
  const blocks = useMemo(() => parseMarkdown(content), [content]);
  const referenceOptions = useMemo(() => ({ onReviewFileClick, reviewFiles }), [onReviewFileClick, reviewFiles]);
  return (
    <div className="markdownContent">
      {blocks.map((block, index) => {
        if (block.type === "code") {
          return (
            <pre className="markdownCode" key={index}>
              {block.language ? <span>{block.language}</span> : null}
              <code>{block.content}</code>
            </pre>
          );
        }
        if (block.type === "heading") {
          if (block.level === 1) return <h3 key={index}>{renderInlineMarkdown(block.text, referenceOptions)}</h3>;
          if (block.level === 2) return <h4 key={index}>{renderInlineMarkdown(block.text, referenceOptions)}</h4>;
          return <h5 key={index}>{renderInlineMarkdown(block.text, referenceOptions)}</h5>;
        }
        if (block.type === "list") {
          return (
            <ul key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInlineMarkdown(item, referenceOptions)}</li>
              ))}
            </ul>
          );
        }
        return <p key={index}>{renderInlineMarkdown(block.text, referenceOptions)}</p>;
      })}
    </div>
  );
}

function ReviewSummaryCard({
  expandedPaths,
  files,
  diffs,
  onOpenReview,
  onToggleFile,
  totals,
}: {
  expandedPaths: Set<string>;
  files: ReviewFile[];
  diffs: Map<string, ParsedDiff>;
  onOpenReview(): void;
  onToggleFile(filePath: string): void;
  totals: { additions: number; deletions: number };
}) {
  if (!files.length) return null;
  return (
    <article className="reviewSummaryCard">
      <div className="reviewSummaryHeader">
        <span className="reviewSummaryTitle">
          <FileText size={15} />
          <strong>
            {files.length} file{files.length === 1 ? "" : "s"} changed
          </strong>
          <span className="additions">+{totals.additions}</span>
          <span className="deletions">-{totals.deletions}</span>
        </span>
        <button className="reviewSummaryReviewButton" type="button" onClick={onOpenReview}>
          <span>Review</span>
          <ExternalLink size={13} />
        </button>
      </div>
      <div className="reviewSummaryFiles">
        {files.map((file) => {
          const stats = diffs.get(file.path) ?? emptyParsedDiff;
          const expanded = expandedPaths.has(file.path);
          const previewRows = stats.rows.slice(0, 120);
          return (
            <section className={`reviewSummaryFile ${expanded ? "expanded" : ""}`} key={file.path}>
              <button
                className="reviewSummaryFileButton"
                type="button"
                onClick={() => onToggleFile(file.path)}
                aria-expanded={expanded}
              >
                <span className="reviewSummaryPath">{file.path}</span>
                <span className="changeStats" aria-label={formatDiffStats(stats)}>
                  <span className="additions">+{stats.additions}</span>
                  <span className="deletions">-{stats.deletions}</span>
                </span>
                <ChevronDown className="reviewSummaryChevron" size={14} />
              </button>
              <div className={`reviewSummaryFileBody ${expanded ? "open" : ""}`}>
                <div className="diffRows compactDiffRows">
                  {previewRows.length ? (
                    previewRows.map((row, index) => (
                      <div className={`diffRow ${row.kind}`} key={`${file.path}-${index}-${row.oldLine ?? ""}-${row.newLine ?? ""}`}>
                        <span className="diffLineNumber">{row.oldLine ?? ""}</span>
                        <span className="diffLineNumber">{row.newLine ?? ""}</span>
                        <span className="diffMarker">{row.marker}</span>
                        <code>{row.content || " "}</code>
                      </div>
                    ))
                  ) : (
                    <Empty label="No text diff available" />
                  )}
                </div>
              </div>
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

function App() {
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  const [repository, setRepository] = useState<RepositoryInfo | null>(null);
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>("normal");
  const reasoningMode: ReasoningMode = "reasoning";
  const [chats, setChats] = useState<ChatRecord[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [task, setTask] = useState<TaskInfo | null>(null);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [attachedFiles, setAttachedFiles] = useState<ChatAttachment[]>([]);
  const [fileMatches, setFileMatches] = useState<FileSearchResult[]>([]);
  const [mention, setMention] = useState<{ query: string; start: number; end: number } | null>(null);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [promptScrollTop, setPromptScrollTop] = useState(0);
  const [deleteCandidate, setDeleteCandidate] = useState<ChatRecord | null>(null);
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<Set<string>>(() => new Set());
  const [events, setEvents] = useState<BackendUiEvent[]>([]);
  const [assistantText, setAssistantText] = useState("");
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [approvalChecks, setApprovalChecks] = useState<ApprovalCheck[]>([]);
  const [expandedReviewPaths, setExpandedReviewPaths] = useState<Set<string>>(() => new Set());
  const [expandedCommandId, setExpandedCommandId] = useState<string | null>(null);
  const [expandedReasoningIds, setExpandedReasoningIds] = useState<Set<string>>(() => new Set());
  const [autoExpandedReasoningIds, setAutoExpandedReasoningIds] = useState<Set<string>>(() => new Set());
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [checkoutPending, setCheckoutPending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"account" | "tools" | "skills" | "telemetry">("account");
  const [accountMessage, setAccountMessage] = useState<string | null>(null);
  const [telemetryMessage, setTelemetryMessage] = useState<string | null>(null);
  const [exportingTelemetry, setExportingTelemetry] = useState(false);
  const [toolsEnabled, setToolsEnabled] = useState<Record<string, boolean>>({
    read: true,
    write: true,
    edit: true,
    search: true,
    command: true,
  });
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsDirectory, setSkillsDirectory] = useState<string>("~/.aegis/skills");
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsEnabled, setSkillsEnabled] = useState<Record<string, boolean>>({});
  const [skillsMessage, setSkillsMessage] = useState<string | null>(null);
  const [newSkillFormOpen, setNewSkillFormOpen] = useState(false);
  const [newSkillName, setNewSkillName] = useState("");
  const [creatingSkill, setCreatingSkill] = useState(false);
  const [ideMenuOpen, setIdeMenuOpen] = useState(false);
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [availableIdes, setAvailableIdes] = useState<IdeChoice[]>(defaultIdeChoices);
  const [selectedIdeId, setSelectedIdeId] = useState(defaultIdeChoices[0].id);
  const [sidebarWidth, setSidebarWidth] = useState(sidebarDefaultWidth);
  const [reviewWidth, setReviewWidth] = useState(520);
  const [showBypassDialog, setShowBypassDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentMenuRef = useRef<HTMLDivElement | null>(null);
  const draftSaveRef = useRef<number | null>(null);
  const suppressDraftSaveRef = useRef(false);
  const reviewRefreshRef = useRef(false);
  const appBlurredRef = useRef(false);

  const latestTaskId = task?.id;
  const rawReviewFiles = task?.reviewFiles ?? emptyReviewFiles;
  const reviewFiles = useMemo(() => {
    const byPath = new Map<string, ReviewFile>();
    for (const file of rawReviewFiles) {
      byPath.set(file.path, file);
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
  const activeChat = activeChatId ? chats.find((chat) => chat.id === activeChatId) : undefined;
  const closedChatNotice = closedChatMessage(task?.state ?? activeChat?.taskState);
  const canStart = !!selectedModel && prompt.trim().length > 0 && !busy && !closedChatNotice;
  const canApprove = task?.state === "review_ready" && reviewFiles.length > 0 && !busy;
  const canUndo = !!task && task.state !== "merged" && task.state !== "rejected" && task.state !== "completed" && !busy;
  const canOpenIde = !!task && task.state !== "merged" && task.state !== "rejected" && task.state !== "completed";
  const reviewEmptyLabel = !task
    ? "No active review"
    : task.state === "review_ready"
      ? "No file changes found"
      : stateLabel(task.state);
  const attachmentMenuOpen = !!mention;
  const attachmentSearchQuery = mention?.query ?? "";
  const canAttachFiles = !busy && !closedChatNotice;
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
  const composerItems = useMemo(
    () => composerTimelineFromEvents(visibleEvents, task?.prompt, task?.state),
    [task?.prompt, task?.state, visibleEvents],
  );
  const assistantCopyText = useMemo(() => assistantTextFromEvents(visibleEvents), [visibleEvents]);
  const chatProjectGroups = useMemo(() => {
    const groups = new Map<
      string,
      { key: string; name: string; path?: string; chats: ChatRecord[]; latestUpdatedAt: string }
    >();
    for (const chat of chats) {
      const key = chatProjectKey(chat);
      const existing = groups.get(key);
      if (existing) {
        existing.chats.push(chat);
        if (chat.updatedAt > existing.latestUpdatedAt) existing.latestUpdatedAt = chat.updatedAt;
        continue;
      }
      groups.set(key, {
        key,
        name: chat.repositoryName || folderName(chat.repositoryPath),
        path: chat.repositoryPath,
        chats: [chat],
        latestUpdatedAt: chat.updatedAt,
      });
    }
    return Array.from(groups.values()).sort((left, right) => {
      if (left.key === "__unassigned__") return 1;
      if (right.key === "__unassigned__") return -1;
      return right.latestUpdatedAt.localeCompare(left.latestUpdatedAt);
    });
  }, [chats]);
  const layoutStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    "--review-width": `${reviewWidth}px`,
  } as React.CSSProperties;
  const todayPromptLabel = repository ? `What should we build in ${repository.name}?` : "What should we build today?";

  useEffect(() => {
    const reasoningItems = composerItems.filter(
      (item): item is Extract<ComposerTimelineItem, { type: "reasoning" }> => item.type === "reasoning",
    );
    setAutoExpandedReasoningIds((current) => {
      let changed = false;
      const next = new Set(current);
      for (const item of reasoningItems) {
        if (!item.finished && !next.has(item.id)) {
          next.add(item.id);
          changed = true;
          continue;
        }
        if (item.finished && next.delete(item.id)) {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [composerItems]);

  useEffect(() => {
    void refreshStatus();
    void loadAvailableIdes();
    void loadChats();
    return api.onBackendEvent((rawEvent) => {
      const event = asBackendEvent(rawEvent);
      if (!event) return;
      if (event.type === "assistant.delta" && isReviewReadyText(event.text)) return;
      setEvents((current) => appendBackendEvent(current, event, 500));
      if (event.type === "assistant.delta") {
        setAssistantText((current) => `${current}${event.text}`);
      }
      if (event.type === "assistant.done") {
        setTask((current) =>
          current && current.id === event.taskId && current.state === "running" ? { ...current, state: "completed" } : current,
        );
        void loadChats();
      }
      if (event.type === "permission.requested") setPendingPermission(event.request);
      if (event.type === "permission.resolved") {
        setPendingPermission((current) => (current?.id === event.id ? null : current));
      }
      if (event.type === "worktree.requested") {
        setTask((current) =>
          current && current.id === event.taskId
            ? { ...current, state: "awaiting_worktree_approval", worktreePath: event.path, agentBranch: event.branch }
            : current,
        );
        void loadChats();
      }
      if (event.type === "worktree.created") {
        setTask((current) =>
          current && current.id === event.taskId
            ? { ...current, state: "running", worktreePath: event.path, agentBranch: event.branch }
            : current,
        );
      }
      if (event.type === "review.ready") {
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
          void refreshTaskReviewById(event.taskId);
        }, 120);
        void loadChats();
      }
      if (event.type === "approval.check") {
        setApprovalChecks((current) => {
          const next = current.filter((check) => check.name !== event.name);
          next.push({ name: event.name, status: event.status, detail: event.detail });
          return next;
        });
      }
      if (event.type === "merge.completed") {
        setTask((current) =>
          current && current.id === event.taskId ? { ...current, state: "merged", patchHash: event.patchHash } : current,
        );
        void loadChats();
      }
      if (event.type === "task.error") {
        setError(event.message);
        setTask((current) =>
          current && current.id === event.taskId ? { ...current, state: "failed", error: event.message } : current,
        );
        void loadChats();
      }
    });
  }, []);

  useEffect(() => {
    const markBlurred = () => {
      appBlurredRef.current = true;
    };
    const refreshOnFocus = () => {
      if (!appBlurredRef.current) return;
      appBlurredRef.current = false;
      void refreshActiveReview();
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
      window.removeEventListener("blur", markBlurred);
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [task?.id, task?.state, busy]);

  useEffect(() => {
    if (availableIdes.length > 0 && !availableIdes.some((ide) => ide.id === selectedIdeId)) {
      setSelectedIdeId(availableIdes[0].id);
    }
  }, [availableIdes, selectedIdeId]);

  useEffect(() => {
    if (!canOpenIde) setIdeMenuOpen(false);
  }, [canOpenIde]);

  useEffect(() => {
    if (!reviewOpen) return undefined;
    const resizeReview = () => {
      const nextSidebarWidth = sidebarOpen ? Math.min(sidebarWidth, compactSidebarWidth()) : 0;
      if (sidebarOpen && nextSidebarWidth !== sidebarWidth) {
        setSidebarWidth(nextSidebarWidth);
      }
      setReviewWidth(wideReviewWidth(nextSidebarWidth));
    };
    window.addEventListener("resize", resizeReview);
    return () => window.removeEventListener("resize", resizeReview);
  }, [reviewOpen, sidebarOpen, sidebarWidth]);

  useEffect(() => {
    const node = streamRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [events.length, assistantText]);

  useEffect(() => {
    if (!activeChatId || suppressDraftSaveRef.current) return undefined;
    if (draftSaveRef.current) window.clearTimeout(draftSaveRef.current);
    const chatId = activeChatId;
    const draftPrompt = prompt;
    const files = attachedFiles;
    draftSaveRef.current = window.setTimeout(() => {
      void persistDraft(chatId, draftPrompt, files);
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

  async function persistDraft(chatId: string, draftPrompt: string, files: ChatAttachment[]) {
    try {
      const next = await api.updateChatDraft({ chatId, draftPrompt, attachedFiles: files });
      setChats((current) =>
        current.map((chat) =>
          chat.id === chatId
            ? { ...chat, draftPrompt: next.draftPrompt, attachedFiles: next.attachedFiles, updatedAt: next.updatedAt }
            : chat,
        ),
      );
    } catch {
      /* Draft persistence should not interrupt typing. */
    }
  }

  function mergeChat(chat: ChatRecord) {
    setChats((current) => [chat, ...current.filter((row) => row.id !== chat.id)]);
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
          createdAt: existing?.createdAt ?? chat.createdAt,
          repositoryName: chat.repositoryName ?? existing?.repositoryName,
          repositoryPath: chat.repositoryPath ?? existing?.repositoryPath,
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

  async function refreshStatus() {
    try {
      const status = await api.getBackendStatus();
      setBackend(status);
      setPermissionModeState(status.permissionMode);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function exportTelemetry() {
    setExportingTelemetry(true);
    setTelemetryMessage(null);
    try {
      const result = await api.exportTelemetry();
      setTelemetryMessage(result.ok ? `Exported to ${result.path}` : result.message);
    } catch (cause) {
      setTelemetryMessage(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setExportingTelemetry(false);
    }
  }

  async function loadSkills() {
    setSkillsLoading(true);
    try {
      const result = await api.listSkills();
      setSkills(result.skills);
      setSkillsDirectory(result.directory);
      setSkillsEnabled((prev) => {
        const next: Record<string, boolean> = {};
        for (const skill of result.skills) {
          next[skill.id] = prev[skill.id] ?? true;
        }
        return next;
      });
    } catch (cause) {
      setSkills([]);
      console.warn("Failed to list skills", cause);
    } finally {
      setSkillsLoading(false);
    }
  }

  async function openSkillsFolder() {
    setSkillsMessage(null);
    try {
      const result = await api.openSkillsFolder();
      if (!result.ok) {
        setSkillsMessage(result.message);
      } else {
        setSkillsDirectory(result.directory);
      }
    } catch (cause) {
      setSkillsMessage(String(cause instanceof Error ? cause.message : cause));
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
    } catch (cause) {
      setSkillsMessage(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setCreatingSkill(false);
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

  async function refreshTaskReviewById(taskId: string, openWhenReady = false) {
    if (reviewRefreshRef.current) return;
    reviewRefreshRef.current = true;
    try {
      const nextTask = await api.refreshTaskReview({ taskId });
      if (!nextTask) return;
      setTask((current) => (!current || current.id === nextTask.id ? nextTask : current));
      setExpandedReviewPaths((current) => {
        const availablePaths = new Set(nextTask.reviewFiles.map((file) => file.path));
        return new Set(Array.from(current).filter((filePath) => availablePaths.has(filePath)));
      });
      if (openWhenReady && nextTask.state === "review_ready") {
        openReviewPanel();
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
    if (!task || busy || task.state !== "review_ready") return;
    await refreshTaskReviewById(task.id);
  }

  async function pickRepository() {
    setError(null);
    setBusy(true);
    try {
      const result = await api.pickRepository();
      if (!result.canceled) {
        setRepository(result.repository);
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

  async function restoreChatRepository(chat: ChatRecord, repositoryId?: string) {
    if (!chat.repositoryPath && !repositoryId) {
      setRepository(null);
      return;
    }
    try {
      const nextRepository = await api.getRepository({ repositoryId, repositoryPath: chat.repositoryPath });
      if (nextRepository) {
        setRepository(nextRepository);
      }
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function updatePermissionMode(mode: PermissionMode) {
    if (mode === "bypass" && permissionMode !== "bypass") {
      setShowBypassDialog(true);
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

  async function confirmBypassMode() {
    setShowBypassDialog(false);
    setError(null);
    setPermissionModeState("bypass");
    try {
      const status = await api.setPermissionMode("bypass");
      setBackend(status);
      setPermissionModeState(status.permissionMode);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function startTask() {
    if (!selectedModel) {
      setError("Configure an OpenAI-compatible endpoint and model id.");
      return;
    }
    if (closedChatNotice) {
      setError(closedChatNotice);
      return;
    }
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) return;
    const isContinuingChat = !!task && task.chatId === activeChatId;
    const preservedEvents = isContinuingChat ? events : [];
    setError(null);
    setBusy(true);
    if (!isContinuingChat) {
      setEvents([]);
      setAssistantText("");
      setApprovalChecks([]);
      setExpandedCommandId(null);
      setExpandedReasoningIds(new Set());
      setAutoExpandedReasoningIds(new Set());
      setExpandedReviewPaths(new Set());
      setReviewOpen(false);
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
      });
      setTask(nextTask);
      setEvents((current) =>
        isContinuingChat
          ? mergeEventSnapshots(preservedEvents, nextTask.events ?? [], current)
          : mergeEventSnapshots(nextTask.events ?? [], current),
      );
      if (nextTask.chatId) setActiveChatId(nextTask.chatId);
      upsertChatFromTask(nextTask);
      suppressDraftSaveBriefly();
      setPrompt("");
      setAttachedFiles([]);
      setMention(null);
      setFileMatches([]);
      await persistDraft(nextTask.chatId ?? chatId, "", []);
      if (!isContinuingChat) setExpandedReviewPaths(new Set());
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setBusy(false);
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

  async function rateResponse(messageId: string, rating: "good" | "bad") {
    if (!latestTaskId) return;
    setError(null);
    try {
      await api.setResponseFeedback({ taskId: latestTaskId, messageId, rating });
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function openIde(ideId: string) {
    if (!canOpenIde || !task) return;
    setIdeMenuOpen(false);
    const result = await api.openTaskInIde({ taskId: task.id, ideId });
    if (!result.ok) setError(result.message);
  }

  function sidebarMaxAvailableWidth() {
    return clamp(Math.round(window.innerWidth * sidebarMaxRatio), sidebarMinWidth, sidebarMaxWidth);
  }

  function compactSidebarWidth() {
    return clamp(Math.round(window.innerWidth * compactSidebarRatio), sidebarMinWidth, Math.min(sidebarDefaultWidth, sidebarMaxAvailableWidth()));
  }

  function reviewAvailableWidth(sidebarWidthOverride = sidebarOpen ? sidebarWidth : 0) {
    const sidebarSpace = sidebarOpen ? sidebarWidthOverride : 0;
    return Math.max(reviewMinWidth + composerMinWidth, window.innerWidth - sidebarSpace);
  }

  function reviewMaxWidth(sidebarWidthOverride = sidebarOpen ? sidebarWidth : 0) {
    return Math.max(reviewMinWidth, reviewAvailableWidth(sidebarWidthOverride) - composerMinWidth);
  }

  function wideReviewWidth(sidebarWidthOverride = sidebarOpen ? sidebarWidth : 0) {
    const available = reviewAvailableWidth(sidebarWidthOverride);
    return clamp(Math.round(available * reviewOpenRatio), reviewMinWidth, reviewMaxWidth(sidebarWidthOverride));
  }

  function toggleSidebarPanel() {
    if (sidebarOpen) {
      setSidebarOpen(false);
      return;
    }
    setSidebarWidth(compactSidebarWidth());
    setSidebarOpen(true);
  }

  function openReviewPanel(filePath?: string) {
    const nextSidebarWidth = sidebarOpen ? Math.min(sidebarWidth, compactSidebarWidth()) : 0;
    if (sidebarOpen && nextSidebarWidth !== sidebarWidth) {
      setSidebarWidth(nextSidebarWidth);
    }
    setReviewWidth(wideReviewWidth(nextSidebarWidth));
    setReviewOpen(true);
    if (filePath) {
      setExpandedReviewPaths((current) => new Set([...current, filePath]));
    }
  }

  function toggleReviewPanel() {
    if (reviewOpen) {
      setReviewOpen(false);
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
        const next = current ? { ...current, state: "merged" as const, patchHash: result.patchHash } : current;
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
    setIdeMenuOpen(false);
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
  }

  function handlePromptChange(event: React.ChangeEvent<HTMLTextAreaElement>) {
    const nextPrompt = event.target.value;
    setPrompt(nextPrompt);
    setAttachedFiles((current) => current.filter((file) => nextPrompt.includes(attachmentMention(normalizeAttachment(file)))));
    updateMention(nextPrompt, event.target.selectionStart);
  }

  function mergeAttachments(current: ChatAttachment[], files: ChatAttachment[]): ChatAttachment[] {
    const next = [...current];
    for (const file of files.map(normalizeAttachment)) {
      if (!next.some((attached) => attached.path === file.path)) {
        next.push(file);
      }
      if (next.length >= 16) break;
    }
    return next;
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
    if (mention) {
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

  async function pickAttachment() {
    if (busy || closedChatNotice) return;
    setError(null);
    try {
      let chatId = activeChatId;
      if (!chatId) {
        const chat = await api.createChat(chatInputForCurrentProject(prompt.trim() ? titleFromPrompt(prompt) : "New chat"));
        mergeChat(chat);
        suppressDraftSaveBriefly();
        setActiveChatId(chat.id);
        chatId = chat.id;
      }
      const result = await api.pickAttachmentFiles({ chatId, repositoryId: repository?.id });
      if (result.canceled) return;
      const files = result.files.map(normalizeAttachment);
      setAttachedFiles((current) => mergeAttachments(current, files));
      insertAttachmentMentions(files);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  function handlePromptKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (attachmentMenuOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        setFileMatches([]);
        setSelectedFileIndex(0);
        return;
      }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && fileMatches.length) {
        event.preventDefault();
        setSelectedFileIndex((current) => {
          const direction = event.key === "ArrowDown" ? 1 : -1;
          return (current + direction + fileMatches.length) % fileMatches.length;
        });
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && fileMatches.length) {
        event.preventDefault();
        addAttachment(fileMatches[Math.min(selectedFileIndex, fileMatches.length - 1)]);
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    event.preventDefault();
    void startTask();
  }

  async function newChat() {
    setError(null);
    try {
      if (activeChatId) await persistDraft(activeChatId, prompt, attachedFiles);
      const chat = await api.createChat({ title: "New chat" });
      mergeChat(chat);
      suppressDraftSaveBriefly();
      setActiveChatId(chat.id);
      setRepository(null);
      setTask(null);
      setEvents([]);
      setAssistantText("");
      setApprovalChecks([]);
      setExpandedCommandId(null);
      setExpandedReasoningIds(new Set());
      setAutoExpandedReasoningIds(new Set());
      setPendingPermission(null);
      setExpandedReviewPaths(new Set());
      setReviewOpen(false);
      setAttachedFiles([]);
      setMention(null);
      setFileMatches([]);
      setPrompt(initialPrompt);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function newChatForProject(project: { name: string; path?: string }) {
    if (!project.path) return;
    setError(null);
    try {
      if (activeChatId) await persistDraft(activeChatId, prompt, attachedFiles);
      const chat = await api.createChat(chatInputForProject("New chat", project));
      mergeChat(chat);
      suppressDraftSaveBriefly();
      setActiveChatId(chat.id);
      setTask(null);
      setEvents([]);
      setAssistantText("");
      setApprovalChecks([]);
      setExpandedCommandId(null);
      setExpandedReasoningIds(new Set());
      setAutoExpandedReasoningIds(new Set());
      setPendingPermission(null);
      setExpandedReviewPaths(new Set());
      setReviewOpen(false);
      setAttachedFiles([]);
      setMention(null);
      setFileMatches([]);
      setPrompt(initialPrompt);
      await restoreChatRepository(chat);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function selectChat(chat: ChatRecord) {
    if (activeChatId === chat.id) {
      void restoreChatRepository(chat, task?.repositoryId);
      return;
    }
    if (activeChatId) await persistDraft(activeChatId, prompt, attachedFiles);
    suppressDraftSaveBriefly();
    setActiveChatId(chat.id);
    setEvents([]);
    setAssistantText("");
    setApprovalChecks([]);
    setExpandedCommandId(null);
    setExpandedReasoningIds(new Set());
    setAutoExpandedReasoningIds(new Set());
    setPendingPermission(null);
    setError(null);
    setExpandedReviewPaths(new Set());
    setAttachedFiles(chat.attachedFiles ?? []);
    setMention(null);
    setFileMatches([]);
    try {
      let nextTask = chat.taskId ? await api.getTask({ taskId: chat.taskId }) : null;
      if (nextTask?.state === "review_ready") {
        nextTask = (await api.refreshTaskReview({ taskId: nextTask.id })) ?? nextTask;
      }
      await restoreChatRepository(chat, nextTask?.repositoryId);
      if (!chat.taskId) {
        setTask(null);
        setReviewOpen(false);
        setPrompt(chat.draftPrompt ?? "");
        return;
      }
      setTask(nextTask);
      setEvents(compactBackendEvents(nextTask?.events ?? [], 500));
      const draftPrompt = chat.draftPrompt ?? "";
      const sentDraft = nextTask ? draftMatchesTaskPrompt(draftPrompt, nextTask.prompt) : false;
      setPrompt(sentDraft ? "" : draftPrompt);
      setAttachedFiles(!draftPrompt || sentDraft ? [] : (chat.attachedFiles ?? []));
      if (sentDraft) void persistDraft(chat.id, "", []);
      setExpandedReviewPaths(new Set());
    } catch (cause) {
      setTask(null);
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function confirmDeleteChat() {
    if (!deleteCandidate) return;
    const target = deleteCandidate;
    setDeleteCandidate(null);
    try {
      await api.deleteChat({ chatId: target.id });
      setChats((current) => current.filter((chat) => chat.id !== target.id));
      if (activeChatId === target.id) {
        suppressDraftSaveBriefly();
        setActiveChatId(null);
        setTask(null);
        setEvents([]);
        setAssistantText("");
        setApprovalChecks([]);
        setExpandedCommandId(null);
        setExpandedReasoningIds(new Set());
        setAutoExpandedReasoningIds(new Set());
        setPendingPermission(null);
        setExpandedReviewPaths(new Set());
        setReviewOpen(false);
        setAttachedFiles([]);
        setMention(null);
        setFileMatches([]);
        setPrompt("");
      }
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  function beginSidebarResize(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let closeAfterDrag = false;
    document.body.classList.add("isResizing");
    const move = (moveEvent: PointerEvent) => {
      const nextWidth = startWidth + moveEvent.clientX - startX;
      closeAfterDrag = nextWidth < sidebarCloseThreshold;
      setSidebarWidth(clamp(nextWidth, sidebarMinWidth, sidebarMaxAvailableWidth()));
    };
    const stop = () => {
      if (closeAfterDrag) {
        setSidebarOpen(false);
      } else {
        setSidebarOpen(true);
      }
      document.body.classList.remove("isResizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  function beginReviewResize(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = reviewWidth;
    const maxWidth = reviewMaxWidth();
    let closeAfterDrag = false;
    document.body.classList.add("isResizing");
    const finish = () => {
      document.body.classList.remove("isResizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    const move = (moveEvent: PointerEvent) => {
      const nextWidth = startWidth - (moveEvent.clientX - startX);
      closeAfterDrag = nextWidth < reviewCloseThreshold;
      setReviewWidth(clamp(nextWidth, reviewMinWidth, maxWidth));
    };
    const stop = () => {
      if (closeAfterDrag) {
        setReviewOpen(false);
      } else {
        setReviewOpen(true);
      }
      finish();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  return (
    <div
      className={`appShell ${isMacLike ? "macChrome" : ""} ${sidebarOpen ? "" : "sidebarClosed"} ${reviewOpen ? "" : "reviewClosed"}`}
      style={layoutStyle}
    >
      <header className="topbar">
        <button
          className={`chromeButton ${sidebarOpen ? "isActive" : ""}`}
          type="button"
          onClick={toggleSidebarPanel}
          aria-pressed={sidebarOpen}
          title="Toggle sidebar"
        >
          <PanelLeft size={15} />
        </button>
        <button
          className="chromeButton"
          type="button"
          onClick={() => {
            setTask(null);
            setReviewOpen(false);
          }}
          title="Back"
        >
          <ArrowLeft size={15} />
        </button>
        <div className="topbarSpacer" />
      </header>

      <aside className="sidebar">
        <div className="sidebarResizeHandle" role="separator" aria-orientation="vertical" onPointerDown={beginSidebarResize} />
        <div className="sidebarHeader">
          <button className="newChatButton" type="button" onClick={newChat}>
            <Plus size={16} />
            <span>New chat</span>
          </button>
        </div>
        <div className="sidebarStack">
          <section className="chatArchive">
            <div className="sideHeader">
              <h2>Chats</h2>
            </div>
            <div className="chatList">
              {chats.length ? (
                chatProjectGroups.map((group) => {
                  const collapsed = collapsedProjectKeys.has(group.key);
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
                      </div>
                      {!collapsed ? (
                        <div className="chatProjectChats">
                          {group.chats.map((chat) => (
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
                                  setDeleteCandidate(chat);
                                }}
                                title="Delete chat"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          ))}
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
            setTelemetryMessage(null);
            void refreshStatus();
            void loadSkills();
          }}
        >
          <Settings size={16} />
          <span>Settings</span>
        </button>
      </aside>

      <main className="workspace">
        <section className="workArea">
          <section className="composerPanel">
            <div className="composerTopbar">
              <button
                className={`chromeButton composerReviewToggle ${reviewOpen ? "isActive" : ""}`}
                type="button"
                onClick={toggleReviewPanel}
                aria-pressed={reviewOpen}
                title="Toggle review"
              >
                <PanelRight size={15} />
              </button>
            </div>
            <div className="composerBody" ref={streamRef}>
              {composerItems.length ? (
                <div className="timeline">
                  {composerItems.map((item) =>
                    item.type === "user" ? (
                      <article className="timelineMessage userMessage" key={item.id}>
                        <div className="userMessageBubble">
                          <MarkdownContent content={item.text} />
                        </div>
                        <div className="messageActions">
                          <button className="messageAction" type="button" onClick={() => void copyText(item.text)} title="Copy prompt">
                            <Copy size={14} />
                          </button>
                        </div>
                      </article>
                    ) : item.type === "assistant" ? (
                      (() => {
                        const rating = responseFeedback.get(item.id);
                        return (
                          <article className="timelineMessage assistantMessage" key={item.id}>
                            <MarkdownContent content={item.text} onReviewFileClick={openReviewReference} reviewFiles={reviewFiles} />
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
                          </article>
                        );
                      })()
                    ) : item.type === "reasoning" ? (
                      (() => {
                        const expanded = !item.finished || autoExpandedReasoningIds.has(item.id) || expandedReasoningIds.has(item.id);
                        return (
                          <article
                            className={`timelineReasoning ${item.finished ? "isFinished" : "isThinking"} ${
                              expanded ? "isExpanded" : ""
                            }`}
                            key={item.id}
                          >
                            <button
                              className="reasoningHeader"
                              type="button"
                              onClick={() => {
                                setAutoExpandedReasoningIds((current) => {
                                  if (!current.has(item.id)) return current;
                                  const next = new Set(current);
                                  next.delete(item.id);
                                  return next;
                                });
                                setExpandedReasoningIds((current) => {
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
                              <Brain size={13} />
                              <span>{thoughtSummary(item)}</span>
                              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                            </button>
                            <div className={`reasoningBody ${expanded ? "open" : ""}`} aria-hidden={!expanded}>
                              <pre>{item.text.trim()}</pre>
                            </div>
                          </article>
                        );
                      })()
                    ) : (
                      <article className={`timelineCommand commandCard ${item.run.status}`} key={item.id}>
                        <button
                          className="commandSummary"
                          type="button"
                          onClick={() => setExpandedCommandId((current) => (current === item.run.id ? null : item.run.id))}
                        >
                          <TerminalSquare size={15} />
                          <span className="commandStatus" />
                          <span>
                            <strong>{commandLabel(item.run.command)}</strong>
                            <em>{commandSummary(item.run)}</em>
                          </span>
                        </button>
                        {expandedCommandId === item.run.id ? (
                          <div className="commandDetails">
                            <div className="shellBlock">
                              <div className="shellHeader">
                                <span>{commandDetailLabel(item.run)}</span>
                                <span className={`shellResult ${item.run.status}`}>
                                  {item.run.status === "running" ? (
                                    <Loader2 className="spin" size={13} />
                                  ) : item.run.status === "passed" ? (
                                    <CheckCircle2 size={13} />
                                  ) : (
                                    <TriangleAlert size={13} />
                                  )}
                                  {item.run.status === "passed"
                                    ? "Success"
                                    : item.run.status === "failed"
                                      ? `Exit ${item.run.exitCode ?? "unknown"}`
                                      : "Running"}
                                </span>
                              </div>
                              <pre>
                                <code>{commandShellText(item.run)}</code>
                              </pre>
                            </div>
                          </div>
                        ) : null}
                      </article>
                    ),
                  )}
                  {reviewFiles.length &&
                  (task?.state === "review_ready" ||
                    task?.state === "approving" ||
                    task?.state === "merged" ||
                    task?.state === "rejected") ? (
                    <ReviewSummaryCard
                      diffs={reviewDiffs}
                      expandedPaths={expandedReviewPaths}
                      files={reviewFiles}
                      onOpenReview={() => openReviewPanel()}
                      onToggleFile={toggleReviewFile}
                      totals={reviewTotals}
                    />
                  ) : null}
                  {task?.state === "running" ? <span className="streamCaret" /> : null}
                </div>
              ) : (
                <ComposerGreeting label={todayPromptLabel} />
              )}
            </div>
          </section>
        </section>

        {task?.state === "awaiting_worktree_approval" ? (
          <section className="floatingApproval">
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
          <section className="floatingApproval">
            <div>
              <strong>{pendingPermission.kind} permission</strong>
              <span>{pendingPermission.command}</span>
            </div>
            <button className="secondaryAction" type="button" onClick={() => resolvePermission("deny")}>
              <X size={15} />
              Deny
            </button>
            <button className="primaryAction" type="button" onClick={() => resolvePermission("allow")}>
              <ShieldCheck size={15} />
              Allow
            </button>
          </section>
        ) : null}

        <section className="promptDock">
          <div className="promptControls">
            <div className={`workspaceCluster ${repository?.kind === "git" ? "hasBranch" : ""}`}>
              <button className="workspaceControl" type="button" onClick={pickRepository} disabled={busy}>
                <span className="controlIcon">{repository?.kind === "git" ? <GitBranch size={14} /> : <FolderOpen size={14} />}</span>
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

            <div className={`permissionControl ${permissionMode === "bypass" ? "isBypass" : ""}`}>
              <button
                className="permissionTrigger"
                type="button"
                onClick={() => setPermissionMenuOpen((open) => !open)}
                aria-expanded={permissionMenuOpen}
                aria-haspopup="menu"
                title={permissionMode === "bypass" ? "Bypass mode" : "Normal mode"}
              >
                {permissionMode === "bypass" ? (
                  <ShieldAlert className="bypassIcon" size={14} />
                ) : (
                  <Hand size={14} />
                )}
                <span className="permissionLabel">{permissionMode === "bypass" ? "Bypass" : "Normal"}</span>
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
                    <span>Normal</span>
                  </button>
                  <button
                    className={permissionMode === "bypass" ? "active" : ""}
                    type="button"
                    onClick={() => {
                      setPermissionMenuOpen(false);
                      void updatePermissionMode("bypass");
                    }}
                  >
                    <ShieldAlert className="bypassIcon" size={14} />
                    <span>Bypass</span>
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
            </div>
          </div>
          {closedChatNotice ? (
            <div className="closedChatNotice">
              <CheckCircle2 size={15} />
              <span>{closedChatNotice}</span>
            </div>
          ) : null}
          <div className="composer">
            {attachmentMenuOpen && !closedChatNotice ? (
              <div className="attachmentMenu" ref={attachmentMenuRef}>
                <div className="attachmentMenuHeader">
                  {mention ? <AtSign size={14} /> : <Paperclip size={14} />}
                  <span>{repository ? `Attach from ${repository.name}` : "Search files after selecting a folder"}</span>
                </div>
                {repository ? (
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
                  {renderPromptHighlights(prompt, attachedFiles)}
                </div>
              </div>
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={handlePromptChange}
                onKeyDown={handlePromptKeyDown}
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
            <button className="sendButton" type="button" onClick={startTask} disabled={!canStart}>
              {busy ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
            </button>
          </div>
        </section>
      </main>

      <aside className="reviewSidebar">
        <div className="reviewResizeHandle" role="separator" aria-orientation="vertical" onPointerDown={beginReviewResize} />
        <section className="panel reviewPanel">
          <div className="reviewTopbar">
            <span className="reviewChangeSummary">
              <FileText size={15} />
              <strong>Review</strong>
              {reviewFiles.length ? (
                <span className="reviewStats">
                  <span>{reviewFiles.length} file{reviewFiles.length === 1 ? "" : "s"}</span>
                  <span className="additions">+{reviewTotals.additions}</span>
                  <span className="deletions">-{reviewTotals.deletions}</span>
                </span>
              ) : null}
            </span>
            <div className="reviewTopActions">
              <button className="reviewTextButton" type="button" onClick={undoTask} disabled={!canUndo} title="Undo this chat's changes">
                <span>Undo</span>
                <Undo2 size={13} />
              </button>
              <div className={`idePicker ${canOpenIde ? "" : "isDisabled"}`}>
                <button
                  className="idePickerOpen"
                  type="button"
                  onClick={() => openIde(selectedIde.id)}
                  disabled={!canOpenIde}
                  title={canOpenIde ? `Open in ${selectedIde.label}` : "No review folder yet"}
                >
                  <IdeIcon icon={selectedIde.icon} />
                </button>
                <button
                  className="idePickerToggle"
                  type="button"
                  onClick={() => setIdeMenuOpen((open) => !open)}
                  disabled={!canOpenIde}
                  aria-expanded={ideMenuOpen && canOpenIde}
                  aria-haspopup="menu"
                  title={canOpenIde ? "Choose editor" : "No review folder yet"}
                >
                  <ChevronDown size={13} />
                </button>
                {ideMenuOpen && canOpenIde ? (
                  <div className="ideMenu" role="menu">
                    {availableIdes.map((ide) => (
                      <button
                        className={ide.id === selectedIde.id ? "active" : ""}
                        key={ide.id}
                        type="button"
                        onClick={() => {
                          setSelectedIdeId(ide.id);
                          setIdeMenuOpen(false);
                        }}
                      >
                        <IdeIcon icon={ide.icon} />
                        <span>{ide.label}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {reviewFiles.length ? (
            <div className="diffWorkspace">
              <div className="changedFiles">
                {reviewFiles.map((file) => {
                  const stats = reviewDiffs.get(file.path) ?? emptyParsedDiff;
                  const expanded = expandedReviewPaths.has(file.path);
                  return (
                    <article className={`reviewFile ${expanded ? "expanded" : ""}`} key={file.path}>
                      <div className={`reviewFileHeader ${expanded ? "active" : ""}`}>
                        <button
                          className="reviewFileToggle"
                          type="button"
                          onClick={() => toggleReviewFile(file.path)}
                          aria-expanded={expanded}
                        >
                          <span className="changedFilePath">{file.path}</span>
                          <span className="changeStats" aria-label={formatDiffStats(stats)}>
                            <span className="additions">+{stats.additions}</span>
                            <span className="deletions">-{stats.deletions}</span>
                          </span>
                        </button>
                        <button
                          className="openReviewFileButton"
                          type="button"
                          onClick={() => openReviewFile(file.path)}
                          disabled={!canOpenIde || file.status === "deleted"}
                          title={
                            file.status === "deleted"
                              ? "Deleted files cannot be opened"
                              : `Open ${file.path} in ${selectedIde.label}`
                          }
                        >
                          <ExternalLink size={14} />
                        </button>
                        <button
                          className="reviewFileChevronButton"
                          type="button"
                          onClick={() => toggleReviewFile(file.path)}
                          aria-expanded={expanded}
                          title={expanded ? "Collapse diff" : "Expand diff"}
                        >
                          <ChevronDown className="reviewFileChevron" size={15} />
                        </button>
                      </div>
                      {expanded ? (
                        <div className="reviewFileDiff">
                          <div className="diffRows">
                            {stats.rows.length ? (
                              stats.rows.map((row, index) => (
                                <div className={`diffRow ${row.kind}`} key={`${index}-${row.oldLine ?? ""}-${row.newLine ?? ""}`}>
                                  <span className="diffLineNumber">{row.oldLine ?? ""}</span>
                                  <span className="diffLineNumber">{row.newLine ?? ""}</span>
                                  <span className="diffMarker">{row.marker}</span>
                                  <code>{row.content || " "}</code>
                                </div>
                              ))
                            ) : (
                              <Empty label="No text diff available" />
                            )}
                          </div>
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </div>
          ) : (
            <Empty label={reviewEmptyLabel} />
          )}

          {task?.state === "review_ready" || task?.state === "approving" || task?.state === "merged" ? (
            <div className="reviewFooter">
              <div className="approvalActions">
                <button className="primaryAction" type="button" disabled={!canApprove} onClick={approveMerge}>
                  <GitBranch size={15} />
                  Accept + merge
                </button>
              </div>
            </div>
          ) : null}

          {approvalChecks.length ? (
            <div className="checkList">
              {approvalChecks.map((check) => (
                <div className={`checkRow ${check.status}`} key={check.name}>
                  <ApprovalIcon status={check.status} />
                  <span>
                    <strong>{check.name}</strong>
                    {check.detail ? <em>{check.detail}</em> : null}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          </section>
      </aside>

      {settingsOpen ? (
        <div className="modalScrim" role="presentation">
          <section className="settingsDialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <header className="settingsDialogHeader">
              <span>
                <Settings size={17} />
                <strong id="settings-title">Settings</strong>
              </span>
              <button className="chromeButton" type="button" onClick={() => setSettingsOpen(false)} title="Close settings">
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
                  <span>Account</span>
                </button>
                <button
                  type="button"
                  className={`settingsNavItem ${settingsTab === "tools" ? "isActive" : ""}`}
                  onClick={() => setSettingsTab("tools")}
                >
                  <TerminalSquare size={15} />
                  <span>Tools</span>
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
                    <div className="settingsPanelHead">
                      <h3>Account</h3>
                      <p>Sign in to sync settings across devices. Aegis runs locally either way.</p>
                    </div>

                    <div className="accountCard">
                      <div className="accountAvatar" aria-hidden="true">
                        <User size={22} />
                      </div>
                      <div className="accountIdentity">
                        <strong>Local developer</strong>
                        <em>Not signed in</em>
                      </div>
                    </div>

                    <div className="settingsGroup">
                      <h4>Sign in with</h4>
                      <button className="ssoButton" type="button" onClick={() => setAccountMessage("SSO is coming soon. Aegis will keep working in local mode.")}>
                        <GoogleMark />
                        <span>Continue with Google</span>
                      </button>
                      <button className="ssoButton" type="button" onClick={() => setAccountMessage("SSO is coming soon. Aegis will keep working in local mode.")}>
                        <MicrosoftMark />
                        <span>Continue with Microsoft</span>
                      </button>
                      {accountMessage ? <p className="settingsMessage">{accountMessage}</p> : null}
                    </div>
                  </div>
                ) : null}

                {settingsTab === "tools" ? (
                  <div className="settingsPanel">
                    <div className="settingsPanelHead">
                      <h3>Tools</h3>
                      <p>Capabilities the model can call during a run. Disable any tool to keep it out of new turns.</p>
                    </div>

                    <div className="settingsNotice">
                      <TriangleAlert size={14} />
                      <span>UI only for now. Toggles do not yet enforce in runs — needs to be wired into the runner.</span>
                    </div>

                    <ul className="skillList">
                      {[
                        { id: "read", name: "read", description: "Read a workspace file or list a directory." },
                        { id: "search", name: "search", description: "Search workspace file paths and small text files." },
                        { id: "edit", name: "edit", description: "Replace exact text in a workspace file. Requires permission." },
                        { id: "write", name: "write", description: "Write a workspace file. Requires permission." },
                        { id: "command", name: "command", description: "Run a local shell command after policy and permission checks." },
                      ].map((tool) => (
                        <li key={tool.id} className="skillRow">
                          <div className="skillRowText">
                            <strong className="toolName">{tool.name}</strong>
                            <em>{tool.description}</em>
                          </div>
                          <button
                            type="button"
                            className={`toggle ${toolsEnabled[tool.id] ? "isOn" : ""}`}
                            role="switch"
                            aria-checked={!!toolsEnabled[tool.id]}
                            aria-label={`Toggle ${tool.name}`}
                            onClick={() => setToolsEnabled((prev) => ({ ...prev, [tool.id]: !prev[tool.id] }))}
                          >
                            <span className="toggleKnob" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {settingsTab === "skills" ? (
                  <div className="settingsPanel">
                    <div className="settingsPanelHead">
                      <h3>Skills</h3>
                      <p>
                        Skills are global guidance Aegis includes in <strong>every chat</strong>. Use them for things like a personal style guide or rules every task should follow.
                      </p>
                    </div>

                    <div className="settingsGroup">
                      <div className="skillSectionHeader">
                        <h4>Managed</h4>
                        <span className="skillSectionTag">Company</span>
                      </div>
                      <p className="skillSectionHint">
                        Maintained by your organization and baked into the model. Always on — these can't be disabled here.
                      </p>
                      <div className="settingsEmpty">
                        <ShieldCheck size={16} />
                        <span>No managed skills yet. They'll appear here once your team publishes them from the server.</span>
                      </div>
                    </div>

                    <div className="settingsGroup">
                      <div className="skillSectionHeader">
                        <h4>Your skills</h4>
                        <div className="skillSectionActions">
                          <button className="settingsInlineButton" type="button" onClick={() => void openSkillsFolder()}>
                            <FolderOpen size={13} />
                            <span>Open folder</span>
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
                      <p className="skillSectionHint">
                        Loaded from <code className="settingsCode">{skillsDirectory}</code>. Each subfolder with a <code className="settingsCode">SKILL.md</code> becomes a skill.
                      </p>

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

                      {skillsLoading ? (
                        <div className="settingsEmpty">
                          <Loader2 className="spin" size={16} />
                          <span>Loading skills…</span>
                        </div>
                      ) : skills.length === 0 ? (
                        <div className="settingsEmpty">
                          <Sparkles size={16} />
                          <span>No skills yet. Use New skill to scaffold one, or drop a folder with a SKILL.md into the directory above.</span>
                        </div>
                      ) : (
                        <ul className="skillList">
                          {skills.map((skill) => (
                            <li key={skill.id} className="skillRow">
                              <div className="skillRowText">
                                <strong>{skill.name}</strong>
                                {skill.description ? <em>{skill.description}</em> : null}
                              </div>
                              <button
                                type="button"
                                className={`toggle ${skillsEnabled[skill.id] ? "isOn" : ""}`}
                                role="switch"
                                aria-checked={!!skillsEnabled[skill.id]}
                                aria-label={`Toggle ${skill.name}`}
                                onClick={() => setSkillsEnabled((prev) => ({ ...prev, [skill.id]: !prev[skill.id] }))}
                              >
                                <span className="toggleKnob" />
                              </button>
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
                      <p>What Aegis records on this device. Nothing leaves the machine without an explicit export.</p>
                    </div>

                    <div className="settingsList">
                      <div className="settingsListRow">
                        <span>Mode</span>
                        <strong>{backend?.diagnostics.telemetry.localEnabled ? "Local event ledger" : "Off"}</strong>
                      </div>
                      <div className="settingsListRow">
                        <span>Retention</span>
                        <strong>{backend?.diagnostics.telemetry.retentionDays ?? 30} days</strong>
                      </div>
                      <div className="settingsListRow">
                        <span>Sync</span>
                        <strong>{backend?.diagnostics.telemetry.syncEnabled ? "On" : "Off"}</strong>
                      </div>
                    </div>

                    <div className="telemetryColumns">
                      <div className="telemetryColumn">
                        <h4>Collected</h4>
                        <ul>
                          <li><Check size={13} /> Feedback (thumbs up / down)</li>
                          <li><Check size={13} /> Approval decisions</li>
                          <li><Check size={13} /> IDE opens</li>
                          <li><Check size={13} /> Command outcomes</li>
                          <li><Check size={13} /> Review changes</li>
                        </ul>
                      </div>
                      <div className="telemetryColumn">
                        <h4>Excluded</h4>
                        <ul>
                          <li><Minus size={13} /> Raw prompts</li>
                          <li><Minus size={13} /> Full diffs</li>
                          <li><Minus size={13} /> Full command output</li>
                          <li><Minus size={13} /> Source file contents</li>
                        </ul>
                      </div>
                    </div>

                    <div className="settingsActions">
                      <button className="settingsInlineButton" type="button" onClick={exportTelemetry} disabled={exportingTelemetry}>
                        {exportingTelemetry ? <Loader2 className="spin" size={13} /> : <ExternalLink size={13} />}
                        <span>Export redacted JSON</span>
                      </button>
                      {telemetryMessage ? <p className="settingsMessage">{telemetryMessage}</p> : null}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {deleteCandidate ? (
        <div className="modalScrim" role="presentation">
          <section className="bypassDialog deleteDialog" role="dialog" aria-modal="true" aria-labelledby="delete-chat-title">
            <div className="dialogIcon deleteIcon">
              <Trash2 size={18} />
            </div>
            <div>
              <h3 id="delete-chat-title">Delete chat?</h3>
              <p>This removes "{chatDisplayTitle(deleteCandidate)}" from the chat archive. Task files and folders are left alone.</p>
            </div>
            <div className="dialogActions">
              <button className="secondaryAction" type="button" onClick={() => setDeleteCandidate(null)}>
                Cancel
              </button>
              <button className="dangerAction" type="button" onClick={confirmDeleteChat}>
                <Trash2 size={14} />
                Delete chat
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {showBypassDialog ? (
        <div className="modalScrim" role="presentation">
          <section className="bypassDialog" role="dialog" aria-modal="true" aria-labelledby="bypass-title">
            <div className="dialogIcon">
              <ShieldAlert size={18} />
            </div>
            <div>
              <h3 id="bypass-title">Enable bypass mode?</h3>
              <p>
                Aegis will run task commands without pausing for each approval. Commands still run inside the selected task
                workspace and sandboxed runtime, but they can change files there.
              </p>
            </div>
            <div className="dialogActions">
              <button className="secondaryAction" type="button" onClick={() => setShowBypassDialog(false)}>
                Cancel
              </button>
              <button className="dangerAction" type="button" onClick={confirmBypassMode}>
                <TriangleAlert size={14} />
                Enable bypass
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

function GoogleMark() {
  return (
    <svg className="ssoMark" width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.49h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.63z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.32A8.99 8.99 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.96H.96A8.99 8.99 0 0 0 0 9c0 1.45.35 2.82.96 4.04l3.01-2.32z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A8.99 8.99 0 0 0 .96 4.96L3.97 7.28C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

function MicrosoftMark() {
  return (
    <svg className="ssoMark" width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <rect x="1" y="1" width="7.5" height="7.5" fill="#F25022" />
      <rect x="9.5" y="1" width="7.5" height="7.5" fill="#7FBA00" />
      <rect x="1" y="9.5" width="7.5" height="7.5" fill="#00A4EF" />
      <rect x="9.5" y="9.5" width="7.5" height="7.5" fill="#FFB900" />
    </svg>
  );
}

type RootElement = HTMLElement & {
  aegisRoot?: ReturnType<typeof createRoot>;
};

const rootElement = document.getElementById("root") as RootElement;
rootElement.aegisRoot ??= createRoot(rootElement);
rootElement.aegisRoot.render(<App />);
