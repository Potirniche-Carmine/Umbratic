import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  AtSign,
  ChevronDown,
  CheckCircle2,
  CircleDashed,
  Copy,
  ExternalLink,
  File,
  FileText,
  FolderOpen,
  GitBranch,
  Loader2,
  PanelLeft,
  PanelRight,
  Play,
  Plus,
  Send,
  Settings,
  ShieldAlert,
  ShieldCheck,
  TerminalSquare,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";

type ServiceStatus = "ready" | "degraded" | "unavailable";
type PermissionMode = "normal" | "bypass";
type WorkspaceKind = "git" | "folder";
type LocalProviderId = "local-ollama" | "local-lmstudio";
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
  opencode: ServiceStatus;
  ollama: ServiceStatus;
  lmstudio: ServiceStatus;
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
  message?: string;
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
  createdAt: string;
  changedFiles: string[];
  reviewFiles: ReviewFile[];
  events: BackendUiEvent[];
  latestTest?: TestResult;
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
  cwd: string;
};

type BackendUiEvent =
  | { type: "user.message"; taskId: string; text: string }
  | { type: "assistant.delta"; taskId: string; text: string }
  | { type: "assistant.done"; taskId: string }
  | { type: "worktree.requested"; taskId: string; branch: string; path: string; baseCommit: string }
  | { type: "worktree.created"; taskId: string; branch: string; path: string }
  | { type: "command.started"; taskId: string; id: string; command: string; cwd: string }
  | { type: "command.output"; taskId: string; id: string; stream: "stdout" | "stderr"; text: string }
  | { type: "command.finished"; taskId: string; id: string; exitCode: number | null }
  | { type: "permission.requested"; taskId: string; request: PermissionRequest }
  | { type: "permission.resolved"; taskId: string; id: string; decision: "allow" | "deny" }
  | { type: "review.ready"; taskId: string; changedFiles: string[]; reviewFiles: ReviewFile[]; latestTest?: TestResult }
  | { type: "approval.check"; taskId: string; name: string; status: "running" | "passed" | "failed"; detail?: string }
  | { type: "merge.completed"; taskId: string; targetBranch: string; commit: string; patchHash: string }
  | { type: "task.error"; taskId: string; message: string };

type ApprovalCheck = {
  name: string;
  status: "running" | "passed" | "failed";
  detail?: string;
};

type CommandRun = {
  id: string;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  status: "running" | "passed" | "failed";
};

type ComposerTimelineItem =
  | { type: "user"; id: string; text: string }
  | { type: "assistant"; id: string; text: string }
  | { type: "command"; id: string; run: CommandRun };

type DesktopApi = {
  listChats(): Promise<ChatRecord[]>;
  createChat(input?: { title?: string; repositoryName?: string; repositoryPath?: string }): Promise<ChatRecord>;
  updateChatDraft(input: { chatId: string; draftPrompt: string; attachedFiles: ChatAttachment[] }): Promise<ChatRecord>;
  deleteChat(input: { chatId: string }): Promise<{ ok: true }>;
  getTask(input: { taskId: string }): Promise<TaskInfo | null>;
  refreshTaskReview(input: { taskId: string }): Promise<TaskInfo | null>;
  searchFiles(input: { repositoryId: string; query: string; limit?: number }): Promise<FileSearchResult[]>;
  pickRepository(): Promise<{ canceled: true } | { canceled: false; repository: RepositoryInfo }>;
  getRepository(input: { repositoryId?: string; repositoryPath?: string }): Promise<RepositoryInfo | null>;
  getBackendStatus(): Promise<BackendStatus>;
  setPermissionMode(mode: PermissionMode): Promise<BackendStatus>;
  setSelectedModel(input: { providerId: string; modelId: string }): Promise<BackendStatus>;
  listAvailableIdes(): Promise<IdeChoice[]>;
  startTask(input: { repositoryId: string; prompt: string; chatId?: string; attachedFiles?: ChatAttachment[] }): Promise<TaskInfo>;
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
  return { path: file.path, name: file.name || file.path.split(/[\\/]/).pop() || file.path };
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
  getBackendStatus: async () => ({
    opencode: "unavailable",
    ollama: "unavailable",
    lmstudio: "unavailable",
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
    message: "Electron preload is not available in this browser preview.",
  }),
  setPermissionMode: async (mode) => {
    previewPermissionMode = mode;
    return fallbackApi.getBackendStatus();
  },
  setSelectedModel: async () => fallbackApi.getBackendStatus(),
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

function eventSignature(event: BackendUiEvent): string {
  return JSON.stringify(event);
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
  return merged.slice(-300);
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
  return chat.updatedAt ? new Date(chat.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
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

function renderPlainInlineText(text: string, keyPrefix: string): React.ReactNode[] {
  return text.split(/(@[A-Za-z0-9][A-Za-z0-9._/-]*)/g).map((part, index) =>
    part.startsWith("@") ? (
      <span className="inlineMentionToken" key={`${keyPrefix}-mention-${index}`}>
        {part}
      </span>
    ) : (
      <React.Fragment key={`${keyPrefix}-text-${index}`}>{part}</React.Fragment>
    ),
  );
}

function eventTitle(event: BackendUiEvent): string {
  switch (event.type) {
    case "user.message":
      return "user";
    case "assistant.delta":
      return "assistant";
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
    case "approval.check":
      return `check ${event.status}`;
    case "merge.completed":
      return "approved";
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
    case "assistant.done":
      return "stream complete";
    case "worktree.requested":
      return `${event.branch} at ${event.path}`;
    case "worktree.created":
      return `${event.branch} at ${event.path}`;
    case "command.started":
      return `${event.command} - ${event.cwd}`;
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
    case "approval.check":
      return event.detail ?? event.name;
    case "merge.completed":
      return `${event.targetBranch} ${shortHash(event.commit)}`;
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

function statusLetter(status: ReviewFile["status"]): string {
  if (status === "added") return "A";
  if (status === "deleted") return "D";
  return "M";
}

function displayReviewStatus(file: ReviewFile): ReviewFile["status"] {
  if (file.status !== "modified") return file.status;
  if (/^(new file mode|--- \/dev\/null)/m.test(file.diff)) return "added";
  if (/^(deleted file mode|\+\+\+ \/dev\/null)/m.test(file.diff)) return "deleted";
  return file.status;
}

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
  const lower = command.toLowerCase();
  if (lower.startsWith("write ")) return `Wrote ${command.replace(/^write\s+/i, "")}`;
  return `Ran ${command}`;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function commandSummary(run: CommandRun): string {
  if (run.status === "running") return "running";
  if (run.status === "failed") return `failed${run.exitCode === null ? "" : `, exit ${run.exitCode}`}`;
  const output = stripAnsi(run.stdout || run.stderr).trim();
  return output ? output.split(/\r?\n/).filter(Boolean).slice(-1)[0] : `exit ${run.exitCode ?? 0}`;
}

function commandShellText(run: CommandRun): string {
  const parts = [`$ ${run.command}`];
  const output = stripAnsi([run.stdout, run.stderr].filter(Boolean).join("\n")).trimEnd();
  if (output) parts.push(output);
  return parts.join("\n\n");
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
      runs.set(event.id, {
        id: event.id,
        command: event.command,
        cwd: event.cwd,
        stdout: "",
        stderr: "",
        exitCode: null,
        status: "running",
      });
      continue;
    }
    if (event.type === "command.output") {
      const run = runs.get(event.id);
      if (!run) continue;
      if (event.stream === "stdout") {
        run.stdout = `${run.stdout}${event.text}`;
      } else {
        run.stderr = `${run.stderr}${event.text}`;
      }
      continue;
    }
    if (event.type === "command.finished") {
      const run = runs.get(event.id);
      if (!run) continue;
      run.exitCode = event.exitCode;
      run.status = event.exitCode === 0 ? "passed" : "failed";
    }
  }
  return Array.from(runs.values());
}

function composerTimelineFromEvents(events: BackendUiEvent[], taskPrompt?: string): ComposerTimelineItem[] {
  const runs = new Map<string, CommandRun>();
  const items: ComposerTimelineItem[] = [];
  let assistantBuffer = "";
  let assistantIndex = 0;
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

  for (const event of events) {
    if (event.type === "user.message") {
      flushAssistant();
      items.push({ type: "user", id: `user-${items.length}-${event.text.length}`, text: event.text });
      continue;
    }
    if (event.type === "assistant.delta") {
      assistantBuffer = `${assistantBuffer}${event.text}`;
      continue;
    }
    if (event.type === "assistant.done") {
      flushAssistant();
      continue;
    }
    if (event.type === "command.started") {
      flushAssistant();
      const run: CommandRun = {
        id: event.id,
        command: event.command,
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
      const run = runs.get(event.id);
      if (!run) continue;
      if (event.stream === "stdout") {
        run.stdout = `${run.stdout}${event.text}`;
      } else {
        run.stderr = `${run.stderr}${event.text}`;
      }
      continue;
    }
    if (event.type === "command.finished") {
      const run = runs.get(event.id);
      if (!run) continue;
      run.exitCode = event.exitCode;
      run.status = event.exitCode === 0 ? "passed" : "failed";
    }
  }
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

function renderInlineMarkdown(text: string): React.ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return <React.Fragment key={index}>{renderPlainInlineText(part, `inline-${index}`)}</React.Fragment>;
  });
}

function MarkdownContent({ content }: { content: string }) {
  const blocks = useMemo(() => parseMarkdown(content), [content]);
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
          if (block.level === 1) return <h3 key={index}>{renderInlineMarkdown(block.text)}</h3>;
          if (block.level === 2) return <h4 key={index}>{renderInlineMarkdown(block.text)}</h4>;
          return <h5 key={index}>{renderInlineMarkdown(block.text)}</h5>;
        }
        if (block.type === "list") {
          return (
            <ul key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
              ))}
            </ul>
          );
        }
        return <p key={index}>{renderInlineMarkdown(block.text)}</p>;
      })}
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function App() {
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  const [repository, setRepository] = useState<RepositoryInfo | null>(null);
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>("normal");
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
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [ideMenuOpen, setIdeMenuOpen] = useState(false);
  const [availableIdes, setAvailableIdes] = useState<IdeChoice[]>(defaultIdeChoices);
  const [selectedIdeId, setSelectedIdeId] = useState(defaultIdeChoices[0].id);
  const [sidebarWidth, setSidebarWidth] = useState(276);
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
  const canStart = !!repository && !!selectedModel && prompt.trim().length > 0 && !busy;
  const canApprove = task?.state === "review_ready" && reviewFiles.length > 0 && !busy;
  const canUndo = !!task && task.state !== "merged" && task.state !== "rejected" && task.state !== "completed" && !busy;
  const canOpenIde = !!task && task.state !== "merged" && task.state !== "rejected" && task.state !== "completed";
  const reviewEmptyLabel = !task
    ? "No active review"
    : task.state === "review_ready"
      ? "No file changes found"
      : stateLabel(task.state);
  const attachmentMenuOpen = !!mention;
  const composerItems = useMemo(() => composerTimelineFromEvents(events, task?.prompt), [events, task?.prompt]);
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

  useEffect(() => {
    void refreshStatus();
    void loadAvailableIdes();
    void loadChats();
    return api.onBackendEvent((rawEvent) => {
      const event = asBackendEvent(rawEvent);
      if (!event) return;
      setEvents((current) => [...current, event].slice(-300));
      if (event.type === "assistant.delta") setAssistantText((current) => `${current}${event.text}`);
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
        setReviewOpen(true);
        window.setTimeout(() => {
          void refreshTaskReviewById(event.taskId, true);
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
    if (!mention || !repository) {
      setFileMatches([]);
      setSelectedFileIndex(0);
      return undefined;
    }
    let canceled = false;
    const timer = window.setTimeout(async () => {
      try {
        const matches = await api.searchFiles({ repositoryId: repository.id, query: mention.query, limit: 10 });
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
  }, [mention?.query, repository?.id]);

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
        setReviewOpen(true);
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
      if (!result.canceled) setRepository(result.repository);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setBusy(false);
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

  async function selectModel(model: LocalModelInfo) {
    setError(null);
    setModelMenuOpen(false);
    try {
      const status = await api.setSelectedModel({ providerId: model.providerId, modelId: model.modelId });
      setBackend(status);
      setPermissionModeState(status.permissionMode);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function startTask() {
    if (!repository) return;
    if (!selectedModel) {
      setError("Start LM Studio or Ollama with at least one loaded model.");
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
        repositoryId: repository.id,
        prompt: trimmedPrompt,
        chatId,
        attachedFiles: attachedFiles.map(normalizeAttachment),
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

  function copyText(value: string) {
    const write = navigator.clipboard?.writeText(value);
    if (write) void write.catch(() => undefined);
  }

  async function openIde(ideId: string) {
    if (!canOpenIde || !task) return;
    setIdeMenuOpen(false);
    const result = await api.openTaskInIde({ taskId: task.id, ideId });
    if (!result.ok) setError(result.message);
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

  function addAttachment(file: ChatAttachment) {
    const normalized = normalizeAttachment(file);
    setAttachedFiles((current) =>
      current.some((attached) => attached.path === normalized.path) ? current : [...current, normalized].slice(0, 16),
    );
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
    }
  }

  function handlePromptKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mention) {
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
      const chat = await api.createChat(chatInputForCurrentProject("New chat"));
      mergeChat(chat);
      suppressDraftSaveBriefly();
      setActiveChatId(chat.id);
      setTask(null);
      setEvents([]);
      setAssistantText("");
      setApprovalChecks([]);
      setExpandedCommandId(null);
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
      setEvents(nextTask?.events ?? []);
      const draftPrompt = chat.draftPrompt ?? "";
      const sentDraft = nextTask ? draftMatchesTaskPrompt(draftPrompt, nextTask.prompt) : false;
      setPrompt(sentDraft ? "" : draftPrompt);
      setAttachedFiles(!draftPrompt || sentDraft ? [] : (chat.attachedFiles ?? []));
      if (sentDraft) void persistDraft(chat.id, "", []);
      setExpandedReviewPaths(new Set());
      if (nextTask?.reviewFiles.length) setReviewOpen(true);
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
    document.body.classList.add("isResizing");
    const move = (moveEvent: PointerEvent) => {
      setSidebarWidth(clamp(startWidth + moveEvent.clientX - startX, 220, 430));
    };
    const stop = () => {
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
    let closedByDrag = false;
    document.body.classList.add("isResizing");
    const finish = () => {
      document.body.classList.remove("isResizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    const move = (moveEvent: PointerEvent) => {
      if (closedByDrag) return;
      const nextWidth = startWidth - (moveEvent.clientX - startX);
      if (nextWidth < 150) {
        closedByDrag = true;
        setReviewOpen(false);
        finish();
        return;
      }
      setReviewWidth(clamp(nextWidth, 365, 780));
    };
    const stop = () => {
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
          onClick={() => setSidebarOpen((open) => !open)}
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
        <div className="topbarTitle">
          <ShieldCheck size={15} />
          <span>Aegis</span>
        </div>
        <div className="topbarContext">
          {repository ? (
            <>
              {repository.kind === "git" ? <GitBranch size={13} /> : <FolderOpen size={13} />}
              <span>{repository.name}</span>
            </>
          ) : null}
        </div>
        <div className="topbarSpacer" />
        <button
          className={`chromeButton ${reviewOpen ? "isActive" : ""}`}
          type="button"
          onClick={() => setReviewOpen((open) => !open)}
          aria-pressed={reviewOpen}
          title="Toggle review"
        >
          <PanelRight size={15} />
        </button>
      </header>

      <aside className="sidebar">
        <div className="sidebarResizeHandle" role="separator" aria-orientation="vertical" onPointerDown={beginSidebarResize} />
        <div className="sidebarStack">
          <button className="newChatButton" type="button" onClick={newChat}>
            <Plus size={16} />
            <span>New chat</span>
          </button>

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
                          {group.path ? <em>{group.path}</em> : <em>Drafts without a folder</em>}
                        </span>
                      </button>
                      {!collapsed ? (
                        <div className="chatProjectChats">
                          {group.chats.map((chat) => (
                            <div
                              className={`chatRow ${activeChatId === chat.id ? "active" : ""}`}
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

        <button className="settingsPlaceholder" type="button">
          <Settings size={16} />
          <span>Settings</span>
          <em>soon</em>
        </button>
      </aside>

      <main className="workspace">
        {task?.state === "awaiting_worktree_approval" ? (
          <section className="actionBand warn">
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
        ) : null}

        <section className="workArea">
          <section className="composerPanel">
            <div className="composerBody" ref={streamRef}>
              {composerItems.length ? (
                <div className="timeline">
                  {composerItems.map((item) =>
                    item.type === "user" ? (
                      <article className="timelineMessage userMessage" key={item.id}>
                        <MarkdownContent content={item.text} />
                        <div className="messageActions">
                          <button className="messageAction" type="button" onClick={() => copyText(item.text)} title="Copy prompt">
                            <Copy size={14} />
                          </button>
                        </div>
                      </article>
                    ) : item.type === "assistant" ? (
                      <article className="timelineMessage assistantMessage" key={item.id}>
                        <MarkdownContent content={item.text} />
                        <div className="messageActions">
                          <button className="messageAction" type="button" onClick={() => copyText(item.text)} title="Copy response">
                            <Copy size={14} />
                          </button>
                          <button className="messageAction" type="button" title="Good response">
                            <ThumbsUp size={14} />
                          </button>
                          <button className="messageAction" type="button" title="Bad response">
                            <ThumbsDown size={14} />
                          </button>
                        </div>
                      </article>
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
                                <span>Shell</span>
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
                  {task?.state === "running" ? <span className="streamCaret" /> : null}
                </div>
              ) : (
                <Empty label="Waiting for task output" />
              )}
            </div>
          </section>
        </section>

        {pendingPermission ? (
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
            <button className="workspaceControl" type="button" onClick={pickRepository} disabled={busy}>
              <span className="controlIcon">{repository?.kind === "git" ? <GitBranch size={16} /> : <FolderOpen size={16} />}</span>
              <span>
                <strong>{repository ? repository.name : "Select folder"}</strong>
                <em>{repository ? repository.rootPath : "Choose where the task runs"}</em>
              </span>
            </button>

            <div className="permissionControl">
              <button
                className={permissionMode === "normal" ? "active" : ""}
                type="button"
                onClick={() => updatePermissionMode("normal")}
              >
                Normal
              </button>
              <button
                className={permissionMode === "bypass" ? "active dangerActive" : ""}
                type="button"
                onClick={() => updatePermissionMode("bypass")}
              >
                <ShieldAlert className="bypassIcon" size={14} />
                Bypass
              </button>
            </div>

            <div className="modelMenuHost">
              <button className="modelMenuButton" type="button" onClick={() => setModelMenuOpen((open) => !open)}>
                <span>
                  <strong>{selectedModel?.modelId ?? "No local model"}</strong>
                  <em>{selectedModel ? selectedModel.providerName : "LM Studio / Ollama"}</em>
                </span>
                <ChevronDown size={15} />
              </button>
              {modelMenuOpen ? (
                <div className="modelMenu" role="menu">
                  {backend?.models.length ? (
                    backend.models.map((model) => {
                      const active = selectedModel?.providerId === model.providerId && selectedModel.modelId === model.modelId;
                      return (
                        <button key={`${model.providerId}:${model.modelId}`} type="button" onClick={() => selectModel(model)}>
                          {active ? <CheckCircle2 size={15} /> : <CircleDashed size={15} />}
                          <span>
                            <strong>{model.modelId}</strong>
                            <em>{model.providerName}</em>
                          </span>
                        </button>
                      );
                    })
                  ) : (
                    <div className="modelMenuEmpty">No LM Studio or Ollama models found</div>
                  )}
                </div>
              ) : null}
            </div>
          </div>
          <div className="composer">
            {attachmentMenuOpen ? (
              <div className="attachmentMenu" ref={attachmentMenuRef}>
                <div className="attachmentMenuHeader">
                  <AtSign size={14} />
                  <span>{repository ? `Search ${repository.name}` : "Select a folder first"}</span>
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
                disabled={busy}
                placeholder="Ask Aegis to change something... Use @ to attach files."
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
                  const displayStatus = displayReviewStatus(file);
                  const expanded = expandedReviewPaths.has(file.path);
                  return (
                    <article className={`reviewFile ${expanded ? "expanded" : ""}`} key={file.path}>
                      <div className={`reviewFileHeader ${expanded ? "active" : ""}`}>
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
                          className="reviewFileToggle"
                          type="button"
                          onClick={() => toggleReviewFile(file.path)}
                          aria-expanded={expanded}
                        >
                          <span className={`fileBadge ${displayStatus}`}>{statusLetter(displayStatus)}</span>
                          <span className="changedFilePath">{file.path}</span>
                          <span className="changeStats" aria-label={formatDiffStats(stats)}>
                            <span className="additions">+{stats.additions}</span>
                            <span className="deletions">-{stats.deletions}</span>
                          </span>
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

type RootElement = HTMLElement & {
  aegisRoot?: ReturnType<typeof createRoot>;
};

const rootElement = document.getElementById("root") as RootElement;
rootElement.aegisRoot ??= createRoot(rootElement);
rootElement.aegisRoot.render(<App />);
