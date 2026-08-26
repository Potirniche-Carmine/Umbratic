import type { ResponseFeedbackReason, ResponseRating } from "./responseFeedback";
import type { BackendUiEvent } from "./backendEvents";
import type { DocumentReviewSnapshot } from "./documentReview";
import type { LocalCatalogModel, LocalCatalogModelKind, ModelDownloadEvent } from "./localModels";
import type { ReviewFile } from "./reviewDiff";

export type { ReviewFile };

export type ServiceStatus = "ready" | "degraded" | "unavailable";
export type PermissionMode = "normal" | "auto_safe";
export type WorkspaceKind = "git" | "folder";
export type WorkspaceMode = "local" | "worktree";
export type HarnessProfileId = "marketing" | "sales" | "engineering";
export type LocalProviderId = "company-endpoint";
export type ModelEndpointMode = "local" | "server";
export type RunnerToolId =
  | "read"
  | "ls"
  | "find"
  | "search"
  | "web_search"
  | "web_fetch"
  | "write"
  | "edit"
  | "lsp"
  | "workspace_graph"
  | "artifact"
  | "command";
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

export type PublicModelEndpointSettings = {
  mode: ModelEndpointMode;
  baseUrl: string;
  modelId: string;
  secret: string;
  secretConfigured: boolean;
  headers: Array<{
    name: string;
    value: string;
    valueConfigured: boolean;
  }>;
};

export type CompanyConnectionStatus = {
  state: "not_enrolled" | "enrolled";
  baseUrl?: string;
  orgName?: string;
  deviceLabel?: string;
};

/**
 * One model a server-mode Veil publishes. `available` is live — a registered
 * model whose process is stopped stays listed and dimmed, because a user with
 * it selected needs to see why nothing is answering.
 */
export type ServerModelInfo = {
  id: string;
  display: string;
  contextLength?: number;
  reasoning: boolean;
  available: boolean;
  default: boolean;
};

export type DesktopStartupSettings = {
  permissionMode: PermissionMode;
  modelEndpoint: PublicModelEndpointSettings;
  companyConnection: CompanyConnectionStatus;
  harnessProfile: HarnessProfileId;
  contextLength: number;
  reasoningEffort: ReasoningEffort;
  /** Live model thinking in the Working block. Off until the user asks. */
  showThinking: boolean;
  sendOnEnter: boolean;
  /** Composer Web toggle. Off until the user turns it on. */
  webTools: boolean;
};

/** How a remote connection proves who it is. */
export type RemoteAuthMethod = "agent" | "identity_file" | "password";

export type RemoteRunnerState = "unknown" | "missing" | "outdated" | "ready";

/**
 * A saved remote host, as the renderer is allowed to see it. The password never
 * crosses this boundary — only whether one is configured.
 */
export type RemoteConnectionInfo = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: RemoteAuthMethod;
  identityFilePath: string;
  passwordConfigured: boolean;
  /** Where a run starts unless the chat picked another folder. */
  defaultDirectory: string;
  runnerState: RemoteRunnerState;
  /** What the installed runner calls itself, for display only. */
  runnerVersion: string;
  /** Absolute path on the remote host, empty when nothing is installed. */
  runnerPath: string;
  platform: { os: string; arch: string };
};

export type RemoteConnectionDraft = {
  id?: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: RemoteAuthMethod;
  identityFilePath?: string;
  /** Empty leaves a stored password untouched; a value replaces it. */
  password?: string;
  defaultDirectory?: string;
};

export type RemoteConnectionCheck = {
  ok: boolean;
  message: string;
  connection: RemoteConnectionInfo;
};

export type RemoteDirectoryEntry = {
  name: string;
  /** Absolute POSIX path on the remote host. */
  path: string;
  kind: "directory" | "file";
  /** True for a directory the connecting user cannot enter. */
  unreadable: boolean;
};

export type RemoteDirectoryListing = {
  path: string;
  parentPath: string;
  entries: RemoteDirectoryEntry[];
  /** Set when the directory holds more entries than the listing returned. */
  truncated: boolean;
};

export type CapabilityProbeStatus = "available" | "missing" | "error" | "unknown";
export type CapabilityProbeCategory =
  | "required"
  | "recommended"
  | "optional-engineering"
  | "optional-artifacts";
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

export type LocalModelInfo = {
  providerId: LocalProviderId;
  providerName: string;
  modelId: string;
  displayName: string;
  baseUrl: string;
  contextLength?: number;
  capabilities?: ModelCapabilities;
};

export type ModelCapabilities = {
  parallelToolCalls: boolean;
  vision: boolean;
  reasoning: boolean;
  /**
   * The effort levels this model's chat template reads, in menu order. Absent
   * or empty means it takes no direction on how hard to think — narrower than
   * `reasoning`, and a choice the template ignores is worse than none.
   */
  reasoningEfforts?: ReasoningEffort[];
};

/** How hard the model is asked to think. "off" is a level, not an absence. */
export type ReasoningEffort = "off" | "on" | "low" | "medium" | "high";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["off", "on", "low", "medium", "high"];

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/**
 * The level a model actually runs at, out of the ones it offers, or null when
 * it offers none.
 *
 * The stored effort is one setting across every model, but each model grades
 * thinking its own way, so the stored level is often not one this model reads.
 * It falls back to a level this model does offer, keeping whether the user
 * wanted thinking at all: someone on "medium" who switches to a model that
 * only knows on and off means on, and taking the first offered level instead
 * would quietly turn their thinking off.
 *
 * Both sides resolve through here — the runtime, to decide what to start the
 * model with, and the menu, to decide which row is checked. Resolving in one
 * place is what keeps the checkmark on the level the model is really using
 * rather than on nothing at all.
 */
export function resolveReasoningEffort(
  offered: readonly ReasoningEffort[] | undefined,
  effort: ReasoningEffort,
): ReasoningEffort | null {
  if (!offered || offered.length === 0) return null;
  if (offered.includes(effort)) return effort;
  const wantsThinking = effort !== "off";
  return offered.find((level) => (level !== "off") === wantsThinking) ?? offered[0];
}

export type LocalModelProvider = {
  providerId: LocalProviderId;
  providerName: string;
  baseUrl: string;
  status: ServiceStatus;
  models: LocalModelInfo[];
  message?: string;
};

export type LocalDiagnosticInfo = {
  bytes: number;
  entries: number;
};

export type TelemetryPolicyInfo = {
  mode: "developer_toggle" | "managed_required" | "managed_disabled";
  localEnabled: boolean;
  syncEnabled: boolean;
  retentionDays: number;
  exportFormat: "redacted-json";
  storage: "company-managed-telemetry" | "task-event-snapshots";
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
  runtimes: {
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
      platform: string;
      preferred: "pwsh" | "powershell" | "posix";
      nonInteractive: boolean;
    };
  };
  capabilities: CapabilityProbeReport;
};

export type BackendStatus = {
  runner: ServiceStatus;
  endpoint: ServiceStatus;
  model: LocalModelInfo | null;
  models: LocalModelInfo[];
  providers: LocalModelProvider[];
  permissionMode: PermissionMode;
  /**
   * Feature names the connected Veil advertised on the last health check.
   * Empty in local mode and on a server that advertises nothing — the renderer
   * hides server-cooperation controls rather than offering ones that would
   * silently do nothing.
   */
  veilFeatures: string[];
  /**
   * Whether local mode can transcribe right now: a dictation model is selected
   * and its files are on disk. False in server mode, where `veilFeatures`
   * already answers the same question.
   */
  localDictationReady: boolean;
  system: SystemProfile;
  endpointConfig: {
    source: "local-default" | "server-default" | "stored" | "managed";
    endpointEditingAllowed: boolean;
  };
  privacy: {
    share: "disabled";
    enabledProviders: LocalProviderId[];
    webTools: "off" | "on";
  };
  diagnostics: BackendDiagnostics;
  message?: string;
};

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

export type ChatAttachment = {
  path: string;
  name: string;
  kind?: "file" | "folder";
  source?: "workspace" | "chat";
  storedPath?: string;
  originalPath?: string;
  previewDataUrl?: string;
  contextTokens?: number;
};

export type FileSearchKind = "file" | "folder" | "all";

export type PastedAttachmentInput = {
  name?: string;
  mimeType?: string;
  dataUrl: string;
};

/**
 * A draft for a chat that has not been created yet. Held in main-process memory,
 * never written to disk: it survives moving between chats and is gone on restart.
 */
export type UnsavedChatDraft = {
  draftPrompt: string;
  attachedFiles: ChatAttachment[];
};

export type FileSearchResult = ChatAttachment & {
  kind: "file" | "folder";
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

export type { BackendUiEvent };

/** Identifies the remote host a task ran on, for tasks that did not run here. */
export type TaskRemoteInfo = {
  connectionId: string;
  name: string;
  host: string;
  directory: string;
};

export type TaskInfo = {
  id: string;
  chatId?: string;
  worktreeRootTaskId?: string;
  remote?: TaskRemoteInfo;
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
  runnerName?: string;
  runnerVersion?: string;
  policyVersion?: string;
  createdAt: string;
  changedFiles: string[];
  reviewFiles: ReviewFile[];
  events: BackendUiEvent[];
  latestTest?: TestResult;
  reviewPatchHash?: string;
  reviewScope?: "task" | "worktree";
  reviewBaselineLabel?: string;
  reviewBaselineOid?: string;
  patchHash?: string;
  error?: string;
};

export type ConversationMessage = {
  role: "user" | "assistant" | "tool";
  content: unknown;
  toolCallId?: string;
  toolCalls?: unknown[];
};

export type ConversationState = {
  sourceTaskId: string;
  updatedAt: string;
  summary: string | null;
  tail: ConversationMessage[];
  sourceDigest: string;
  usage: {
    estimatedPromptTokens: number;
    observedPromptTokens: number | null;
    compactionCount: number;
  };
};

export type ChatRecord = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  modelEndpointMode?: ModelEndpointMode;
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
  conversationState?: ConversationState;
};

export type TaskCheckpointView = {
  id: string;
  source: "manual" | "pre_turn" | "pre_restore" | "pre_cleanup";
  label?: string;
  createdAt: string;
  state: "preparing" | "ready" | "failed";
  pinned: boolean;
  logicalBytes?: number;
};

export type IdeInfo = {
  id: string;
  label: string;
  icon: "vscode" | "visualstudio" | "explorer" | "finder" | "files";
};

export type SkillInfo = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  source: "system" | "local";
  readOnly: boolean;
  checksum?: string;
  checksumStatus: "known_good" | "modified" | "untracked";
  modified: boolean;
  provenance?: "bundled" | "created" | "imported";
  paths?: string[];
};

export type SkillDocument = SkillInfo & {
  path: string;
  content: string;
};

export type WorkspaceIndexEvent = {
  workspacePath: string;
  phase: "started" | "finished";
  ok?: boolean;
};

/**
 * One update from the open dictation.
 *
 * A partial replaces the previous partial rather than extending it: a
 * transcript is not append-only, and a model that has heard two more syllables
 * may revise words it already emitted. `final` and `error` are terminal.
 * `loading` is sent once, before a start that has to read speech weights into
 * memory — the one press where "starting" is tens of seconds rather than a
 * beat, and the only one worth explaining outside the button.
 */
export type DictationEvent =
  | { kind: "loading" }
  | { kind: "partial"; text: string }
  | { kind: "final"; text: string; truncated: boolean }
  | { kind: "error"; message: string };

/**
 * How dictation is configured. `model` is a catalog id or "off"; `language` is
 * a hint for the runtime, where null means detect it.
 */
export type DictationSettings = {
  model: "off" | "qwen3-asr-0.6b" | "qwen3-asr-1.7b";
  language: string | null;
  /** The chosen microphone's device id, or null for the system default. */
  deviceId: string | null;
};

/**
 * One rebound chord, as it is stored.
 *
 * `primary` is Command on a Mac and Control everywhere else, so one stored
 * binding covers a user who moves between the two. The shortcut's id and what
 * it does are the renderer's business — this side keeps only the keys.
 */
export type StoredKeyBinding = {
  key: string;
  primary?: boolean;
  shift?: boolean;
  alt?: boolean;
};

/**
 * Only the chords the user actually changed, by shortcut id. A stored copy of
 * the whole table would pin every default to whatever shipped the day it was
 * written, so a release that moves one could never move it for them.
 */
export type KeyBindingSettings = Record<string, StoredKeyBinding>;

/**
 * Where the installed app stands against the release feed at downloads.umbratic.ai.
 *
 * `automatic` is the one setting: whether the app checks on its own. Off means
 * the feed is never reached at all — there is no on-demand check to override
 * it — which is the contract for a machine that is meant to stay quiet.
 * `checkedAt` is the last time this session actually consulted the feed, so a
 * user can see that "up to date" is a fresh answer rather than an old one; a
 * check that never left the machine does not move it. Downloads happen in the
 * background; the `ready` state is the one that asks something of the user.
 */
export type AppUpdateStatus = {
  installedVersion: string;
  automatic: boolean;
  checkedAt: string | null;
  state:
    /** A development build, which has no feed to check. */
    | { phase: "unsupported" }
    | { phase: "idle" }
    | { phase: "checking" }
    | { phase: "current" }
    /**
     * The feed will not serve this installation: its company's licence ended,
     * it was revoked, or this machine has never reached a Veil to be given a
     * token. Distinct from `failed` because nothing is broken and nobody at
     * this keyboard can act on it.
     */
    | { phase: "unlicensed" }
    | { phase: "downloading"; latestVersion: string; percent: number }
    | { phase: "ready"; latestVersion: string }
    | { phase: "failed"; message: string };
};

/**
 * What this machine brings to running a model, independent of which model is
 * chosen. Reported so a user whose graphics driver leaves the app on the
 * processor sees that, rather than concluding the app is just slow.
 * `accelerator` is the backend family — "Vulkan", "Metal" — or null on the CPU.
 * `vramGB` is the accelerator's own memory, and null when there is none to
 * report separately: no accelerator, or one that shares system memory.
 */
export type SystemProfile = {
  totalRamGB: number;
  vramGB: number | null;
  accelerator: string | null;
  acceleratorDevice: string | null;
  quality: "optimal" | "good" | "cpu";
};

export type { LocalCatalogModel, LocalCatalogModelKind, LocalMemoryFit, LocalModelQuant, ModelDownloadEvent } from "./localModels";

export type DesktopApi = {
  listProjects(): Promise<RepositoryInfo[]>;
  listChats(): Promise<ChatRecord[]>;
  createChat(input?: {
    id?: string;
    title?: string;
    repositoryName?: string;
    repositoryPath?: string;
    worktreeTaskId?: string;
  }): Promise<ChatRecord>;
  updateChatDraft(input: {
    chatId: string;
    draftPrompt: string;
    attachedFiles: ChatAttachment[];
  }): Promise<ChatRecord>;
  updateChatProject(input: {
    chatId: string;
    repositoryName: string;
    repositoryPath: string;
  }): Promise<ChatRecord>;
  /**
   * The draft for a chat that has not been created yet, held in main-process
   * memory only. `scope` is the workspace path the new chat belongs to, or ""
   * for none.
   */
  getUnsavedDraft(input: { scope: string }): Promise<UnsavedChatDraft>;
  setUnsavedDraft(input: {
    scope: string;
    draftPrompt: string;
    attachedFiles: ChatAttachment[];
  }): Promise<UnsavedChatDraft>;
  clearUnsavedDraft(input: { scope: string }): Promise<{ ok: true }>;
  deleteChat(input: { chatId: string }): Promise<{ ok: true }>;
  deleteProjectChats(input: {
    projectId: string;
  }): Promise<{ ok: true; deletedChatIds: string[] }>;
  deleteProject(input: {
    projectId: string;
  }): Promise<{ ok: true; deletedChatIds: string[] }>;
  getNotes(): Promise<UserNotes>;
  updateNotes(input: { content: string }): Promise<UserNotes>;
  getTask(input: { taskId: string }): Promise<TaskInfo | null>;
  listTaskCheckpoints(input: { taskId: string }): Promise<{
    supported: boolean;
    reason?: string;
    changedFileCount: number;
    checkpoints: TaskCheckpointView[];
  }>;
  createTaskCheckpoint(input: {
    taskId: string;
    label?: string;
  }): Promise<TaskCheckpointView>;
  setTaskCheckpointPinned(input: {
    taskId: string;
    checkpointId: string;
    pinned: boolean;
  }): Promise<TaskCheckpointView>;
  deleteTaskCheckpoint(input: {
    taskId: string;
    checkpointId: string;
  }): Promise<void>;
  forkTaskCheckpoint(input: {
    taskId: string;
    checkpointId: string;
  }): Promise<TaskInfo>;
  restoreTaskCheckpoint(input: {
    taskId: string;
    checkpointId: string;
    confirmed: boolean;
  }): Promise<TaskInfo>;
  refreshTaskReview(input: {
    taskId: string;
    scope?: "task" | "worktree";
    repositoryPath?: string;
  }): Promise<TaskInfo | null>;
  refreshWorkspaceReview(input: {
    repositoryPath: string;
  }): Promise<{ reviewFiles: ReviewFile[]; baselineOid: string }>;
  readArtifactPreview(input: {
    taskId: string;
    documentPath: string;
  }): Promise<
    | { ok: true; preview: DocumentReviewSnapshot }
    | {
        ok: false;
        code: "not_available" | "invalid" | "unsafe" | "too_large";
        message: string;
      }
  >;
  searchFiles(input: {
    repositoryId: string;
    query: string;
    limit?: number;
    kind?: FileSearchKind;
  }): Promise<FileSearchResult[]>;
  pickRepository(): Promise<
    { canceled: true } | { canceled: false; repository: RepositoryInfo }
  >;
  pickAttachmentFiles(input: {
    chatId: string;
    repositoryId?: string;
  }): Promise<
    { canceled: true } | { canceled: false; files: ChatAttachment[] }
  >;
  savePastedAttachments(input: {
    chatId: string;
    files: PastedAttachmentInput[];
  }): Promise<{ files: ChatAttachment[] }>;
  openChatAttachment(input: {
    attachment: ChatAttachment;
    repositoryId?: string;
  }): Promise<{ ok: true } | { ok: false; message: string }>;
  getRepository(input: {
    repositoryId?: string;
    repositoryPath?: string;
  }): Promise<RepositoryInfo | null>;
  listRepositoryBranches(input: {
    repositoryId?: string;
    repositoryPath?: string;
  }): Promise<
    | { ok: true; current: string; branches: string[] }
    | { ok: false; message: string }
  >;
  checkoutRepositoryBranch(input: {
    repositoryId?: string;
    repositoryPath?: string;
    branch: string;
  }): Promise<
    { ok: true; repository: RepositoryInfo } | { ok: false; message: string }
  >;
  getBackendStatus(): Promise<BackendStatus>;
  /** Starts the local model stack now — the manual load behind the refresh control. */
  loadLocalModel(): Promise<{ status: BackendStatus }>;
  /** Stops the local model stack and gives its memory back. */
  unloadLocalModel(): Promise<{ status: BackendStatus }>;
  getStartupSettings(): Promise<DesktopStartupSettings>;
  getCapabilityProbes(input?: {
    force?: boolean;
  }): Promise<CapabilityProbeReport>;
  listRemoteConnections(): Promise<RemoteConnectionInfo[]>;
  saveRemoteConnection(input: RemoteConnectionDraft): Promise<RemoteConnectionInfo>;
  deleteRemoteConnection(input: { connectionId: string }): Promise<{ ok: true }>;
  checkRemoteConnection(input: { connectionId: string }): Promise<RemoteConnectionCheck>;
  installRemoteRunner(input: { connectionId: string }): Promise<RemoteConnectionCheck>;
  browseRemoteDirectory(input: { connectionId: string; path?: string }): Promise<RemoteDirectoryListing>;
  setRemoteDefaultDirectory(input: { connectionId: string; path: string }): Promise<RemoteConnectionInfo>;
  pickRemoteIdentityFile(): Promise<{ path: string }>;
  getHarnessProfile(): Promise<HarnessProfileId>;
  saveHarnessProfile(input: HarnessProfileId): Promise<{
    settings: HarnessProfileId;
    status: BackendStatus;
  }>;
  getContextLength(): Promise<number>;
  saveContextLength(input: number): Promise<{
    contextLength: number;
    status: BackendStatus;
  }>;
  /** Whether local models draft from their multi-token-prediction head. */
  getLocalMtp(): Promise<boolean>;
  saveLocalMtp(input: boolean): Promise<{ mtp: boolean; status: BackendStatus }>;
  getReasoningEffort(): Promise<ReasoningEffort>;
  saveReasoningEffort(input: ReasoningEffort): Promise<{
    reasoningEffort: ReasoningEffort;
    status: BackendStatus;
  }>;
  saveShowThinking(input: boolean): Promise<boolean>;
  saveSendOnEnter(input: boolean): Promise<boolean>;
  getLaunchAtLogin(): Promise<{ enabled: boolean; available: boolean }>;
  saveLaunchAtLogin(input: boolean): Promise<{ enabled: boolean; available: boolean }>;
  getModelEndpointSettings(input?: {
    mode?: ModelEndpointMode;
  }): Promise<PublicModelEndpointSettings>;
  getKeyBindings(): Promise<KeyBindingSettings>;
  saveKeyBindings(input: KeyBindingSettings): Promise<KeyBindingSettings>;
  getDictationSettings(): Promise<DictationSettings>;
  saveDictationSettings(input: DictationSettings): Promise<{ dictation: DictationSettings; status: BackendStatus }>;
  listLocalModels(input: { kind: LocalCatalogModelKind }): Promise<LocalCatalogModel[]>;
  downloadLocalModel(input: { id: string }): Promise<{ ok: true } | { ok: false; message: string }>;
  cancelLocalModelDownload(input: { id: string }): Promise<{ ok: true }>;
  /** Chooses which quantization a model downloads and runs at. */
  setLocalModelQuant(input: { id: string; quant: string }): Promise<{ ok: true } | { ok: false; message: string }>;
  /** Pins a Hugging Face repo (link or author/model) into the local collection. */
  addCustomLocalModel(input: { reference: string }): Promise<{ ok: true } | { ok: false; message: string }>;
  /** Forgets a custom model and deletes any of its downloaded files. */
  removeCustomLocalModel(input: { id: string }): Promise<{ ok: true } | { ok: false; message: string }>;
  openModelsFolder(): Promise<{ ok: true; directory: string } | { ok: false; message: string }>;
  listServerModels(): Promise<ServerModelInfo[]>;
  saveModelEndpointSettings(input: PublicModelEndpointSettings): Promise<{
    settings: PublicModelEndpointSettings;
    status: BackendStatus;
  }>;
  getCompanyConnectionStatus(): Promise<CompanyConnectionStatus>;
  enrollCompanyConnection(input: {
    baseUrl: string;
    enrollmentCode: string;
    deviceLabel?: string;
  }): Promise<{
    connection: CompanyConnectionStatus;
    settings: PublicModelEndpointSettings;
    status: BackendStatus;
  }>;
  connectCompanyConnection(): Promise<{
    connection: CompanyConnectionStatus;
    settings: PublicModelEndpointSettings;
    status: BackendStatus;
  }>;
  disconnectCompanySession(): Promise<{
    connection: CompanyConnectionStatus;
    settings: PublicModelEndpointSettings;
    status: BackendStatus;
  }>;
  disconnectCompanyConnection(): Promise<{
    connection: CompanyConnectionStatus;
    settings: PublicModelEndpointSettings;
    status: BackendStatus;
  }>;
  exportTelemetry(): Promise<
    { ok: true; path: string } | { ok: false; message: string }
  >;
  exportLocalDiagnostics(): Promise<
    { ok: true; path: string } | { ok: false; message: string }
  >;
  clearLocalDiagnostics(): Promise<LocalDiagnosticInfo>;
  recordProductEvent(input: {
    type: "review.opened" | "ide.selected";
    taskId?: string;
    repositoryId?: string;
    scope?: "task" | "worktree";
    target?: "task" | "project";
    ideId?: string;
    surface?: "composer" | "review";
  }): Promise<void>;
  listSkills(): Promise<{ skills: SkillInfo[]; directory: string }>;
  saveSkillSettings(input: Record<string, boolean>): Promise<{
    skills: SkillInfo[];
    directory: string;
  }>;
  openSkillsFolder(): Promise<
    { ok: true; directory: string } | { ok: false; message: string }
  >;
  openRunnerDiagnosticsFolder(): Promise<
    { ok: true; directory: string } | { ok: false; message: string }
  >;
  openSkillInEditor(input: {
    id: string;
  }): Promise<{ ok: true; path: string } | { ok: false; message: string }>;
  importSkill(input?: { sourcePath?: string }): Promise<
    | { ok: true; skill: SkillInfo; skills: SkillInfo[]; directory: string }
    | { ok: false; message: string }
  >;
  createSkill(input: { name: string }): Promise<
    | { ok: true; skill: SkillInfo; directory: string }
    | { ok: false; message: string }
  >;
  getSkillDocument(input: { id: string }): Promise<
    | { ok: true; skill: SkillDocument; directory: string }
    | { ok: false; message: string }
  >;
  saveSkillDocument(input: { id: string; content: string }): Promise<
    | {
        ok: true;
        skill: SkillDocument;
        skills: SkillInfo[];
        directory: string;
      }
    | { ok: false; message: string }
  >;
  resetSystemSkill(input: { id: string }): Promise<
    | {
        ok: true;
        skill: SkillDocument;
        skills: SkillInfo[];
        directory: string;
      }
    | { ok: false; message: string }
  >;
  setPermissionMode(mode: PermissionMode): Promise<PermissionMode>;
  setWebTools(enabled: boolean): Promise<boolean>;
  listAvailableIdes(): Promise<IdeInfo[]>;
  startTask(input: {
    repositoryId?: string;
    /** Runs on this saved remote host instead of on this computer. */
    remoteConnectionId?: string;
    /** Absolute folder on that host; its default folder when omitted. */
    remoteDirectory?: string;
    prompt: string;
    chatId?: string;
    attachedFiles?: ChatAttachment[];
    useWorktree?: boolean;
    worktreeTaskId?: string;
  }): Promise<TaskInfo>;
  steerTask(input: {
    taskId: string;
    prompt: string;
    attachedFiles?: ChatAttachment[];
  }): Promise<void>;
  queueFollowUpTask(input: {
    taskId: string;
    prompt: string;
    attachedFiles?: ChatAttachment[];
  }): Promise<{ actionId: string }>;
  dropQueuedTaskPrompt(input: { taskId: string; actionId: string }): Promise<void>;
  listQueuedTaskPrompts(input: { taskId: string }): Promise<Array<{
    actionId: string;
    prompt: string;
    attachedFiles: ChatAttachment[];
  }>>;
  approveWorktreeCreation(input: {
    taskId: string;
    approved: boolean;
  }): Promise<void>;
  respondToToolPermission(input: {
    taskId: string;
    id: string;
    decision: "allow" | "deny";
  }): Promise<void>;
  openRepositoryInIde(input: {
    repositoryId: string;
    ideId: string;
  }): Promise<{ ok: true } | { ok: false; message: string }>;
  openTaskInIde(input: {
    taskId: string;
    ideId: string;
    filePath?: string;
  }): Promise<{ ok: true } | { ok: false; message: string }>;
  /**
   * Puts one reviewed file back to how it was before the turn. There is no
   * whole-turn counterpart on purpose: undo is per file so that a stray click
   * can never take back more than the file being looked at.
   */
  revertReviewFile(input: { taskId: string; path: string }): Promise<TaskInfo | null>;
  keepWorktree(input: { taskId: string }): Promise<void>;
  cancelTask(input: { taskId: string }): Promise<void>;
  setResponseFeedback(input: {
    taskId: string;
    messageId: string;
    rating: ResponseRating | null;
    reason?: ResponseFeedbackReason;
    comment?: string;
  }): Promise<void>;
  setWindowChromeTheme(theme: "dark" | "light"): Promise<{ ok: true }>;
  /**
   * Opens a link from a chat reply in the user's browser. The URL comes from
   * model output, so the main process re-checks the scheme itself and answers
   * `{ ok: false }` for anything it will not open.
   */
  openExternal(input: { url: string }): Promise<{ ok: boolean }>;
  /**
   * Opens the dictation stream to Veil. The renderer holds the microphone and
   * this call holds the connection, so audio is captured in one place and
   * credentials stay in the other. Throws when the connected server does not
   * advertise `speech.transcribe`.
   */
  startDictation(input: { language?: string }): Promise<{ started: boolean }>;
  /** Takes microphone consent the way the platform takes it, before the renderer
   *  opens a device — so a refusal is explained where it can be fixed. */
  requestMicrophoneAccess(): Promise<{ granted: boolean }>;
  /** Sends one slice of 16 kHz mono 16-bit PCM to the open stream. */
  sendDictationAudio(input: { chunk: Uint8Array }): Promise<void>;
  /** Ends the recording and waits for the last transcript. */
  stopDictation(): Promise<{ stopping: boolean }>;
  /** Abandons the recording without waiting for a transcript. */
  cancelDictation(): Promise<void>;
  getAppUpdateStatus(): Promise<AppUpdateStatus>;
  /** Consults the feed now and answers once it has, before any download. */
  setAutomaticAppUpdates(input: { enabled: boolean }): Promise<AppUpdateStatus>;
  /** Quits into the downloaded release. Only meaningful in the `ready` state. */
  installAppUpdate(): Promise<void>;
  onBackendEvent(callback: (event: BackendUiEvent) => void): () => void;
  /** Every change to the update status, including download progress. */
  onAppUpdateStatus(callback: (status: AppUpdateStatus) => void): () => void;
  /**
   * Transcripts for the open dictation. Partials replace each other and a
   * terminal event ends the session.
   */
  onDictationEvent(callback: (event: DictationEvent) => void): () => void;
  /** Progress for the one model download that can be in flight at a time. */
  onModelDownloadEvent(callback: (event: ModelDownloadEvent) => void): () => void;
  /**
   * The first index build for a workspace. Separate from the backend event bus
   * because that bus is task-scoped and this happens on folder open, before any
   * task exists.
   */
  onWorkspaceIndex(callback: (event: WorkspaceIndexEvent) => void): () => void;
};
