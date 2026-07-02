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
  headers: Array<{ name: string; value: string }>;
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
type UmbraticRuntimeProfileId = "none" | "python" | "markdown" | "cmake" | "powershell" | "posix-shell" | "node";
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
    source: "server-default" | "stored" | "managed";
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
  telemetry: UmbraticTelemetryPolicyInfo;
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
  kind: "read" | "edit" | "bash";
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
  | {
      type: "command.finished";
      taskId: string;
      id: string;
      exitCode: number | null;
      status?: UmbraticToolResultStatus;
      errorCode?: UmbraticToolErrorCode;
      errorMessage?: string;
      durationMs?: number;
    }
  | { type: "permission.requested"; taskId: string; request: UmbraticPermissionRequest }
  | { type: "permission.resolved"; taskId: string; id: string; decision: "allow" | "deny" }
  | { type: "review.ready"; taskId: string; changedFiles: string[]; reviewFiles: UmbraticReviewFile[]; latestTest?: UmbraticTestResult }
  | { type: "approval.check"; taskId: string; name: string; status: "running" | "passed" | "failed"; detail?: string }
  | { type: "approval.completed"; taskId: string; target: string; patchHash: string }
  | { type: "merge.completed"; taskId: string; targetBranch: string; commit: string; patchHash: string }
  | { type: "response.feedback"; taskId: string; messageId: string; rating: "good" | "bad" }
  | { type: "skill.selected"; taskId: string; skillId: string; source: "system" | "local"; reason: "explicit_request" | "strong_match" | "metadata"; fullContent: boolean }
  | {
      type: "required_tool.failed";
      taskId: string;
      requirement: UmbraticRequiredToolContractRequirement;
      reason: UmbraticRequiredToolContractReason;
      requiredTools: UmbraticRunnerToolId[];
      attemptedTools?: UmbraticRunnerToolId[];
      attempt?: number;
      detail?: string;
    }
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
      createChat(input?: { id?: string; title?: string; repositoryName?: string; repositoryPath?: string; worktreeTaskId?: string; persist?: boolean }): Promise<UmbraticChatRecord>;
      updateChatDraft(input: { chatId: string; draftPrompt: string; attachedFiles: UmbraticChatAttachment[] }): Promise<UmbraticChatRecord>;
      updateChatProject(input: { chatId: string; repositoryName: string; repositoryPath: string }): Promise<UmbraticChatRecord>;
      deleteChat(input: { chatId: string }): Promise<{ ok: true }>;
      deleteProjectChats(input: { repositoryPath: string }): Promise<{ ok: true; deletedChatIds: string[] }>;
      deleteProject(input: { repositoryPath: string }): Promise<{ ok: true; deletedChatIds: string[] }>;
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
      getCapabilityProbes(input?: { force?: boolean }): Promise<UmbraticCapabilityProbeReport>;
      getHarnessProfile(): Promise<UmbraticHarnessProfileId>;
      saveHarnessProfile(input: UmbraticHarnessProfileId): Promise<{
        settings: UmbraticHarnessProfileId;
        status: UmbraticBackendStatus;
      }>;
      getModelEndpointSettings(): Promise<UmbraticModelEndpointSettings>;
      saveModelEndpointSettings(input: UmbraticModelEndpointSettings): Promise<{
        settings: UmbraticModelEndpointSettings;
        status: UmbraticBackendStatus;
      }>;
      exportTelemetry(): Promise<{ ok: true; path: string } | { ok: false; message: string }>;
      listSkills(): Promise<{
        skills: UmbraticSkillInfo[];
        directory: string;
      }>;
      saveSkillSettings(input: Record<string, boolean>): Promise<{
        skills: UmbraticSkillInfo[];
        directory: string;
      }>;
      openSkillsFolder(): Promise<{ ok: true; directory: string } | { ok: false; message: string }>;
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
      setResponseFeedback(input: { taskId: string; messageId: string; rating: "good" | "bad" }): Promise<void>;
      setWindowChromeTheme(theme: "dark" | "light"): Promise<{ ok: true }>;
      onBackendEvent(callback: (event: unknown) => void): () => void;
    };
    umbratic?: Window["umbratic"];
  }
}

export {};
