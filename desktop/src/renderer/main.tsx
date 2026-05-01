import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Database,
  FileText,
  FolderOpen,
  GitBranch,
  GitFork,
  MessageSquare,
  Paperclip,
  PanelLeft,
  Plus,
  RefreshCw,
  Send,
  Terminal,
  Trash2,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";
import "./styles.css";

type ServiceStatus = "ready" | "degraded" | "unavailable";
type SocketState = "idle" | "connecting" | "open" | "closed";
type RailView = "chats" | "git" | "tools" | "data";
type MainTab = "chat" | "diff" | "terminal";
type PermissionMode = "default" | "bypass";

type DaemonHealth = {
  daemon: ServiceStatus;
  sqlite_path: string;
  lm_studio: ServiceStatus;
  model_base_url: string;
  semantic_index: ServiceStatus;
};

type RpcResponse<T> = {
  id: string;
  result?: T;
  error?: { message: string };
};

type ServerEvent =
  | {
      type: "status";
      daemon: ServiceStatus;
      sqlite_path: string;
      lm_studio: ServiceStatus;
      model_base_url: string;
      semantic_index: ServiceStatus;
    }
  | { type: "trace"; at: string; level: string; message: string; data?: unknown }
  | { type: "agent_stream"; turn_id: string; kind: string; content?: string; data?: unknown };

type ChatLine = {
  role: "user" | "assistant" | "tool" | "thinking";
  content: string;
  toolName?: string;
  status?: ServiceStatus;
  detail?: string;
  streaming?: boolean;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
};

type ProjectSummary = {
  id: string;
  name: string;
  root_path: string;
  preferred_ide?: string | null;
  created_at: string;
  last_opened_at?: string | null;
};

type SessionSummary = {
  id: string;
  project_id: string;
  title?: string | null;
  model_id?: string | null;
  started_at: string;
  finished_at?: string | null;
  status: string;
  user_message?: string | null;
};

type StoreOverview = {
  sqlite_path: string;
  projects: number;
  sessions: number;
  turns: number;
  tool_calls: number;
  proposals: number;
  index_chunks: number;
};

type GitResult = {
  stdout: string;
  stderr: string;
  success: boolean;
};

type GitBranchInfo = {
  current?: string | null;
  branches: string[];
};

type GitWorktreeInfo = {
  path: string;
  branch?: string | null;
  commit?: string | null;
};

type SearchMatch = {
  path: string;
  line: number;
  snippet: string;
};

type ProjectFileEntry = {
  path: string;
  name: string;
  directory: string;
  kind?: "file" | "directory" | string;
};

type AttachedFile = {
  path: string;
  name: string;
  projectPath?: string;
  content?: string;
};

type IdeInstall = {
  id: "code" | "devenv" | "clion" | "explorer" | string;
  label: string;
  command: string;
};

type SendTaskResult = {
  session_id: string;
  turn_id: string;
  assistant_message: string;
};

type ContextUsageResult = {
  prompt_tokens: number;
  max_context_tokens?: number | null;
  message_count: number;
  source: string;
};

type ContextUsageState = {
  promptTokens: number;
  maxContextTokens?: number | null;
  messageCount: number;
  percent: number;
  status: "loading" | "ready" | "unavailable";
  detail: string;
};

type TimelineRow = {
  id: string;
  name: string;
  status: ServiceStatus;
  detail: string;
  at: string;
};

type ToolApprovalRequest = {
  id: string;
  toolName: string;
  actionKey: string;
  command: string;
  summary: string;
  requestedAt: string;
};

type ToolApprovalEvent = {
  id: string;
  toolName: string;
  actionKey: string;
  command: string;
  decision: "accepted" | "declined";
  quality: "Good" | "Bad";
  at: string;
};

type LocalChat = {
  id: string;
  title: string;
  createdAt: string;
  messages: ChatLine[];
  timeline: TimelineRow[];
  sessionId?: string;
  branch?: string;
  worktreePath?: string;
  worktreeEnabled: boolean;
  diffAvailable?: boolean;
  changedFileCount?: number;
  changedLineStats?: DiffLineStats;
  pendingApproval?: ToolApprovalRequest;
  approvedToolActions: string[];
  approvalEvents: ToolApprovalEvent[];
};

type DiffLineStats = {
  added: number;
  removed: number;
};

type PersistedWorkspace = {
  chats: LocalChat[];
  activeChatId: string;
  selectedProjectId?: string | null;
  selectedModel?: string;
  selectedIdeId?: string;
  permissionMode?: PermissionMode;
};

const CHAT_STORAGE_KEY = "aegis.workspace.v2";

type AgentTool = {
  id: string;
  label: string;
  summary: string;
  command: string;
  kind: "read" | "search" | "write" | "git" | "context";
  enabled: boolean;
};

type AgentToolContext = {
  id: string;
  label: string;
  summary: string;
  command: string;
  enabled: boolean;
};

type RequestedToolCall = {
  tool: string;
  args: Record<string, unknown>;
};

type DesktopConnection =
  | { status: "ready"; url: string; token: string }
  | { status: "missing"; message: string }
  | { status: "error"; message: string };

type PickProjectResult =
  | { canceled: true }
  | { canceled: false; rootPath: string; name: string };

type IdeOpenResult = { ok: true } | { ok: false; message: string };

type DesktopApi = {
  getDaemonConnection(): Promise<DesktopConnection>;
  restartDaemon(): Promise<DesktopConnection>;
  pickProjectFolder(): Promise<PickProjectResult>;
  pickAttachments(projectRoot?: string): Promise<
    | { canceled: true }
    | { canceled: false; files: AttachedFile[] }
  >;
  openProjectInIde?(payload: { ideId: string; command: string; projectRoot: string }): Promise<IdeOpenResult>;
  openFileInIde?(payload: { ideId: string; command: string; projectRoot: string; file: string; line?: number | null }): Promise<IdeOpenResult>;
  startTerminal(cwd?: string): Promise<{ started: boolean; shell: string }>;
  writeTerminal(data: string): Promise<{ written: boolean }>;
  onTerminalData(callback: (data: string) => void): () => void;
  onOpenProjectRequested(callback: () => void): () => void;
  onBackToChatRequested(callback: () => void): () => void;
  onToggleSidebarRequested(callback: () => void): () => void;
};

const aegisApi: DesktopApi =
  window.aegis ??
  {
    getDaemonConnection: async () => ({
      status: "missing",
      message: "This is the browser preview. Open the Electron window from npm run desktop:dev.",
    }),
    restartDaemon: async () => ({
      status: "missing",
      message: "This is the browser preview. Open the Electron window from npm run desktop:dev.",
    }),
    pickProjectFolder: async () => ({ canceled: true }),
    pickAttachments: async () => ({ canceled: true }),
    startTerminal: async () => ({ started: false, shell: "browser preview" }),
    writeTerminal: async () => ({ written: false }),
    onTerminalData: () => () => undefined,
    onOpenProjectRequested: () => () => undefined,
    onBackToChatRequested: () => () => undefined,
    onToggleSidebarRequested: () => () => undefined,
  };

function newLocalChat(branch?: string): LocalChat {
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    createdAt: new Date().toISOString(),
    messages: [],
    timeline: [],
    branch,
    worktreeEnabled: false,
    approvedToolActions: [],
    approvalEvents: [],
  };
}

function sanitizeChatLine(line: Partial<ChatLine>): ChatLine | null {
  const role = line.role;
  if (!role || !["user", "assistant", "tool", "thinking"].includes(role)) {
    return null;
  }
  return {
    role,
    content: typeof line.content === "string" ? line.content : "",
    toolName: typeof line.toolName === "string" ? line.toolName : undefined,
    status: line.status,
    detail: typeof line.detail === "string" ? line.detail : undefined,
    streaming: false,
    startedAt: typeof line.startedAt === "string" ? line.startedAt : undefined,
    endedAt: typeof line.endedAt === "string" ? line.endedAt : undefined,
    durationMs: typeof line.durationMs === "number" ? line.durationMs : undefined,
  };
}

function sanitizeApprovalRequest(value: unknown): ToolApprovalRequest | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const row = value as Partial<ToolApprovalRequest>;
  if (
    typeof row.id !== "string" ||
    typeof row.toolName !== "string" ||
    typeof row.actionKey !== "string" ||
    typeof row.command !== "string"
  ) {
    return undefined;
  }
  return {
    id: row.id,
    toolName: row.toolName,
    actionKey: row.actionKey,
    command: row.command,
    summary: typeof row.summary === "string" ? row.summary : "",
    requestedAt: typeof row.requestedAt === "string" ? row.requestedAt : new Date().toISOString(),
  };
}

function sanitizeApprovalEvent(value: unknown): ToolApprovalEvent | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const row = value as Partial<ToolApprovalEvent>;
  if (
    typeof row.id !== "string" ||
    typeof row.toolName !== "string" ||
    typeof row.actionKey !== "string" ||
    typeof row.command !== "string" ||
    (row.decision !== "accepted" && row.decision !== "declined")
  ) {
    return null;
  }
  return {
    id: row.id,
    toolName: row.toolName,
    actionKey: row.actionKey,
    command: row.command,
    decision: row.decision,
    quality: row.decision === "accepted" ? "Good" : "Bad",
    at: typeof row.at === "string" ? row.at : new Date().toISOString(),
  };
}

function sanitizeChat(chat: Partial<LocalChat>): LocalChat | null {
  if (!chat.id || typeof chat.id !== "string") {
    return null;
  }
  const messages = Array.isArray(chat.messages)
    ? chat.messages.map((line) => sanitizeChatLine(line)).filter((line): line is ChatLine => !!line)
    : [];
  const timeline = Array.isArray(chat.timeline)
    ? chat.timeline
        .filter((row): row is TimelineRow =>
          !!row &&
          typeof row.id === "string" &&
          typeof row.name === "string" &&
          typeof row.detail === "string" &&
          typeof row.at === "string",
        )
        .slice(0, 40)
    : [];
  return {
    id: chat.id,
    title: typeof chat.title === "string" && chat.title.trim() ? chat.title : "New chat",
    createdAt: typeof chat.createdAt === "string" ? chat.createdAt : new Date().toISOString(),
    messages,
    timeline,
    sessionId: typeof chat.sessionId === "string" ? chat.sessionId : undefined,
    branch: typeof chat.branch === "string" ? chat.branch : undefined,
    worktreePath: typeof chat.worktreePath === "string" ? chat.worktreePath : undefined,
    worktreeEnabled: chat.worktreeEnabled === true,
    diffAvailable: chat.diffAvailable === true,
    changedFileCount: typeof chat.changedFileCount === "number" ? chat.changedFileCount : undefined,
    changedLineStats: chat.changedLineStats,
    pendingApproval: sanitizeApprovalRequest(chat.pendingApproval),
    approvedToolActions: Array.isArray(chat.approvedToolActions)
      ? chat.approvedToolActions.filter((key): key is string => typeof key === "string")
      : [],
    approvalEvents: Array.isArray(chat.approvalEvents)
      ? chat.approvalEvents.map(sanitizeApprovalEvent).filter((row): row is ToolApprovalEvent => !!row).slice(-80)
      : [],
  };
}

function loadPersistedWorkspace(): PersistedWorkspace {
  try {
    const raw = window.localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) {
      const chat = newLocalChat();
      return { chats: [chat], activeChatId: chat.id };
    }
    const parsed = JSON.parse(raw) as Partial<PersistedWorkspace>;
    const chats = Array.isArray(parsed.chats)
      ? parsed.chats.map((chat) => sanitizeChat(chat)).filter((chat): chat is LocalChat => !!chat)
      : [];
    const rows = chats.length > 0 ? chats : [newLocalChat()];
    const activeChatId = rows.some((chat) => chat.id === parsed.activeChatId) ? String(parsed.activeChatId) : rows[0].id;
    return {
      chats: rows,
      activeChatId,
      selectedProjectId: parsed.selectedProjectId ?? null,
      selectedModel: parsed.selectedModel,
      selectedIdeId: parsed.selectedIdeId,
      permissionMode: parsed.permissionMode,
    };
  } catch {
    const chat = newLocalChat();
    return { chats: [chat], activeChatId: chat.id };
  }
}

function persistWorkspace(workspace: PersistedWorkspace) {
  try {
    window.localStorage.setItem(
      CHAT_STORAGE_KEY,
      JSON.stringify({
        ...workspace,
        chats: workspace.chats.map((chat) => ({
          ...chat,
          messages: chat.messages.map((message) => ({ ...message, streaming: false })),
        })),
      }),
    );
  } catch {
    /* localStorage can be unavailable in hardened browser previews */
  }
}

const DEFAULT_AGENT_TOOLS: AgentTool[] = [
  {
    id: "project.search",
    label: "Project search",
    summary: "Search text inside the selected project directory.",
    command: 'project.search {"query":"text"}',
    kind: "search",
    enabled: true,
  },
  {
    id: "rg.search",
    label: "Ripgrep search",
    summary: "Use rg-style search when the agent asks for fast project lookup.",
    command: 'rg.search {"query":"text"}',
    kind: "search",
    enabled: true,
  },
  {
    id: "grep.search",
    label: "Grep search",
    summary: "Use grep-style search as a portable fallback.",
    command: 'grep.search {"query":"text"}',
    kind: "search",
    enabled: true,
  },
  {
    id: "file.read",
    label: "Read file",
    summary: "Read text files inside the project root.",
    command: 'file.read {"path":"relative/path"}',
    kind: "read",
    enabled: true,
  },
  {
    id: "file.write",
    label: "Write/create file",
    summary: "Create or replace text files inside the project root.",
    command: 'file.write {"path":"relative/path","content":"..."}',
    kind: "write",
    enabled: true,
  },
  {
    id: "git.status",
    label: "Git status",
    summary: "Inspect modified, staged, and untracked files.",
    command: "git.status {}",
    kind: "git",
    enabled: true,
  },
  {
    id: "git.diff",
    label: "Git diff",
    summary: "Review the current project diff.",
    command: "git.diff {}",
    kind: "git",
    enabled: true,
  },
  {
    id: "git.branches",
    label: "Git branches",
    summary: "Read local branch information.",
    command: "git.branches {}",
    kind: "git",
    enabled: true,
  },
  {
    id: "git.worktree_list",
    label: "Git worktrees",
    summary: "Inspect project worktrees.",
    command: "git.worktree_list {}",
    kind: "git",
    enabled: true,
  },
  {
    id: "terminal.run",
    label: "Run terminal command",
    summary: "Run a project-scoped command through the harness shell and stream the output.",
    command: 'terminal.run {"command":"pwd"}',
    kind: "write",
    enabled: true,
  },
  {
    id: "os.context",
    label: "Harness OS context",
    summary: "Tell the agent which operating system the harness is running on.",
    command: "operating_system",
    kind: "context",
    enabled: true,
  },
];

function detectHarnessOs(): string {
  const ua = navigator.userAgent;
  if (/Mac|iPhone|iPad/i.test(ua)) {
    return "macOS";
  }
  if (/Windows/i.test(ua)) {
    return "Windows";
  }
  return "Linux";
}

function shortToolDetail(data: unknown): string {
  if (!data || typeof data !== "object") {
    return "";
  }
  const record = data as Record<string, unknown>;
  const args = record.args;
  if (!args || typeof args !== "object") {
    return "";
  }
  const argsRecord = args as Record<string, unknown>;
  const path = argsRecord.path ?? argsRecord.file;
  const query = argsRecord.query;
  if (typeof path === "string" && path.trim()) {
    return path;
  }
  if (typeof query === "string" && query.trim()) {
    return query;
  }
  return JSON.stringify(argsRecord).slice(0, 120);
}

function looksLikeToolCall(content: string): boolean {
  return parseToolCall(content) !== null;
}

function looksLikeToolCallFragment(content: string): boolean {
  const trimmed = content.trim();
  return (
    trimmed.startsWith("{\"tool\"") ||
    trimmed.startsWith("{\n\"tool\"") ||
    trimmed.startsWith("<|tool_call>") ||
    trimmed.includes("\"args\"")
  );
}

function cleanAssistantMessage(content: string): string {
  return content
    .replace(/\n+\s*Files changed:\s*(?:none|[^\n]*)\s*\n\s*Verified:\s*[^\n]*\s*$/i, "")
    .replace(/\n+\s*Files changed:\s*none\.?\s*Verified:\s*(?:not verified|tool result returned)\.?\s*$/i, "")
    .trim();
}

function decodeMarkdownDisplayEscapes(content: string): string {
  return content
    .replace(/\\(["'])/g, "$1")
    .replace(/\\\\n/g, "\\n")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&apos;|&#39;/g, "'");
}

function normalizeCommandShorthandBlocks(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  return lines
    .map((line) => {
      const match = /^(bash|sh|shell|powershell|pwsh|cmd|bat)\s+(.+)$/.exec(line.trim());
      if (!match) {
        return line;
      }
      const language = match[1] === "shell" ? "bash" : match[1];
      return ["```" + language, match[2], "```"].join("\n");
    })
    .join("\n");
}

function toolDisplayText(toolName: string, done: boolean, success = true): string {
  if (!done) {
    return `Using ${toolName}`;
  }
  return success ? `Used ${toolName}` : `${toolName} failed`;
}

function compactLabel(input: string, maxLength = 52): string {
  const normalized = input.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function toolArgs(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") {
    return {};
  }
  const args = (data as Record<string, unknown>).args;
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

function stringArg(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function mentionTarget(value: string): string {
  const cleaned = value.replace(/^@/, "").replace(/\\/g, "/").trim();
  return compactLabel(cleaned ? `@${cleaned}` : "");
}

function commandTarget(command: string): string {
  const words = command.trim().split(/\s+/).slice(0, 2).join(" ");
  return compactLabel(words || "command", 34);
}

function toolActivityLabel(toolName: string, data: unknown, success = true): string {
  const args = toolArgs(data);
  const path = stringArg(args, ["path", "file", "project_path"]);
  const query = stringArg(args, ["query", "pattern"]);
  const command = stringArg(args, ["command"]);
  const done = (label: string) => success ? label : `${label} failed`;

  if (toolName === "file.read") {
    return done(`Reading ${mentionTarget(path) || "file"}`);
  }
  if (toolName === "file.write") {
    return done(`Writing ${mentionTarget(path) || "file"}`);
  }
  if (toolName === "project.search" || toolName === "rg.search" || toolName === "grep.search") {
    return done(`Searching ${compactLabel(query || "project", 40)}`);
  }
  if (toolName === "git.status") {
    return done("Checking git status");
  }
  if (toolName === "git.diff") {
    return done("Reading git diff");
  }
  if (toolName === "git.branches") {
    return done("Reading branches");
  }
  if (toolName === "git.worktree_list") {
    return done("Reading worktrees");
  }
  if (toolName === "terminal.run") {
    return done(`Running ${command ? commandTarget(command) : "command"}`);
  }
  if (toolName === "os.context") {
    return done("Reading system context");
  }

  const action = toolName.includes("write")
    ? "Writing"
    : toolName.includes("read")
      ? "Reading"
      : toolName.includes("search")
        ? "Searching"
        : "Using";
  const target = path ? mentionTarget(path) : query ? compactLabel(query, 40) : compactLabel(toolName, 32);
  return done(`${action} ${target}`);
}

function toolActionCommand(toolName: string, data: unknown): string {
  if (!data || typeof data !== "object") {
    return toolName;
  }
  if (toolName === "file.write") {
    const path = stringArg(toolArgs(data), ["path", "file", "project_path"]);
    return `Write ${mentionTarget(path) || "file"}`;
  }
  const record = data as Record<string, unknown>;
  if (typeof record.command === "string" && record.command.trim()) {
    return record.command.trim();
  }
  return JSON.stringify({ tool: toolName, args: toolArgs(data) });
}

function approvalRequestFromToolEvent(toolName: string, data: unknown, summary: string): ToolApprovalRequest | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const record = data as Record<string, unknown>;
  if (record.approval_required !== true || typeof record.action_key !== "string" || !record.action_key.trim()) {
    return null;
  }
  return {
    id: crypto.randomUUID(),
    toolName,
    actionKey: record.action_key,
    command: toolActionCommand(toolName, data),
    summary,
    requestedAt: new Date().toISOString(),
  };
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalizeJson(nested)]),
    );
  }
  return value;
}

function toolActionKey(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "file.write") {
    return "file.write";
  }
  return `${toolName}:${JSON.stringify(canonicalizeJson(args))}`;
}

function approvalRequestFromRawToolCall(call: RequestedToolCall): ToolApprovalRequest | null {
  if (call.tool !== "file.write" && call.tool !== "terminal.run") {
    return null;
  }
  const data = {
    tool: call.tool,
    args: call.args,
    action_key: toolActionKey(call.tool, call.args),
    approval_required: true,
    command:
      call.tool === "terminal.run" && typeof call.args.command === "string"
        ? call.args.command
        : undefined,
  };
  return approvalRequestFromToolEvent(call.tool, data, "");
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

function thinkingDuration(line: ChatLine, now = Date.now()): number | null {
  if (typeof line.durationMs === "number" && Number.isFinite(line.durationMs)) {
    return line.durationMs;
  }
  if (!line.startedAt) {
    return null;
  }
  const started = Date.parse(line.startedAt);
  if (!Number.isFinite(started)) {
    return null;
  }
  const ended = line.endedAt ? Date.parse(line.endedAt) : now;
  return Number.isFinite(ended) ? Math.max(0, ended - started) : null;
}

function finishThinkingLine(line: ChatLine, endedAtMs: number): ChatLine {
  const startedAtMs = line.startedAt ? Date.parse(line.startedAt) : endedAtMs;
  const durationMs = Number.isFinite(startedAtMs) ? Math.max(0, endedAtMs - startedAtMs) : undefined;
  return {
    ...line,
    streaming: false,
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs,
  };
}

function contextMessagesForDaemon(messages: ChatLine[]): Array<{ role: "user" | "assistant"; content: string }> {
  return messages
    .filter((message) => !message.streaming && (message.role === "user" || message.role === "assistant"))
    .map((message) => ({
      role: message.role as "user" | "assistant",
      content: message.role === "assistant" ? cleanAssistantMessage(message.content) : message.content,
    }))
    .filter((message) => message.content.trim().length > 0)
    .slice(-12);
}

function chatHistoryForDaemon(messages: ChatLine[]): Array<{ role: "user" | "assistant"; content: string }> {
  return contextMessagesForDaemon(messages);
}

function contextPercent(tokens: number, maxTokens?: number | null): number {
  if (!maxTokens || maxTokens <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round((tokens / maxTokens) * 100)));
}

type MarkdownBlock =
  | { kind: "code"; language: string; content: string }
  | { kind: "heading"; level: number; content: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "paragraph"; content: string };

function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", content: paragraph.join(" ") });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ kind: "list", ordered: list.ordered, items: list.items });
      list = null;
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = /^```([A-Za-z0-9_-]*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      blocks.push({ kind: "code", language: fence[1] ?? "", content: code.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "heading", level: heading[1].length, content: heading[2].trim() });
      continue;
    }
    const unordered = /^\s*[-*]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const isOrdered = !!ordered;
      if (!list || list.ordered !== isOrdered) {
        flushList();
        list = { ordered: isOrdered, items: [] };
      }
      list.items.push((ordered?.[1] ?? unordered?.[1] ?? "").trim());
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  return blocks;
}

function renderInlineMarkdown(text: string) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
}

function MarkdownContent({ content }: { content: string }) {
  const blocks = parseMarkdownBlocks(normalizeCommandShorthandBlocks(decodeMarkdownDisplayEscapes(content)));
  return (
    <div className="markdownBubble">
      {blocks.map((block, index) => {
        if (block.kind === "code") {
          return <CopyableCodeBlock key={index} language={block.language} content={block.content} />;
        }
        if (block.kind === "heading") {
          return block.level === 1 ? (
            <h3 key={index}>{renderInlineMarkdown(block.content)}</h3>
          ) : (
            <h4 key={index}>{renderInlineMarkdown(block.content)}</h4>
          );
        }
        if (block.kind === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
              ))}
            </List>
          );
        }
        return <p key={index}>{renderInlineMarkdown(block.content)}</p>;
      })}
    </div>
  );
}

function CopyableCodeBlock({ language, content }: { language?: string; content: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="codeBlockShell" data-language={language || undefined}>
      <div className="codeBlockHeader">
        <span>{language || "code"}</span>
        <button type="button" onClick={copy} title="Copy code">
          <Copy size={12} />
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre>
        <code>{content}</code>
      </pre>
    </div>
  );
}

function renderMessageContent(content: string, role: ChatLine["role"]) {
  if (role !== "user") {
    return content;
  }
  const parts = content.split(/(@[A-Za-z0-9_.\-\\/]+)/g);
  return parts.map((part, index) =>
    part.startsWith("@") ? (
      <span className="inlineMention" key={`${part}-${index}`}>
        {part}
      </span>
    ) : (
      <React.Fragment key={`${part}-${index}`}>{part}</React.Fragment>
    ),
  );
}

function parseToolCall(content: string): RequestedToolCall | null {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }
  const taggedStart = trimmed.indexOf("<|tool_call>");
  if (taggedStart >= 0) {
    const rest = trimmed.slice(taggedStart + "<|tool_call>".length);
    const taggedEnd = rest.indexOf("<tool_call|>");
    const body = (taggedEnd >= 0 ? rest.slice(0, taggedEnd) : rest).trim().replace(/^call:/, "");
    const jsonStart = body.indexOf("{");
    if (jsonStart > 0) {
      const tool = body.slice(0, jsonStart).trim();
      const args = parseToolArgsText(body.slice(jsonStart));
      return tool && args ? { tool, args } : null;
    }
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return typeof parsed.tool === "string" && typeof parsed.args === "object" && parsed.args !== null
      ? { tool: parsed.tool, args: parsed.args as Record<string, unknown> }
      : null;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
        return typeof parsed.tool === "string" && typeof parsed.args === "object" && parsed.args !== null
          ? { tool: parsed.tool, args: parsed.args as Record<string, unknown> }
          : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function parseToolArgsText(text: string): Record<string, unknown> | null {
  const normalized = text.replaceAll('<|"|>', '"').replaceAll("<|'|>", "'");
  try {
    const parsed = JSON.parse(normalized) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return parseLooseToolArgs(normalized);
  }
}

function parseLooseToolArgs(text: string): Record<string, unknown> | null {
  const body = text.trim().replace(/^\{/, "").replace(/\}$/, "");
  if (!body.trim()) {
    return {};
  }
  const args: Record<string, unknown> = {};
  for (const part of body.split(",")) {
    const separator = part.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = part.slice(0, separator).trim().replace(/^["']|["']$/g, "");
    const value = part.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key) {
      args[key] = value;
    }
  }
  return Object.keys(args).length > 0 ? args : null;
}

function activeMentionStart(input: string): number | null {
  const index = input.lastIndexOf("@");
  if (index < 0) {
    return null;
  }
  if (index > 0 && !/\s/.test(input[index - 1])) {
    return null;
  }
  if (input.slice(index + 1).includes("\n")) {
    return null;
  }
  return index;
}

function activeMentionQuery(input: string): string | null {
  const index = activeMentionStart(input);
  if (index === null) {
    return null;
  }
  const slice = input.slice(index + 1);
  if (/\s/.test(slice)) {
    return null;
  }
  return slice;
}

function summarizeForSlug(input: string): string {
  const words = input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .slice(0, 3);
  return (words.length > 0 ? words : ["aegis", "task"]).join("-");
}

function cleanPath(path?: string | null): string {
  if (!path) {
    return "";
  }
  return path.replace(/^\\\\\?\\/, "").replace(/\\/g, "\\");
}

function projectEntriesFromSearch(matches: SearchMatch[]): ProjectFileEntry[] {
  const entries = new Map<string, ProjectFileEntry>();
  for (const match of matches) {
    const path = normalizeDiffPath(match.path);
    if (!path || entries.has(path)) {
      continue;
    }
    entries.set(path, {
      path,
      name: fileName(path),
      directory: fileDirectory(path),
    });
  }
  return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeMentionPath(path: string): string {
  return path.trim().replace(/^@/, "").replace(/\\/g, "/");
}

function resolveProjectFileReference(reference: string, files: ProjectFileEntry[], attached: AttachedFile[]): string {
  const normalized = normalizeMentionPath(reference).toLowerCase();
  if (!normalized) {
    return "";
  }
  const candidates = [
    ...attached
      .map((file) => file.projectPath ?? file.path)
      .filter(Boolean)
      .map((path) => ({ path, name: fileName(path) })),
    ...files.map((file) => ({ path: file.path, name: file.name })),
  ];
  const exact = candidates.find((file) => file.path.toLowerCase() === normalized);
  const suffix = candidates.find((file) => file.path.toLowerCase().endsWith(normalized));
  const byName = candidates.find((file) => file.name.toLowerCase() === normalized);
  const contains = candidates.find((file) => {
    const path = file.path.toLowerCase();
    const name = file.name.toLowerCase();
    return path.includes(normalized) || name.includes(normalized);
  });
  return exact?.path ?? suffix?.path ?? byName?.path ?? contains?.path ?? normalizeMentionPath(reference);
}

function diffFileCount(diff?: GitResult | null): number {
  if (!diff?.stdout.trim()) {
    return 0;
  }
  return parseDiff(diff.stdout).length;
}

function App() {
  const persistedWorkspace = useMemo(() => loadPersistedWorkspace(), []);
  const [connection, setConnection] = useState<DesktopConnection | null>(null);
  const [socketState, setSocketState] = useState<SocketState>("idle");
  const [health, setHealth] = useState<DaemonHealth | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState(persistedWorkspace.selectedModel ?? "google/gemma-4-e4b");
  const [contextUsage, setContextUsage] = useState<ContextUsageState>({
    promptTokens: 0,
    maxContextTokens: null,
    messageCount: 0,
    percent: 0,
    status: "unavailable",
    detail: "Open LM Studio to count tokens with the loaded model.",
  });
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(persistedWorkspace.selectedProjectId ?? null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [storeOverview, setStoreOverview] = useState<StoreOverview | null>(null);
  const [gitStatus, setGitStatus] = useState<GitResult | null>(null);
  const [gitDiff, setGitDiff] = useState<GitResult | null>(null);
  const [branchInfo, setBranchInfo] = useState<GitBranchInfo>({ branches: [] });
  const [selectedBranch, setSelectedBranch] = useState("");
  const [worktrees, setWorktrees] = useState<GitWorktreeInfo[]>([]);
  const [projectFiles, setProjectFiles] = useState<ProjectFileEntry[]>([]);
  const [projectFilesLoading, setProjectFilesLoading] = useState(false);
  const [projectFilesError, setProjectFilesError] = useState<string | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [activeFile, setActiveFile] = useState<SearchMatch | null>(null);
  const [activeDiffPath, setActiveDiffPath] = useState("");
  const [activeRail, setActiveRail] = useState<RailView>("chats");
  const [activeTab, setActiveTab] = useState<MainTab>("chat");
  const [prompt, setPrompt] = useState("");
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const [chats, setChats] = useState<LocalChat[]>(persistedWorkspace.chats);
  const [activeChatId, setActiveChatId] = useState(persistedWorkspace.activeChatId);
  const [ides, setIdes] = useState<IdeInstall[]>([]);
  const [selectedIdeId, setSelectedIdeId] = useState(persistedWorkspace.selectedIdeId ?? "code");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(persistedWorkspace.permissionMode ?? "default");
  const [ideMenuOpen, setIdeMenuOpen] = useState(false);
  const [composerBranchMenuOpen, setComposerBranchMenuOpen] = useState(false);
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [showBypassConfirm, setShowBypassConfirm] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [chatLeftWidth, setChatLeftWidth] = useState(280);
  const [dataLeftWidth, setDataLeftWidth] = useState(280);
  const [agentTools, setAgentTools] = useState<AgentTool[]>(DEFAULT_AGENT_TOOLS);
  const [terminalOutput, setTerminalOutput] = useState("");
  const [terminalInput, setTerminalInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef(new Map<string, (response: RpcResponse<unknown>) => void>());
  const streamingChatRef = useRef<string | null>(null);
  const streamBufferRef = useRef<string>("");
  const streamFrameRef = useRef<number | null>(null);

  const activeChat = chats.find((chat) => chat.id === activeChatId) ?? chats[0];
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const visibleProject = useMemo(
    () => selectedProject ? { ...selectedProject, root_path: cleanPath(selectedProject.root_path) } : null,
    [selectedProject],
  );
  const selectedIde = useMemo(
    () => ides.find((ide) => ide.id === selectedIdeId) ?? ides[0] ?? { id: "code", label: "VS Code", command: "code" },
    [ides, selectedIdeId],
  );
  const toolContext = useMemo<AgentToolContext[]>(
    () =>
      agentTools.map((tool) => ({
        id: tool.id,
        label: tool.label,
        summary: tool.summary,
        command: tool.command,
        enabled: tool.enabled,
      })),
    [agentTools],
  );

  const telemetry = useMemo(
    () => ({
      connection,
      health,
      selectedProject: visibleProject,
      activeFile,
      chats: chats.length,
      activeChat,
      sessions: sessions.length,
      sessionRows: sessions,
      storeOverview,
      branchInfo,
      worktrees: worktrees.map((worktree) => ({ ...worktree, path: cleanPath(worktree.path) })),
      models,
      selectedModel,
      permissionMode,
      enabledTools: agentTools.filter((tool) => tool.enabled).map((tool) => tool.id),
      toolContext,
      attachedFiles,
      approvalBehavior: chats.flatMap((chat) =>
        chat.approvalEvents.map((event) => ({
          chatId: chat.id,
          chatTitle: chat.title,
          ...event,
        })),
      ),
      pendingApproval: activeChat.pendingApproval,
      approvedToolActions: activeChat.approvedToolActions,
      operatingSystem: detectHarnessOs(),
      lastError: error,
    }),
    [activeChat, activeFile, agentTools, attachedFiles, branchInfo, chats, connection, error, health, models, permissionMode, selectedModel, sessions, storeOverview, toolContext, visibleProject, worktrees],
  );
  const agentTimeline = useMemo(
    () => activeChat.timeline.filter((row) => ["agent", "reasoning", "tool"].includes(row.name)),
    [activeChat.timeline],
  );
  const updateChat = useCallback((chatId: string, updater: (chat: LocalChat) => LocalChat) => {
    setChats((rows) => rows.map((chat) => (chat.id === chatId ? updater(chat) : chat)));
  }, []);

  const flushStreamBuffer = useCallback(() => {
    streamFrameRef.current = null;
    const chunk = streamBufferRef.current;
    streamBufferRef.current = "";
    const chatId = streamingChatRef.current;
    if (!chatId || !chunk) {
      return;
    }
    updateChat(chatId, (chat) => {
      const messages = [...chat.messages];
      const last = messages[messages.length - 1];
      if (last?.role === "assistant" && last.streaming) {
        messages[messages.length - 1] = { ...last, content: `${last.content}${chunk}` };
      } else {
        messages.push({ role: "assistant", content: chunk, streaming: true });
      }
      return { ...chat, messages };
    });
  }, [updateChat]);

  const enqueueStreamDelta = useCallback((delta: string) => {
    streamBufferRef.current += delta;
    if (streamFrameRef.current !== null) {
      return;
    }
    streamFrameRef.current = requestAnimationFrame(flushStreamBuffer);
  }, [flushStreamBuffer]);

  const enqueueThinkingDelta = useCallback((chatId: string, delta: string) => {
    updateChat(chatId, (chat) => {
      const messages = [...chat.messages];
      let thinkingIndex = -1;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role === "thinking" && messages[index].streaming) {
          thinkingIndex = index;
          break;
        }
      }
      if (thinkingIndex >= 0) {
        messages[thinkingIndex] = {
          ...messages[thinkingIndex],
          content: `${messages[thinkingIndex].content}${delta}`,
        };
        return { ...chat, messages };
      }
      let assistantIndex = -1;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role === "assistant" && messages[index].streaming) {
          assistantIndex = index;
          break;
        }
      }
      const thinking: ChatLine = {
        role: "thinking",
        content: delta,
        streaming: true,
        startedAt: new Date().toISOString(),
      };
      if (assistantIndex >= 0) {
        messages.splice(assistantIndex, 0, thinking);
      } else {
        messages.push(thinking);
      }
      return { ...chat, messages };
    });
  }, [updateChat]);

  const finishStreaming = useCallback((chatId: string) => {
    const endedAtMs = Date.now();
    if (streamFrameRef.current !== null) {
      cancelAnimationFrame(streamFrameRef.current);
      streamFrameRef.current = null;
    }
    if (streamBufferRef.current) {
      const tail = streamBufferRef.current;
      streamBufferRef.current = "";
      updateChat(chatId, (chat) => {
        const messages = chat.messages.map((message) =>
          message.role === "thinking" && message.streaming ? finishThinkingLine(message, endedAtMs) : message,
        );
        const last = messages[messages.length - 1];
        if (last?.role === "assistant" && last.streaming) {
          messages[messages.length - 1] = { ...last, content: `${last.content}${tail}`, streaming: false };
        } else {
          messages.push({ role: "assistant", content: tail });
        }
        return { ...chat, messages };
      });
      return;
    }
    updateChat(chatId, (chat) => {
      const messages = chat.messages.map((message, index) => {
        if (index === chat.messages.length - 1 && message.role === "assistant" && message.streaming) {
          return { ...message, streaming: false };
        }
        if (message.role === "thinking" && message.streaming) {
          return finishThinkingLine(message, endedAtMs);
        }
        return message;
      });
      return { ...chat, messages };
    });
  }, [updateChat]);

  const addTimeline = useCallback((name: string, status: ServiceStatus, detail: string, chatId = activeChatId) => {
    const row: TimelineRow = {
      id: crypto.randomUUID(),
      name,
      status,
      detail,
      at: new Date().toLocaleTimeString(),
    };
    updateChat(chatId, (chat) => ({ ...chat, timeline: [row, ...chat.timeline].slice(0, 40) }));
  }, [activeChatId, updateChat]);

  const rpc = useCallback(<T,>(method: string, params: unknown): Promise<T> => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Daemon socket is not open."));
    }
    const id = crypto.randomUUID();
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => {
      pendingRef.current.set(id, (response) => {
        if (response.error) {
          reject(new Error(response.error.message));
        } else {
          resolve(response.result as T);
        }
      });
      setTimeout(() => {
        if (pendingRef.current.has(id)) {
          pendingRef.current.delete(id);
          reject(new Error(`${method} timed out.`));
        }
      }, 45000);
    });
  }, []);

  useEffect(() => {
    if (socketState !== "open") {
      setContextUsage((current) => ({
        ...current,
        status: "unavailable",
        detail: "Daemon is not connected.",
      }));
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      const workingRoot = activeChat.worktreePath ?? selectedProject?.root_path;
      const message = prompt.trim();
      setContextUsage((current) => ({ ...current, status: "loading" }));
      void rpc<ContextUsageResult>("agent.context_usage", {
        project_id: selectedProject?.id,
        project_root: workingRoot,
        message,
        conversation_history: chatHistoryForDaemon(activeChat.messages),
        model: selectedModel,
        git_branch: selectedBranch || undefined,
        worktree_enabled: activeChat.worktreeEnabled,
        worktree_path: workingRoot,
        permission_mode: permissionMode,
        enabled_tools: agentTools.filter((tool) => tool.enabled).map((tool) => tool.id),
        approved_tool_actions: activeChat.approvedToolActions,
        tool_context: toolContext,
        attached_files: attachedFiles.map((file) => ({
          path: file.path,
          project_path: file.projectPath,
          content: file.projectPath ? undefined : file.content,
        })),
        operating_system: detectHarnessOs(),
      })
        .then((usage) => {
          if (cancelled) {
            return;
          }
          setContextUsage({
            promptTokens: usage.prompt_tokens,
            maxContextTokens: usage.max_context_tokens,
            messageCount: usage.message_count,
            percent: contextPercent(usage.prompt_tokens, usage.max_context_tokens),
            status: "ready",
            detail: "Counted by LM Studio using the selected model context.",
          });
        })
        .catch((cause) => {
          if (cancelled) {
            return;
          }
          const message = String(cause instanceof Error ? cause.message : cause);
          setContextUsage((current) => ({
            ...current,
            status: "unavailable",
            detail: message,
          }));
        });
    }, 450);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    activeChat.approvedToolActions,
    activeChat.id,
    activeChat.messages,
    activeChat.worktreeEnabled,
    activeChat.worktreePath,
    agentTools,
    attachedFiles,
    permissionMode,
    prompt,
    rpc,
    selectedBranch,
    selectedModel,
    selectedProject,
    socketState,
    toolContext,
  ]);

  const refreshStore = useCallback(async () => {
    setStoreOverview(await rpc<StoreOverview>("store.overview", {}));
  }, [rpc]);

  const refreshSessions = useCallback(async (projectId = selectedProjectId) => {
    setSessions(await rpc<SessionSummary[]>("session.list", { projectId }));
  }, [rpc, selectedProjectId]);

  const refreshProjectFiles = useCallback(async (project = selectedProject) => {
    if (!project) {
      setProjectFiles([]);
      setProjectFilesError(null);
      return;
    }
    setProjectFilesLoading(true);
    setProjectFilesError(null);
    try {
      setProjectFiles(await rpc<ProjectFileEntry[]>("project.files", { projectRoot: project.root_path, limit: 10_000 }));
    } catch (cause) {
      const message = String(cause instanceof Error ? cause.message : cause);
      if (/unknown method project\.files/i.test(message)) {
        try {
          const matches = await rpc<SearchMatch[]>("project.search", {
            project_root: project.root_path,
            query: "",
            limit: 10_000,
          });
          setProjectFiles(projectEntriesFromSearch(matches));
          setProjectFilesError(null);
          return;
        } catch (fallbackCause) {
          const fallbackMessage = String(fallbackCause instanceof Error ? fallbackCause.message : fallbackCause);
          setProjectFiles([]);
          setProjectFilesError(fallbackMessage);
          throw fallbackCause;
        }
      } else {
        setProjectFiles([]);
        setProjectFilesError(message);
        throw cause;
      }
    } finally {
      setProjectFilesLoading(false);
    }
  }, [rpc, selectedProject]);

  const refreshGit = useCallback(async (project = selectedProject) => {
    if (!project) {
      setGitStatus(null);
      setGitDiff(null);
      setBranchInfo({ branches: [] });
      setWorktrees([]);
      return null;
    }
    const params = { projectRoot: project.root_path };
    const [status, diff, branches, treeRows] = await Promise.all([
      rpc<GitResult>("git.status", params),
      rpc<GitResult>("git.diff", params),
      rpc<GitBranchInfo>("git.branches", params),
      rpc<GitWorktreeInfo[]>("git.worktree_list", params),
    ]);
    setGitStatus(status);
    setGitDiff(diff);
    setBranchInfo(branches);
    setWorktrees(treeRows);
    const nextBranch = branches.current ?? branches.branches[0] ?? "";
    setSelectedBranch((current) => current || nextBranch);
    addTimeline("git", status.success && diff.success ? "ready" : "degraded", "branch, status, diff refreshed");
    return diff;
  }, [addTimeline, rpc, selectedProject]);

  const loadInitialData = useCallback(async () => {
    const [healthResult, projectRows, sessionRows, overview, detectedIdes, modelRows] = await Promise.all([
      rpc<DaemonHealth>("daemon.health", {}),
      rpc<ProjectSummary[]>("project.list", {}),
      rpc<SessionSummary[]>("session.list", {}),
      rpc<StoreOverview>("store.overview", {}),
      rpc<IdeInstall[]>("ide.detect", {}),
      rpc<Array<{ id: string }>>("model.list", {}),
    ]);
    setHealth(healthResult);
    setProjects(projectRows);
    setSessions(sessionRows);
    setStoreOverview(overview);
    setIdes(detectedIdes);
    setModels(modelRows.map((model) => model.id));
    setSelectedModel((current) => modelRows.some((model) => model.id === current) ? current : modelRows[0]?.id ?? current);
    setSelectedIdeId((current) => detectedIdes.some((ide) => ide.id === current) ? current : detectedIdes.find((ide) => ide.id === "code")?.id ?? detectedIdes[0]?.id ?? "code");
    setSelectedProjectId((current) => projectRows.some((project) => project.id === current) ? current : projectRows[0]?.id ?? null);
    const projectForFiles = projectRows.find((project) => project.id === selectedProjectId) ?? projectRows[0];
    if (projectForFiles) {
      void refreshProjectFiles(projectForFiles).catch(() => setProjectFiles([]));
    }
    addTimeline("daemon", "ready", "connected");
    addTimeline("lm-studio", healthResult.lm_studio, `${modelRows.length} model(s)`);
  }, [addTimeline, refreshProjectFiles, rpc, selectedProjectId]);

  const connect = useCallback(async () => {
    setSocketState("connecting");
    setError(null);
    const daemon = await aegisApi.getDaemonConnection();
    setConnection(daemon);

    if (daemon.status !== "ready") {
      setSocketState("closed");
      setError(daemon.message);
      addTimeline("desktop", "unavailable", daemon.message);
      return;
    }

    const ws = new WebSocket(`${daemon.url}?token=${encodeURIComponent(daemon.token)}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setSocketState("open");
      void loadInitialData().catch((cause) => setError(String(cause)));
    };

    ws.onclose = () => setSocketState("closed");
    ws.onerror = () => setError("WebSocket connection to the daemon failed.");
    ws.onmessage = (event) => {
      const parsed = JSON.parse(event.data) as RpcResponse<unknown> | ServerEvent;
      if ("id" in parsed) {
        const handler = pendingRef.current.get(parsed.id);
        if (handler) {
          pendingRef.current.delete(parsed.id);
          handler(parsed);
        }
        return;
      }
      if (parsed.type === "status") {
        setHealth({
          daemon: parsed.daemon,
          sqlite_path: parsed.sqlite_path,
          lm_studio: parsed.lm_studio,
          model_base_url: parsed.model_base_url,
          semantic_index: parsed.semantic_index,
        });
      }
      if (parsed.type === "agent_stream") {
        const chatId = streamingChatRef.current;
        if (!chatId) {
          return;
        }
        if (parsed.kind === "message.delta" && parsed.content) {
          enqueueStreamDelta(parsed.content);
        }
        if (parsed.kind === "reasoning.delta" && parsed.content) {
          enqueueThinkingDelta(chatId, parsed.content);
          addTimeline("reasoning", "degraded", "thinking", chatId);
        }
        if (parsed.kind === "reasoning.start") {
          enqueueThinkingDelta(chatId, "");
          addTimeline("reasoning", "degraded", "thinking", chatId);
        }
        if (parsed.kind === "tool.start") {
          if (streamFrameRef.current !== null) {
            cancelAnimationFrame(streamFrameRef.current);
            streamFrameRef.current = null;
          }
          streamBufferRef.current = "";
          const toolName = typeof parsed.data === "object" && parsed.data && "tool" in parsed.data
            ? String((parsed.data as Record<string, unknown>).tool)
            : "tool";
          const detail = toolActivityLabel(toolName, parsed.data);
          updateChat(chatId, (chat) => {
            const messages = [...chat.messages];
            const last = messages[messages.length - 1];
            const isToolCall =
              last?.role === "assistant" &&
              (looksLikeToolCall(last.content) || looksLikeToolCallFragment(last.content));
            const isEmptyStreamingPlaceholder =
              last?.role === "assistant" && last.streaming === true && last.content.length === 0;
            const isBackgroundStreamingText =
              last?.role === "assistant" && last.streaming === true;
            if (isToolCall || isEmptyStreamingPlaceholder || isBackgroundStreamingText) {
              messages.pop();
            }
            return {
              ...chat,
              messages: [
                ...messages,
                {
                  role: "tool",
                  toolName,
                  status: "degraded",
                  detail,
                  content: detail,
                },
              ],
            };
          });
          addTimeline("tool", "degraded", detail, chatId);
        }
        if (parsed.kind === "tool.end") {
          const data = parsed.data as Record<string, unknown>;
          const toolName = typeof data?.tool === "string" ? data.tool : "tool";
          const success = data?.success !== false;
          const approvalRequest = approvalRequestFromToolEvent(toolName, data, String(data?.summary ?? ""));
          const summary = approvalRequest
            ? `Approval needed: ${toolActionCommand(toolName, data)}`
            : toolActivityLabel(toolName, data, success);
          updateChat(chatId, (chat) => {
            const messages = [...chat.messages];
            let updated = false;
            for (let index = messages.length - 1; index >= 0; index -= 1) {
              if (messages[index].role === "tool" && messages[index].toolName === toolName && messages[index].status === "degraded") {
                const display = approvalRequest
                  ? messages[index].detail || toolActivityLabel(toolName, data, true)
                  : success
                    ? messages[index].detail || summary
                    : summary;
                messages[index] = {
                  ...messages[index],
                  status: success ? "ready" : approvalRequest ? "degraded" : "unavailable",
                  detail: display,
                  content: display,
                };
                updated = true;
                break;
              }
            }
            if (!updated) {
              messages.push({
                role: "tool",
                toolName,
                status: success ? "ready" : approvalRequest ? "degraded" : "unavailable",
                detail: summary,
                content: summary,
              });
            }
            return { ...chat, messages, pendingApproval: approvalRequest ?? chat.pendingApproval };
          });
          addTimeline("tool", success ? "ready" : approvalRequest ? "degraded" : "unavailable", summary, chatId);
          if (approvalRequest) {
            addTimeline("approval", "degraded", `Pending: ${approvalRequest.command}`, chatId);
          }
        }
        if (parsed.kind === "terminal.output" && parsed.content) {
          setTerminalOutput((current) => `${current}${parsed.content}`.slice(-80_000));
        }
      }
    };
  }, [addTimeline, enqueueStreamDelta, enqueueThinkingDelta, loadInitialData, updateChat]);

  const pickProject = useCallback(async () => {
    setError(null);
    const picked = await aegisApi.pickProjectFolder();
    if (picked.canceled) {
      return;
    }
    const project = await rpc<ProjectSummary>("project.add", {
      root_path: picked.rootPath,
      name: picked.name,
    });
    setProjects((rows) => [project, ...rows.filter((row) => row.id !== project.id)]);
    setSelectedProjectId(project.id);
    setActiveRail("chats");
    setActiveTab("chat");
    setActiveFile(null);
    setActiveDiffPath("");
    setAttachedFiles([]);
    addTimeline("project", "ready", project.root_path);
    await Promise.all([refreshSessions(project.id), refreshStore(), refreshGit(project), refreshProjectFiles(project)]);
  }, [addTimeline, refreshGit, refreshProjectFiles, refreshSessions, refreshStore, rpc]);

  useEffect(() => {
    void connect();
    const unsubscribeOpen = aegisApi.onOpenProjectRequested(() => void pickProject());
    const unsubscribeBack = aegisApi.onBackToChatRequested(() => setActiveTab("chat"));
    const unsubscribeSidebar = aegisApi.onToggleSidebarRequested(() => setSidebarVisible((visible) => !visible));
    return () => {
      wsRef.current?.close();
      unsubscribeOpen();
      unsubscribeBack();
      unsubscribeSidebar();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (socketState === "open") {
      void refreshSessions(selectedProjectId).catch((cause) => setError(String(cause)));
    }
  }, [refreshSessions, selectedProjectId, socketState]);

  useEffect(() => {
    if (socketState === "open" && selectedProject) {
      void refreshGit(selectedProject).catch((cause) => {
        setGitStatus({ stdout: "", stderr: String(cause), success: false });
        setGitDiff(null);
      });
      void refreshProjectFiles(selectedProject).catch(() => setProjectFiles([]));
    }
  }, [refreshProjectFiles, selectedProject, selectedProjectId, socketState]);

  useEffect(() => {
    const unsubscribe = aegisApi.onTerminalData((data) => {
      setTerminalOutput((current) => `${current}${data}`.slice(-80_000));
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    persistWorkspace({
      chats,
      activeChatId,
      selectedProjectId,
      selectedModel,
      selectedIdeId,
      permissionMode,
    });
  }, [activeChatId, chats, permissionMode, selectedIdeId, selectedModel, selectedProjectId]);

  const newChat = () => {
    const chat = newLocalChat(selectedBranch);
    setChats((rows) => [chat, ...rows]);
    setActiveChatId(chat.id);
    setPrompt("");
    setActiveTab("chat");
  };

  const deleteChat = (chatId: string) => {
    setChats((rows) => {
      if (rows.length === 1) {
        const replacement = newLocalChat(selectedBranch);
        setActiveChatId(replacement.id);
        return [replacement];
      }
      const nextRows = rows.filter((chat) => chat.id !== chatId);
      if (chatId === activeChatId) {
        setActiveChatId(nextRows[0]?.id ?? rows[0]?.id ?? newLocalChat(selectedBranch).id);
      }
      return nextRows;
    });
  };

  const restart = async () => {
    setSocketState("connecting");
    setError(null);
    wsRef.current?.close();
    pendingRef.current.clear();
    const daemon = await aegisApi.restartDaemon();
    setConnection(daemon);
    setTimeout(() => void connect(), 150);
  };

  const ensureWorktree = async (chatId: string, message: string): Promise<GitWorktreeInfo | null> => {
    const chat = chats.find((row) => row.id === chatId);
    if (!selectedProject || !chat?.worktreeEnabled || chat.worktreePath) {
      return null;
    }
    const slug = summarizeForSlug(message);
    const branch = selectedBranch || branchInfo.current || "HEAD";
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 12);
    const newBranch = `codex/${slug}-${stamp}`;
    addTimeline("worktree", "degraded", `creating Aegis/${slug}`, chatId);
    const worktree = await rpc<GitWorktreeInfo>("git.worktree_create", {
      projectRoot: selectedProject.root_path,
      branch,
      newBranch,
      worktreeName: slug,
    });
    updateChat(chatId, (row) => ({
      ...row,
      branch: newBranch,
      worktreePath: worktree.path,
    }));
    setSelectedBranch(newBranch);
    setWorktrees((rows) => [worktree, ...rows.filter((row) => row.path !== worktree.path)]);
    addTimeline("worktree", "ready", worktree.path, chatId);
    return worktree;
  };

  const executeReturnedToolCall = async (content: string, projectRoot: string | undefined, chatId: string): Promise<string> => {
    const call = parseToolCall(content);
    if (!call || !projectRoot) {
      return content;
    }
    const approvalRequest = approvalRequestFromRawToolCall(call);
    if (approvalRequest) {
      updateChat(chatId, (chat) => ({ ...chat, pendingApproval: approvalRequest }));
      addTimeline("approval", "degraded", `Pending: ${approvalRequest.command}`, chatId);
      return `I need your approval before ${approvalRequest.command}.`;
    }
    addTimeline("tool", "unavailable", `${call.tool} returned as final text`, chatId);
    return [
      `The model returned a raw ${call.tool} tool call as the final answer instead of letting the daemon continue the tool loop.`,
      "",
      "Send the request again and Aegis can continue from the current chat context.",
    ].join("\n");
  };

  const sendTaskWithMessage = async (
    message: string,
    promptAttachments: AttachedFile[] = [],
    options: { clearPrompt?: boolean; extraApprovedActions?: string[]; hideUserMessage?: boolean } = {},
  ) => {
    const trimmed = message.trim();
    const chatId = activeChat.id;
    if (!trimmed || busy) {
      return;
    }

    setBusy(true);
    setError(null);
    if (options.clearPrompt) {
      setPrompt("");
    }
    setAttachedFiles([]);
    streamingChatRef.current = chatId;
    streamBufferRef.current = "";
    if (streamFrameRef.current !== null) {
      cancelAnimationFrame(streamFrameRef.current);
      streamFrameRef.current = null;
    }
    updateChat(chatId, (chat) => ({
      ...chat,
      title: chat.messages.length === 0 ? trimmed.slice(0, 64) : chat.title,
      branch: selectedBranch,
      messages: options.hideUserMessage
        ? [...chat.messages, { role: "assistant", content: "", streaming: true }]
        : [
            ...chat.messages,
            { role: "user", content: trimmed },
            { role: "assistant", content: "", streaming: true },
          ],
    }));
    addTimeline("agent", "degraded", "generating response", chatId);
    if (selectedProject) {
      void refreshGit(selectedProject).catch(() => undefined);
    }
    try {
      const chat = chats.find((row) => row.id === chatId);
      const lazyWorktree = await ensureWorktree(chatId, trimmed);
      const workingRoot = lazyWorktree?.path ?? chat?.worktreePath ?? selectedProject?.root_path;
      const conversationHistory = chatHistoryForDaemon(chat?.messages ?? []);
      const approvedToolActions = Array.from(
        new Set([...(chat?.approvedToolActions ?? []), ...(options.extraApprovedActions ?? [])]),
      );
      const result = await rpc<SendTaskResult>("agent.send_task", {
        project_id: selectedProject?.id,
        project_root: workingRoot,
        message: trimmed,
        conversation_history: conversationHistory,
        model: selectedModel,
        git_branch: lazyWorktree?.branch ?? (selectedBranch || undefined),
        worktree_enabled: chat?.worktreeEnabled ?? false,
        worktree_path: workingRoot,
        permission_mode: permissionMode,
        enabled_tools: agentTools.filter((tool) => tool.enabled).map((tool) => tool.id),
        approved_tool_actions: approvedToolActions,
        tool_context: toolContext,
        attached_files: promptAttachments.map((file) => ({
          path: file.path,
          project_path: file.projectPath,
          content: file.projectPath ? undefined : file.content,
        })),
        operating_system: detectHarnessOs(),
      });
      finishStreaming(chatId);
      const assistantMessage = cleanAssistantMessage(
        await executeReturnedToolCall(result.assistant_message, workingRoot, chatId),
      );
      updateChat(chatId, (row) => ({
        ...row,
        sessionId: result.session_id,
        messages: (() => {
          const messages = row.messages.filter(
            (message) =>
              !(
                message.role === "assistant" &&
                (looksLikeToolCall(message.content) || looksLikeToolCallFragment(message.content))
              ),
          );
          if (row.pendingApproval && /^I need your approval\b/i.test(assistantMessage)) {
            return messages.filter(
              (message, index) =>
                !(
                  index === messages.length - 1 &&
                  message.role === "assistant" &&
                  (message.streaming || /^I need your approval\b/i.test(message.content) || message.content.trim() === "")
                ),
            );
          }
          const last = messages[messages.length - 1];
          if (last?.role === "assistant") {
            messages[messages.length - 1] = {
              role: "assistant",
              content: assistantMessage || cleanAssistantMessage(last.content) || "(empty response)",
            };
            return messages;
          }
          let toolCallIndex = -1;
          for (let index = messages.length - 1; index >= 0; index -= 1) {
            if (messages[index].role === "assistant" && looksLikeToolCall(messages[index].content)) {
              toolCallIndex = index;
              break;
            }
          }
          if (toolCallIndex >= 0) {
            messages.splice(toolCallIndex, 1);
          }
          return [...messages, { role: "assistant", content: assistantMessage || "(empty response)" }];
        })(),
      }));
      addTimeline("agent", "ready", `turn ${result.turn_id.slice(0, 8)} finished`, chatId);
      const [, , refreshedDiff] = await Promise.all([
        refreshSessions(selectedProjectId),
        refreshStore(),
        refreshGit(selectedProject ?? undefined),
        refreshProjectFiles(selectedProject ?? undefined),
      ]);
      const changedFileCount = diffFileCount(refreshedDiff);
      if (changedFileCount > 0) {
        const changedLineStats = totalDiffLineStats(parseDiff(refreshedDiff?.stdout ?? ""));
        updateChat(chatId, (row) => ({
          ...row,
          diffAvailable: true,
          changedFileCount,
          changedLineStats,
        }));
      }
    } catch (cause) {
      const message = String(cause instanceof Error ? cause.message : cause);
      setError(message);
      addTimeline("agent", "unavailable", message, chatId);
      finishStreaming(chatId);
    } finally {
      streamingChatRef.current = null;
      setBusy(false);
    }
  };

  const sendTask = async () => {
    await sendTaskWithMessage(prompt, attachedFiles, { clearPrompt: true });
  };

  const toggleWorktree = (enabled: boolean) => {
    updateChat(activeChat.id, (chat) => ({
      ...chat,
      worktreeEnabled: enabled,
      worktreePath: enabled ? chat.worktreePath : undefined,
    }));
  };

  const openProjectInIde = async (ideId = selectedIdeId) => {
    if (!selectedProject) {
      return;
    }
    const ide = ides.find((row) => row.id === ideId) ?? selectedIde;
    const projectRoot = activeChat.worktreePath ?? selectedProject.root_path;
    try {
      if (aegisApi.openProjectInIde) {
        const result = await aegisApi.openProjectInIde({ ideId, command: ide.command, projectRoot });
        if (!result.ok) {
          throw new Error(result.message);
        }
      } else {
        await rpc("ide.open_project", { ideId, projectRoot });
      }
      addTimeline("ide", "ready", `opened ${selectedProject.name} in ${ide.label}`);
    } catch (cause) {
      const message = String(cause instanceof Error ? cause.message : cause);
      setError(message);
      addTimeline("ide", "unavailable", message);
    }
  };

  const openFileInIde = async (filePath: string, line: number, ideId = selectedIdeId) => {
    if (!selectedProject) {
      return;
    }
    const ide = ides.find((row) => row.id === ideId) ?? selectedIde;
    const projectRoot = activeChat.worktreePath ?? selectedProject.root_path;
    setActiveFile({ path: filePath, line, snippet: "Changed in current diff" });
    try {
      if (aegisApi.openFileInIde) {
        const result = await aegisApi.openFileInIde({
          ideId,
          command: ide.command,
          projectRoot,
          file: filePath,
          line,
        });
        if (!result.ok) {
          throw new Error(result.message);
        }
      } else {
        await rpc("ide.open_file", { ideId, projectRoot, file: filePath, line });
      }
      addTimeline("ide", "ready", `opened ${filePath} in ${ide.label}`);
    } catch (cause) {
      const message = String(cause instanceof Error ? cause.message : cause);
      setError(message);
      addTimeline("ide", "unavailable", message);
    }
  };

  const attachProjectFile = (file: ProjectFileEntry) => {
    setAttachedFiles((files) => {
      if (files.some((row) => row.projectPath === file.path)) {
        return files;
      }
      return [...files, { path: file.path, name: file.name, projectPath: file.path }];
    });
    setPrompt((current) => {
      const start = activeMentionStart(current);
      if (start === null) {
        return `${current.trimEnd()} @${file.name} `;
      }
      return `${current.slice(0, start)}@${file.name} `;
    });
  };

  const attachLocalFiles = async () => {
    const picked = await aegisApi.pickAttachments(activeChat.worktreePath ?? selectedProject?.root_path);
    if (picked.canceled) {
      return;
    }
    setAttachedFiles((files) => {
      const next = [...files];
      for (const file of picked.files) {
        const key = file.projectPath ?? file.path;
        if (!next.some((row) => (row.projectPath ?? row.path) === key)) {
          next.push(file);
        }
      }
      return next;
    });
  };

  const removeAttachedFile = (path: string) => {
    setAttachedFiles((files) => files.filter((file) => (file.projectPath ?? file.path) !== path));
  };

  const resolveApproval = (request: ToolApprovalRequest, decision: "accepted" | "declined") => {
    const event: ToolApprovalEvent = {
      id: crypto.randomUUID(),
      toolName: request.toolName,
      actionKey: request.actionKey,
      command: request.command,
      decision,
      quality: decision === "accepted" ? "Good" : "Bad",
      at: new Date().toISOString(),
    };
    updateChat(activeChat.id, (chat) => ({
      ...chat,
      pendingApproval: chat.pendingApproval?.id === request.id ? undefined : chat.pendingApproval,
      approvedToolActions:
        decision === "accepted" && !chat.approvedToolActions.includes(request.actionKey)
          ? [...chat.approvedToolActions, request.actionKey]
          : chat.approvedToolActions,
      approvalEvents: [...chat.approvalEvents, event].slice(-80),
    }));
    addTimeline(
      "approval",
      decision === "accepted" ? "ready" : "unavailable",
      `${event.quality}: ${decision} ${request.command}`,
      activeChat.id,
    );
    if (decision === "accepted") {
      void sendTaskWithMessage(`Internal approval granted for ${request.command}. Continue the previous request. Do not mention this approval event.`, [], {
        extraApprovedActions: [request.actionKey],
        hideUserMessage: true,
      });
    }
  };

  const startTerminal = async () => {
    const root = activeChat.worktreePath ?? selectedProject?.root_path;
    const result = await aegisApi.startTerminal(root);
    setTerminalOutput((current) => current || `[started ${result.shell}]\r\n`);
  };

  const submitTerminalInput = async () => {
    if (!terminalInput.trim()) {
      return;
    }
    await aegisApi.writeTerminal(`${terminalInput}\n`);
    setTerminalInput("");
  };

  const copyTelemetry = async () => {
    await navigator.clipboard.writeText(JSON.stringify(telemetry, null, 2));
    addTimeline("telemetry", "ready", "copied telemetry JSON");
  };

  const choosePermissionMode = (mode: PermissionMode) => {
    setPermissionMenuOpen(false);
    if (mode === "bypass" && permissionMode !== "bypass") {
      setShowBypassConfirm(true);
      return;
    }
    setPermissionMode(mode);
  };

  const leftWidth = activeRail === "data" ? dataLeftWidth : chatLeftWidth;

  const startResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const initial = leftWidth;
    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      const workspaceMinimum = 320;
      const maxSidebarWidth = Math.max(230, Math.min(640, window.innerWidth - 52 - workspaceMinimum));
      const next = Math.max(230, Math.min(maxSidebarWidth, initial + delta));
      if (activeRail === "data") setDataLeftWidth(next);
      else setChatLeftWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const railTitle = {
    chats: "Chats",
    git: "Source Control",
    tools: "Tools",
    data: "Telemetry",
  }[activeRail];

  const toggleAgentTool = (id: string, enabled: boolean) => {
    setAgentTools((tools) => tools.map((tool) => (tool.id === id ? { ...tool, enabled } : tool)));
  };
  const updateAgentTool = (id: string, patch: Partial<Pick<AgentTool, "label" | "summary" | "command">>) => {
    setAgentTools((tools) => tools.map((tool) => (tool.id === id ? { ...tool, ...patch } : tool)));
  };
  const mentionQuery = activeMentionQuery(prompt);
  const mentionMatches = mentionQuery === null
    ? []
    : projectFiles
        .filter((file) => {
          const query = mentionQuery.toLowerCase();
          const haystack = `${file.path} ${file.name} ${file.directory}`.toLowerCase();
          return haystack.includes(query);
        })
        .slice(0, 80);

  useEffect(() => {
    setMentionSelectedIndex(0);
  }, [mentionQuery]);

  useEffect(() => {
    setMentionSelectedIndex((index) => Math.max(0, Math.min(index, Math.max(mentionMatches.length - 1, 0))));
  }, [mentionMatches.length]);

  useEffect(() => {
    if (mentionQuery !== null && selectedProject && socketState === "open") {
      const timer = window.setTimeout(() => {
        void refreshProjectFiles(selectedProject).catch(() => setProjectFiles([]));
      }, 120);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [mentionQuery, refreshProjectFiles, selectedProject, socketState]);

  return (
    <main
      className={`app ${sidebarVisible ? "" : "sidebarCollapsed"}`}
      style={{
        gridTemplateColumns: `52px ${sidebarVisible ? leftWidth : 0}px minmax(0, 1fr)`,
      }}
    >
      <header className="titlebar">
        <div className="titlebar-left">
          <div className="window-controls">
            <button className="ctrlButton" title="Back to chat" onClick={() => setActiveTab("chat")}>
              <ArrowLeft size={15} />
            </button>
            <button className="ctrlButton" title="Toggle sidebar" onClick={() => setSidebarVisible((visible) => !visible)}>
              <PanelLeft size={15} />
            </button>
          </div>
          <div className="brand">
            <Code2 size={15} className="brandMark" />
            <span>Aegis</span>
          </div>
        </div>
        <div className="titlebar-drag" />
        <div className="titlebar-right">
          <IdePicker
            ides={ides}
            selectedIde={selectedIde}
            selectedIdeId={selectedIdeId}
            disabled={!selectedProject}
            open={ideMenuOpen}
            onOpenChange={setIdeMenuOpen}
            onOpenProject={() => void openProjectInIde()}
            onSelectIde={(id) => {
              setSelectedIdeId(id);
              setIdeMenuOpen(false);
            }}
          />
          <button className="ctrlButton" title="Restart daemon" onClick={restart}>
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      <aside className="rail">
        <RailButton active={activeRail === "chats"} title="Chats" onClick={() => setActiveRail("chats")}>
          <MessageSquare size={18} />
        </RailButton>
        <RailButton active={activeRail === "git"} title="Source control" onClick={() => setActiveRail("git")}>
          <GitBranch size={18} />
        </RailButton>
        <RailButton active={activeRail === "tools"} title="Tools" onClick={() => setActiveRail("tools")}>
          <Wrench size={18} />
        </RailButton>
        <RailButton active={activeRail === "data"} title="Telemetry" onClick={() => setActiveRail("data")}>
          <Database size={18} />
        </RailButton>
      </aside>

      {sidebarVisible ? (
      <section className="sidebar">
        <div className="sidebarHeader">
          <h2>{railTitle}</h2>
          {activeRail === "chats" ? (
            <button className="newChatButton" onClick={newChat} title="New chat">
              <Plus size={14} />
            </button>
          ) : null}
          {activeRail === "data" ? (
            <button className="newChatButton" onClick={copyTelemetry} title="Copy telemetry JSON">
              <Copy size={13} />
            </button>
          ) : null}
        </div>
        {activeRail === "chats" ? (
          <SidebarChats chats={chats} activeChatId={activeChat.id} onSelect={setActiveChatId} onDelete={deleteChat} />
        ) : null}
        {activeRail === "git" ? (
          <SidebarGit
            status={gitStatus}
            diff={gitDiff}
            branchInfo={branchInfo}
            worktrees={worktrees}
            selectedBranch={selectedBranch}
            setSelectedBranch={setSelectedBranch}
            onRefresh={() => void refreshGit()}
            onOpenChangedFile={(path) => {
              setActiveDiffPath(path);
              setActiveTab("diff");
            }}
            hasProject={!!selectedProject}
          />
        ) : null}
        {activeRail === "tools" ? (
          <SidebarTools
            tools={agentTools}
            operatingSystem={detectHarnessOs()}
            onToggle={toggleAgentTool}
            onUpdate={updateAgentTool}
            onReset={() => setAgentTools(DEFAULT_AGENT_TOOLS)}
          />
        ) : null}
        {activeRail === "data" ? (
          <SidebarData telemetry={telemetry} health={health} socketState={socketState} storeOverview={storeOverview} />
        ) : null}
      </section>
      ) : null}
      {sidebarVisible ? <div className="resizeHandle leftHandle" onPointerDown={startResize} /> : null}

      <section className="workspace">
        <nav className="tabs">
          {(["chat", "diff", "terminal"] as const).map((tab) => (
            <button key={tab} className={activeTab === tab ? "active" : ""} onClick={() => setActiveTab(tab)}>
              {tab}
            </button>
          ))}
        </nav>
        <div className="content">
          {activeTab === "chat" ? <ChatView chat={activeChat} busy={busy} onShowDiff={() => setActiveTab("diff")} /> : null}
          {activeTab === "diff" ? (
            <DiffView
              diff={gitDiff}
              hasProject={!!selectedProject}
              selectedPath={activeDiffPath}
              openLabel={`Open with ${selectedIde.label}`}
              onOpenFile={(path, line) => void openFileInIde(path, line)}
              onSelectFile={setActiveDiffPath}
            />
          ) : null}
          {activeTab === "terminal" ? (
            <TerminalView
              projectRoot={cleanPath(activeChat.worktreePath ?? selectedProject?.root_path)}
              operatingSystem={detectHarnessOs()}
              output={terminalOutput}
              input={terminalInput}
              locked={busy}
              onInputChange={setTerminalInput}
              onStart={startTerminal}
              onSubmit={submitTerminalInput}
            />
          ) : null}
        </div>
        <footer className="composer">
          {activeChat.pendingApproval ? (
            <PermissionApprovalBar
              request={activeChat.pendingApproval}
              busy={busy}
              onAccept={() => resolveApproval(activeChat.pendingApproval!, "accepted")}
              onDecline={() => resolveApproval(activeChat.pendingApproval!, "declined")}
            />
          ) : null}
          <div className="composerMeta">
            <BranchMenu
              selectedBranch={selectedBranch}
              branches={branchInfo.branches}
              disabled={branchInfo.branches.length === 0}
              open={composerBranchMenuOpen}
              onOpenChange={setComposerBranchMenuOpen}
              onSelect={setSelectedBranch}
            />
            <label className={activeChat.worktreeEnabled ? "worktreeCheck active" : "worktreeCheck"}>
              <input
                type="checkbox"
                checked={activeChat.worktreeEnabled}
                onChange={(event) => toggleWorktree(event.target.checked)}
                disabled={!selectedProject}
              />
              <GitFork size={12} />
              <span>{activeChat.worktreePath ? cleanPath(activeChat.worktreePath).split(/[\\/]/).pop() : "Worktree"}</span>
            </label>
            <div className="menuControl composerMenu">
              <button
                type="button"
                className={`permissionButton ${permissionMode === "bypass" ? "bypass" : ""}`}
                onClick={() => setPermissionMenuOpen((open) => !open)}
                aria-haspopup="menu"
                aria-expanded={permissionMenuOpen}
              >
                <span>{permissionMode === "default" ? "Default" : "Bypass"}</span>
                <ChevronDown size={12} />
              </button>
              {permissionMenuOpen ? (
                <div className="menuPopover permissionMenu" role="menu">
                  <button type="button" role="menuitem" onClick={() => choosePermissionMode("default")}>
                    <span>Default permissions</span>
                    <small>Approve once per chat</small>
                  </button>
                  <button type="button" role="menuitem" onClick={() => choosePermissionMode("bypass")}>
                    <span>Bypass permissions</span>
                    <small>Auto-run safe tools</small>
                  </button>
                </div>
              ) : null}
            </div>
            <button className="headerAttachButton" title="Attach files" onClick={() => void attachLocalFiles()} disabled={!selectedProject}>
              <Paperclip size={13} />
            </button>
            <ContextMeter usage={contextUsage} />
            <button className="folderButton" onClick={pickProject} title="Open folder">
              <FolderOpen size={13} />
              <span>{selectedProject?.name ?? "Open Folder"}</span>
            </button>
          </div>
          {attachedFiles.length > 0 ? (
            <div className="attachmentStrip">
              {attachedFiles.map((file) => {
                const key = file.projectPath ?? file.path;
                return (
                  <span className="attachmentChip" key={key} title={file.projectPath ?? file.path}>
                    <FileText size={12} />
                    <span>{file.name}</span>
                    <button type="button" title="Remove attachment" onClick={() => removeAttachedFile(key)}>
                      <X size={11} />
                    </button>
                  </span>
                );
              })}
            </div>
          ) : null}
          <div className="composerInput">
            {mentionQuery !== null ? (
              <div className="mentionPopover">
                {mentionMatches.length > 0 ? (
                  mentionMatches.map((file, index) => (
                    <button
                      type="button"
                      key={file.path}
                      className={index === mentionSelectedIndex ? "active" : ""}
                      onMouseEnter={() => setMentionSelectedIndex(index)}
                      onClick={() => attachProjectFile(file)}
                    >
                      {file.kind === "directory" ? <FolderOpen size={14} /> : <FileText size={14} />}
                      <span>
                        <strong>{file.name}</strong>
                        <small>{file.directory || "."}</small>
                      </span>
                    </button>
                  ))
                ) : projectFilesLoading ? (
                  <div className="mentionEmpty">Loading files...</div>
                ) : projectFilesError ? (
                  <div className="mentionEmpty">{projectFilesError}</div>
                ) : (
                  <div className="mentionEmpty">No files found</div>
                )}
              </div>
            ) : null}
            <textarea
              value={prompt}
              placeholder={socketState === "open" ? "Ask Gemma for a coding task…" : "Connecting to daemon…"}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (mentionQuery !== null) {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setMentionSelectedIndex((index) => Math.min(index + 1, Math.max(mentionMatches.length - 1, 0)));
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setMentionSelectedIndex((index) => Math.max(index - 1, 0));
                    return;
                  }
                  if ((event.key === "Enter" || event.key === "Tab") && mentionMatches[mentionSelectedIndex]) {
                    event.preventDefault();
                    attachProjectFile(mentionMatches[mentionSelectedIndex]);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setPrompt((current) => {
                      const start = activeMentionStart(current);
                      return start === null ? current : current.slice(0, start);
                    });
                    return;
                  }
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendTask();
                }
              }}
            />
            <button className="sendButton" title="Send task" onClick={sendTask} disabled={busy || socketState !== "open" || prompt.trim().length === 0}>
              {prompt.trim().length > 0 ? <ArrowUp size={16} /> : <Send size={15} />}
            </button>
          </div>
        </footer>
      </section>
      {error ? <div className="toastError">{error}</div> : null}

      {showBypassConfirm ? (
        <div className="modalScrim" role="dialog" aria-modal="true" aria-labelledby="bypass-title">
          <section className="confirmDialog">
            <div>
              <h2 id="bypass-title">Bypass permissions?</h2>
              <p>
                Aegis will auto-run non-destructive read tools for this chat. Destructive actions and tool creation still require approval.
              </p>
            </div>
            <div className="dialogActions">
              <button type="button" className="secondaryAction" onClick={() => setShowBypassConfirm(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="primaryAction"
                onClick={() => {
                  setPermissionMode("bypass");
                  setShowBypassConfirm(false);
                }}
              >
                Enable bypass
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function RailButton({ active, title, onClick, children }: React.PropsWithChildren<{ active: boolean; title: string; onClick: () => void }>) {
  return (
    <button className={`railItem ${active ? "active" : ""}`} title={title} onClick={onClick}>
      {children}
    </button>
  );
}

function BranchMenu({
  selectedBranch,
  branches,
  disabled,
  open,
  onOpenChange,
  onSelect,
}: {
  selectedBranch: string;
  branches: string[];
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (branch: string) => void;
}) {
  const rows = selectedBranch
    ? [selectedBranch, ...branches.filter((branch) => branch !== selectedBranch)]
    : branches;
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div className="menuControl branchMenuControl">
      <button
        ref={buttonRef}
        type="button"
        className="branchMenuButton"
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <GitBranch size={12} />
        <span>{selectedBranch || "No branch"}</span>
        <ChevronDown size={12} />
      </button>
      <FloatingMenu
        anchorRef={buttonRef}
        open={open}
        onClose={() => onOpenChange(false)}
        className="branchMenu"
      >
        {rows.length === 0 ? (
          <button type="button" disabled>
            No branches
          </button>
        ) : null}
        {rows.map((branch) => (
          <button
            key={branch}
            type="button"
            role="menuitem"
            className={branch === selectedBranch ? "active" : ""}
            onClick={() => {
              onSelect(branch);
              onOpenChange(false);
            }}
          >
            <GitBranch size={12} />
            <span>{branch}</span>
          </button>
        ))}
      </FloatingMenu>
    </div>
  );
}

function IdePicker({
  ides,
  selectedIde,
  selectedIdeId,
  disabled,
  open,
  onOpenChange,
  onOpenProject,
  onSelectIde,
}: {
  ides: IdeInstall[];
  selectedIde: IdeInstall;
  selectedIdeId: string;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenProject: () => void;
  onSelectIde: (id: string) => void;
}) {
  const chevronRef = useRef<HTMLButtonElement | null>(null);
  const list = ides.length > 0 ? ides : [{ id: "code", label: "VS Code", command: "code" }];
  return (
    <div className="menuControl">
      <div className="ideSplitControl">
        <button
          className="ideButton idePrimaryButton"
          onClick={onOpenProject}
          disabled={disabled}
          title={`Open project in ${selectedIde.label}`}
        >
          <IdeGlyph id={selectedIde.id} />
          <span>{selectedIde.label}</span>
        </button>
        <button
          ref={chevronRef}
          className="ideButton ideChevronButton"
          onClick={() => onOpenChange(!open)}
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open}
          title="Choose editor"
        >
          <ChevronDown size={13} />
        </button>
      </div>
      <FloatingMenu
        anchorRef={chevronRef}
        open={open}
        onClose={() => onOpenChange(false)}
        className="ideMenu"
      >
        {list.map((ide) => (
          <button
            key={ide.id}
            type="button"
            role="menuitem"
            className={ide.id === selectedIdeId ? "active" : ""}
            onClick={() => onSelectIde(ide.id)}
          >
            <IdeGlyph id={ide.id} />
            <span>{ide.label}</span>
          </button>
        ))}
      </FloatingMenu>
    </div>
  );
}

function FloatingMenu({
  anchorRef,
  open,
  onClose,
  className,
  children,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number; placement: "top" | "bottom" } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const measure = () => {
      const anchor = anchorRef.current;
      if (!anchor) {
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const menu = menuRef.current;
      const menuHeight = menu?.offsetHeight ?? 240;
      const menuWidth = menu?.offsetWidth ?? rect.width;
      const spaceBelow = window.innerHeight - rect.bottom;
      const placement = spaceBelow < menuHeight + 16 && rect.top > menuHeight ? "top" : "bottom";
      const left = Math.min(
        Math.max(8, rect.left),
        Math.max(8, window.innerWidth - menuWidth - 8),
      );
      const top = placement === "bottom" ? rect.bottom + 6 : rect.top - menuHeight - 6;
      setPosition({ top, left, placement });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open) {
    return null;
  }
  return createPortal(
    <div
      ref={menuRef}
      className={`menuPopover floatingMenu ${className ?? ""}`}
      role="menu"
      style={{
        position: "fixed",
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        opacity: position ? 1 : 0,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

function VsCodeLogo() {
  return (
    <svg viewBox="0 0 32 32" width="14" height="14" aria-hidden="true">
      <defs>
        <linearGradient id="vscG" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3aafff" />
          <stop offset="100%" stopColor="#0e75ce" />
        </linearGradient>
      </defs>
      <path
        fill="url(#vscG)"
        d="M24.4 1.3c.45-.27 1.02-.27 1.47 0l4.62 2.27c.6.3.97.91.97 1.59v21.66c0 .68-.37 1.29-.97 1.59l-4.62 2.27c-.45.27-1.02.27-1.47 0L12.04 21.32 6.65 25.5c-.5.4-1.22.36-1.69-.07L3.1 23.59c-.55-.51-.55-1.39 0-1.91L8.78 16 3.1 10.32c-.55-.52-.55-1.4 0-1.91L4.96 6.57c.47-.43 1.19-.47 1.69-.07l5.39 4.18L24.4 1.3zm-.27 7.78L15.2 16l8.93 6.92V9.08z"
      />
    </svg>
  );
}

function VisualStudioLogo() {
  return (
    <svg viewBox="0 0 32 32" width="14" height="14" aria-hidden="true">
      <defs>
        <linearGradient id="vsG" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#b18cf2" />
          <stop offset="100%" stopColor="#5c2d91" />
        </linearGradient>
      </defs>
      <path
        fill="url(#vsG)"
        d="M22.5 2.4 30 6.1c.6.3 1 .9 1 1.6v16.6c0 .7-.4 1.3-1 1.6l-7.5 3.7c-.7.3-1.5.2-2.1-.3L8.6 18.4 4 22.2c-.5.4-1.2.4-1.7 0l-1.1-1c-.4-.3-.4-1 0-1.4L6 16 1.2 12.2c-.4-.4-.4-1 0-1.4l1.1-1c.5-.4 1.2-.4 1.7 0l4.6 3.8L20.4 2.7c.6-.5 1.4-.6 2.1-.3zm0 9-7 4.6 7 4.6V11.4z"
      />
    </svg>
  );
}

function ExplorerLogo() {
  return (
    <svg viewBox="0 0 32 32" width="14" height="14" aria-hidden="true">
      <path fill="#dba74a" d="M3 9.2c0-1.1.9-2 2-2h6.4c.45 0 .88.18 1.2.5l1.7 1.7c.32.32.75.5 1.2.5H27c1.1 0 2 .9 2 2v9.9c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V9.2z" />
      <path fill="#f3c869" d="M5 12.5h22V22c0 1.1-.9 2-2 2H7c-1.1 0-2-.9-2-2V12.5z" />
    </svg>
  );
}

function ClionLogo() {
  return (
    <svg viewBox="0 0 32 32" width="14" height="14" aria-hidden="true">
      <defs>
        <linearGradient id="clionG" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#22d4f4" />
          <stop offset="50%" stopColor="#2090f4" />
          <stop offset="100%" stopColor="#ed358c" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="28" height="28" rx="6" fill="url(#clionG)" />
      <text x="16" y="21" textAnchor="middle" fontFamily="-apple-system, Segoe UI, sans-serif" fontSize="11" fontWeight="800" fill="#fff">CL</text>
    </svg>
  );
}

function IdeGlyph({ id }: { id: string }) {
  if (id === "code") {
    return <VsCodeLogo />;
  }
  if (id === "devenv") {
    return <VisualStudioLogo />;
  }
  if (id === "explorer") {
    return <ExplorerLogo />;
  }
  if (id === "clion") {
    return <ClionLogo />;
  }
  return <ExplorerLogo />;
}

function SidebarChats({
  chats,
  activeChatId,
  onSelect,
  onDelete,
}: {
  chats: LocalChat[];
  activeChatId: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="list">
      {chats.map((chat) => (
        <div
          className={`listItem chatItem ${chat.id === activeChatId ? "active" : ""}`}
          key={chat.id}
        >
          <button type="button" className="chatSelectButton" onClick={() => onSelect(chat.id)}>
            <strong>{chat.title}</strong>
            <span>{chat.branch || "no branch"} · {chat.messages.length} messages</span>
          </button>
          <button type="button" className="chatDeleteButton" title="Delete chat" onClick={() => onDelete(chat.id)}>
            <Trash2 size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

function SidebarGit({
  status,
  diff,
  branchInfo,
  worktrees,
  selectedBranch,
  setSelectedBranch,
  onRefresh,
  onOpenChangedFile,
  hasProject,
}: {
  status: GitResult | null;
  diff: GitResult | null;
  branchInfo: GitBranchInfo;
  worktrees: GitWorktreeInfo[];
  selectedBranch: string;
  setSelectedBranch: (branch: string) => void;
  onRefresh: () => void;
  onOpenChangedFile: (path: string) => void;
  hasProject: boolean;
}) {
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const files = parseGitStatusFiles(status);
  const diffFiles = diff?.stdout.trim() ? parseDiff(diff.stdout) : [];
  const statsByPath = diffStatsByPath(diffFiles);
  const totalStats = totalDiffLineStats(diffFiles);
  return (
    <div className="sidebarStack sourceControlStack">
      <div className="sourceControlTop">
        <button className="secondaryButton" onClick={onRefresh} disabled={!hasProject}>
          Refresh
        </button>
        <BranchMenu
          selectedBranch={selectedBranch}
          branches={branchInfo.branches}
          disabled={!hasProject}
          open={branchMenuOpen}
          onOpenChange={setBranchMenuOpen}
          onSelect={setSelectedBranch}
        />
      </div>
      {hasProject ? (
        <div className="sourceBranchLabel">
          <GitBranch size={12} />
          <span>{selectedBranch || branchInfo.current || "No branch"}</span>
        </div>
      ) : null}
      {diffFiles.length > 0 ? (
        <div className="sourceSummaryLine">
          <span>{diffFiles.length} file{diffFiles.length === 1 ? "" : "s"} changed</span>
          <DiffStatsBadge stats={totalStats} />
        </div>
      ) : null}
      {!hasProject ? <div className="emptyState">Open a project to inspect git status.</div> : null}
      {files.length > 0 ? (
        <div className="changedFileList">
          {files.map((file) => {
            const dir = fileDirectory(file.path);
            const stats = statsByPath.get(normalizeDiffPath(file.path));
            return (
              <div className="changedFileRow" key={`${file.status}-${file.path}`}>
                <button
                  type="button"
                  className="changedFileMain"
                  onClick={() => onOpenChangedFile(file.path)}
                >
                  <FileText size={14} />
                  <span className="changedFileText">
                    <span className="changedFileTitle">
                      <strong>{fileName(file.path)}</strong>
                    </span>
                    {dir ? <small>{dir}</small> : null}
                    {stats ? <DiffStatsBadge stats={stats} block /> : null}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      ) : status ? (
        <div className="emptyState">{status.stderr || "Working tree clean."}</div>
      ) : null}
    </div>
  );
}

function SidebarData({
  telemetry,
  health,
  socketState,
  storeOverview,
}: {
  telemetry: unknown;
  health: DaemonHealth | null;
  socketState: SocketState;
  storeOverview: StoreOverview | null;
}) {
  return (
    <div className="sidebarStack dataStack">
      <div className="kvCard">
        <div className="kvRow"><span>Socket</span><strong>{socketState}</strong></div>
        <div className="kvRow"><span>Daemon</span><strong>{health?.daemon ?? "—"}</strong></div>
        <div className="kvRow"><span>LM Studio</span><strong>{health?.lm_studio ?? "—"}</strong></div>
        <div className="kvRow"><span>Index</span><strong>{health?.semantic_index ?? "—"}</strong></div>
      </div>
      {storeOverview ? (
        <div className="kvCard">
          <div className="kvRow"><span>Projects</span><strong>{storeOverview.projects}</strong></div>
          <div className="kvRow"><span>Sessions</span><strong>{storeOverview.sessions}</strong></div>
          <div className="kvRow"><span>Turns</span><strong>{storeOverview.turns}</strong></div>
          <div className="kvRow"><span>Tool calls</span><strong>{storeOverview.tool_calls}</strong></div>
          <div className="kvRow"><span>Index chunks</span><strong>{storeOverview.index_chunks}</strong></div>
        </div>
      ) : null}
      <details className="rawTelemetry">
        <summary>Raw JSON</summary>
        <pre>{JSON.stringify(telemetry, null, 2)}</pre>
      </details>
    </div>
  );
}

function SidebarTools({
  tools,
  operatingSystem,
  onToggle,
  onUpdate,
  onReset,
}: {
  tools: AgentTool[];
  operatingSystem: string;
  onToggle: (id: string, enabled: boolean) => void;
  onUpdate: (id: string, patch: Partial<Pick<AgentTool, "label" | "summary" | "command">>) => void;
  onReset: () => void;
}) {
  const enabledCount = tools.filter((tool) => tool.enabled).length;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const allEnabled = enabledCount === tools.length;
  const setAll = (enabled: boolean) => {
    for (const tool of tools) {
      if (tool.enabled !== enabled) {
        onToggle(tool.id, enabled);
      }
    }
  };
  return (
    <div className="sidebarStack toolsStack">
      <div className="toolHeader">
        <div className="toolHeaderStat">
          <strong>{enabledCount}</strong>
          <span>/ {tools.length} enabled</span>
        </div>
        <div className="toolHeaderStat alt" title="Harness operating system">
          <strong>{operatingSystem}</strong>
          <span>harness</span>
        </div>
      </div>
      <div className="toolHeaderActions">
        <button
          type="button"
          className="ghostButton"
          onClick={() => setAll(!allEnabled)}
        >
          {allEnabled ? "Disable all" : "Enable all"}
        </button>
        <button type="button" className="ghostButton" onClick={onReset}>
          Reset
        </button>
      </div>
      <div className="toolCardList">
        {tools.map((tool) => {
          const expanded = expandedId === tool.id;
          return (
            <div className={`toolCard ${tool.enabled ? "enabled" : "disabled"}`} key={tool.id}>
              <div className="toolCardHead">
                <span className={`toolKindDot ${tool.kind}`} aria-hidden="true" />
                <div className="toolCardTitle">
                  <strong>{tool.label}</strong>
                  <small>{tool.summary}</small>
                </div>
                <div className="toolCardActions">
                  <button
                    type="button"
                    className="toolEditButton"
                    title={expanded ? "Hide details" : "Edit"}
                    onClick={() => setExpandedId(expanded ? null : tool.id)}
                    aria-expanded={expanded}
                  >
                    <ChevronDown
                      size={13}
                      style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 120ms ease" }}
                    />
                  </button>
                  <label className="toolSwitch" title={tool.enabled ? "Enabled" : "Disabled"}>
                    <input
                      type="checkbox"
                      checked={tool.enabled}
                      onChange={(event) => onToggle(tool.id, event.target.checked)}
                      aria-label={`${tool.id} enabled`}
                    />
                    <span className="toolSwitchTrack" aria-hidden="true">
                      <span className="toolSwitchThumb" />
                    </span>
                  </label>
                </div>
              </div>
              <div className="toolCardMeta">
                <span className={`toolKind ${tool.kind}`}>{tool.kind}</span>
                <code className="toolCardCommand">{tool.command}</code>
              </div>
              {expanded ? (
                <div className="toolCardEditor">
                  <label>
                    <span>Label</span>
                    <input
                      aria-label={`${tool.id} label`}
                      value={tool.label}
                      onChange={(event) => onUpdate(tool.id, { label: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>Summary</span>
                    <textarea
                      aria-label={`${tool.id} summary`}
                      value={tool.summary}
                      onChange={(event) => onUpdate(tool.id, { summary: event.target.value })}
                      rows={2}
                    />
                  </label>
                  <label>
                    <span>Command</span>
                    <input
                      aria-label={`${tool.id} command`}
                      className="toolCommandInput"
                      value={tool.command}
                      onChange={(event) => onUpdate(tool.id, { command: event.target.value })}
                    />
                  </label>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PermissionApprovalBar({
  request,
  busy,
  onAccept,
  onDecline,
}: {
  request: ToolApprovalRequest;
  busy: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const isTerminalCommand = request.toolName === "terminal.run";
  return (
    <div className="approvalBar">
      <div className="approvalCopy">
        <span>Permission request</span>
        {isTerminalCommand ? (
          <CopyableCodeBlock language="command" content={request.command} />
        ) : (
          <code>{request.command}</code>
        )}
      </div>
      <div className="approvalActions">
        <button type="button" className="approvalAccept" onClick={onAccept} disabled={busy}>
          <CheckCircle2 size={13} />
          Accept
        </button>
        <button type="button" className="approvalDecline" onClick={onDecline} disabled={busy}>
          <X size={13} />
          Decline
        </button>
      </div>
    </div>
  );
}

function ContextMeter({ usage }: { usage: ContextUsageState }) {
  const used = usage.promptTokens.toLocaleString();
  const max = usage.maxContextTokens ? usage.maxContextTokens.toLocaleString() : "unknown";
  const statusLabel =
    usage.status === "loading"
      ? "Counting"
      : usage.status === "ready"
        ? "Exact count"
        : "Unavailable";
  return (
    <div
      className={`contextMeterWrap ${usage.status}`}
      style={{ "--context-percent": `${usage.percent}%` } as React.CSSProperties}
      aria-label={`Context tokens: ${used} of ${max}`}
      tabIndex={0}
    >
      <span className="contextMeter" />
      <span className="contextPopover" role="tooltip">
        <strong>{statusLabel}</strong>
        <span>{used} tokens used</span>
        <span>{max} max context</span>
        <span>{usage.messageCount} app messages in payload</span>
        <small>{usage.detail}</small>
      </span>
    </div>
  );
}

function TerminalView({
  projectRoot,
  operatingSystem,
  output,
  input,
  locked,
  onInputChange,
  onStart,
  onSubmit,
}: {
  projectRoot: string;
  operatingSystem: string;
  output: string;
  input: string;
  locked: boolean;
  onInputChange: (value: string) => void;
  onStart: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="terminalView">
      <div className="terminalHeader">
        <Terminal size={14} />
        <span>{projectRoot || "No project opened"}</span>
        <button type="button" onClick={onStart}>Start</button>
      </div>
      <pre className="terminalPre">
        {`os=${operatingSystem}\ncwd=${projectRoot || "(none)"}\n`}
        {output || "\n# Start a terminal to run commands here."}
      </pre>
      <div className="terminalInputRow">
        <span>$</span>
        <input
          value={input}
          disabled={locked}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void onSubmit();
            }
          }}
          placeholder={locked ? "Agent is using the terminal" : "Run a command"}
        />
      </div>
    </div>
  );
}

function ThinkingBubble({ line }: { line: ChatLine }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!line.streaming) {
      return undefined;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [line.streaming]);

  const elapsed = thinkingDuration(line, now);
  const durationText = elapsed === null ? "" : ` for ${formatDuration(elapsed)}`;
  const label = line.streaming ? `Working${durationText}` : `Worked${durationText}`;

  return (
    <details className="thinkingBubble" open={line.streaming || undefined}>
      <summary>
        <span className="thinkingSummaryText">
          {line.streaming ? <span className="thinkingPulse" /> : null}
          <span>{label}</span>
        </span>
        <ChevronRight className="thinkingChevron" size={13} />
      </summary>
      <p>{line.content || "Starting..."}</p>
    </details>
  );
}

function ChatView({ chat, busy, onShowDiff }: { chat: LocalChat; busy: boolean; onShowDiff: () => void }) {
  const streamRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = streamRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [chat.messages.length, chat.messages[chat.messages.length - 1]?.content]);

  if (chat.messages.length === 0 && !busy) {
    return (
      <div className="blankSlate">
        <h1>Local Coding Agent</h1>
        <p>Open a folder, choose a branch, then ask for a coding change. Each chat keeps its own messages and tool trail.</p>
      </div>
    );
  }
  return (
    <div className="chatStream" ref={streamRef}>
      {chat.messages.map((line, index) => {
        const isStreamingPlaceholder = line.role === "assistant" && line.streaming && line.content.length === 0;
        return (
          <article className={`message ${line.role}${line.streaming ? " streaming" : ""}`} key={`${line.role}-${index}`}>
            {line.role === "tool" ? (
              <div className="toolBubble">
                {line.status === "ready" ? <CheckCircle2 size={12} /> : line.status === "unavailable" ? <TriangleAlert size={12} /> : <Wrench size={12} />}
                <div>
                  <span>{line.detail || line.content || toolDisplayText(line.toolName ?? "tool", line.status !== "degraded", line.status !== "unavailable")}</span>
                </div>
              </div>
            ) : line.role === "thinking" ? (
              <ThinkingBubble line={line} />
            ) : isStreamingPlaceholder ? (
              <p className="streamingPending">
                <span className="streamDot" />
                <span className="streamDot" />
                <span className="streamDot" />
              </p>
            ) : line.role === "assistant" ? (
              <>
                <MarkdownContent content={cleanAssistantMessage(line.content)} />
                {line.streaming ? <span className="streamingCaret markdownCaret" aria-hidden="true" /> : null}
              </>
            ) : (
              <p>
                {renderMessageContent(line.content, line.role)}
                {line.streaming ? <span className="streamingCaret" aria-hidden="true" /> : null}
              </p>
            )}
          </article>
        );
      })}
      {chat.diffAvailable ? (
        <div className="chatDiffNotice">
          <GitBranch size={14} />
          <span>{chat.changedFileCount ?? 0} changed file{chat.changedFileCount === 1 ? "" : "s"}</span>
          <DiffStatsBadge stats={chat.changedLineStats} />
          <button type="button" onClick={onShowDiff}>View diff</button>
        </div>
      ) : null}
    </div>
  );
}

type ParsedDiffLine = {
  kind: "meta" | "hunk" | "add" | "remove" | "context";
  content: string;
  oldLine?: number;
  newLine?: number;
};

type ParsedDiffFile = {
  oldPath: string;
  newPath: string;
  lines: ParsedDiffLine[];
};

type SideBySideRow = {
  kind: "context" | "add" | "remove" | "change" | "meta" | "hunk";
  oldLine?: number;
  newLine?: number;
  oldContent: string;
  newContent: string;
};

const DIFF_ROW_LIMIT = 450;

function parseDiff(text: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { oldPath: "", newPath: "", lines: [] };
      files.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith("--- ")) {
      current.oldPath = line.replace(/^---\s+a\//, "").trim();
      continue;
    }
    if (line.startsWith("+++ ")) {
      current.newPath = line.replace(/^\+\+\+\s+b\//, "").trim();
      continue;
    }
    if (
      line.startsWith("index ") ||
      line.startsWith("new file mode ") ||
      line.startsWith("deleted file mode ") ||
      line.startsWith("similarity index ") ||
      line.startsWith("rename from ") ||
      line.startsWith("rename to ") ||
      line.startsWith("\\ No newline")
    ) {
      continue;
    }
    if (line.startsWith("@@")) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldLine = match ? Number(match[1]) : oldLine;
      newLine = match ? Number(match[2]) : newLine;
      current.lines.push({ kind: "hunk", content: line });
      continue;
    }
    if (line.startsWith("+")) {
      current.lines.push({ kind: "add", content: line, newLine });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      current.lines.push({ kind: "remove", content: line, oldLine });
      oldLine += 1;
      continue;
    }
    current.lines.push({ kind: "context", content: line, oldLine, newLine });
    oldLine += 1;
    newLine += 1;
  }

  return files.filter((file) => file.newPath || file.oldPath || file.lines.length > 1);
}

function firstChangedLine(file: ParsedDiffFile): number {
  return file.lines.find((line) => line.kind === "add" && line.newLine)?.newLine ?? 1;
}

function changedLineCount(file: ParsedDiffFile): number {
  return file.lines.filter((line) => line.kind === "add" || line.kind === "remove").length;
}

function diffLineStats(file: ParsedDiffFile): DiffLineStats {
  return {
    added: file.lines.filter((line) => line.kind === "add").length,
    removed: file.lines.filter((line) => line.kind === "remove").length,
  };
}

function totalDiffLineStats(files: ParsedDiffFile[]): DiffLineStats {
  return files.reduce(
    (total, file) => {
      const stats = diffLineStats(file);
      return {
        added: total.added + stats.added,
        removed: total.removed + stats.removed,
      };
    },
    { added: 0, removed: 0 },
  );
}

function normalizeDiffPath(path: string): string {
  return path.replace(/^"|"$/g, "").replace(/\\/g, "/");
}

function diffPathKeys(file: ParsedDiffFile): string[] {
  return [file.newPath, file.oldPath, visibleFilePath(file), openableDiffPath(file)]
    .filter((path): path is string => !!path && path !== "/dev/null")
    .map(normalizeDiffPath);
}

function diffStatsByPath(files: ParsedDiffFile[]): Map<string, DiffLineStats> {
  const stats = new Map<string, DiffLineStats>();
  for (const file of files) {
    const fileStats = diffLineStats(file);
    for (const path of diffPathKeys(file)) {
      stats.set(path, fileStats);
    }
  }
  return stats;
}

function DiffStatsBadge({ stats, block = false }: { stats?: DiffLineStats; block?: boolean }) {
  if (!stats || (stats.added === 0 && stats.removed === 0)) {
    return null;
  }
  return (
    <span className={`diffStatsBadge${block ? " block" : ""}`}>
      {stats.added > 0 ? <strong className="added">+{stats.added}</strong> : null}
      {stats.removed > 0 ? <strong className="removed">-{stats.removed}</strong> : null}
    </span>
  );
}


function visibleFilePath(file: ParsedDiffFile): string {
  return normalizeDiffPath(file.newPath || file.oldPath).replace(/^\/dev\/null$/, "New file");
}

function openableDiffPath(file: ParsedDiffFile): string {
  if (file.newPath && file.newPath !== "/dev/null") {
    return file.newPath;
  }
  return file.oldPath;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function fileDirectory(path: string): string {
  const parts = path.split(/[\\/]/);
  parts.pop();
  return parts.join("/");
}

function fileChangeStatus(file: ParsedDiffFile): string {
  if (file.oldPath === "/dev/null") {
    return "A";
  }
  if (file.newPath === "/dev/null") {
    return "D";
  }
  return "M";
}

function statusLabel(status: string): string {
  const trimmed = status.trim();
  if (trimmed.includes("A") || trimmed.includes("?")) {
    return "A";
  }
  if (trimmed.includes("D")) {
    return "D";
  }
  return "M";
}

function parseGitStatusFiles(status?: GitResult | null): Array<{ path: string; status: string }> {
  if (!status?.stdout.trim()) {
    return [];
  }
  return status.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const statusPart = line.slice(0, 2);
      const pathPart = line.slice(3).trim();
      const renamed = pathPart.includes(" -> ") ? pathPart.split(" -> ").pop() ?? pathPart : pathPart;
      return {
        path: normalizeDiffPath(renamed),
        status: statusLabel(statusPart),
      };
    });
}

function hunkLabel(content: string): string {
  const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@\s*(.*)/.exec(content);
  if (!match) {
    return "Changed section";
  }
  const title = match[3]?.trim();
  return title ? `Changed around line ${match[2]} · ${title}` : `Changed around line ${match[2]}`;
}

function toSideBySideRows(file: ParsedDiffFile): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  for (let index = 0; index < file.lines.length; index += 1) {
    const line = file.lines[index];
    if (line.kind === "remove") {
      rows.push({
        kind: "remove",
        oldLine: line.oldLine,
        oldContent: line.content.slice(1),
        newContent: "",
      });
      continue;
    }
    if (line.kind === "add") {
      rows.push({
        kind: "add",
        newLine: line.newLine,
        oldContent: "",
        newContent: line.content.slice(1),
      });
      continue;
    }
    if (line.kind === "context") {
      const content = line.content.startsWith(" ") ? line.content.slice(1) : line.content;
      rows.push({
        kind: "context",
        oldLine: line.oldLine,
        newLine: line.newLine,
        oldContent: content,
        newContent: content,
      });
      continue;
    }
    if (line.kind === "hunk") {
      continue;
    }
    rows.push({
      kind: line.kind,
      oldContent: line.content,
      newContent: line.content,
    });
  }
  return rows;
}

function oldDiffCellKind(row: SideBySideRow): string {
  if (row.kind === "add") {
    return "blank";
  }
  if (row.kind === "change") {
    return "remove";
  }
  return row.kind;
}

function newDiffCellKind(row: SideBySideRow): string {
  if (row.kind === "remove") {
    return "blank";
  }
  if (row.kind === "change") {
    return "add";
  }
  return row.kind;
}

function diffCellContent(row: SideBySideRow, side: "old" | "new"): string {
  if (side === "old") {
    if (row.kind === "remove" || row.kind === "change") {
      return row.oldContent;
    }
    if (row.kind === "add") {
      return "";
    }
    return row.oldContent;
  }
  if (row.kind === "add" || row.kind === "change") {
    return row.newContent;
  }
  if (row.kind === "remove") {
    return "";
  }
  return row.newContent;
}

function DiffView({
  diff,
  hasProject,
  selectedPath,
  openLabel,
  onOpenFile,
  onSelectFile,
}: {
  diff: GitResult | null;
  hasProject: boolean;
  selectedPath: string;
  openLabel: string;
  onOpenFile: (path: string, line: number) => void;
  onSelectFile: (path: string) => void;
}) {
  const diffText = diff?.stdout ?? "";
  const files = diffText.trim() ? parseDiff(diffText) : [];
  const selectedKey = normalizeDiffPath(selectedPath);
  const selectedFile = files.find((file) => diffPathKeys(file).includes(selectedKey)) ?? files[0];
  const selectedRows = selectedFile ? toSideBySideRows(selectedFile) : [];
  const tooLarge = selectedRows.length > DIFF_ROW_LIMIT;
  const visibleRows = tooLarge ? selectedRows.slice(0, DIFF_ROW_LIMIT) : selectedRows;

  if (!hasProject) {
    return <div className="blankSlate"><h1>Diff</h1><p>Open a project to inspect the current git diff.</p></div>;
  }
  if (!diffText.trim()) {
    return <div className="blankSlate"><h1>Diff</h1><p>{diff?.stderr || "No unstaged diff in the selected project."}</p></div>;
  }
  return (
    <div className="diffReview">
      <aside className="diffExplorer">
        <div className="diffExplorerHeader">
          <strong>Changed Files</strong>
          <span>{files.length}</span>
        </div>
        <div className="changedFileList">
          {files.map((file) => {
            const path = visibleFilePath(file);
            const dir = fileDirectory(path);
            const stats = diffLineStats(file);
            const isActive = selectedFile && diffPathKeys(selectedFile).includes(path);
            return (
              <div className="changedFileRow" key={`${file.oldPath}-${file.newPath}`}>
                <button
                  type="button"
                  className={`changedFileMain${isActive ? " active" : ""}`}
                  onClick={() => onSelectFile(path)}
                >
                  <FileText size={14} />
                  <span className="changedFileText">
                    <span className="changedFileTitle">
                      <strong>{fileName(path)}</strong>
                    </span>
                    {dir ? <small>{dir}</small> : null}
                    <DiffStatsBadge stats={stats} block />
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </aside>
      <section className="diffWorkbench">
        {selectedFile ? (
          <>
            <header className="diffWorkbenchHeader">
              <div>
                <strong>{fileName(visibleFilePath(selectedFile))}</strong>
                <span>{visibleFilePath(selectedFile)} · {changedLineCount(selectedFile)} changed line{changedLineCount(selectedFile) === 1 ? "" : "s"}</span>
              </div>
              <button type="button" onClick={() => onOpenFile(openableDiffPath(selectedFile), firstChangedLine(selectedFile))}>
                <FileText size={14} />
                {openLabel}
              </button>
            </header>
            {tooLarge ? (
              <div className="diffLimitNotice">
                This file has {selectedRows.length} diff rows. Showing the first {DIFF_ROW_LIMIT}; choose files one-by-one from the explorer to review changes step by step.
              </div>
            ) : null}
            <div className="sideBySideDiff">
              <div className="sideHeader">Previous</div>
              <div className="sideHeader">Current</div>
              {visibleRows.map((row, index) => (
                <React.Fragment key={`${row.kind}-${index}`}>
                  <div className={`sideCell old ${oldDiffCellKind(row)}`}>
                    <span className="lineNo">{row.oldLine ?? ""}</span>
                    <code>{diffCellContent(row, "old")}</code>
                  </div>
                  <div className={`sideCell new ${newDiffCellKind(row)}`}>
                    <span className="lineNo">{row.newLine ?? ""}</span>
                    <code>{diffCellContent(row, "new")}</code>
                  </div>
                </React.Fragment>
              ))}
            </div>
          </>
        ) : (
          <div className="blankSlate"><h1>Diff</h1><p>No changed files to review.</p></div>
        )}
      </section>
    </div>
  );
}

{
  const ua = navigator.userAgent;
  const platform = /Mac|iPhone|iPad/i.test(ua) ? "mac" : /Windows/i.test(ua) ? "win" : "linux";
  document.documentElement.dataset.platform = platform;
}

createRoot(document.getElementById("root")!).render(<App />);
