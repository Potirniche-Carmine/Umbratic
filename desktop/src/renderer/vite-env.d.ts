/// <reference types="vite/client" />

type UmbraticPermissionMode = "normal" | "bypass";
type UmbraticReasoningMode = "fast" | "reasoning";
type UmbraticServiceStatus = "ready" | "degraded" | "unavailable";
type UmbraticWorkspaceKind = "git" | "folder";
type UmbraticWorkspaceMode = "local" | "worktree";
type UmbraticLocalProviderId = "company-endpoint";
type UmbraticModelEndpointMode = "local" | "server";
type UmbraticModelEndpointSettings = {
  mode: UmbraticModelEndpointMode;
  baseUrl: string;
  modelId: string;
  secret: string;
};
type UmbraticCommandClass =
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
type UmbraticRuntimeProfileId = "none" | "python" | "markdown" | "cmake" | "powershell" | "posix-shell" | "node";

type UmbraticRepositoryInfo = {
  id: string;
  name: string;
  rootPath: string;
  kind: UmbraticWorkspaceKind;
  originalBranch: string;
  baseCommit: string;
  dirty: boolean;
  statusSummary: string;
};

type UmbraticBackendStatus = {
  runner: UmbraticServiceStatus;
  endpoint: UmbraticServiceStatus;
  model: UmbraticLocalModelInfo | null;
  models: UmbraticLocalModelInfo[];
  providers: UmbraticLocalModelProvider[];
  permissionMode: UmbraticPermissionMode;
  privacy: {
    share: "disabled";
    enabledProviders: UmbraticLocalProviderId[];
    disabledProviders: string[];
    webTools: "disabled";
  };
  diagnostics: UmbraticBackendDiagnostics;
  message?: string;
};

type UmbraticBackendDiagnostics = {
  runnerName: string;
  runnerVersion: string;
  runnerContractVersion: string;
  policyVersion: string;
  runnerBinary: "present" | "missing";
  configAssertions: "enabled";
  providerAllowlist: UmbraticLocalProviderId[];
  localhostOnlyModels: boolean;
  commandClassifier: "enabled";
  telemetry: {
    mode: "developer_toggle" | "managed_required" | "managed_disabled";
    localEnabled: boolean;
    syncEnabled: boolean;
    retentionDays: number;
    exportFormat: "redacted-json";
    storage: "company-managed-telemetry" | "task-event-snapshots";
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
      buildDir: ".umbratic/build";
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

type UmbraticLocalModelInfo = {
  providerId: UmbraticLocalProviderId;
  providerName: string;
  modelId: string;
  displayName: string;
  baseUrl: string;
};

type UmbraticLocalModelProvider = {
  providerId: UmbraticLocalProviderId;
  providerName: string;
  baseUrl: string;
  status: UmbraticServiceStatus;
  models: UmbraticLocalModelInfo[];
  message?: string;
};

type UmbraticTestResult = {
  command: string;
  output: string;
  passed: boolean;
  exitCode: number | null;
  completedAt: string;
};

type UmbraticReviewFile = {
  path: string;
  status: "added" | "modified" | "deleted";
  diff: string;
};

type UmbraticChatAttachment = {
  path: string;
  name: string;
  source?: "workspace" | "chat";
  storedPath?: string;
  originalPath?: string;
  previewDataUrl?: string;
};

type UmbraticPastedAttachmentInput = {
  name?: string;
  mimeType?: string;
  dataUrl: string;
};

type UmbraticFileSearchResult = UmbraticChatAttachment & {
  match: "path" | "content";
};

type UmbraticPermissionRequest = {
  id: string;
  kind: "edit" | "bash";
  summary: string;
  command: string;
  commandClass?: UmbraticCommandClass;
  cwd: string;
};

type UmbraticBackendEventMeta = { at?: string; endedAt?: string };
type UmbraticBackendUiEvent = UmbraticBackendEventMeta &
(
  | { type: "user.message"; taskId: string; text: string; attachedFiles?: UmbraticChatAttachment[] }
  | { type: "assistant.delta"; taskId: string; text: string }
  | { type: "assistant.reasoning.delta"; taskId: string; text: string }
  | { type: "assistant.done"; taskId: string }
  | { type: "worktree.requested"; taskId: string; branch: string; path: string; baseCommit: string }
  | { type: "worktree.created"; taskId: string; branch: string; path: string }
  | { type: "command.started"; taskId: string; id: string; command: string; cwd: string; kind?: UmbraticPermissionRequest["kind"]; commandClass?: UmbraticCommandClass }
  | { type: "command.output"; taskId: string; id: string; stream: "stdout" | "stderr"; text: string }
  | { type: "command.finished"; taskId: string; id: string; exitCode: number | null }
  | { type: "permission.requested"; taskId: string; request: UmbraticPermissionRequest }
  | { type: "permission.resolved"; taskId: string; id: string; decision: "allow" | "deny" }
  | { type: "review.ready"; taskId: string; changedFiles: string[]; reviewFiles: UmbraticReviewFile[]; latestTest?: UmbraticTestResult }
  | { type: "approval.check"; taskId: string; name: string; status: "running" | "passed" | "failed"; detail?: string }
  | { type: "merge.completed"; taskId: string; targetBranch: string; commit: string; patchHash: string }
  | { type: "response.feedback"; taskId: string; messageId: string; rating: "good" | "bad" }
  | { type: "task.error"; taskId: string; message: string }
);

type UmbraticChatRecord = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  repositoryName?: string;
  repositoryPath?: string;
  taskId?: string;
  taskState?: UmbraticTaskInfo["state"];
  changedFiles?: number;
  draftPrompt?: string;
  attachedFiles?: UmbraticChatAttachment[];
};

type UmbraticUserNotes = {
  content: string;
  updatedAt: string;
};

type UmbraticTaskInfo = {
  id: string;
  chatId?: string;
  repositoryId: string;
  prompt: string;
  workspaceKind: UmbraticWorkspaceKind;
  workspaceMode: UmbraticWorkspaceMode;
  state: "awaiting_worktree_approval" | "running" | "completed" | "review_ready" | "approving" | "merged" | "rejected" | "failed";
  originalBranch: string;
  baseCommit: string;
  agentBranch: string;
  worktreePath: string;
  permissionMode: UmbraticPermissionMode;
  reasoningMode?: UmbraticReasoningMode;
  runnerName?: string;
  runnerVersion?: string;
  policyVersion?: string;
  runtimeProfile?: UmbraticRuntimeProfileId;
  createdAt: string;
  changedFiles: string[];
  reviewFiles: UmbraticReviewFile[];
  events: UmbraticBackendUiEvent[];
  latestTest?: UmbraticTestResult;
  patchHash?: string;
  error?: string;
};

type UmbraticPermissionDecision = {
  taskId: string;
  id: string;
  decision: "allow" | "deny";
};

type UmbraticIdeOpenResult = { ok: true } | { ok: false; message: string };
type UmbraticApproveResult =
  | { ok: true; targetBranch: string; commit: string; patchHash: string; metadataPath: string }
  | { ok: false; message: string };

type UmbraticIdeInfo = {
  id: string;
  label: string;
  icon: "vscode" | "visualstudio" | "explorer" | "finder" | "files";
};

declare global {
  interface Window {
    umbratic?: {
      listChats(): Promise<UmbraticChatRecord[]>;
      createChat(input?: { title?: string; repositoryName?: string; repositoryPath?: string }): Promise<UmbraticChatRecord>;
      updateChatDraft(input: { chatId: string; draftPrompt: string; attachedFiles: UmbraticChatAttachment[] }): Promise<UmbraticChatRecord>;
      deleteChat(input: { chatId: string }): Promise<{ ok: true }>;
      getNotes(): Promise<UmbraticUserNotes>;
      updateNotes(input: { content: string }): Promise<UmbraticUserNotes>;
      getTask(input: { taskId: string }): Promise<UmbraticTaskInfo | null>;
      refreshTaskReview(input: { taskId: string }): Promise<UmbraticTaskInfo | null>;
      searchFiles(input: { repositoryId: string; query: string; limit?: number }): Promise<UmbraticFileSearchResult[]>;
      pickRepository(): Promise<{ canceled: true } | { canceled: false; repository: UmbraticRepositoryInfo }>;
      pickAttachmentFiles(input: { chatId: string; repositoryId?: string }): Promise<{ canceled: true } | { canceled: false; files: UmbraticChatAttachment[] }>;
      savePastedAttachments(input: { chatId: string; files: UmbraticPastedAttachmentInput[] }): Promise<{ files: UmbraticChatAttachment[] }>;
      openChatAttachment(input: { attachment: UmbraticChatAttachment; repositoryId?: string }): Promise<{ ok: true } | { ok: false; message: string }>;
      getRepository(input: { repositoryId?: string; repositoryPath?: string }): Promise<UmbraticRepositoryInfo | null>;
      listRepositoryBranches(input: { repositoryId?: string; repositoryPath?: string }): Promise<
        { ok: true; current: string; branches: string[] } | { ok: false; message: string }
      >;
      checkoutRepositoryBranch(input: { repositoryId?: string; repositoryPath?: string; branch: string }): Promise<
        { ok: true; repository: UmbraticRepositoryInfo } | { ok: false; message: string }
      >;
      getBackendStatus(): Promise<UmbraticBackendStatus>;
      getModelEndpointSettings(): Promise<UmbraticModelEndpointSettings>;
      saveModelEndpointSettings(input: UmbraticModelEndpointSettings): Promise<{
        settings: UmbraticModelEndpointSettings;
        status: UmbraticBackendStatus;
      }>;
      exportTelemetry(): Promise<{ ok: true; path: string } | { ok: false; message: string }>;
      listSkills(): Promise<{ skills: Array<{ id: string; name: string; description: string }>; directory: string }>;
      openSkillsFolder(): Promise<{ ok: true; directory: string } | { ok: false; message: string }>;
      createSkill(input: { name: string }): Promise<
        | { ok: true; skill: { id: string; name: string; description: string }; directory: string }
        | { ok: false; message: string }
      >;
      setPermissionMode(mode: UmbraticPermissionMode): Promise<UmbraticBackendStatus>;
      listAvailableIdes(): Promise<UmbraticIdeInfo[]>;
      startTask(input: {
        repositoryId?: string;
        prompt: string;
        chatId?: string;
        attachedFiles?: UmbraticChatAttachment[];
        reasoningMode?: UmbraticReasoningMode;
        useWorktree?: boolean;
      }): Promise<UmbraticTaskInfo>;
      approveWorktreeCreation(input: { taskId: string; approved: boolean }): Promise<void>;
      respondToToolPermission(input: UmbraticPermissionDecision): Promise<void>;
      openTaskInIde(input: { taskId: string; ideId: string; filePath?: string }): Promise<UmbraticIdeOpenResult>;
      approveTaskMerge(input: { taskId: string }): Promise<UmbraticApproveResult>;
      rejectTask(input: { taskId: string; cleanup: boolean }): Promise<void>;
      keepWorktree(input: { taskId: string }): Promise<void>;
      cancelTask(input: { taskId: string }): Promise<void>;
      setResponseFeedback(input: { taskId: string; messageId: string; rating: "good" | "bad" }): Promise<void>;
      setWindowChromeTheme(theme: "dark" | "light"): Promise<{ ok: true }>;
      onBackendEvent(callback: (event: unknown) => void): () => void;
    };
    umbratic?: Window["umbratic"];
  }
}

export {};
