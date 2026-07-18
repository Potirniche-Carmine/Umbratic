/// <reference types="vite/client" />

type UmbraticPermissionMode = "normal" | "bypass";
type UmbraticReasoningMode = "fast" | "reasoning";
type UmbraticServiceStatus = "ready" | "degraded" | "unavailable";
type UmbraticCapabilityProbeStatus = "available" | "missing" | "error" | "unknown";
type UmbraticCapabilityProbeCategory = "required" | "recommended" | "optional-engineering" | "optional-artifacts";
type UmbraticCapabilityProbeImportance = "required" | "recommended" | "optional";
type UmbraticCapabilityProbeResult = {
  id: string;
  label: string;
  category: UmbraticCapabilityProbeCategory;
  importance: UmbraticCapabilityProbeImportance;
  status: UmbraticCapabilityProbeStatus;
  version?: string;
  executablePath?: string;
  detectedCommand?: string;
  purpose: string;
  installHint: string;
  workflows: string[];
  checkedAt: string;
  message?: string;
};
type UmbraticCapabilityProbeReport = {
  checkedAt: string;
  probes: UmbraticCapabilityProbeResult[];
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
type UmbraticWorkspaceKind = "git" | "folder";
type UmbraticWorkspaceMode = "local" | "worktree";
type UmbraticRunnerToolId = "read" | "write" | "edit" | "search" | "command";
type UmbraticRequiredToolContractRequirement = "file_change";
type UmbraticRequiredToolContractReason =
  | "file_tools_disabled"
  | "missing_tool_call"
  | "agent_reported_blocker"
  | "attempted_tool_failed"
  | "no_review_changes";
type UmbraticHarnessProfileId = "marketing" | "sales" | "engineering";
type UmbraticLocalProviderId = "company-endpoint";
type UmbraticModelEndpointMode = "local" | "server";
type UmbraticModelEndpointSoftware = "ollama" | "vllm";
type UmbraticModelEndpointSettings = {
  mode: UmbraticModelEndpointMode;
  software: UmbraticModelEndpointSoftware;
  baseUrl: string;
  modelId: string;
  secret: string;
  secretConfigured: boolean;
  headers: Array<{ name: string; value: string; valueConfigured: boolean }>;
};
type UmbraticCommandClass =
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
type UmbraticToolResultStatus = "success" | "permission_denied" | "policy_blocked" | "validation_error" | "runtime_error" | "timeout";
type UmbraticToolErrorCode =
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
  endpointConfig: {
    source: "local-default" | "server-default" | "stored" | "managed";
    endpointEditingAllowed: boolean;
  };
  privacy: {
    share: "disabled";
    enabledProviders: UmbraticLocalProviderId[];
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
  runnerDiagnosticsDirectory: string;
  localLogs: { bytes: number; entries: number };
  telemetry: UmbraticTelemetryPolicyInfo;
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
  capabilities: UmbraticCapabilityProbeReport;
};

type UmbraticTelemetryPolicyInfo = {
  mode: "developer_toggle" | "managed_required" | "managed_disabled";
  localEnabled: boolean;
  syncEnabled: boolean;
  retentionDays: number;
  exportFormat: "redacted-json";
  storage: "company-managed-telemetry" | "task-event-snapshots";
};

type UmbraticLocalModelInfo = {
  providerId: UmbraticLocalProviderId;
  providerName: string;
  modelId: string;
  displayName: string;
  baseUrl: string;
  contextLength?: number;
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
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "binary";
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string;
  diff: string;
  contentHash: string;
  hunks: Array<{
    id: string;
    header: string;
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: Array<{ origin: "context" | "addition" | "deletion"; content: string; oldLine: number | null; newLine: number | null }>;
  }>;
  tooLarge?: boolean;
};

type UmbraticChatAttachment = {
  path: string;
  name: string;
  source?: "workspace" | "chat";
  storedPath?: string;
  originalPath?: string;
  previewDataUrl?: string;
  contextTokens?: number;
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
  kind: "read" | "edit" | "bash";
  summary: string;
  command: string;
  commandClass?: UmbraticCommandClass;
  cwd: string;
};

type UmbraticBackendUiEvent = import("../shared/backendEvents").BackendUiEventV1;

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
  worktreeRootTaskId?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeBaseCommit?: string;
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
  worktreeRootTaskId?: string;
  repositoryId: string;
  prompt: string;
  workspaceKind: UmbraticWorkspaceKind;
  workspaceMode: UmbraticWorkspaceMode;
  state: "awaiting_worktree_approval" | "running" | "completed" | "review_ready" | "approving" | "approved" | "merged" | "rejected" | "failed";
  originalBranch: string;
  baseCommit: string;
  agentBranch: string;
  worktreePath: string;
  permissionMode: UmbraticPermissionMode;
  reasoningMode?: UmbraticReasoningMode;
  runnerName?: string;
  runnerVersion?: string;
  policyVersion?: string;
  createdAt: string;
  changedFiles: string[];
  reviewFiles: UmbraticReviewFile[];
  events: UmbraticBackendUiEvent[];
  latestTest?: UmbraticTestResult;
  reviewPatchHash?: string;
  reviewScope?: "task" | "worktree";
  reviewBaselineLabel?: string;
  reviewBaselineOid?: string;
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

type UmbraticSkillChecksumStatus = "known_good" | "modified" | "untracked";
type UmbraticSkillInfo = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  source?: "system" | "local";
  readOnly?: boolean;
  checksum?: string;
  checksumStatus?: UmbraticSkillChecksumStatus;
  modified?: boolean;
  provenance?: "bundled" | "created" | "imported";
};
type UmbraticSkillDocument = UmbraticSkillInfo & {
  path: string;
  content: string;
};

declare global {
  interface Window {
    umbratic?: {
      listProjects(): Promise<UmbraticRepositoryInfo[]>;
      listChats(): Promise<UmbraticChatRecord[]>;
      createChat(input?: { id?: string; title?: string; repositoryName?: string; repositoryPath?: string; worktreeTaskId?: string }): Promise<UmbraticChatRecord>;
      updateChatDraft(input: { chatId: string; draftPrompt: string; attachedFiles: UmbraticChatAttachment[] }): Promise<UmbraticChatRecord>;
      updateChatProject(input: { chatId: string; repositoryName: string; repositoryPath: string }): Promise<UmbraticChatRecord>;
      deleteChat(input: { chatId: string }): Promise<{ ok: true }>;
      deleteProjectChats(input: { repositoryPath: string }): Promise<{ ok: true; deletedChatIds: string[] }>;
      deleteProject(input: { repositoryPath: string }): Promise<{ ok: true; deletedChatIds: string[] }>;
      getNotes(): Promise<UmbraticUserNotes>;
      updateNotes(input: { content: string }): Promise<UmbraticUserNotes>;
      getTask(input: { taskId: string }): Promise<UmbraticTaskInfo | null>;
      refreshTaskReview(input: { taskId: string; scope?: "task" | "worktree"; repositoryPath?: string }): Promise<UmbraticTaskInfo | null>;
      refreshWorkspaceReview(input: { repositoryPath: string }): Promise<{ reviewFiles: UmbraticReviewFile[]; baselineOid: string }>;
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
      getCapabilityProbes(input?: { force?: boolean }): Promise<UmbraticCapabilityProbeReport>;
      getHarnessProfile(): Promise<UmbraticHarnessProfileId>;
      saveHarnessProfile(input: UmbraticHarnessProfileId): Promise<{
        settings: UmbraticHarnessProfileId;
        status: UmbraticBackendStatus;
      }>;
      getContextLength(): Promise<number>;
      saveContextLength(input: number): Promise<{
        contextLength: number;
        status: UmbraticBackendStatus;
      }>;
      getModelEndpointSettings(): Promise<UmbraticModelEndpointSettings>;
      saveModelEndpointSettings(input: UmbraticModelEndpointSettings): Promise<{
        settings: UmbraticModelEndpointSettings;
        status: UmbraticBackendStatus;
      }>;
      exportTelemetry(): Promise<{ ok: true; path: string } | { ok: false; message: string }>;
      exportLocalDiagnostics(): Promise<{ ok: true; path: string } | { ok: false; message: string }>;
      clearLocalDiagnostics(): Promise<{ bytes: number; entries: number }>;
      recordProductEvent(input: {
        type: "review.opened" | "ide.selected";
        taskId?: string;
        repositoryId?: string;
        scope?: "task" | "worktree";
        target?: "task" | "project";
        ideId?: string;
        surface?: "composer" | "review";
      }): Promise<void>;
      listSkills(): Promise<{
        skills: UmbraticSkillInfo[];
        directory: string;
      }>;
      saveSkillSettings(input: Record<string, boolean>): Promise<{
        skills: UmbraticSkillInfo[];
        directory: string;
      }>;
      openSkillsFolder(): Promise<{ ok: true; directory: string } | { ok: false; message: string }>;
      openRunnerDiagnosticsFolder(): Promise<{ ok: true; directory: string } | { ok: false; message: string }>;
      openSkillInEditor(input: { id: string }): Promise<{ ok: true; path: string } | { ok: false; message: string }>;
      importSkill(input?: { sourcePath?: string }): Promise<
        | {
            ok: true;
            skill: UmbraticSkillInfo;
            skills: UmbraticSkillInfo[];
            directory: string;
          }
        | { ok: false; message: string }
      >;
      createSkill(input: { name: string }): Promise<
        | {
            ok: true;
            skill: UmbraticSkillInfo;
            directory: string;
          }
        | { ok: false; message: string }
      >;
      getSkillDocument(input: { id: string }): Promise<
        | {
            ok: true;
            skill: UmbraticSkillDocument;
            directory: string;
          }
        | { ok: false; message: string }
      >;
      saveSkillDocument(input: { id: string; content: string }): Promise<
        | {
            ok: true;
            skill: UmbraticSkillDocument;
            skills: UmbraticSkillInfo[];
            directory: string;
          }
        | { ok: false; message: string }
      >;
      resetSystemSkill(input: { id: string }): Promise<
        | {
            ok: true;
            skill: UmbraticSkillDocument;
            skills: UmbraticSkillInfo[];
            directory: string;
          }
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
        worktreeTaskId?: string;
      }): Promise<UmbraticTaskInfo>;
      approveWorktreeCreation(input: { taskId: string; approved: boolean }): Promise<void>;
      respondToToolPermission(input: UmbraticPermissionDecision): Promise<void>;
      openRepositoryInIde(input: { repositoryId?: string; repositoryPath?: string; ideId: string }): Promise<UmbraticIdeOpenResult>;
      openTaskInIde(input: { taskId: string; ideId: string; filePath?: string }): Promise<UmbraticIdeOpenResult>;
      approveTaskMerge(input: { taskId: string }): Promise<UmbraticApproveResult>;
      rejectTask(input: { taskId: string; cleanup: boolean }): Promise<void>;
      keepWorktree(input: { taskId: string }): Promise<void>;
      cancelTask(input: { taskId: string }): Promise<void>;
      setResponseFeedback(input: { taskId: string; messageId: string; rating: "good" | "bad"; comment?: string }): Promise<void>;
      setWindowChromeTheme(theme: "dark" | "light"): Promise<{ ok: true }>;
      onBackendEvent(callback: (event: UmbraticBackendUiEvent) => void): () => void;
    };
    umbratic?: Window["umbratic"];
  }
}

export {};
