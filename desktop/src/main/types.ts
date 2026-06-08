import type { ChildProcess } from "node:child_process";

export type ServiceStatus = "ready" | "degraded" | "unavailable";
export type PermissionMode = "normal" | "bypass";
export type ReasoningMode = "fast" | "reasoning";
export type WorkspaceKind = "git" | "folder";
export type WorkspaceMode = "local" | "worktree";
export type RunnerToolId = "read" | "write" | "edit" | "search" | "command" | "debugger";
export type HarnessProfileId = "marketing" | "sales" | "engineering";
export type LocalProviderId = "company-endpoint";
export type ModelEndpointMode = "local" | "server";
export type ModelEndpointSoftware = "ollama" | "lmstudio" | "vllm";
export type ModelEndpointSettings = {
  mode: ModelEndpointMode;
  software: ModelEndpointSoftware;
  baseUrl: string;
  modelId: string;
  secret: string;
};
export type CommandClass =
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
export type RuntimeProfileId = "none" | "python" | "markdown" | "cmake" | "powershell" | "posix-shell" | "node";
export type TaskState =
  | "awaiting_worktree_approval"
  | "running"
  | "completed"
  | "review_ready"
  | "approving"
  | "approved"
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
  runner: ServiceStatus;
  endpoint: ServiceStatus;
  model: LocalModelInfo | null;
  models: LocalModelInfo[];
  providers: LocalModelProvider[];
  permissionMode: PermissionMode;
  endpointConfig: {
    source: "local-default" | "stored" | "managed";
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

export type BackendDiagnostics = {
  runnerName: string;
  runnerVersion: string;
  runnerContractVersion: string;
  policyVersion: string;
  runnerBinary: "present" | "missing";
  configAssertions: "enabled";
  providerAllowlist: LocalProviderId[];
  localhostOnlyModels: boolean;
  commandClassifier: "enabled";
  telemetry: TelemetryPolicyInfo;
  runtimes: RuntimeDiagnostics;
};

export type TelemetryPolicyInfo = {
  mode: "developer_toggle" | "managed_required" | "managed_disabled";
  localEnabled: boolean;
  syncEnabled: boolean;
  retentionDays: number;
  exportFormat: "redacted-json";
  storage: "company-managed-telemetry" | "task-event-snapshots";
};

export type RuntimeDiagnostics = {
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
    platform: NodeJS.Platform;
    preferred: "pwsh" | "powershell" | "posix";
    nonInteractive: boolean;
  };
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

export type UserNotes = {
  content: string;
  updatedAt: string;
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
  source?: "workspace" | "chat";
  storedPath?: string;
  originalPath?: string;
  previewDataUrl?: string;
};

export type PastedAttachmentInput = {
  name?: string;
  mimeType?: string;
  dataUrl: string;
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
  workspaceMode: WorkspaceMode;
  originalRepoPath: string;
  originalWasDirty: boolean;
  hiddenWorkspace?: boolean;
  baselineFiles?: Record<string, string>;
  model?: LocalModelInfo;
  providerId?: LocalProviderId;
  modelId?: string;
  modelBaseUrlHost?: string;
  enabledTools?: RunnerToolId[];
  runnerSessionId?: string;
  pendingPrompt?: string;
  metadataPath?: string;
  approvedAt?: string;
  mergedAt?: string;
  rejectedAt?: string;
};

export type PermissionRequest = {
  id: string;
  kind: "edit" | "bash";
  summary: string;
  command: string;
  commandClass?: CommandClass;
  cwd: string;
};

export type BackendEventMeta = { at?: string; endedAt?: string };

export type BackendUiEvent = BackendEventMeta &
(
  | { type: "user.message"; taskId: string; text: string; attachedFiles?: ChatAttachment[] }
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
  | { type: "approval.completed"; taskId: string; target: string; patchHash: string }
  | { type: "merge.completed"; taskId: string; targetBranch: string; commit: string; patchHash: string }
  | { type: "ide.opened"; taskId: string; ideId: string; target: "workspace" | "file"; filePath?: string; result: "success" | "failed"; message?: string }
  | { type: "response.feedback"; taskId: string; messageId: string; rating: "good" | "bad" }
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

export type RunnerProcess = {
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
