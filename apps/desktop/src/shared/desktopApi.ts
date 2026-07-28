import type { BackendUiEventInput, BackendUiEventV1 } from "./backendEvents";
import type { DocumentReviewSnapshot } from "./documentReview";
import type { ReviewFile } from "./reviewDiff";

export type ServiceStatus = "ready" | "degraded" | "unavailable";
export type PermissionMode = "normal" | "auto_safe";
export type ReasoningMode = "fast" | "reasoning";
export type WorkspaceKind = "git" | "folder";
export type WorkspaceMode = "local" | "worktree";
export type HarnessProfileId = "marketing" | "sales" | "engineering";
export type LocalProviderId = "company-endpoint";
export type ModelEndpointMode = "local" | "server";
export type ModelEndpointSoftware = "ollama" | "vllm";

export type PublicModelEndpointSettings = {
  mode: ModelEndpointMode;
  software: ModelEndpointSoftware;
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

export type DesktopStartupSettings = {
  permissionMode: PermissionMode;
  modelEndpoint: PublicModelEndpointSettings;
  harnessProfile: HarnessProfileId;
  contextLength: number;
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
};

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
  source?: "workspace" | "chat";
  storedPath?: string;
  originalPath?: string;
  previewDataUrl?: string;
  contextTokens?: number;
};

export type PastedAttachmentInput = {
  name?: string;
  mimeType?: string;
  dataUrl: string;
};

export type FileSearchResult = ChatAttachment & {
  match: "path" | "content";
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

export type BackendUiEvent = BackendUiEventInput;

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
  reviewScope?: "task" | "worktree";
  reviewBaselineLabel?: string;
  reviewBaselineOid?: string;
  patchHash?: string;
  error?: string;
};

export type ContextMessageV1 = {
  role: "user" | "assistant" | "tool";
  content: unknown;
  tool_call_id?: string;
  tool_calls?: unknown[];
};

export type ContextStateV1 = {
  version: 1;
  sourceTaskId: string;
  updatedAt: string;
  summary?: string;
  tail: ContextMessageV1[];
  sourceDigest: string;
  usage: {
    estimatedPromptTokens: number;
    observedPromptTokens?: number;
    compactionCount: number;
  };
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
  contextState?: ContextStateV1;
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
  source?: "system" | "local";
  readOnly?: boolean;
  checksum?: string;
  checksumStatus?: "known_good" | "modified" | "untracked";
  modified?: boolean;
  provenance?: "bundled" | "created" | "imported";
};

export type SkillDocument = SkillInfo & {
  path: string;
  content: string;
};

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
  readDocumentReview(input: {
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
  getStartupSettings(): Promise<DesktopStartupSettings>;
  getCapabilityProbes(input?: {
    force?: boolean;
  }): Promise<CapabilityProbeReport>;
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
  getModelEndpointSettings(): Promise<PublicModelEndpointSettings>;
  saveModelEndpointSettings(input: PublicModelEndpointSettings): Promise<{
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
  listAvailableIdes(): Promise<IdeInfo[]>;
  startTask(input: {
    repositoryId?: string;
    prompt: string;
    chatId?: string;
    attachedFiles?: ChatAttachment[];
    reasoningMode?: ReasoningMode;
    useWorktree?: boolean;
    worktreeTaskId?: string;
  }): Promise<TaskInfo>;
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
  approveTaskMerge(input: { taskId: string }): Promise<
    | {
        ok: true;
        targetBranch: string;
        commit: string;
        patchHash: string;
        metadataPath: string;
      }
    | { ok: false; message: string }
  >;
  rejectTask(input: { taskId: string; cleanup: boolean }): Promise<void>;
  keepWorktree(input: { taskId: string }): Promise<void>;
  cancelTask(input: { taskId: string }): Promise<void>;
  setResponseFeedback(input: {
    taskId: string;
    messageId: string;
    rating: "good" | "bad";
    comment?: string;
  }): Promise<void>;
  setWindowChromeTheme(theme: "dark" | "light"): Promise<{ ok: true }>;
  onBackendEvent(callback: (event: BackendUiEventV1) => void): () => void;
};

export const desktopIpcChannels = {
  listProjects: "umbratic:list-projects",
  listChats: "umbratic:list-chats",
  createChat: "umbratic:create-chat",
  updateChatDraft: "umbratic:update-chat-draft",
  updateChatProject: "umbratic:update-chat-project",
  deleteChat: "umbratic:delete-chat",
  deleteProjectChats: "umbratic:delete-project-chats",
  deleteProject: "umbratic:delete-project",
  getNotes: "umbratic:get-notes",
  updateNotes: "umbratic:update-notes",
  getTask: "umbratic:get-task",
  listTaskCheckpoints: "umbratic:list-task-checkpoints",
  createTaskCheckpoint: "umbratic:create-task-checkpoint",
  setTaskCheckpointPinned: "umbratic:set-task-checkpoint-pinned",
  deleteTaskCheckpoint: "umbratic:delete-task-checkpoint",
  forkTaskCheckpoint: "umbratic:fork-task-checkpoint",
  restoreTaskCheckpoint: "umbratic:restore-task-checkpoint",
  refreshTaskReview: "umbratic:refresh-task-review",
  refreshWorkspaceReview: "umbratic:refresh-workspace-review",
  readDocumentReview: "umbratic:read-document-review",
  searchFiles: "umbratic:search-files",
  pickRepository: "umbratic:pick-repository",
  pickAttachmentFiles: "umbratic:pick-attachment-files",
  savePastedAttachments: "umbratic:save-pasted-attachments",
  openChatAttachment: "umbratic:open-chat-attachment",
  getRepository: "umbratic:get-repository",
  listRepositoryBranches: "umbratic:list-repository-branches",
  checkoutRepositoryBranch: "umbratic:checkout-repository-branch",
  getBackendStatus: "umbratic:get-backend-status",
  getStartupSettings: "umbratic:get-startup-settings",
  getCapabilityProbes: "umbratic:get-capability-probes",
  getHarnessProfile: "umbratic:get-harness-profile",
  saveHarnessProfile: "umbratic:save-harness-profile",
  getContextLength: "umbratic:get-context-length",
  saveContextLength: "umbratic:save-context-length",
  getModelEndpointSettings: "umbratic:get-model-endpoint-settings",
  saveModelEndpointSettings: "umbratic:save-model-endpoint-settings",
  exportTelemetry: "umbratic:export-telemetry",
  exportLocalDiagnostics: "umbratic:export-local-diagnostics",
  clearLocalDiagnostics: "umbratic:clear-local-diagnostics",
  recordProductEvent: "umbratic:record-product-event",
  listSkills: "umbratic:list-skills",
  saveSkillSettings: "umbratic:save-skill-settings",
  openSkillsFolder: "umbratic:open-skills-folder",
  openRunnerDiagnosticsFolder: "umbratic:open-runner-diagnostics-folder",
  openSkillInEditor: "umbratic:open-skill-in-editor",
  importSkill: "umbratic:import-skill",
  createSkill: "umbratic:create-skill",
  getSkillDocument: "umbratic:get-skill-document",
  saveSkillDocument: "umbratic:save-skill-document",
  resetSystemSkill: "umbratic:reset-system-skill",
  setPermissionMode: "umbratic:set-permission-mode",
  listAvailableIdes: "umbratic:list-available-ides",
  startTask: "umbratic:start-task",
  approveWorktreeCreation: "umbratic:approve-worktree-creation",
  respondToToolPermission: "umbratic:respond-tool-permission",
  openRepositoryInIde: "umbratic:open-repository-in-ide",
  openTaskInIde: "umbratic:open-task-in-ide",
  approveTaskMerge: "umbratic:approve-task-merge",
  rejectTask: "umbratic:reject-task",
  keepWorktree: "umbratic:keep-worktree",
  cancelTask: "umbratic:cancel-task",
  setResponseFeedback: "umbratic:set-response-feedback",
  setWindowChromeTheme: "umbratic:set-window-chrome-theme",
} as const satisfies Record<Exclude<keyof DesktopApi, "onBackendEvent">, string>;

type DesktopIpcMethod = keyof typeof desktopIpcChannels;

export type DesktopIpcChannel =
  (typeof desktopIpcChannels)[DesktopIpcMethod];

export type DesktopIpcMethodForChannel<Channel extends DesktopIpcChannel> = {
  [Method in DesktopIpcMethod]: (typeof desktopIpcChannels)[Method] extends Channel
    ? Method
    : never;
}[DesktopIpcMethod];

export type DesktopIpcInput<Channel extends DesktopIpcChannel> =
  Parameters<DesktopApi[DesktopIpcMethodForChannel<Channel>]> extends []
    ? undefined
    : Parameters<DesktopApi[DesktopIpcMethodForChannel<Channel>]>[0];

export type DesktopIpcResult<Channel extends DesktopIpcChannel> = Awaited<
  ReturnType<DesktopApi[DesktopIpcMethodForChannel<Channel>]>
>;
