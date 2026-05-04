import type { ChildProcess } from "node:child_process";

export type ServiceStatus = "ready" | "degraded" | "unavailable";
export type PermissionMode = "normal" | "bypass";
export type ReasoningMode = "fast" | "reasoning";
export type WorkspaceKind = "git" | "folder";
export type LocalProviderId = "local-lmstudio";
export type TaskState =
  | "awaiting_worktree_approval"
  | "running"
  | "completed"
  | "review_ready"
  | "approving"
  | "merged"
  | "rejected"
  | "failed";

export type RepositoryInfo = {
  id: string;
  name: string;
  rootPath: string;
  kind: WorkspaceKind;
  originalBranch: string;
  baseCommit: string;
  dirty: boolean;
  statusSummary: string;
};

export type BackendStatus = {
  opencode: ServiceStatus;
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

export type LocalModelInfo = {
  providerId: LocalProviderId;
  providerName: string;
  modelId: string;
  displayName: string;
  baseUrl: string;
};

export type LocalModelProvider = {
  providerId: LocalProviderId;
  providerName: string;
  baseUrl: string;
  status: ServiceStatus;
  models: LocalModelInfo[];
  message?: string;
};

export type TestResult = {
  command: string;
  output: string;
  passed: boolean;
  exitCode: number | null;
  completedAt: string;
};

export type ReviewFile = {
  path: string;
  status: "added" | "modified" | "deleted";
  diff: string;
};

export type ChatAttachment = {
  path: string;
  name: string;
};

export type FileSearchResult = ChatAttachment & {
  match: "path" | "content";
};

export type TaskInfo = {
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
  createdAt: string;
  changedFiles: string[];
  reviewFiles: ReviewFile[];
  events: BackendUiEvent[];
  latestTest?: TestResult;
  patchHash?: string;
  error?: string;
};

export type ChatRecord = {
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

export type TaskRecord = TaskInfo & {
  originalRepoPath: string;
  originalWasDirty: boolean;
  hiddenWorkspace?: boolean;
  baselineFiles?: Record<string, string>;
  model?: LocalModelInfo;
  openCodeSessionId?: string;
  pendingPrompt?: string;
  metadataPath?: string;
  mergedAt?: string;
  rejectedAt?: string;
};

export type PermissionRequest = {
  id: string;
  kind: "edit" | "bash";
  summary: string;
  command: string;
  cwd: string;
};

export type BackendEventMeta = { at?: string; endedAt?: string };

export type BackendUiEvent = BackendEventMeta &
(
  | { type: "user.message"; taskId: string; text: string }
  | { type: "assistant.delta"; taskId: string; text: string }
  | { type: "assistant.reasoning.delta"; taskId: string; text: string }
  | { type: "assistant.done"; taskId: string }
  | { type: "worktree.requested"; taskId: string; branch: string; path: string; baseCommit: string }
  | { type: "worktree.created"; taskId: string; branch: string; path: string }
  | { type: "command.started"; taskId: string; id: string; command: string; cwd: string; kind?: PermissionRequest["kind"] }
  | { type: "command.output"; taskId: string; id: string; stream: "stdout" | "stderr"; text: string }
  | { type: "command.finished"; taskId: string; id: string; exitCode: number | null }
  | { type: "permission.requested"; taskId: string; request: PermissionRequest }
  | { type: "permission.resolved"; taskId: string; id: string; decision: "allow" | "deny" }
  | { type: "review.ready"; taskId: string; changedFiles: string[]; reviewFiles: ReviewFile[]; latestTest?: TestResult }
  | { type: "approval.check"; taskId: string; name: string; status: "running" | "passed" | "failed"; detail?: string }
  | { type: "merge.completed"; taskId: string; targetBranch: string; commit: string; patchHash: string }
  | { type: "task.error"; taskId: string; message: string }
);

export type ApproveResult =
  | { ok: true; targetBranch: string; commit: string; patchHash: string; metadataPath: string }
  | { ok: false; message: string };

export type IdeOpenResult = { ok: true } | { ok: false; message: string };

export type IdeInfo = {
  id: string;
  label: string;
  icon: "vscode" | "visualstudio" | "explorer" | "finder" | "files";
};

export type CommandOutput = {
  stdout: string;
  stderr: string;
};

export type CommandResult = CommandOutput & {
  exitCode: number | null;
  success: boolean;
};

export type OpenCodeRun = {
  taskId: string;
  url: string;
  password: string;
  directory: string;
  child: ChildProcess;
  abortController: AbortController;
  sessionId?: string;
};

export type PendingPermission = {
  taskId: string;
  onAllow: () => Promise<void> | void;
  onDeny: () => Promise<void> | void;
};

export type SseStream = {
  ready: Promise<void>;
  done: Promise<void>;
};
