/// <reference types="vite/client" />

type AegisPermissionMode = "normal" | "bypass";
type AegisReasoningMode = "fast" | "reasoning";
type AegisServiceStatus = "ready" | "degraded" | "unavailable";
type AegisWorkspaceKind = "git" | "folder";
type AegisWorkspaceMode = "local" | "worktree";
type AegisLocalProviderId = "local-endpoint";
type AegisCommandClass =
  | "read"
  | "edit"
  | "shell"
  | "python-runtime"
  | "markdown"
  | "cmake-build"
  | "compiler"
  | "debugger"
  | "package-manager"
  | "git-read"
  | "git-write"
  | "destructive-file"
  | "network"
  | "external-directory"
  | "unknown";
type AegisRuntimeProfileId = "none" | "python" | "markdown" | "cmake" | "powershell" | "posix-shell" | "node";

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
  runner: AegisServiceStatus;
  endpoint: AegisServiceStatus;
  model: AegisLocalModelInfo | null;
  models: AegisLocalModelInfo[];
  providers: AegisLocalModelProvider[];
  permissionMode: AegisPermissionMode;
  privacy: {
    share: "disabled";
    enabledProviders: AegisLocalProviderId[];
    disabledProviders: string[];
    webTools: "disabled";
  };
  diagnostics: AegisBackendDiagnostics;
  message?: string;
};

type AegisBackendDiagnostics = {
  runnerName: string;
  runnerVersion: string;
  runnerContractVersion: string;
  policyVersion: string;
  runnerBinary: "present" | "missing";
  configAssertions: "enabled";
  providerAllowlist: AegisLocalProviderId[];
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
    debugger: {
      supported: Array<"gdb" | "lldb" | "cdb">;
      toolName: "debugger";
      nonInteractive: boolean;
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
};

type AegisLocalModelInfo = {
  providerId: AegisLocalProviderId;
  providerName: string;
  modelId: string;
  displayName: string;
  baseUrl: string;
};

type AegisLocalModelProvider = {
  providerId: AegisLocalProviderId;
  providerName: string;
  baseUrl: string;
  status: AegisServiceStatus;
  models: AegisLocalModelInfo[];
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
  source?: "workspace" | "chat";
  storedPath?: string;
  originalPath?: string;
  previewDataUrl?: string;
};

type AegisPastedAttachmentInput = {
  name?: string;
  mimeType?: string;
  dataUrl: string;
};

type AegisFileSearchResult = AegisChatAttachment & {
  match: "path" | "content";
};

type AegisPermissionRequest = {
  id: string;
  kind: "edit" | "bash";
  summary: string;
  command: string;
  commandClass?: AegisCommandClass;
  cwd: string;
};

type AegisBackendEventMeta = { at?: string; endedAt?: string };
type AegisBackendUiEvent = AegisBackendEventMeta &
(
  | { type: "user.message"; taskId: string; text: string; attachedFiles?: AegisChatAttachment[] }
  | { type: "assistant.delta"; taskId: string; text: string }
  | { type: "assistant.reasoning.delta"; taskId: string; text: string }
  | { type: "assistant.done"; taskId: string }
  | { type: "worktree.requested"; taskId: string; branch: string; path: string; baseCommit: string }
  | { type: "worktree.created"; taskId: string; branch: string; path: string }
  | { type: "command.started"; taskId: string; id: string; command: string; cwd: string; kind?: AegisPermissionRequest["kind"]; commandClass?: AegisCommandClass }
  | { type: "command.output"; taskId: string; id: string; stream: "stdout" | "stderr"; text: string }
  | { type: "command.finished"; taskId: string; id: string; exitCode: number | null }
  | { type: "permission.requested"; taskId: string; request: AegisPermissionRequest }
  | { type: "permission.resolved"; taskId: string; id: string; decision: "allow" | "deny" }
  | { type: "review.ready"; taskId: string; changedFiles: string[]; reviewFiles: AegisReviewFile[]; latestTest?: AegisTestResult }
  | { type: "approval.check"; taskId: string; name: string; status: "running" | "passed" | "failed"; detail?: string }
  | { type: "merge.completed"; taskId: string; targetBranch: string; commit: string; patchHash: string }
  | { type: "response.feedback"; taskId: string; messageId: string; rating: "good" | "bad" }
  | { type: "task.error"; taskId: string; message: string }
);

type AegisChatRecord = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  repositoryName?: string;
  repositoryPath?: string;
  taskId?: string;
  taskState?: AegisTaskInfo["state"];
  changedFiles?: number;
  draftPrompt?: string;
  attachedFiles?: AegisChatAttachment[];
};

type AegisUserNotes = {
  content: string;
  updatedAt: string;
};

type AegisTaskInfo = {
  id: string;
  chatId?: string;
  repositoryId: string;
  prompt: string;
  workspaceKind: AegisWorkspaceKind;
  workspaceMode: AegisWorkspaceMode;
  state: "awaiting_worktree_approval" | "running" | "completed" | "review_ready" | "approving" | "merged" | "rejected" | "failed";
  originalBranch: string;
  baseCommit: string;
  agentBranch: string;
  worktreePath: string;
  permissionMode: AegisPermissionMode;
  reasoningMode?: AegisReasoningMode;
  runnerName?: string;
  runnerVersion?: string;
  policyVersion?: string;
  runtimeProfile?: AegisRuntimeProfileId;
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
  icon: "vscode" | "visualstudio" | "explorer" | "finder" | "files";
};

declare global {
  interface Window {
    aegis?: {
      listChats(): Promise<AegisChatRecord[]>;
      createChat(input?: { title?: string; repositoryName?: string; repositoryPath?: string }): Promise<AegisChatRecord>;
      updateChatDraft(input: { chatId: string; draftPrompt: string; attachedFiles: AegisChatAttachment[] }): Promise<AegisChatRecord>;
      deleteChat(input: { chatId: string }): Promise<{ ok: true }>;
      getNotes(): Promise<AegisUserNotes>;
      updateNotes(input: { content: string }): Promise<AegisUserNotes>;
      getTask(input: { taskId: string }): Promise<AegisTaskInfo | null>;
      refreshTaskReview(input: { taskId: string }): Promise<AegisTaskInfo | null>;
      searchFiles(input: { repositoryId: string; query: string; limit?: number }): Promise<AegisFileSearchResult[]>;
      pickRepository(): Promise<{ canceled: true } | { canceled: false; repository: AegisRepositoryInfo }>;
      pickAttachmentFiles(input: { chatId: string; repositoryId?: string }): Promise<{ canceled: true } | { canceled: false; files: AegisChatAttachment[] }>;
      savePastedAttachments(input: { chatId: string; files: AegisPastedAttachmentInput[] }): Promise<{ files: AegisChatAttachment[] }>;
      openChatAttachment(input: { attachment: AegisChatAttachment; repositoryId?: string }): Promise<{ ok: true } | { ok: false; message: string }>;
      getRepository(input: { repositoryId?: string; repositoryPath?: string }): Promise<AegisRepositoryInfo | null>;
      listRepositoryBranches(input: { repositoryId?: string; repositoryPath?: string }): Promise<
        { ok: true; current: string; branches: string[] } | { ok: false; message: string }
      >;
      checkoutRepositoryBranch(input: { repositoryId?: string; repositoryPath?: string; branch: string }): Promise<
        { ok: true; repository: AegisRepositoryInfo } | { ok: false; message: string }
      >;
      getBackendStatus(): Promise<AegisBackendStatus>;
      exportTelemetry(): Promise<{ ok: true; path: string } | { ok: false; message: string }>;
      listSkills(): Promise<{ skills: Array<{ id: string; name: string; description: string }>; directory: string }>;
      openSkillsFolder(): Promise<{ ok: true; directory: string } | { ok: false; message: string }>;
      createSkill(input: { name: string }): Promise<
        | { ok: true; skill: { id: string; name: string; description: string }; directory: string }
        | { ok: false; message: string }
      >;
      setPermissionMode(mode: AegisPermissionMode): Promise<AegisBackendStatus>;
      listAvailableIdes(): Promise<AegisIdeInfo[]>;
      startTask(input: {
        repositoryId?: string;
        prompt: string;
        chatId?: string;
        attachedFiles?: AegisChatAttachment[];
        reasoningMode?: AegisReasoningMode;
        useWorktree?: boolean;
      }): Promise<AegisTaskInfo>;
      approveWorktreeCreation(input: { taskId: string; approved: boolean }): Promise<void>;
      respondToToolPermission(input: AegisPermissionDecision): Promise<void>;
      openTaskInIde(input: { taskId: string; ideId: string; filePath?: string }): Promise<AegisIdeOpenResult>;
      approveTaskMerge(input: { taskId: string }): Promise<AegisApproveResult>;
      rejectTask(input: { taskId: string; cleanup: boolean }): Promise<void>;
      keepWorktree(input: { taskId: string }): Promise<void>;
      cancelTask(input: { taskId: string }): Promise<void>;
      setResponseFeedback(input: { taskId: string; messageId: string; rating: "good" | "bad" }): Promise<void>;
      setWindowChromeTheme(theme: "dark" | "light"): Promise<{ ok: true }>;
      onBackendEvent(callback: (event: unknown) => void): () => void;
    };
  }
}

export {};
