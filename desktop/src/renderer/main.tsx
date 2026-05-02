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
  ShieldCheck,
  ShieldQuestion,
  Terminal,
  Trash2,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";
import "./styles.css";

type ServiceStatus = "ready" | "degraded" | "unavailable";
type SocketState = "idle" | "connecting" | "open" | "closed";
type RailView = "chats" | "data";
type MainTab = "chat" | "diff" | "terminal";
type PermissionMode = "default" | "bypass";
type OpenCodeRuntime = "docker-sandbox" | "host";
type StreamPartKind = "answer" | "reasoning" | "pending";

type OpenCodeHealth = {
  opencode: ServiceStatus;
  sqlite_path: string;
  lm_studio: ServiceStatus;
  model_base_url: string;
  semantic_index: ServiceStatus;
};

type ChatLine = {
  role: "user" | "assistant" | "tool" | "thinking";
  content: string;
  toolName?: string;
  status?: ServiceStatus;
  detail?: string;
  command?: string;
  output?: string;
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
  assistant_message?: string;
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
  changedFilePaths?: string[];
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
};

const CHAT_STORAGE_KEY = "aegis.workspace.v2";

type RequestedToolCall = {
  tool: string;
  args: Record<string, unknown>;
};

type DesktopConnection =
  | {
      status: "ready";
      url: string;
      runtime: OpenCodeRuntime;
      sandbox?: {
        driver: "sbx" | "docker-sandbox";
        name: string;
        workspace: string;
      };
      username: string;
      password: string;
      authHeader: string;
      model: {
        providerId: "aegis-lmstudio";
        modelId: string;
        displayName: string;
        lmStudioBaseUrl: string;
        lmStudio: ServiceStatus;
      };
      privacy: {
        share: "disabled";
        enabledProviders: string[];
        disabledProviders: string[];
        webTools: "disabled";
      };
    }
  | { status: "missing"; message: string }
  | { status: "error"; message: string };

type PickProjectResult =
  | { canceled: true }
  | { canceled: false; rootPath: string; name: string };

type IdeOpenResult = { ok: true } | { ok: false; message: string };

type DesktopApi = {
  getOpenCodeConnection(): Promise<DesktopConnection>;
  restartOpenCode(): Promise<DesktopConnection>;
  nativeRequest<T = unknown>(payload: unknown): Promise<T>;
  setPermissionMode?(mode: PermissionMode): Promise<DesktopConnection>;
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
    getOpenCodeConnection: async () => ({
      status: "missing",
      message: "This is the browser preview. Open the Electron window from npm run desktop:dev.",
    }),
    restartOpenCode: async () => ({
      status: "missing",
      message: "This is the browser preview. Open the Electron window from npm run desktop:dev.",
    }),
    nativeRequest: async () => {
      throw new Error("Native Aegis helpers are only available in Electron.");
    },
    setPermissionMode: async () => ({
      status: "missing",
      message: "Permission modes are only available in Electron.",
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
    command: typeof line.command === "string" ? line.command : undefined,
    output: typeof line.output === "string" ? line.output : undefined,
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
    changedFilePaths: Array.isArray(chat.changedFilePaths)
      ? chat.changedFilePaths.filter((path): path is string => typeof path === "string")
      : [],
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
  const cleaned = stripRepeatedSuffix(stripDuplicatedText(stripChainOfThought(
    stripPartialToolCallTail(stripInlineToolCallJson(stripTaggedToolCalls(content))),
  )))
    .replace(/\n+\s*Files changed:\s*(?:none|[^\n]*)\s*\n\s*Verified:\s*[^\n]*\s*$/i, "")
    .replace(/\n+\s*Files changed:\s*none\.?\s*Verified:\s*(?:not verified|tool result returned)\.?\s*$/i, "")
    .trim();
  return /^[\s:.,;*-]*$/.test(cleaned) ? "" : cleaned;
}

function stripDuplicatedText(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length % 2 === 0) {
    const half = trimmed.length / 2;
    const left = trimmed.slice(0, half).trim();
    const right = trimmed.slice(half).trim();
    if (left && left === right) {
      return left;
    }
  }
  const lines = trimmed.split("\n");
  if (lines.length % 2 === 0) {
    const half = lines.length / 2;
    const left = lines.slice(0, half).join("\n").trim();
    const right = lines.slice(half).join("\n").trim();
    if (left && left === right) {
      return left;
    }
  }
  return trimmed;
}

function stripRepeatedSuffix(content: string): string {
  let text = content.trim();
  if (!text) return "";
  for (let length = Math.floor(text.length / 2); length >= 24; length -= 1) {
    const suffix = text.slice(text.length - length).trim();
    const before = text.slice(0, text.length - length).trimEnd();
    if (!suffix || !before.endsWith(suffix)) {
      continue;
    }
    text = before;
    break;
  }
  return text;
}

function mergeRelatedText(existing: string, incoming: string): string {
  const left = existing.trim();
  const right = incoming.trim();
  if (!left) return right;
  if (!right) return left;
  if (left === right) return left;
  if (right.startsWith(left) || right.includes(left)) return right;
  if (left.startsWith(right) || left.includes(right)) return left;
  return right.length >= left.length ? right : left;
}

function splitReasoningFromAnswer(content: string): { reasoning: string; answer: string } {
  const text = content.trim();
  if (!looksLikeReasoningText(text)) {
    return { reasoning: "", answer: content };
  }
  const lower = text.toLowerCase();
  const markers = [
    "final output generation.",
    "final output generation",
    "final answer:",
    "final response:",
    "\nanswer:",
    "\nresponse:",
  ];
  for (const marker of markers) {
    const index = lower.lastIndexOf(marker);
    if (index >= 0) {
      const answerStart = index + marker.length;
      return {
        reasoning: text.slice(0, index).trim(),
        answer: text.slice(answerStart).trim(),
      };
    }
  }
  const conclusion = /\n\s*(?:\*{0,2}Conclusion:\*{0,2}|Conclusion:)[^\n]*(?:\n+|$)/i.exec(text);
  if (conclusion && conclusion.index + conclusion[0].length < text.length) {
    const answer = text.slice(conclusion.index + conclusion[0].length).trim();
    if (answer && !looksLikeReasoningText(answer)) {
      return {
        reasoning: text.slice(0, conclusion.index + conclusion[0].length).trim(),
        answer,
      };
    }
  }
  return { reasoning: text, answer: "" };
}

function looksLikeReasoningText(content: string): boolean {
  const trimmed = content.trimStart().replace(/^[:\s*-]+/, "").toLowerCase();
  return (
    trimmed.startsWith("thinking process:") ||
    trimmed.startsWith("thought process:") ||
    trimmed.startsWith("reasoning:") ||
    trimmed.startsWith("analysis:") ||
    trimmed.startsWith("1. **analyze the user's input") ||
    trimmed.startsWith("1. analyze the user's input") ||
    COT_PREFIXES.some((prefix) => trimmed.startsWith(prefix.toLowerCase()))
  );
}

function stripLeadingUserEcho(content: string, userMessage: string): string {
  const user = userMessage.trim();
  const text = content.trimStart();
  if (!user || !text.startsWith(user)) {
    return content;
  }
  const rest = text.slice(user.length);
  return rest.length === 0 || /^[\s:.-]/.test(rest) ? rest.trimStart() : content;
}

function appendDistinctText(chunks: string[]): string {
  const rows: string[] = [];
  for (const chunk of chunks.map((value) => value.trim()).filter(Boolean)) {
    const duplicateIndex = rows.findIndex((row) => row === chunk || row.includes(chunk) || chunk.includes(row));
    if (duplicateIndex >= 0) {
      if (chunk.length > rows[duplicateIndex].length) {
        rows[duplicateIndex] = chunk;
      }
      continue;
    }
    rows.push(chunk);
  }
  return stripDuplicatedText(rows.join("\n"));
}

function stripPartialToolCallTail(content: string): string {
  const markers = ["{\"tool\"", "{ \"tool\"", "{\n\"tool\"", "<|tool_call>"];
  let cut = -1;
  for (const marker of markers) {
    const idx = content.indexOf(marker);
    if (idx >= 0 && (cut < 0 || idx < cut)) {
      cut = idx;
    }
  }
  if (cut < 0) return content;
  let preceding = cut;
  while (preceding > 0 && /[ \t]/.test(content[preceding - 1])) {
    preceding -= 1;
  }
  return content.slice(0, preceding);
}

function stripTaggedToolCalls(content: string): string {
  let out = "";
  let rest = content;
  while (true) {
    const start = rest.indexOf("<|tool_call>");
    if (start < 0) {
      out += rest;
      break;
    }
    out += rest.slice(0, start);
    const after = rest.slice(start + "<|tool_call>".length);
    const end = after.indexOf("<tool_call|>");
    rest = end >= 0 ? after.slice(end + "<tool_call|>".length) : "";
  }
  return out;
}

function stripInlineToolCallJson(content: string): string {
  let out = "";
  let i = 0;
  let lastEmitted = 0;
  while (i < content.length) {
    if (content[i] === "{") {
      const end = matchingBrace(content, i);
      if (end > i) {
        const candidate = content.slice(i, end + 1);
        if (candidate.includes("\"tool\"")) {
          try {
            const parsed = JSON.parse(candidate) as Record<string, unknown>;
            if (typeof parsed.tool === "string") {
              out += content.slice(lastEmitted, i);
              let after = end + 1;
              while (after < content.length && /[\s,]/.test(content[after])) {
                after += 1;
              }
              lastEmitted = after;
              i = after;
              continue;
            }
          } catch {
            // not JSON; fall through
          }
        }
      }
    }
    i += 1;
  }
  out += content.slice(lastEmitted);
  return out;
}

function matchingBrace(content: string, start: number): number {
  if (content[start] !== "{") return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < content.length; i += 1) {
    const ch = content[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const COT_PREFIXES = [
  "Thinking Process:",
  "Thought Process:",
  "Reasoning:",
  "The user wants",
  "The user is asking",
  "The user has",
  "The user provided",
  "The user's request",
  "Let me think",
  "Let me start",
  "Let me first",
  "I need to",
  "I will start",
  "I will use",
  "I will create",
  "I will write",
  "I will now",
  "First, I",
  "First I",
  "Plan:",
  "**Plan",
  "Let's start",
  "Looking at",
  "Analysis:",
  "Since this",
  "Given the",
  "Okay, the user",
];

function looksLikePotentialReasoningPrefix(content: string): boolean {
  const trimmed = content.trimStart().replace(/^[:\s*-]+/, "").toLowerCase();
  if (!trimmed) {
    return false;
  }
  return COT_PREFIXES.some((prefix) => {
    const normalizedPrefix = prefix.toLowerCase();
    return normalizedPrefix.startsWith(trimmed) && trimmed.length < normalizedPrefix.length;
  });
}

function shouldHoldOpeningStreamFragment(content: string): boolean {
  const trimmed = content.trim();
  return looksLikePotentialReasoningPrefix(trimmed) || /^[A-Za-z]{1,12}$/.test(trimmed);
}

function stripChainOfThought(content: string): string {
  const trimmed = content.trimStart().replace(/^[:\s*-]+(?=(?:\d+\.|thinking|thought|reasoning|analysis|the user|i need|i will))/i, "");
  const lower = trimmed.toLowerCase();
  if (!looksLikeReasoningText(trimmed)) {
    return content;
  }
  const split = splitReasoningFromAnswer(trimmed);
  if (split.answer) {
    return split.answer;
  }
  const markers = ["\nhere is", "\nhere's", "\nhere are", "\n```", "\n# ", "\n## ", "\n### "];
  let earliest = -1;
  for (const marker of markers) {
    const idx = lower.indexOf(marker);
    if (idx >= 0 && (earliest < 0 || idx + 1 < earliest)) {
      earliest = idx + 1;
    }
  }
  if (earliest > 0) {
    return trimmed.slice(earliest);
  }
  return "";
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
  const record = data as Record<string, unknown>;
  const state = record.state && typeof record.state === "object" ? (record.state as Record<string, unknown>) : {};
  const candidates = [record.args, record.input, state.args, state.input, state.metadata];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      return candidate as Record<string, unknown>;
    }
  }
  return {};
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
  const args = toolArgs(data);
  const directCommand = stringArg(args, ["command", "cmd"]);
  if (directCommand) {
    return directCommand;
  }
  if (toolName === "file.write") {
    const path = stringArg(args, ["path", "file", "project_path"]);
    return `Write ${mentionTarget(path) || "file"}`;
  }
  const record = data as Record<string, unknown>;
  if (typeof record.command === "string" && record.command.trim()) {
    return record.command.trim();
  }
  return JSON.stringify({ tool: toolName, args: toolArgs(data) });
}

function toolOutputText(data: unknown): string {
  if (!data || typeof data !== "object") {
    return "";
  }
  const record = data as Record<string, unknown>;
  const state = record.state && typeof record.state === "object" ? (record.state as Record<string, unknown>) : {};
  for (const value of [state.output, state.stdout, state.stderr, state.result, state.error, record.output, record.result]) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
    if (value && typeof value === "object") {
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        // ignore non-serializable tool payloads
      }
    }
  }
  return "";
}

function toolChangedPath(toolName: string, data: unknown): string {
  const name = toolName.toLowerCase();
  if (!/(^|\.)(write|edit)$/.test(name) && !name.includes("write") && !name.includes("edit")) {
    return "";
  }
  const path = stringArg(toolArgs(data), ["filePath", "filepath", "path", "file", "project_path"]);
  return path ? normalizeDiffPath(path) : "";
}

function eventToolPayload(properties: Record<string, unknown>, part: Record<string, unknown> | null): {
  toolName: string;
  status: "running" | "completed" | "error";
  detail: string;
  command: string;
  output: string;
  raw: unknown;
} | null {
  const source = part ?? properties;
  const toolName =
    eventText(source.tool) ||
    eventText(source.name) ||
    eventText(source.toolName) ||
    eventText(source.id) ||
    "tool";
  const state = source.state && typeof source.state === "object" ? (source.state as Record<string, unknown>) : {};
  const statusText = eventText(state.status) || eventText(properties.status);
  const eventType = eventText(properties.type);
  const status =
    statusText === "error" || eventType.endsWith(".after") && (state.error || properties.error)
      ? "error"
      : statusText === "completed" ||
          statusText === "success" ||
          eventText(state.kind) === "completed" ||
          eventText(state.kind) === "success" ||
          eventType.endsWith(".after") ||
          !!state.output ||
          !!state.result
        ? "completed"
        : "running";
  const detail =
    eventText(state.title) ||
    eventText(source.title) ||
    eventText(source.description) ||
    toolActivityLabel(toolName, source, status === "completed");
  return {
    toolName,
    status,
    detail,
    command: toolActionCommand(toolName, source),
    output: toolOutputText(source) || eventText(properties.output) || eventText(properties.stdout) || eventText(properties.stderr),
    raw: source,
  };
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

function contextMessagesForOpenCode(messages: ChatLine[]): Array<{ role: "user" | "assistant"; content: string }> {
  return messages
    .filter((message) => !message.streaming && (message.role === "user" || message.role === "assistant"))
    .map((message) => ({
      role: message.role as "user" | "assistant",
      content: message.role === "assistant" ? cleanAssistantMessage(message.content) : message.content,
    }))
    .filter((message) => message.content.trim().length > 0)
    .slice(-12);
}

function chatHistoryForOpenCode(messages: ChatLine[]): Array<{ role: "user" | "assistant"; content: string }> {
  return contextMessagesForOpenCode(messages);
}

type MarkdownBlock =
  | { kind: "code"; language: string; content: string }
  | { kind: "heading"; level: number; content: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; content: string }
  | { kind: "rule" }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "paragraph"; content: string };

function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] = [];

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
  const flushQuote = () => {
    if (quote.length > 0) {
      blocks.push({ kind: "quote", content: quote.join(" ") });
      quote = [];
    }
  };

  const splitTableRow = (line: string): string[] => {
    const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return trimmed.split("|").map((cell) => cell.trim());
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = /^```([A-Za-z0-9_-]*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      flushList();
      flushQuote();
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
      flushQuote();
      continue;
    }
    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
      flushParagraph();
      flushList();
      flushQuote();
      blocks.push({ kind: "rule" });
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      flushQuote();
      blocks.push({ kind: "heading", level: heading[1].length, content: heading[2].trim() });
      continue;
    }
    const blockquote = /^\s*>\s?(.*)$/.exec(line);
    if (blockquote) {
      flushParagraph();
      flushList();
      quote.push(blockquote[1]);
      continue;
    }
    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      flushQuote();
      const isOrdered = !!ordered;
      if (!list || list.ordered !== isOrdered) {
        flushList();
        list = { ordered: isOrdered, items: [] };
      }
      list.items.push((ordered?.[1] ?? unordered?.[1] ?? "").trim());
      continue;
    }
    if (line.includes("|") && lines[index + 1] && /^\s*\|?\s*:?-{2,}/.test(lines[index + 1])) {
      flushParagraph();
      flushList();
      flushQuote();
      const header = splitTableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim().length > 0) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      index -= 1;
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    flushList();
    flushQuote();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushQuote();
  return blocks;
}

function renderInlineMarkdown(text: string) {
  const tokens = tokenizeInline(text);
  return tokens.map((token, index) => {
    if (token.kind === "code") return <code key={index}>{token.text}</code>;
    if (token.kind === "bold") return <strong key={index}>{renderInlineMarkdown(token.text)}</strong>;
    if (token.kind === "italic") return <em key={index}>{renderInlineMarkdown(token.text)}</em>;
    if (token.kind === "strike") return <del key={index}>{renderInlineMarkdown(token.text)}</del>;
    if (token.kind === "link") {
      return (
        <a key={index} href={token.href} target="_blank" rel="noopener noreferrer">
          {renderInlineMarkdown(token.text)}
        </a>
      );
    }
    if (token.kind === "url") {
      return (
        <a key={index} href={token.text} target="_blank" rel="noopener noreferrer">
          {token.text}
        </a>
      );
    }
    return <React.Fragment key={index}>{token.text}</React.Fragment>;
  });
}

type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "strike"; text: string }
  | { kind: "link"; text: string; href: string }
  | { kind: "url"; text: string };

function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\n]+\*|_[^_\n]+_)|(~~[^~]+~~)|(\[[^\]]+\]\([^)]+\))|(\bhttps?:\/\/[^\s)]+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ kind: "text", text: text.slice(lastIndex, match.index) });
    }
    const [whole, code, bold, italic, strike, link, url] = match;
    if (code) tokens.push({ kind: "code", text: code.slice(1, -1) });
    else if (bold) tokens.push({ kind: "bold", text: bold.slice(2, -2) });
    else if (italic) tokens.push({ kind: "italic", text: italic.slice(1, -1) });
    else if (strike) tokens.push({ kind: "strike", text: strike.slice(2, -2) });
    else if (link) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(link);
      if (linkMatch) tokens.push({ kind: "link", text: linkMatch[1], href: linkMatch[2] });
      else tokens.push({ kind: "text", text: whole });
    } else if (url) tokens.push({ kind: "url", text: url });
    lastIndex = match.index + whole.length;
  }
  if (lastIndex < text.length) {
    tokens.push({ kind: "text", text: text.slice(lastIndex) });
  }
  return tokens.length > 0 ? tokens : [{ kind: "text", text }];
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
          const level = Math.min(Math.max(block.level, 1), 6);
          const Tag = `h${level + 2 > 6 ? 6 : level + 2}` as "h3" | "h4" | "h5" | "h6";
          return <Tag key={index}>{renderInlineMarkdown(block.content)}</Tag>;
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
        if (block.kind === "quote") {
          return (
            <blockquote key={index}>{renderInlineMarkdown(block.content)}</blockquote>
          );
        }
        if (block.kind === "rule") {
          return <hr key={index} />;
        }
        if (block.kind === "table") {
          return (
            <div className="markdownTableWrap" key={index}>
              <table className="markdownTable">
                <thead>
                  <tr>
                    {block.header.map((cell, cellIndex) => (
                      <th key={cellIndex}>{renderInlineMarkdown(cell)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex}>{renderInlineMarkdown(cell)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
  const parts = content.split(/(@"[^"]+"|@`[^`]+`|@[A-Za-z0-9_.\-\\/]+)/g);
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

function stableProjectIdFromRoot(root: string): string {
  let hash = 2166136261;
  const normalized = root.toLowerCase();
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function textFromOpenCodeParts(parts: unknown): string {
  if (!Array.isArray(parts)) {
    return "";
  }
  return appendDistinctText(parts
    .map((part) => {
      const row = recordValue(part);
      if (!row || row.type !== "text") {
        return "";
      }
      const text = typeof row.text === "string" ? row.text : "";
      const split = splitReasoningFromAnswer(text);
      return split.answer || (split.reasoning ? "" : text);
    })
    .filter(Boolean));
}

function reasoningFromOpenCodeParts(parts: unknown): string {
  if (!Array.isArray(parts)) {
    return "";
  }
  return appendDistinctText(parts
    .map((part) => {
      const row = recordValue(part);
      if (!row) {
        return "";
      }
      const type = typeof row.type === "string" ? row.type.toLowerCase() : "";
      if (type === "text") {
        return splitReasoningFromAnswer(eventText(row.text)).reasoning;
      }
      if (!type.includes("reasoning")) {
        return "";
      }
      return eventText(row.text) || eventText(row.content) || eventText(row.reasoning) || eventText(row.reasoningContent) || eventText(row.reasoning_content);
    })
    .filter(Boolean));
}

function latestAssistantSnapshot(messages: unknown[]): { text: string; reasoning: string; error: string } {
  const assistantMessages = messages.filter((message) => recordValue(recordValue(message)?.info)?.role === "assistant");
  const lastAssistant = assistantMessages[assistantMessages.length - 1];
  const error = openCodeMessageError(lastAssistant);
  const parts = recordValue(lastAssistant)?.parts;
  return {
    text: textFromOpenCodeParts(parts),
    reasoning: reasoningFromOpenCodeParts(parts),
    error,
  };
}

function openCodeMessageError(message: unknown): string {
  const info = recordValue(recordValue(message)?.info);
  const error = recordValue(info?.error);
  const data = recordValue(error?.data);
  const messageText = typeof data?.message === "string" ? data.message : typeof error?.name === "string" ? error.name : "";
  return messageText;
}

function eventText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function openCodePartKey(sessionID: string, part: Record<string, unknown> | null, properties: Record<string, unknown>) {
  const messageID = eventText(part?.messageID) || eventText(properties.messageID) || eventText(properties.messageId);
  const partID = eventText(part?.id) || eventText(properties.partID) || eventText(properties.partId);
  const partType = eventText(part?.type) || eventText(properties.partType) || "part";
  return `${sessionID}:${messageID || "message"}:${partID || partType}:${partType}`;
}

function openCodeEventDelta(
  part: Record<string, unknown> | null,
  properties: Record<string, unknown>,
  previous: string,
): { delta: string; snapshot?: string } {
  const direct =
    eventText(properties.delta) ||
    eventText(properties.textDelta) ||
    eventText(properties.text_delta) ||
    eventText(part?.delta);
  if (direct) {
    return { delta: direct };
  }
  const snapshot =
    eventText(part?.text) ||
    eventText(part?.content) ||
    eventText(part?.reasoning) ||
    eventText(part?.reasoningContent) ||
    eventText(part?.reasoning_content) ||
    eventText(properties.text) ||
    eventText(properties.content) ||
    eventText(properties.reasoning) ||
    eventText(properties.reasoningContent) ||
    eventText(properties.reasoning_content);
  if (!snapshot) {
    return { delta: "" };
  }
  return {
    delta: snapshot.startsWith(previous) ? snapshot.slice(previous.length) : snapshot,
    snapshot,
  };
}

function isReasoningPart(part: Record<string, unknown> | null, properties: Record<string, unknown>) {
  const field = eventText(properties.field).toLowerCase();
  const partType = eventText(part?.type).toLowerCase();
  return (
    field.includes("reasoning") ||
    partType.includes("reasoning") ||
    "reasoning" in properties ||
    "reasoningContent" in properties ||
    "reasoning_content" in properties ||
    !!part?.reasoning ||
    !!part?.reasoningContent ||
    !!part?.reasoning_content
  );
}

function splitOpenCodeModel(selection: string, fallbackModelId: string): { providerID: string; modelID: string } {
  const slash = selection.indexOf("/");
  if (slash <= 0) {
    return { providerID: "aegis-lmstudio", modelID: fallbackModelId };
  }
  return {
    providerID: selection.slice(0, slash),
    modelID: selection.slice(slash + 1) || fallbackModelId,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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
  return path.trim().replace(/^@/, "").replace(/^["`]|["`]$/g, "").replace(/\\/g, "/");
}

function mentionTokenForPath(path: string): string {
  const normalized = normalizeMentionPath(path);
  return /\s/.test(normalized) ? `@"${normalized.replace(/"/g, "\\\"")}"` : `@${normalized}`;
}

function promptWithAttachmentContext(message: string, attachments: AttachedFile[]): string {
  if (attachments.length === 0) {
    return message;
  }
  const lines = attachments.map((file) => {
    const projectPath = file.projectPath ?? file.path;
    const label = file.name || fileName(projectPath);
    return `- ${label}: ${projectPath}`;
  });
  return [
    message,
    "",
    "Attached project files. When the user refers to an @ file, use these exact project-relative paths:",
    ...lines,
  ].join("\n");
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
  const [health, setHealth] = useState<OpenCodeHealth | null>(null);
  const [models, setModels] = useState<string[]>(["aegis-lmstudio/local"]);
  const [selectedModel, setSelectedModel] = useState(persistedWorkspace.selectedModel ?? "aegis-lmstudio/local");
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
  const [ideMenuOpen, setIdeMenuOpen] = useState(false);
  const [composerBranchMenuOpen, setComposerBranchMenuOpen] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default");
  const [bypassConfirmOpen, setBypassConfirmOpen] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [chatLeftWidth, setChatLeftWidth] = useState(280);
  const [dataLeftWidth, setDataLeftWidth] = useState(280);
  const [terminalOutput, setTerminalOutput] = useState("");
  const [terminalInput, setTerminalInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connectionRef = useRef<DesktopConnection | null>(null);
  const eventAbortRef = useRef<AbortController | null>(null);
  const streamingChatRef = useRef<string | null>(null);
  const sessionChatRef = useRef<Map<string, string>>(new Map());
  const sessionMonitorRef = useRef<Map<string, AbortController>>(new Map());
  const streamPartTextRef = useRef<Map<string, string>>(new Map());
  const streamPartKindRef = useRef<Map<string, StreamPartKind>>(new Map());
  const streamBufferRef = useRef<Map<string, string>>(new Map());
  const thinkingBufferRef = useRef<Map<string, string>>(new Map());
  const streamFrameRef = useRef<number | null>(null);
  const liveStreamSeenRef = useRef<Map<string, boolean>>(new Map());
  const lastUserMessageRef = useRef<Map<string, string>>(new Map());

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
  const telemetry = useMemo(
    () => ({
      connection,
      runtime: connection?.status === "ready" ? connection.runtime : "unavailable",
      sandbox: connection?.status === "ready" ? connection.sandbox ?? null : null,
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
    [activeChat, activeFile, attachedFiles, branchInfo, chats, connection, error, health, models, permissionMode, selectedModel, sessions, storeOverview, visibleProject, worktrees],
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
    const chunks = Array.from(streamBufferRef.current.entries()).filter(([, chunk]) => chunk.length > 0);
    const thinkingChunks = Array.from(thinkingBufferRef.current.entries()).filter(([, chunk]) => chunk.length > 0);
    streamBufferRef.current.clear();
    thinkingBufferRef.current.clear();
    if (chunks.length === 0 && thinkingChunks.length === 0) {
      return;
    }
    for (const [chatId, chunk] of thinkingChunks) {
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
          const existing = messages[thinkingIndex].content;
          messages[thinkingIndex] = {
            ...messages[thinkingIndex],
            content: stripDuplicatedText(`${existing}${chunk}`),
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
          content: chunk,
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
    }
    for (const [chatId, chunk] of chunks) {
      updateChat(chatId, (chat) => {
        const messages = [...chat.messages];
        const last = messages[messages.length - 1];
        const userMessage = lastUserMessageRef.current.get(chatId) ?? "";
        if (last?.role === "assistant" && last.streaming) {
          messages[messages.length - 1] = {
            ...last,
            content: stripDuplicatedText(stripLeadingUserEcho(`${last.content}${chunk}`, userMessage)),
          };
        } else {
          const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
          const content = stripLeadingUserEcho(chunk, userMessage);
          if (lastAssistant && cleanAssistantMessage(lastAssistant.content) === cleanAssistantMessage(content)) {
            return { ...chat, messages };
          }
          messages.push({ role: "assistant", content, streaming: true });
        }
        return { ...chat, messages };
      });
    }
  }, [updateChat]);

  const enqueueStreamDelta = useCallback((chatId: string, delta: string) => {
    liveStreamSeenRef.current.set(chatId, true);
    streamBufferRef.current.set(chatId, `${streamBufferRef.current.get(chatId) ?? ""}${delta}`);
    if (streamFrameRef.current !== null) {
      return;
    }
    streamFrameRef.current = requestAnimationFrame(flushStreamBuffer);
  }, [flushStreamBuffer]);

  const enqueueThinkingDelta = useCallback((chatId: string, delta: string) => {
    liveStreamSeenRef.current.set(chatId, true);
    thinkingBufferRef.current.set(chatId, `${thinkingBufferRef.current.get(chatId) ?? ""}${delta}`);
    if (streamFrameRef.current !== null) {
      return;
    }
    streamFrameRef.current = requestAnimationFrame(flushStreamBuffer);
  }, [flushStreamBuffer]);

  const setAssistantSnapshot = useCallback((chatId: string, content: string) => {
    const cleaned = cleanAssistantMessage(stripLeadingUserEcho(content, lastUserMessageRef.current.get(chatId) ?? ""));
    if (!cleaned) {
      return;
    }
    updateChat(chatId, (chat) => {
      const messages = [...chat.messages];
      let assistantIndex = -1;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role === "assistant" && messages[index].streaming) {
          assistantIndex = index;
          break;
        }
      }
      if (assistantIndex >= 0) {
        const existing = cleanAssistantMessage(messages[assistantIndex].content);
        messages[assistantIndex] = {
          ...messages[assistantIndex],
          content: mergeRelatedText(existing, cleaned),
        };
      } else {
        const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
        if (lastAssistant && cleanAssistantMessage(lastAssistant.content) === cleaned) {
          return { ...chat, messages };
        }
        messages.push({ role: "assistant", content: cleaned, streaming: true });
      }
      return { ...chat, messages };
    });
  }, [updateChat]);

  const setThinkingSnapshot = useCallback((chatId: string, content: string) => {
      const cleaned = stripDuplicatedText(content);
    if (!cleaned) {
      return;
    }
    updateChat(chatId, (chat) => {
      const messages = [...chat.messages];
      let thinkingIndex = -1;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role === "thinking" && messages[index].streaming) {
          thinkingIndex = index;
          break;
        }
      }
      const startedAt = new Date().toISOString();
      if (thinkingIndex >= 0) {
        const existing = messages[thinkingIndex].content.trim();
        messages[thinkingIndex] = {
          ...messages[thinkingIndex],
          content: mergeRelatedText(existing, cleaned),
        };
      } else {
        let assistantIndex = -1;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          if (messages[index].role === "assistant" && messages[index].streaming) {
            assistantIndex = index;
            break;
          }
        }
        const lastThinking = [...messages].reverse().find((message) => message.role === "thinking");
        if (lastThinking && stripDuplicatedText(lastThinking.content) === cleaned) {
          return { ...chat, messages };
        }
        const thinking: ChatLine = { role: "thinking", content: cleaned, streaming: true, startedAt };
        if (assistantIndex >= 0) {
          messages.splice(assistantIndex, 0, thinking);
        } else {
          messages.push(thinking);
        }
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
    const tail = streamBufferRef.current.get(chatId) ?? "";
    const thinkingTail = thinkingBufferRef.current.get(chatId) ?? "";
    streamBufferRef.current.delete(chatId);
    thinkingBufferRef.current.delete(chatId);
    if (tail || thinkingTail) {
      updateChat(chatId, (chat) => {
        const cleanTail = stripLeadingUserEcho(tail, lastUserMessageRef.current.get(chatId) ?? "");
        const messages = chat.messages.map((message) =>
          message.role === "thinking" && message.streaming ? finishThinkingLine(message, endedAtMs) : message,
        );
        if (thinkingTail) {
          let thinkingIndex = -1;
          for (let index = messages.length - 1; index >= 0; index -= 1) {
            if (messages[index].role === "thinking") {
              thinkingIndex = index;
              break;
            }
          }
          if (thinkingIndex >= 0) {
            messages[thinkingIndex] = finishThinkingLine({
              ...messages[thinkingIndex],
              content: stripDuplicatedText(`${messages[thinkingIndex].content}${thinkingTail}`),
            }, endedAtMs);
          }
        }
        const last = messages[messages.length - 1];
        if (tail && last?.role === "assistant" && last.streaming) {
          messages[messages.length - 1] = {
            ...last,
            content: stripDuplicatedText(stripLeadingUserEcho(`${last.content}${tail}`, lastUserMessageRef.current.get(chatId) ?? "")),
            streaming: false,
          };
        } else if (tail) {
          messages.push({ role: "assistant", content: cleanTail });
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
      const last = messages[messages.length - 1];
      return {
        ...chat,
        messages:
          last?.role === "assistant" && !last.streaming && last.content.trim() === ""
            ? messages.slice(0, -1)
            : messages,
      };
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

  const recordToolChangedFile = useCallback((chatId: string, toolName: string, data: unknown) => {
    const changedPath = toolChangedPath(toolName, data);
    if (!changedPath) {
      return;
    }
    updateChat(chatId, (chat) => {
      const changedFilePaths = Array.from(new Set([...(chat.changedFilePaths ?? []), changedPath]));
      return {
        ...chat,
        diffAvailable: changedFilePaths.length > 0,
        changedFileCount: changedFilePaths.length,
        changedFilePaths,
      };
    });
  }, [updateChat]);

  const upsertToolRun = useCallback((
    chatId: string,
    toolName: string,
    status: "running" | "completed" | "error",
    detail: string,
    command: string,
    output: string,
    raw: unknown,
  ) => {
    if (status === "running" || status === "completed") {
      recordToolChangedFile(chatId, toolName, raw);
    }
    updateChat(chatId, (chat) => {
      const nextStatus: ServiceStatus =
        status === "running" ? "degraded" : status === "completed" ? "ready" : "unavailable";
      const messages = [...chat.messages.filter((message) => !(message.role === "assistant" && message.streaming && message.content.length === 0))];
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (
          messages[index].role === "tool" &&
          messages[index].toolName === toolName &&
          messages[index].command === command &&
          messages[index].status === "degraded"
        ) {
          messages[index] = {
            ...messages[index],
            status: nextStatus,
            detail,
            command,
            output,
            content: detail,
          };
          return { ...chat, messages };
        }
      }
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (
          messages[index].role === "tool" &&
          messages[index].toolName === toolName &&
          messages[index].status === "degraded"
        ) {
          messages[index] = {
            ...messages[index],
            status: nextStatus,
            detail,
            command: command || messages[index].command,
            output,
            content: detail,
          };
          return { ...chat, messages };
        }
      }
      const toolLine: ChatLine = {
        role: "tool",
        toolName,
        status: nextStatus,
        detail,
        command,
        output,
        content: detail,
      };
      let insertAt = messages.length;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role === "tool") {
          break;
        }
        if (message.role === "assistant") {
          insertAt = index;
          break;
        }
      }
      messages.splice(insertAt, 0, toolLine);
      return { ...chat, messages };
    });
    addTimeline("tool", status === "completed" ? "ready" : status === "error" ? "unavailable" : "degraded", detail, chatId);
  }, [addTimeline, recordToolChangedFile, updateChat]);

  const openCodeFetch = useCallback(async <T,>(
    endpoint: string,
    options: RequestInit = {},
    directory?: string,
  ): Promise<T> => {
    const currentConnection = connectionRef.current;
    if (!currentConnection || currentConnection.status !== "ready") {
      throw new Error("OpenCode is not connected.");
    }
    const url = new URL(endpoint, currentConnection.url);
    if (directory) {
      url.searchParams.set("directory", directory);
    }
    const headers = new Headers(options.headers);
    headers.set("Authorization", currentConnection.authHeader);
    if (options.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const response = await fetch(url.toString(), { ...options, headers });
    if (response.status === 204) {
      return undefined as T;
    }
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}${text ? `: ${text.slice(0, 500)}` : ""}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }, []);

  const monitorSessionMessages = useCallback((chatId: string, sessionId: string, directory?: string) => {
    sessionMonitorRef.current.get(sessionId)?.abort();
    const monitor = new AbortController();
    sessionMonitorRef.current.set(sessionId, monitor);
    void (async () => {
      let lastText = "";
      let stableTicks = 0;
      const startedAt = Date.now();
      try {
        for (let attempt = 0; attempt < 240 && !monitor.signal.aborted; attempt += 1) {
          await delay(attempt < 8 ? 250 : 500);
          const messages = await openCodeFetch<Array<unknown>>(
            `/session/${encodeURIComponent(sessionId)}/message?limit=40`,
            { signal: monitor.signal },
            directory,
          ).catch((cause) => {
            if (monitor.signal.aborted) {
              return [];
            }
            throw cause;
          });
          const snapshot = latestAssistantSnapshot(messages);
          if (snapshot.error) {
            throw new Error(snapshot.error);
          }
          const sawEventText = liveStreamSeenRef.current.get(chatId) === true;
          if (snapshot.reasoning && !sawEventText && Date.now() - startedAt > 2500) {
            setThinkingSnapshot(chatId, snapshot.reasoning);
          }
          if (snapshot.text && !sawEventText) {
            setAssistantSnapshot(chatId, snapshot.text);
            stableTicks = snapshot.text === lastText ? stableTicks + 1 : 0;
            lastText = snapshot.text;
          } else if (snapshot.text) {
            stableTicks = snapshot.text === lastText ? stableTicks + 1 : 0;
            lastText = snapshot.text;
          }
          if (snapshot.text && stableTicks >= 3) {
            finishStreaming(chatId);
            addTimeline("agent", "ready", `session ${sessionId.slice(0, 8)} finished`, chatId);
            if (streamingChatRef.current === chatId) {
              streamingChatRef.current = null;
            }
            return;
          }
          if (!snapshot.text && Date.now() - startedAt > 45_000) {
            finishStreaming(chatId);
            addTimeline("agent", "ready", `session ${sessionId.slice(0, 8)} quiet`, chatId);
            if (streamingChatRef.current === chatId) {
              streamingChatRef.current = null;
            }
            return;
          }
        }
      } catch (cause) {
        if (!monitor.signal.aborted) {
          const message = String(cause instanceof Error ? cause.message : cause);
          setError(message);
          addTimeline("agent", "unavailable", message, chatId);
          finishStreaming(chatId);
        }
      } finally {
        if (sessionMonitorRef.current.get(sessionId) === monitor) {
          sessionMonitorRef.current.delete(sessionId);
        }
      }
    })();
  }, [addTimeline, finishStreaming, openCodeFetch, setAssistantSnapshot, setThinkingSnapshot]);

  const rpc = useCallback(async <T,>(method: string, params: unknown): Promise<T> => {
    const input = (params ?? {}) as Record<string, unknown>;
    const currentConnection = connectionRef.current;
    if (method === "opencode.health") {
      const native = await aegisApi.nativeRequest<{
        opencode: ServiceStatus;
        sqlite_path: string;
        lm_studio: ServiceStatus;
        model_base_url: string;
        semantic_index: ServiceStatus;
      }>({ type: "health" });
      return {
        opencode: native.opencode,
        sqlite_path: native.sqlite_path,
        lm_studio: native.lm_studio,
        model_base_url: native.model_base_url,
        semantic_index: native.semantic_index,
      } as T;
    }
    if (method === "project.list") {
      return aegisApi.nativeRequest<T>({ type: "project:list" });
    }
    if (method === "project.add") {
      return aegisApi.nativeRequest<T>({
        type: "project:add",
        rootPath: String(input.root_path ?? input.rootPath ?? ""),
        name: typeof input.name === "string" ? input.name : undefined,
      });
    }
    if (method === "store.overview") {
      return aegisApi.nativeRequest<T>({ type: "store:overview" });
    }
    if (method === "ide.detect") {
      return aegisApi.nativeRequest<T>({ type: "ide:detect" });
    }
    if (method === "model.list") {
      const modelId = currentConnection?.status === "ready"
        ? `${currentConnection.model.providerId}/${currentConnection.model.modelId}`
        : "aegis-lmstudio/local";
      return [{ id: modelId, name: "Local LM Studio" }] as T;
    }
    if (method === "opencode.config") {
      return aegisApi.nativeRequest<T>({ type: "opencode:config" });
    }
    if (method === "session.list") {
      const projectId = typeof input.projectId === "string" ? input.projectId : null;
      const projectRoot = projectId
        ? projects.find((project) => project.id === projectId)?.root_path
        : undefined;
      const sessions = await openCodeFetch<Array<{
        id: string;
        projectID: string;
        directory: string;
        title: string;
        time: { created: number; updated: number };
      }>>("/session", {}, projectRoot);
      return sessions
        .filter((session) => !projectRoot || session.directory === projectRoot)
        .map((session) => ({
          id: session.id,
          project_id:
            projects.find((project) => project.root_path === session.directory)?.id ??
            stableProjectIdFromRoot(session.directory || projectRoot || session.projectID),
          title: session.title,
          model_id: currentConnection?.status === "ready" ? `${currentConnection.model.providerId}/${currentConnection.model.modelId}` : "aegis-lmstudio/local",
          started_at: new Date(session.time.created).toISOString(),
          finished_at: null,
          status: "idle",
          user_message: session.title,
        })) as T;
    }
    if (method === "project.files") {
      const projectRoot = String(input.projectRoot ?? "");
      const limit = Number(input.limit ?? 10000);
      return aegisApi.nativeRequest<T>({ type: "project:files", projectRoot, limit });
    }
    if (method === "project.search") {
      const projectRoot = String(input.project_root ?? input.projectRoot ?? "");
      const pattern = String(input.query ?? "");
      return aegisApi.nativeRequest<T>({
        type: "project:search",
        projectRoot,
        query: pattern,
        limit: Number(input.limit ?? 200),
      });
    }
    if (method === "git.status") {
      return aegisApi.nativeRequest<T>({ type: "git:status", projectRoot: String(input.projectRoot ?? "") });
    }
    if (method === "git.diff") {
      return aegisApi.nativeRequest<T>({ type: "git:diff", projectRoot: String(input.projectRoot ?? "") });
    }
    if (method === "git.branches") {
      return aegisApi.nativeRequest<T>({ type: "git:branches", projectRoot: String(input.projectRoot ?? "") });
    }
    if (method === "git.worktree_list") {
      return aegisApi.nativeRequest<T>({ type: "git:worktree-list", projectRoot: String(input.projectRoot ?? "") });
    }
    if (method === "git.worktree_create") {
      return aegisApi.nativeRequest<T>({
        type: "git:worktree-create",
        projectRoot: String(input.projectRoot ?? ""),
        branch: String(input.branch ?? "HEAD"),
        newBranch: String(input.newBranch ?? ""),
        worktreeName: String(input.worktreeName ?? "aegis-worktree"),
      });
    }
    if (method === "agent.send_task") {
      const projectRoot = String(input.project_root ?? input.worktree_path ?? "");
      const chatId = typeof input.chat_id === "string" ? input.chat_id : activeChatId;
      const existingSessionId = chats.find((chat) => chat.id === chatId)?.sessionId;
      const session = existingSessionId
        ? { id: existingSessionId }
        : await openCodeFetch<{ id: string }>("/session", {
            method: "POST",
            body: JSON.stringify({ title: String(input.message ?? "Aegis task").slice(0, 80) }),
          }, projectRoot || undefined);
      sessionChatRef.current.set(session.id, chatId);
      updateChat(chatId, (chat) => ({ ...chat, sessionId: session.id }));
      const selected = String(input.model ?? selectedModel);
      const { providerID, modelID } = splitOpenCodeModel(
        selected,
        currentConnection?.status === "ready" ? currentConnection.model.modelId : "local",
      );
      const promptParts = [
        {
          type: "text",
          text: String(input.message ?? ""),
        },
      ];
      await openCodeFetch<void>(
        `/session/${encodeURIComponent(session.id)}/prompt_async`,
        {
          method: "POST",
          body: JSON.stringify({
            agent: "aegis",
            model: { providerID, modelID },
            tools: {
              webfetch: false,
              websearch: false,
            },
            parts: promptParts,
          }),
        },
        projectRoot || undefined,
      );
      return {
        session_id: session.id,
        turn_id: session.id,
      } as T;
    }
    if (method === "opencode.permission") {
      const sessionId = String(input.sessionId ?? "");
      const permissionId = String(input.permissionId ?? "");
      return openCodeFetch<T>(
        `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`,
        {
          method: "POST",
          body: JSON.stringify({ response: input.response === "reject" ? "reject" : "once" }),
        },
        typeof input.directory === "string" ? input.directory : undefined,
      );
    }
    throw new Error(`Unsupported Aegis/OpenCode method: ${method}`);
  }, [activeChatId, chats, openCodeFetch, projects, selectedModel, updateChat]);

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
    const [healthResult, projectRows, sessionRows, overview, detectedIdes, modelRows, openCodeConfig] = await Promise.all([
      rpc<OpenCodeHealth>("opencode.health", {}),
      rpc<ProjectSummary[]>("project.list", {}),
      rpc<SessionSummary[]>("session.list", {}),
      rpc<StoreOverview>("store.overview", {}),
      rpc<IdeInstall[]>("ide.detect", {}),
      rpc<Array<{ id: string }>>("model.list", {}),
      rpc<Record<string, unknown>>("opencode.config", {}).catch(() => ({})),
    ]);
    setHealth(healthResult);
    setProjects(projectRows);
    setSessions(sessionRows);
    setStoreOverview(overview);
    setIdes(detectedIdes);
    setModels(modelRows.map((model) => model.id));
    setPermissionMode((openCodeConfig as Record<string, unknown>).aegis_permission_mode === "bypass" ? "bypass" : "default");
    setSelectedModel((current) => modelRows.some((model) => model.id === current) ? current : modelRows[0]?.id ?? current);
    setSelectedIdeId((current) => detectedIdes.some((ide) => ide.id === current) ? current : detectedIdes.find((ide) => ide.id === "code")?.id ?? detectedIdes[0]?.id ?? "code");
    setSelectedProjectId((current) => projectRows.some((project) => project.id === current) ? current : projectRows[0]?.id ?? null);
    const projectForFiles = projectRows.find((project) => project.id === selectedProjectId) ?? projectRows[0];
    if (projectForFiles) {
      void refreshProjectFiles(projectForFiles).catch(() => setProjectFiles([]));
    }
    addTimeline("opencode", "ready", "connected");
    addTimeline("lm-studio", healthResult.lm_studio, `${modelRows.length} model(s)`);
  }, [addTimeline, refreshProjectFiles, rpc, selectedProjectId]);

  const connect = useCallback(async () => {
    setSocketState("connecting");
    setError(null);
    const openCode = await aegisApi.getOpenCodeConnection();
    connectionRef.current = openCode;
    setConnection(openCode);

    if (openCode.status !== "ready") {
      setSocketState("closed");
      setError(openCode.message);
      addTimeline("desktop", "unavailable", openCode.message);
      return;
    }

    setModels([`${openCode.model.providerId}/${openCode.model.modelId}`]);
    setSelectedModel(`${openCode.model.providerId}/${openCode.model.modelId}`);
    setSocketState("open");
    eventAbortRef.current?.abort();
    const abort = new AbortController();
    eventAbortRef.current = abort;
    void (async () => {
      try {
        const response = await fetch(new URL("/global/event", openCode.url).toString(), {
          headers: { Authorization: openCode.authHeader },
          signal: abort.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`OpenCode event stream failed: ${response.status} ${response.statusText}`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!abort.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split(/\r?\n\r?\n/);
          buffer = chunks.pop() ?? "";
          for (const chunk of chunks) {
            const data = chunk
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            const event = recordValue(JSON.parse(data));
            const payload = recordValue(event?.payload) ?? event;
            if (!payload || typeof payload.type !== "string") continue;
            const properties: Record<string, unknown> = { ...(recordValue(payload.properties) ?? {}), type: payload.type };
            const part = recordValue(properties.part);
            const sessionID =
              typeof properties.sessionID === "string"
                ? properties.sessionID
                : typeof part?.sessionID === "string"
                  ? part.sessionID
                  : "";
            const chatId = (sessionID ? sessionChatRef.current.get(sessionID) : undefined) ?? streamingChatRef.current;
            if (payload.type.startsWith("message.part") && chatId) {
              const key = openCodePartKey(sessionID, part, properties);
              const previous = streamPartTextRef.current.get(key) ?? "";
              const { delta, snapshot } = openCodeEventDelta(part, properties, previous);
              if (snapshot !== undefined) {
                streamPartTextRef.current.set(key, snapshot);
              }
              if (delta) {
                const wholeText = snapshot ?? `${previous}${delta}`;
                if (snapshot === undefined) {
                  streamPartTextRef.current.set(key, wholeText);
                }
                const split = splitReasoningFromAnswer(wholeText);
                const priorKind = streamPartKindRef.current.get(key);
                const explicitReasoningPart = isReasoningPart(part, properties);
                if (split.answer) {
                  streamPartKindRef.current.set(key, "answer");
                  if (split.reasoning) {
                    thinkingBufferRef.current.delete(chatId);
                    setThinkingSnapshot(chatId, split.reasoning);
                    addTimeline("reasoning", "degraded", "thinking", chatId);
                  }
                  setAssistantSnapshot(chatId, split.answer);
                } else if (explicitReasoningPart || priorKind === "reasoning") {
                  streamPartKindRef.current.set(key, "reasoning");
                  if (priorKind === "pending") {
                    setThinkingSnapshot(chatId, wholeText);
                  } else {
                    enqueueThinkingDelta(chatId, delta);
                  }
                  addTimeline("reasoning", "degraded", "thinking", chatId);
                } else if (split.reasoning) {
                  streamPartKindRef.current.set(key, "reasoning");
                  if (priorKind === "pending") {
                    setThinkingSnapshot(chatId, split.reasoning);
                  } else {
                    enqueueThinkingDelta(chatId, delta);
                  }
                  addTimeline("reasoning", "degraded", "thinking", chatId);
                } else if (shouldHoldOpeningStreamFragment(wholeText)) {
                  streamPartKindRef.current.set(key, "pending");
                } else {
                  streamPartKindRef.current.set(key, "answer");
                  if (priorKind === "pending") {
                    setAssistantSnapshot(chatId, wholeText);
                  } else {
                    enqueueStreamDelta(chatId, delta);
                  }
                }
              }
              if (part && eventText(part.type).includes("tool")) {
                const toolPayload = eventToolPayload(properties, part);
                if (toolPayload) {
                  upsertToolRun(
                    chatId,
                    toolPayload.toolName,
                    toolPayload.status,
                    toolPayload.detail,
                    toolPayload.command,
                    toolPayload.output,
                    toolPayload.raw,
                  );
                }
              }
            }
            if (
              chatId &&
              (payload.type === "tool.execute.before" ||
                payload.type === "tool.execute.after" ||
                payload.type === "command.executed" ||
                payload.type === "file.edited")
            ) {
              const toolPayload = eventToolPayload(properties, part);
              if (toolPayload) {
                upsertToolRun(
                  chatId,
                  toolPayload.toolName,
                  toolPayload.status,
                  toolPayload.detail,
                  toolPayload.command,
                  toolPayload.output,
                  toolPayload.raw,
                );
              }
            }
            if (payload.type === "permission.updated" || payload.type === "permission.asked") {
              const permission = properties;
              const sessionID = typeof permission.sessionID === "string" ? permission.sessionID : "";
              const permissionID =
                typeof permission.id === "string"
                  ? permission.id
                  : typeof permission.requestID === "string"
                    ? permission.requestID
                    : "";
              if (!sessionID || !permissionID) {
                continue;
              }
              const rawPatterns = Array.isArray(permission.patterns) ? permission.patterns : permission.pattern;
              const patterns = Array.isArray(rawPatterns)
                ? rawPatterns.filter((pattern): pattern is string => typeof pattern === "string")
                : typeof rawPatterns === "string"
                  ? [rawPatterns]
                  : [];
              const permissionKind =
                typeof permission.permission === "string"
                  ? permission.permission
                  : typeof permission.type === "string"
                    ? permission.type
                    : "permission";
              const title =
                typeof permission.title === "string"
                  ? permission.title
                  : patterns.length > 0
                    ? `${permissionKind}: ${patterns.join(", ")}`
                    : "OpenCode permission request";
              const targetChat = sessionChatRef.current.get(sessionID) ?? chats.find((chat) => chat.sessionId === sessionID)?.id ?? streamingChatRef.current ?? activeChatId;
              const request: ToolApprovalRequest = {
                id: permissionID,
                toolName: permissionKind,
                actionKey: `permission:${sessionID}:${permissionID}`,
                command: title,
                summary: title,
                requestedAt: new Date().toISOString(),
              };
              updateChat(targetChat, (chat) => ({ ...chat, pendingApproval: request }));
              addTimeline("approval", "degraded", `Pending: ${title}`, targetChat);
            }
            if (payload.type === "session.idle" || (payload.type.startsWith("session.") && String(properties.status ?? "").toLowerCase() === "idle")) {
              const sessionID = String(properties.sessionID ?? "");
              const targetChat = sessionChatRef.current.get(sessionID) ?? chats.find((chat) => chat.sessionId === sessionID)?.id ?? streamingChatRef.current ?? activeChatId;
              if (targetChat) {
                finishStreaming(targetChat);
                if (streamingChatRef.current === targetChat) {
                  streamingChatRef.current = null;
                }
              }
            }
          }
        }
      } catch (cause) {
        if (!abort.signal.aborted) {
          setError(String(cause instanceof Error ? cause.message : cause));
          setSocketState("closed");
        }
      }
    })();
    void loadInitialData().catch((cause) => setError(String(cause)));
  }, [activeChatId, addTimeline, chats, enqueueStreamDelta, enqueueThinkingDelta, finishStreaming, loadInitialData, upsertToolRun, updateChat]);

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
      eventAbortRef.current?.abort();
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
    });
  }, [activeChatId, chats, selectedIdeId, selectedModel, selectedProjectId]);

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
    eventAbortRef.current?.abort();
    const openCode = await aegisApi.restartOpenCode();
    connectionRef.current = openCode;
    setConnection(openCode);
    setTimeout(() => void connect(), 150);
  };

  const applyPermissionMode = async (mode: PermissionMode) => {
    if (mode === permissionMode || busy) {
      return;
    }
    setPermissionMode(mode);
    setSocketState("connecting");
    setError(null);
    eventAbortRef.current?.abort();
    try {
      const openCode = aegisApi.setPermissionMode
        ? await aegisApi.setPermissionMode(mode)
        : await aegisApi.nativeRequest<DesktopConnection>({ type: "opencode:set-permission-mode", mode });
      connectionRef.current = openCode;
      setConnection(openCode);
      addTimeline("permissions", openCode.status === "ready" ? "ready" : "unavailable", `${mode} mode`);
      setTimeout(() => void connect(), 150);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
      setSocketState("closed");
    }
  };

  const changePermissionMode = async (mode: PermissionMode) => {
    if (mode === "bypass" && permissionMode !== "bypass") {
      setBypassConfirmOpen(true);
      return;
    }
    await applyPermissionMode(mode);
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
      `The model returned a raw ${call.tool} tool call as the final answer instead of letting OpenCode continue the tool loop.`,
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
    streamBufferRef.current.clear();
    thinkingBufferRef.current.clear();
    streamPartTextRef.current.clear();
    streamPartKindRef.current.clear();
    liveStreamSeenRef.current.set(chatId, false);
    lastUserMessageRef.current.set(chatId, trimmed);
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
      const conversationHistory = chatHistoryForOpenCode(chat?.messages ?? []);
      const deliveryMessage = promptWithAttachmentContext(trimmed, promptAttachments);
      const approvedToolActions = Array.from(
        new Set([...(chat?.approvedToolActions ?? []), ...(options.extraApprovedActions ?? [])]),
      );
      const result = await rpc<SendTaskResult>("agent.send_task", {
        chat_id: chatId,
        project_id: selectedProject?.id,
        project_root: workingRoot,
        message: deliveryMessage,
        conversation_history: conversationHistory,
        model: selectedModel,
        git_branch: lazyWorktree?.branch ?? (selectedBranch || undefined),
        worktree_enabled: chat?.worktreeEnabled ?? false,
        worktree_path: workingRoot,
        approved_tool_actions: approvedToolActions,
        attached_files: promptAttachments.map((file) => ({
          path: file.path,
          project_path: file.projectPath,
          content: file.projectPath ? undefined : file.content,
        })),
        operating_system: detectHarnessOs(),
      });
      updateChat(chatId, (row) => ({
        ...row,
        sessionId: result.session_id,
      }));
      addTimeline("agent", "degraded", `turn ${result.turn_id.slice(0, 8)} started`, chatId);
      monitorSessionMessages(chatId, result.session_id, workingRoot);
      await Promise.all([
        refreshSessions(selectedProjectId),
        refreshStore(),
        refreshGit(selectedProject ?? undefined),
        refreshProjectFiles(selectedProject ?? undefined),
      ]);
    } catch (cause) {
      const message = String(cause instanceof Error ? cause.message : cause);
      setError(message);
      addTimeline("agent", "unavailable", message, chatId);
      finishStreaming(chatId);
    } finally {
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
    const token = mentionTokenForPath(file.path);
    setAttachedFiles((files) => {
      if (files.some((row) => row.projectPath === file.path)) {
        return files;
      }
      return [...files, { path: file.path, name: file.name, projectPath: file.path }];
    });
    setPrompt((current) => {
      const start = activeMentionStart(current);
      if (start === null) {
        return `${current.trimEnd()} ${token} `;
      }
      return `${current.slice(0, start)}${token} `;
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
    if (request.actionKey.startsWith("permission:")) {
      const [, sessionId, permissionId] = request.actionKey.split(":");
      void rpc("opencode.permission", {
        sessionId,
        permissionId,
        response: decision === "accepted" ? "once" : "reject",
        directory: activeChat.worktreePath ?? selectedProject?.root_path,
      }).catch((cause) => setError(String(cause instanceof Error ? cause.message : cause)));
      return;
    }
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
    data: "Telemetry",
  }[activeRail];

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
          <button className="ctrlButton" title="Restart OpenCode" onClick={restart}>
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      <aside className="rail">
        <RailButton active={activeRail === "chats"} title="Chats" onClick={() => setActiveRail("chats")}>
          <MessageSquare size={18} />
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
            <PermissionModeControl mode={permissionMode} busy={busy || socketState === "connecting"} onChange={(mode) => void changePermissionMode(mode)} />
            <button className="headerAttachButton" title="Attach files" onClick={() => void attachLocalFiles()} disabled={!selectedProject}>
              <Paperclip size={13} />
            </button>
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
              placeholder={socketState === "open" ? "Ask Local LM Studio for a coding task..." : "Connecting to OpenCode..."}
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
      {bypassConfirmOpen ? (
        <ConfirmDialog
          title="Enable Bypass?"
          body={connection?.status === "ready" && connection.runtime === "docker-sandbox"
            ? "Bypass permissions removes prompts and lets the agent run commands and change mounted workspace files without asking first. The Docker Sandbox limits host exposure, but workspace changes still happen on your machine."
            : "Bypass permissions removes prompts and lets the agent run commands and access files without asking first. In host mode this can give the AI agent full access to your computer, so there is real risk involved."}
          confirmLabel="Enable Bypass"
          onCancel={() => setBypassConfirmOpen(false)}
          onConfirm={() => {
            setBypassConfirmOpen(false);
            void applyPermissionMode("bypass");
          }}
        />
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

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return createPortal(
    <div className="modalScrim" role="presentation" onMouseDown={onCancel}>
      <section
        className="confirmDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div>
          <h2 id="confirm-dialog-title">{title}</h2>
          <p>{body}</p>
        </div>
        <div className="dialogActions">
          <button type="button" className="secondaryAction" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primaryAction danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>,
    document.body,
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

function PermissionModeControl({
  mode,
  busy,
  onChange,
}: {
  mode: PermissionMode;
  busy: boolean;
  onChange: (mode: PermissionMode) => void;
}) {
  return (
    <div className="permissionModeControl" aria-label="Permission mode">
      <button
        type="button"
        className={mode === "default" ? "active" : ""}
        disabled={busy}
        title="Default permissions: running in a sandbox when available. Only sensitive information gathering and destructive or write actions ask for approval."
        onClick={() => onChange("default")}
      >
        <ShieldQuestion size={12} />
        <span>Default</span>
      </button>
      <button
        type="button"
        className={mode === "bypass" ? "active danger" : ""}
        disabled={busy}
        title="Bypass permissions: full access without approval prompts. In host mode the agent can access your computer, so there is real risk involved."
        onClick={() => onChange("bypass")}
      >
        <ShieldCheck size={12} />
        <span>Bypass</span>
      </button>
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
  health: OpenCodeHealth | null;
  socketState: SocketState;
  storeOverview: StoreOverview | null;
}) {
  return (
    <div className="sidebarStack dataStack">
      <div className="kvCard">
        <div className="kvRow"><span>Connection</span><strong>{socketState}</strong></div>
        <div className="kvRow"><span>Runtime</span><strong>{typeof telemetry === "object" && telemetry && "runtime" in telemetry ? String((telemetry as { runtime?: unknown }).runtime) : "—"}</strong></div>
        <div className="kvRow"><span>OpenCode</span><strong>{health?.opencode ?? "—"}</strong></div>
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

function PermissionApprovalBar({
  request,
  busy: _busy,
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
        <button type="button" className="approvalAccept" onClick={onAccept}>
          <CheckCircle2 size={13} />
          Accept
        </button>
        <button type="button" className="approvalDecline" onClick={onDecline}>
          <X size={13} />
          Decline
        </button>
      </div>
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

function ToolRunGroup({ lines }: { lines: ChatLine[] }) {
  const running = lines.some((line) => line.status === "degraded");
  const failed = lines.some((line) => line.status === "unavailable");
  const label = `${running ? "running" : "ran"} ${lines.length} command${lines.length === 1 ? "" : "s"} >`;
  return (
    <details className={`toolRunGroup ${running ? "running" : ""} ${failed ? "failed" : ""}`}>
      <summary>
        {failed ? <TriangleAlert size={12} /> : running ? <Wrench size={12} /> : <CheckCircle2 size={12} />}
        <span>{label}</span>
      </summary>
      <div className="toolRunList">
        {lines.map((line, index) => {
          const toolName = line.toolName ?? "tool";
          const isCommand = toolName === "terminal.run" || toolName === "bash";
          const command = line.command || line.content || line.detail || "";
          const statusLabel = line.status === "degraded" ? "running" : line.status === "unavailable" ? "failed" : "done";
          return (
            <div className={`toolRunItem ${line.status ?? "ready"}`} key={`${toolName}-${index}`}>
              <div className="toolRunTitle">
                <strong>{toolName}</strong>
                <span>{line.detail || toolDisplayText(toolName, line.status !== "degraded", line.status !== "unavailable")}</span>
                <em>{statusLabel}</em>
              </div>
              <div className="toolRunSection">
                <span>{isCommand ? "command" : "tool call"}</span>
                <CopyableCodeBlock language={isCommand ? "command" : "json"} content={command} />
              </div>
              {line.output ? (
                <div className="toolRunSection">
                  <span>output</span>
                  <CopyableCodeBlock language="output" content={line.output} />
                </div>
              ) : (
                <div className="toolRunEmptyOutput">{line.status === "degraded" ? "Waiting for output..." : "No output returned."}</div>
              )}
            </div>
          );
        })}
      </div>
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
        if (line.role === "tool" && chat.messages[index - 1]?.role === "tool") {
          return null;
        }
        if (line.role === "tool") {
          const group = [line];
          for (let nextIndex = index + 1; chat.messages[nextIndex]?.role === "tool"; nextIndex += 1) {
            group.push(chat.messages[nextIndex]);
          }
          return (
            <article className="message tool" key={`tool-group-${index}`}>
              <ToolRunGroup lines={group} />
            </article>
          );
        }
        const assistantContent = line.role === "assistant" ? cleanAssistantMessage(line.content) : "";
        const isStreamingPlaceholder = line.role === "assistant" && line.streaming && assistantContent.length === 0;
        if (line.role === "assistant" && !line.streaming && assistantContent.length === 0) {
          return null;
        }
        return (
          <article className={`message ${line.role}${line.streaming ? " streaming" : ""}`} key={`${line.role}-${index}`}>
            {line.role === "thinking" ? (
              <ThinkingBubble line={line} />
            ) : isStreamingPlaceholder ? (
              <p className="streamingPending">
                <span className="streamDot" />
                <span className="streamDot" />
                <span className="streamDot" />
              </p>
            ) : line.role === "assistant" ? (
              <>
                {assistantContent ? <MarkdownContent content={assistantContent} /> : null}
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
      const paths = diffGitPaths(line);
      current = { oldPath: paths.oldPath, newPath: paths.newPath, lines: [] };
      files.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith("--- ")) {
      const path = diffHeaderPath(line, "---", "a");
      if (path) {
        current.oldPath = path;
      }
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = diffHeaderPath(line, "+++", "b");
      if (path) {
        current.newPath = path;
      }
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

function diffGitPaths(line: string): { oldPath: string; newPath: string } {
  const raw = line.slice("diff --git ".length).trim();
  const match = /^"a\/(.+)"\s+"b\/(.+)"$/.exec(raw) || /^a\/(.+)\s+b\/(.+)$/.exec(raw);
  if (!match) {
    return { oldPath: "", newPath: "" };
  }
  return {
    oldPath: normalizeDiffPath(match[1]),
    newPath: normalizeDiffPath(match[2]),
  };
}

function diffHeaderPath(line: string, marker: "---" | "+++", prefix: "a" | "b"): string {
  const raw = line.slice(marker.length).trim();
  if (!raw || raw === "null") {
    return "";
  }
  if (raw === "/dev/null") {
    return raw;
  }
  return normalizeDiffPath(raw.replace(new RegExp(`^${prefix}/`), ""));
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
  const normalized = path.replace(/^"|"$/g, "").replace(/\\/g, "/").trim();
  return normalized === "null" ? "" : normalized;
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
  if (file.newPath === "/dev/null") {
    return normalizeDiffPath(file.oldPath || "Deleted file");
  }
  if (file.oldPath === "/dev/null") {
    return normalizeDiffPath(file.newPath || "New file");
  }
  return normalizeDiffPath(file.newPath || file.oldPath || "Changed file");
}

function openableDiffPath(file: ParsedDiffFile): string | null {
  if (file.newPath && file.newPath !== "/dev/null") {
    return file.newPath;
  }
  if (file.oldPath && file.oldPath !== "/dev/null") {
    return file.oldPath;
  }
  return null;
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
  const selectedOpenPath = selectedFile ? openableDiffPath(selectedFile) : null;
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
              <button
                type="button"
                disabled={!selectedOpenPath || selectedFile.newPath === "/dev/null"}
                onClick={() => selectedOpenPath ? onOpenFile(selectedOpenPath, firstChangedLine(selectedFile)) : undefined}
              >
                <FileText size={14} />
                {selectedFile.newPath === "/dev/null" ? "Deleted file" : openLabel}
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
