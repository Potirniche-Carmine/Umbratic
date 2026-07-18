import type { ChildProcess } from "node:child_process";
import type { ReviewFile as NormalizedReviewFile } from "../shared/reviewDiff";
import type { BackendUiEventInput } from "../shared/backendEvents";

export type ServiceStatus = "ready" | "degraded" | "unavailable";
export type PermissionMode = "normal" | "bypass";
export type ReasoningMode = "fast" | "reasoning";
export type WorkspaceKind = "git" | "folder";
export type WorkspaceMode = "local" | "worktree";
export type RunnerToolId = "read" | "write" | "edit" | "search" | "command";
export type RequiredToolContractRequirement = "file_change";
export type RequiredToolContractReason =
  | "file_tools_disabled"
  | "missing_tool_call"
  | "agent_reported_blocker"
  | "attempted_tool_failed"
  | "no_review_changes";
export type HarnessProfileId = "marketing" | "sales" | "engineering";
export type LocalProviderId = "company-endpoint";
export type ModelEndpointMode = "local" | "server";
export type ModelEndpointSoftware = "ollama" | "vllm";
export type ModelEndpointSettings = {
  mode: ModelEndpointMode;
  software: ModelEndpointSoftware;
  baseUrl: string;
  modelId: string;
  secret: string;
  headers: Array<{ name: string; value: string }>;
};
export type CommandClass =
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
  runnerDiagnosticsDirectory: string;
  localLogs: LocalDiagnosticInfo;
  telemetry: TelemetryPolicyInfo;
  runtimes: RuntimeDiagnostics;
  capabilities: CapabilityProbeReport;
};

export type TelemetryPolicyInfo = {
  mode: "developer_toggle" | "managed_required" | "managed_disabled";
  localEnabled: boolean;
  syncEnabled: boolean;
  retentionDays: number;
  exportFormat: "redacted-json";
  storage: "company-managed-telemetry" | "task-event-snapshots";
};

export type TelemetrySyncResult = {
  ok: boolean;
  uploaded: number;
  pending: number;
  spooledPath: string;
  spoolDirectory: string;
  destination: string;
  message: string;
};

export type ToolResultStatus =
  | "success"
  | "permission_denied"
  | "policy_blocked"
  | "validation_error"
  | "runtime_error"
  | "timeout";

export type ToolErrorCode =
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

export type ContextContentKind =
  | "search"
  | "directory"
  | "file"
  | "command"
  | "json"
  | "log"
  | "diff"
  | "plain_text";

export type ContextCompressionStrategy =
  | "passthrough"
  | "search_top_lines"
  | "directory_grouped"
  | "log_errors_tail"
  | "json_array_sample"
  | "text_head_tail"
  | "tool_history_summary";

export type RuntimeDiagnostics = {
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
    platform: NodeJS.Platform;
    preferred: "pwsh" | "powershell" | "posix";
    nonInteractive: boolean;
  };
};

export type CapabilityProbeStatus = "available" | "missing" | "error" | "unknown";
export type CapabilityProbeCategory = "required" | "recommended" | "optional-engineering" | "optional-artifacts";
export type CapabilityProbeImportance = "required" | "recommended" | "optional";

export type CapabilityProbeResult = {
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

export type CapabilityProbeReport = {
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

export type CapabilityTelemetryProbe = {
  id: string;
  status: CapabilityProbeStatus;
  category: CapabilityProbeCategory;
  importance: CapabilityProbeImportance;
  workflows: string[];
  versionFamily?: string;
  affectedCurrentRun?: boolean;
};

export type LocalModelInfo = {
  providerId: LocalProviderId;
  providerName: string;
  modelId: string;
  displayName: string;
  baseUrl: string;
  contextLength?: number;
};

export type LocalDiagnosticInfo = {
  bytes: number;
  entries: number;
};

export type LocalDiagnosticLevel = "debug" | "info" | "warn" | "error";

export type LocalDiagnosticRecord = {
  id: number;
  at: string;
  level: LocalDiagnosticLevel;
  source: string;
  event: string;
  taskId?: string;
  message?: string;
  data: unknown;
};

export type ProductTelemetryEventType =
  | "review.opened"
  | "ide.selected"
  | "ide.opened"
  | "task.accepted"
  | "task.undone"
  | "worktree.requested"
  | "worktree.approved"
  | "worktree.denied"
  | "worktree.created"
  | "worktree.kept";

export type ProductTelemetryEvent = {
  id: string;
  type: ProductTelemetryEventType;
  at: string;
  taskId?: string;
  chatId?: string;
  repositoryId?: string;
  data?: Record<string, string | number | boolean>;
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

export type ReviewFile = NormalizedReviewFile;

export type ReviewScope = "task" | "worktree";

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
  reviewScope?: ReviewScope;
  reviewBaselineLabel?: string;
  reviewBaselineOid?: string;
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
  worktreeRootTaskId?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeBaseCommit?: string;
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
  capabilityProbes?: CapabilityTelemetryProbe[];
  runnerSessionId?: string;
  diagnosticLogPath?: string;
  pendingPrompt?: string;
  metadataPath?: string;
  approvedAt?: string;
  mergedAt?: string;
  rejectedAt?: string;
};

export type PermissionRequest = {
  id: string;
  kind: "read" | "edit" | "bash";
  summary: string;
  command: string;
  commandClass?: CommandClass;
  cwd: string;
};

export type BackendUiEvent = BackendUiEventInput;

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
  diagnosticLogPath?: string;
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
