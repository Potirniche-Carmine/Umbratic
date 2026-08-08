import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";
import type { BackendUiEvent } from "../shared/backendEvents";
import type {
  ChatAttachment,
  DesktopApi,
  HarnessProfileId,
  PastedAttachmentInput,
  PermissionMode,
  ReasoningMode,
} from "../shared/desktopApi";
import type { ResponseFeedbackReason, ResponseRating } from "../shared/responseFeedback";

type ChatInput = { id?: string; title?: string; repositoryName?: string; repositoryPath?: string; worktreeTaskId?: string };
const umbraticApi = {
  listProjects: () => ipcRenderer.invoke("umbratic:list-projects"),
  listChats: () => ipcRenderer.invoke("umbratic:list-chats"),
  createChat: (input?: ChatInput) => ipcRenderer.invoke("umbratic:create-chat", input ?? {}),
  updateChatDraft: (input: { chatId: string; draftPrompt: string; attachedFiles: ChatAttachment[] }) =>
    ipcRenderer.invoke("umbratic:update-chat-draft", input),
  updateChatProject: (input: { chatId: string; repositoryName: string; repositoryPath: string }) =>
    ipcRenderer.invoke("umbratic:update-chat-project", input),
  getUnsavedDraft: (input: { scope: string }) => ipcRenderer.invoke("umbratic:get-unsaved-draft", input),
  setUnsavedDraft: (input: { scope: string; draftPrompt: string; attachedFiles: ChatAttachment[] }) =>
    ipcRenderer.invoke("umbratic:set-unsaved-draft", input),
  clearUnsavedDraft: (input: { scope: string }) => ipcRenderer.invoke("umbratic:clear-unsaved-draft", input),
  deleteChat: (input: { chatId: string }) => ipcRenderer.invoke("umbratic:delete-chat", input),
  deleteProjectChats: (input: { projectId: string }) => ipcRenderer.invoke("umbratic:delete-project-chats", input),
  deleteProject: (input: { projectId: string }) => ipcRenderer.invoke("umbratic:delete-project", input),
  getNotes: () => ipcRenderer.invoke("umbratic:get-notes"),
  updateNotes: (input: { content: string }) => ipcRenderer.invoke("umbratic:update-notes", input),
  getTask: (input: { taskId: string }) => ipcRenderer.invoke("umbratic:get-task", input),
  listTaskCheckpoints: (input: { taskId: string }) => ipcRenderer.invoke("umbratic:list-task-checkpoints", input),
  createTaskCheckpoint: (input: { taskId: string; label?: string }) => ipcRenderer.invoke("umbratic:create-task-checkpoint", input),
  setTaskCheckpointPinned: (input: { taskId: string; checkpointId: string; pinned: boolean }) =>
    ipcRenderer.invoke("umbratic:set-task-checkpoint-pinned", input),
  deleteTaskCheckpoint: (input: { taskId: string; checkpointId: string }) =>
    ipcRenderer.invoke("umbratic:delete-task-checkpoint", input),
  forkTaskCheckpoint: (input: { taskId: string; checkpointId: string }) =>
    ipcRenderer.invoke("umbratic:fork-task-checkpoint", input),
  restoreTaskCheckpoint: (input: { taskId: string; checkpointId: string; confirmed: boolean }) =>
    ipcRenderer.invoke("umbratic:restore-task-checkpoint", input),
  refreshTaskReview: (input: { taskId: string; scope?: "task" | "worktree"; repositoryPath?: string }) => ipcRenderer.invoke("umbratic:refresh-task-review", input),
  refreshWorkspaceReview: (input: { repositoryPath: string }) => ipcRenderer.invoke("umbratic:refresh-workspace-review", input),
  readDocumentReview: (input: { taskId: string; documentPath: string }) => ipcRenderer.invoke("umbratic:read-document-review", input),
  searchFiles: (input: { repositoryId: string; query: string; limit?: number; kind?: "file" | "folder" | "all" }) =>
    ipcRenderer.invoke("umbratic:search-files", input),
  pickRepository: () => ipcRenderer.invoke("umbratic:pick-repository"),
  pickAttachmentFiles: (input: { chatId: string; repositoryId?: string }) => ipcRenderer.invoke("umbratic:pick-attachment-files", input),
  savePastedAttachments: (input: { chatId: string; files: PastedAttachmentInput[] }) =>
    ipcRenderer.invoke("umbratic:save-pasted-attachments", input),
  openChatAttachment: (input: { attachment: ChatAttachment; repositoryId?: string }) =>
    ipcRenderer.invoke("umbratic:open-chat-attachment", input),
  getRepository: (input: { repositoryId?: string; repositoryPath?: string }) => ipcRenderer.invoke("umbratic:get-repository", input),
  listRepositoryBranches: (input: { repositoryId?: string; repositoryPath?: string }) =>
    ipcRenderer.invoke("umbratic:list-repository-branches", input),
  checkoutRepositoryBranch: (input: { repositoryId?: string; repositoryPath?: string; branch: string }) =>
    ipcRenderer.invoke("umbratic:checkout-repository-branch", input),
  getBackendStatus: () => ipcRenderer.invoke("umbratic:get-backend-status"),
  getStartupSettings: () => ipcRenderer.invoke("umbratic:get-startup-settings"),
  getCapabilityProbes: (input?: { force?: boolean }) => ipcRenderer.invoke("umbratic:get-capability-probes", input ?? {}),
  getHarnessProfile: () => ipcRenderer.invoke("umbratic:get-harness-profile"),
  saveHarnessProfile: (input: HarnessProfileId) => ipcRenderer.invoke("umbratic:save-harness-profile", input),
  getContextLength: () => ipcRenderer.invoke("umbratic:get-context-length"),
  saveContextLength: (input: number) => ipcRenderer.invoke("umbratic:save-context-length", input),
  getModelEndpointSettings: (input?: { mode?: "local" | "server" }) =>
    ipcRenderer.invoke("umbratic:get-model-endpoint-settings", input),
  getCachedLocalModels: (input: { baseUrl: string }) =>
    ipcRenderer.invoke("umbratic:get-cached-local-models", input),
  probeLocalModels: (input: { baseUrl: string }) =>
    ipcRenderer.invoke("umbratic:probe-local-models", input),
  saveModelEndpointSettings: (input: {
    mode: "local" | "server";
    baseUrl: string;
    modelId: string;
    secret: string;
    secretConfigured: boolean;
    headers: Array<{ name: string; value: string; valueConfigured: boolean }>;
  }) =>
    ipcRenderer.invoke("umbratic:save-model-endpoint-settings", input),
  getCompanyConnectionStatus: () => ipcRenderer.invoke("umbratic:get-company-connection-status"),
  enrollCompanyConnection: (input: { baseUrl: string; enrollmentCode: string; deviceLabel?: string }) =>
    ipcRenderer.invoke("umbratic:enroll-company-connection", input),
  connectCompanyConnection: () => ipcRenderer.invoke("umbratic:connect-company-connection"),
  disconnectCompanySession: () => ipcRenderer.invoke("umbratic:disconnect-company-session"),
  disconnectCompanyConnection: () => ipcRenderer.invoke("umbratic:disconnect-company-connection"),
  exportTelemetry: () => ipcRenderer.invoke("umbratic:export-telemetry"),
  exportLocalDiagnostics: () => ipcRenderer.invoke("umbratic:export-local-diagnostics"),
  clearLocalDiagnostics: () => ipcRenderer.invoke("umbratic:clear-local-diagnostics"),
  recordProductEvent: (input: {
    type: "review.opened" | "ide.selected";
    taskId?: string;
    repositoryId?: string;
    scope?: "task" | "worktree";
    target?: "task" | "project";
    ideId?: string;
    surface?: "composer" | "review";
  }) => ipcRenderer.invoke("umbratic:record-product-event", input),
  listSkills: () => ipcRenderer.invoke("umbratic:list-skills"),
  saveSkillSettings: (input: Record<string, boolean>) => ipcRenderer.invoke("umbratic:save-skill-settings", input),
  openSkillsFolder: () => ipcRenderer.invoke("umbratic:open-skills-folder"),
  openRunnerDiagnosticsFolder: () => ipcRenderer.invoke("umbratic:open-runner-diagnostics-folder"),
  openSkillInEditor: (input: { id: string }) => ipcRenderer.invoke("umbratic:open-skill-in-editor", input),
  importSkill: (input?: { sourcePath?: string }) => ipcRenderer.invoke("umbratic:import-skill", input ?? {}),
  createSkill: (input: { name: string }) => ipcRenderer.invoke("umbratic:create-skill", input),
  getSkillDocument: (input: { id: string }) => ipcRenderer.invoke("umbratic:get-skill-document", input),
  saveSkillDocument: (input: { id: string; content: string }) => ipcRenderer.invoke("umbratic:save-skill-document", input),
  resetSystemSkill: (input: { id: string }) => ipcRenderer.invoke("umbratic:reset-system-skill", input),
  setPermissionMode: (mode: PermissionMode) => ipcRenderer.invoke("umbratic:set-permission-mode", mode),
  listAvailableIdes: () => ipcRenderer.invoke("umbratic:list-available-ides"),
  startTask: (input: {
    repositoryId?: string;
    prompt: string;
    chatId?: string;
    attachedFiles?: ChatAttachment[];
    reasoningMode?: ReasoningMode;
    useWorktree?: boolean;
    worktreeTaskId?: string;
  }) =>
    ipcRenderer.invoke("umbratic:start-task", input),
  steerTask: (input: { taskId: string; prompt: string; attachedFiles?: ChatAttachment[] }) =>
    ipcRenderer.invoke("umbratic:steer-task", input),
  queueFollowUpTask: (input: { taskId: string; prompt: string; attachedFiles?: ChatAttachment[] }) =>
    ipcRenderer.invoke("umbratic:queue-follow-up-task", input),
  dropQueuedTaskPrompt: (input: { taskId: string; actionId: string }) =>
    ipcRenderer.invoke("umbratic:drop-queued-task-prompt", input),
  listQueuedTaskPrompts: (input: { taskId: string }) =>
    ipcRenderer.invoke("umbratic:list-queued-task-prompts", input),
  approveWorktreeCreation: (input: { taskId: string; approved: boolean }) =>
    ipcRenderer.invoke("umbratic:approve-worktree-creation", input),
  respondToToolPermission: (input: { taskId: string; id: string; decision: "allow" | "deny" }) =>
    ipcRenderer.invoke("umbratic:respond-tool-permission", input),
  openRepositoryInIde: (input: { repositoryId: string; ideId: string }) =>
    ipcRenderer.invoke("umbratic:open-repository-in-ide", input),
  openTaskInIde: (input: { taskId: string; ideId: string; filePath?: string }) =>
    ipcRenderer.invoke("umbratic:open-task-in-ide", input),
  approveTaskMerge: (input: { taskId: string }) => ipcRenderer.invoke("umbratic:approve-task-merge", input),
  rejectTask: (input: { taskId: string; cleanup: boolean }) => ipcRenderer.invoke("umbratic:reject-task", input),
  keepWorktree: (input: { taskId: string }) => ipcRenderer.invoke("umbratic:keep-worktree", input),
  cancelTask: (input: { taskId: string }) => ipcRenderer.invoke("umbratic:cancel-task", input),
  setResponseFeedback: (input: { taskId: string; messageId: string; rating: ResponseRating | null; reason?: ResponseFeedbackReason; comment?: string }) =>
    ipcRenderer.invoke("umbratic:set-response-feedback", input),
  setWindowChromeTheme: (theme: "dark" | "light") => ipcRenderer.invoke("umbratic:set-window-chrome-theme", theme),
  openExternal: (input: { url: string }) => ipcRenderer.invoke("umbratic:open-external", input),
  onBackendEvent: (callback: (event: BackendUiEvent) => void) => {
    // The main process validates at the runner boundary and constructs the rest
    // itself, so by the time an event reaches this channel its shape is settled.
    const listener = (_event: IpcRendererEvent, value: BackendUiEvent) => callback(value);
    ipcRenderer.on("umbratic:backend-event", listener);
    return () => ipcRenderer.removeListener("umbratic:backend-event", listener);
  },
} satisfies DesktopApi;

contextBridge.exposeInMainWorld("umbratic", umbraticApi);
