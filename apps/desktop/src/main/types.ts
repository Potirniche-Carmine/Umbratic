import type { ChildProcess } from "node:child_process";
import type { BackendUiEvent } from "../shared/backendEvents";
import type {
  BackendDiagnostics,
  CapabilityProbeCategory,
  CapabilityProbeImportance,
  CapabilityProbeStatus,
  LocalModelInfo,
  LocalProviderId,
  ModelEndpointMode,
  RemoteAuthMethod,
  RunnerToolId,
  TaskInfo,
  TaskRemoteInfo,
  WorkspaceMode,
} from "../shared/desktopApi";

export type {
  BackendDiagnostics,
  BackendStatus,
  CapabilityProbeCategory,
  CapabilityProbeImportance,
  CapabilityProbeReport,
  CapabilityProbeResult,
  CapabilityProbeStatus,
  ChatAttachment,
  ChatRecord,
  ConversationMessage,
  ConversationState,
  FileSearchKind,
  FileSearchResult,
  HarnessProfileId,
  IdeInfo,
  LocalDiagnosticInfo,
  LocalModelInfo,
  LocalModelProvider,
  LocalProviderId,
  ModelCapabilities,
  ModelEndpointMode,
  PastedAttachmentInput,
  PermissionMode,
  RemoteAuthMethod,
  RemoteConnectionCheck,
  RemoteConnectionDraft,
  RemoteConnectionInfo,
  RemoteDirectoryEntry,
  RemoteDirectoryListing,
  RemoteRunnerState,
  RepositoryInfo,
  RunnerToolId,
  ServiceStatus,
  TaskInfo,
  TaskState,
  TelemetryPolicyInfo,
  TestResult,
  ToolErrorCode,
  ToolResultStatus,
  UserNotes,
  WorkspaceKind,
  WorkspaceMode,
} from "../shared/desktopApi";
export type { ReviewFile } from "../shared/reviewDiff";
export type { BackendUiEvent };

export type TaskRemote = TaskRemoteInfo;
export type RuntimeDiagnostics = BackendDiagnostics["runtimes"];
export type ReviewScope = "task" | "worktree";

/** The minimum a connection needs to build an ssh command line. */
export type RemoteTarget = {
  host: string;
  port: number;
  username: string;
  authMethod: RemoteAuthMethod;
  identityFilePath?: string;
};

export type ActiveModelEndpointSettings = {
  mode: ModelEndpointMode;
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
  | "blocked-path"
  | "unknown";

export type TelemetrySyncResult = {
  ok: boolean;
  uploaded: number;
  pending: number;
  spooledPath: string;
  spoolDirectory: string;
  destination: string;
  message: string;
};

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

export type LspServerLaunchConfig = {
  id: string;
  command: string;
  args: string[];
  languageIds: string[];
  extensions: string[];
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

export type LocalDiagnosticLevel = "warn" | "error";

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
  | "permission.mode_changed"
  | "reasoning.mode_changed"
  | "task.accepted"
  | "task.undone"
  | "worktree.requested"
  | "worktree.approved"
  | "worktree.denied"
  | "worktree.created"
  | "worktree.kept"
  | "checkpoint.started"
  | "checkpoint.completed"
  | "checkpoint.failed"
  | "fork.completed"
  | "fork.failed"
  | "restore.started"
  | "restore.completed"
  | "restore.failed";

export type ProductTelemetryEvent = {
  id: string;
  type: ProductTelemetryEventType;
  at: string;
  taskId?: string;
  chatId?: string;
  repositoryId?: string;
  data?: Record<string, string | number | boolean>;
};

export type TaskRecord = TaskInfo & {
  workspaceMode: WorkspaceMode;
  originalRepoPath: string;
  originalWasDirty: boolean;
  modelEndpointMode?: ModelEndpointMode;
  hiddenWorkspace?: boolean;
  baselineFiles?: Record<string, string>;
  undoFileHashes?: Record<string, string>;
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
  activeWorkspaceId?: string;
  latestCheckpointId?: string;
  turnCheckpointId?: string;
  parentTaskId?: string;
  sourceCheckpointId?: string;
};

export type TaskCheckpoint = {
  id: string;
  taskId: string;
  workspaceId: string;
  parentCheckpointId?: string;
  source: "manual" | "pre_turn" | "pre_restore" | "pre_cleanup";
  label?: string;
  commitOid: string;
  treeOid: string;
  indexTreeOid?: string;
  createdAt: string;
  state: "preparing" | "ready" | "failed";
  pinned: boolean;
  logicalBytes?: number;
};

export type TaskWorkspace = {
  id: string;
  taskId: string;
  number: number;
  branch: string;
  path: string;
  sourceCheckpointId?: string;
  createdAt: string;
  state: "preparing" | "active" | "recovery" | "retired" | "failed";
};

export type PermissionRequest = {
  id: string;
  kind: "read" | "edit" | "bash";
  summary: string;
  command: string;
  commandClass?: CommandClass;
  cwd: string;
  consequence?: string;
  riskyFragment?: string;
  suggestion?: string;
};

export type ApproveResult =
  | { ok: true; targetBranch: string; commit: string; patchHash: string; metadataPath: string }
  | { ok: false; message: string };

export type IdeOpenResult = { ok: true } | { ok: false; message: string };

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
  /** Present when `child` is the ssh tunnel rather than the runner itself. */
  remote?: TaskRemote;
  diagnosticLogPath?: string;
  child: ChildProcess;
  abortController: AbortController;
  sessionId?: string;
  providerSessionRefresh?: ReturnType<typeof setInterval>;
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
