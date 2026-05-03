/// <reference types="vite/client" />

type AegisPermissionMode = "normal" | "bypass";
type AegisServiceStatus = "ready" | "degraded" | "unavailable";
type AegisWorkspaceKind = "git" | "folder";

type AegisRepositoryInfo = {
  id: string;
  name: string;
  rootPath: string;
  kind: AegisWorkspaceKind;
  originalBranch: string;
  baseCommit: string;
  dirty: boolean;
  statusSummary: string;
};

type AegisBackendStatus = {
  opencode: AegisServiceStatus;
  ollama: AegisServiceStatus;
  model: {
    providerId: "local-ollama";
    modelId: string;
    displayName: string;
    baseUrl: string;
  };
  permissionMode: AegisPermissionMode;
  privacy: {
    share: "disabled";
    enabledProviders: ["local-ollama"];
    disabledProviders: string[];
    webTools: "disabled";
  };
  message?: string;
};

type AegisTestResult = {
  command: string;
  output: string;
  passed: boolean;
  exitCode: number | null;
  completedAt: string;
};

type AegisReviewFile = {
  path: string;
  status: "added" | "modified" | "deleted";
  diff: string;
};

type AegisChatAttachment = {
  path: string;
  name: string;
};

type AegisFileSearchResult = AegisChatAttachment & {
  match: "path" | "content";
};

type AegisPermissionRequest = {
  id: string;
  kind: "edit" | "bash";
  summary: string;
  command: string;
  cwd: string;
};

type AegisBackendUiEvent =
  | { type: "assistant.delta"; taskId: string; text: string }
  | { type: "assistant.done"; taskId: string }
  | { type: "worktree.requested"; taskId: string; branch: string; path: string; baseCommit: string }
  | { type: "worktree.created"; taskId: string; branch: string; path: string }
  | { type: "command.started"; taskId: string; id: string; command: string; cwd: string }
  | { type: "command.output"; taskId: string; id: string; stream: "stdout" | "stderr"; text: string }
  | { type: "command.finished"; taskId: string; id: string; exitCode: number | null }
  | { type: "permission.requested"; taskId: string; request: AegisPermissionRequest }
  | { type: "permission.resolved"; taskId: string; id: string; decision: "allow" | "deny" }
  | { type: "review.ready"; taskId: string; changedFiles: string[]; reviewFiles: AegisReviewFile[]; latestTest?: AegisTestResult }
  | { type: "approval.check"; taskId: string; name: string; status: "running" | "passed" | "failed"; detail?: string }
  | { type: "merge.completed"; taskId: string; targetBranch: string; commit: string; patchHash: string }
  | { type: "task.error"; taskId: string; message: string };

type AegisChatRecord = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  taskId?: string;
  taskState?: AegisTaskInfo["state"];
  repositoryName?: string;
  repositoryPath?: string;
  changedFiles?: number;
  draftPrompt?: string;
  attachedFiles?: AegisChatAttachment[];
};

type AegisTaskInfo = {
  id: string;
  chatId?: string;
  repositoryId: string;
  prompt: string;
  workspaceKind: AegisWorkspaceKind;
  state: "awaiting_worktree_approval" | "running" | "review_ready" | "approving" | "merged" | "rejected" | "failed";
  originalBranch: string;
  baseCommit: string;
  agentBranch: string;
  worktreePath: string;
  permissionMode: AegisPermissionMode;
  createdAt: string;
  changedFiles: string[];
  reviewFiles: AegisReviewFile[];
  events: AegisBackendUiEvent[];
  latestTest?: AegisTestResult;
  patchHash?: string;
  error?: string;
};

type AegisPermissionDecision = {
  taskId: string;
  id: string;
  decision: "allow" | "deny";
};

type AegisIdeOpenResult = { ok: true } | { ok: false; message: string };
type AegisApproveResult =
  | { ok: true; targetBranch: string; commit: string; patchHash: string; metadataPath: string }
  | { ok: false; message: string };

type AegisIdeInfo = {
  id: string;
  label: string;
  icon: "vscode" | "visualstudio" | "explorer";
};

declare global {
  interface Window {
    aegis?: {
      listChats(): Promise<AegisChatRecord[]>;
      createChat(input?: { title?: string }): Promise<AegisChatRecord>;
      updateChatDraft(input: { chatId: string; draftPrompt: string; attachedFiles: AegisChatAttachment[] }): Promise<AegisChatRecord>;
      deleteChat(input: { chatId: string }): Promise<{ ok: true }>;
      getTask(input: { taskId: string }): Promise<AegisTaskInfo | null>;
      refreshTaskReview(input: { taskId: string }): Promise<AegisTaskInfo | null>;
      searchFiles(input: { repositoryId: string; query: string; limit?: number }): Promise<AegisFileSearchResult[]>;
      pickRepository(): Promise<{ canceled: true } | { canceled: false; repository: AegisRepositoryInfo }>;
      getBackendStatus(): Promise<AegisBackendStatus>;
      setPermissionMode(mode: AegisPermissionMode): Promise<AegisBackendStatus>;
      listAvailableIdes(): Promise<AegisIdeInfo[]>;
      startTask(input: { repositoryId: string; prompt: string; chatId?: string }): Promise<AegisTaskInfo>;
      approveWorktreeCreation(input: { taskId: string; approved: boolean }): Promise<void>;
      respondToToolPermission(input: AegisPermissionDecision): Promise<void>;
      openTaskInIde(input: { taskId: string; ideId: string }): Promise<AegisIdeOpenResult>;
      approveTaskMerge(input: { taskId: string }): Promise<AegisApproveResult>;
      rejectTask(input: { taskId: string; cleanup: boolean }): Promise<void>;
      keepWorktree(input: { taskId: string }): Promise<void>;
      cancelTask(input: { taskId: string }): Promise<void>;
      onBackendEvent(callback: (event: unknown) => void): () => void;
    };
  }
}

export {};
