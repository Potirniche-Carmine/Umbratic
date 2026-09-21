import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";
import type { BackendUiEvent } from "../shared/backendEvents";
import type {
  AppUpdateStatus,
  ChatAttachment,
  DesktopApi,
  DictationEvent,
  DictationSettings,
  HarnessProfileId,
  KeyBindingSettings,
  ModelDownloadEvent,
  PastedAttachmentInput,
  PermissionMode,
  ReasoningEffort,
  RemoteConnectionDraft,
  WorkspaceIndexEvent,
} from "../shared/desktopApi";
import type { ResponseFeedbackReason, ResponseRating } from "../shared/responseFeedback";

type ChatInput = { id?: string; title?: string; repositoryName?: string; repositoryPath?: string; worktreeTaskId?: string };

/**
 * Electron rejects a failed handler with the whole of
 * `Error invoking remote method '<channel>': Error: <message>`, and the app
 * shows what it is given. Only the last part of that was written for a person
 * to read — the rest names an internal channel and the class the main process
 * happened to throw. Both are stripped here, at the boundary that adds them, so
 * every caller reports the sentence the main process actually wrote.
 */
function readableFailure(cause: unknown): Error {
  // Read `message` by shape rather than by `instanceof Error`: an error crossing
  // a context boundary is not an instance of *this* context's Error, and
  // `String()` on it would fold the class name back into the text this is here
  // to remove.
  const message = (typeof (cause as { message?: unknown })?.message === "string"
    ? (cause as { message: string }).message
    : String(cause))
    .replace(/^Error invoking remote method\s+'[^']*':\s*/, "")
    // Bare `Error:` as well as `TypeError:` / `SshError:` — the class name is
    // never part of what the message meant to say.
    .replace(/^\w*Error:\s*/, "")
    .trim();
  // A handler that threw something with no message would otherwise surface as
  // an empty banner, which reads as a bug in the banner rather than the action.
  return new Error(message || "That did not work. Please try again.");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors ipcRenderer.invoke, whose result each caller types.
function invoke(channel: string, ...args: unknown[]): Promise<any> {
  return ipcRenderer.invoke(channel, ...args).catch((cause: unknown) => {
    throw readableFailure(cause);
  });
}

const umbraticApi = {
  listProjects: () => invoke("umbratic:list-projects"),
  listChats: () => invoke("umbratic:list-chats"),
  createChat: (input?: ChatInput) => invoke("umbratic:create-chat", input ?? {}),
  updateChatDraft: (input: { chatId: string; draftPrompt: string; attachedFiles: ChatAttachment[] }) =>
    invoke("umbratic:update-chat-draft", input),
  updateChatProject: (input: { chatId: string; repositoryName: string; repositoryPath: string }) =>
    invoke("umbratic:update-chat-project", input),
  getUnsavedDraft: (input: { scope: string }) => invoke("umbratic:get-unsaved-draft", input),
  setUnsavedDraft: (input: { scope: string; draftPrompt: string; attachedFiles: ChatAttachment[] }) =>
    invoke("umbratic:set-unsaved-draft", input),
  clearUnsavedDraft: (input: { scope: string }) => invoke("umbratic:clear-unsaved-draft", input),
  deleteChat: (input: { chatId: string }) => invoke("umbratic:delete-chat", input),
  deleteProjectChats: (input: { projectId: string }) => invoke("umbratic:delete-project-chats", input),
  deleteProject: (input: { projectId: string }) => invoke("umbratic:delete-project", input),
  getNotes: () => invoke("umbratic:get-notes"),
  updateNotes: (input: { content: string }) => invoke("umbratic:update-notes", input),
  getTask: (input: { taskId: string }) => invoke("umbratic:get-task", input),
  refreshTaskReview: (input: { taskId: string; scope?: "task" | "worktree"; repositoryPath?: string }) => invoke("umbratic:refresh-task-review", input),
  refreshWorkspaceReview: (input: { repositoryPath: string }) => invoke("umbratic:refresh-workspace-review", input),
  readArtifactPreview: (input: { taskId: string; documentPath: string }) => invoke("umbratic:read-artifact-preview", input),
  searchFiles: (input: { repositoryId: string; query: string; limit?: number; kind?: "file" | "folder" | "all" }) =>
    invoke("umbratic:search-files", input),
  pickRepository: () => invoke("umbratic:pick-repository"),
  pickAttachmentFiles: (input: { chatId: string; repositoryId?: string }) => invoke("umbratic:pick-attachment-files", input),
  savePastedAttachments: (input: { chatId: string; files: PastedAttachmentInput[] }) =>
    invoke("umbratic:save-pasted-attachments", input),
  openChatAttachment: (input: { attachment: ChatAttachment; repositoryId?: string }) =>
    invoke("umbratic:open-chat-attachment", input),
  getRepository: (input: { repositoryId?: string; repositoryPath?: string }) => invoke("umbratic:get-repository", input),
  listRepositoryBranches: (input: { repositoryId?: string; repositoryPath?: string }) =>
    invoke("umbratic:list-repository-branches", input),
  checkoutRepositoryBranch: (input: { repositoryId?: string; repositoryPath?: string; branch: string }) =>
    invoke("umbratic:checkout-repository-branch", input),
  getBackendStatus: () => invoke("umbratic:get-backend-status"),
  loadLocalModel: () => invoke("umbratic:load-local-model"),
  unloadLocalModel: () => invoke("umbratic:unload-local-model"),
  getStartupSettings: () => invoke("umbratic:get-startup-settings"),
  getCapabilityProbes: (input?: { force?: boolean }) => invoke("umbratic:get-capability-probes", input ?? {}),
  listRemoteConnections: () => invoke("umbratic:list-remote-connections"),
  saveRemoteConnection: (input: RemoteConnectionDraft) =>
    invoke("umbratic:save-remote-connection", input),
  deleteRemoteConnection: (input: { connectionId: string }) =>
    invoke("umbratic:delete-remote-connection", input),
  checkRemoteConnection: (input: { connectionId: string }) =>
    invoke("umbratic:check-remote-connection", input),
  installRemoteRunner: (input: { connectionId: string }) =>
    invoke("umbratic:install-remote-runner", input),
  browseRemoteDirectory: (input: { connectionId: string; path?: string }) =>
    invoke("umbratic:browse-remote-directory", input),
  setRemoteDefaultDirectory: (input: { connectionId: string; path: string }) =>
    invoke("umbratic:set-remote-default-directory", input),
  pickRemoteIdentityFile: () => invoke("umbratic:pick-remote-identity-file"),
  getHarnessProfile: () => invoke("umbratic:get-harness-profile"),
  saveHarnessProfile: (input: HarnessProfileId) => invoke("umbratic:save-harness-profile", input),
  getContextLength: () => invoke("umbratic:get-context-length"),
  saveContextLength: (input: number) => invoke("umbratic:save-context-length", input),
  getLocalMtp: () => invoke("umbratic:get-local-mtp"),
  saveLocalMtp: (input: boolean) => invoke("umbratic:save-local-mtp", input),
  getReasoningEffort: () => invoke("umbratic:get-reasoning-effort"),
  saveReasoningEffort: (input: ReasoningEffort) => invoke("umbratic:save-reasoning-effort", input),
  saveShowThinking: (input: boolean) => invoke("umbratic:save-show-thinking", input),
  saveSendOnEnter: (input: boolean) => invoke("umbratic:save-send-on-enter", input),
  getLaunchAtLogin: () => invoke("umbratic:get-launch-at-login", undefined),
  saveLaunchAtLogin: (input: boolean) => invoke("umbratic:save-launch-at-login", input),
  getModelEndpointSettings: (input?: { mode?: "local" | "server" }) =>
    invoke("umbratic:get-model-endpoint-settings", input),
  getDictationSettings: () => invoke("umbratic:get-dictation-settings"),
  saveDictationSettings: (input: DictationSettings) =>
    invoke("umbratic:save-dictation-settings", input),
  getKeyBindings: () => invoke("umbratic:get-key-bindings"),
  saveKeyBindings: (input: KeyBindingSettings) => invoke("umbratic:save-key-bindings", input),
  readGeneratedImage: (input: { taskId: string; path: string }) => invoke("umbratic:read-generated-image", input),
  getImageSettings: () => invoke("umbratic:get-image-settings"),
  saveImageSettings: (input: { model: string }) => invoke("umbratic:save-image-settings", input),
  listLocalModels: (input: { kind: "chat" | "dictation" | "image" }) =>
    invoke("umbratic:list-local-models", input),
  downloadLocalModel: (input: { id: string }) =>
    invoke("umbratic:download-local-model", input),
  cancelLocalModelDownload: (input: { id: string }) =>
    invoke("umbratic:cancel-local-model-download", input),
  setLocalModelQuant: (input: { id: string; quant: string }) =>
    invoke("umbratic:set-local-model-quant", input),
  addCustomLocalModel: (input: { reference: string }) =>
    invoke("umbratic:add-custom-local-model", input),
  removeCustomLocalModel: (input: { id: string }) =>
    invoke("umbratic:remove-custom-local-model", input),
  openModelsFolder: () => invoke("umbratic:open-models-folder"),
  listServerModels: () => invoke("umbratic:list-server-models"),
  saveModelEndpointSettings: (input: {
    mode: "local" | "server";
    baseUrl: string;
    modelId: string;
    secret: string;
    secretConfigured: boolean;
    headers: Array<{ name: string; value: string; valueConfigured: boolean }>;
  }) =>
    invoke("umbratic:save-model-endpoint-settings", input),
  getCompanyConnectionStatus: () => invoke("umbratic:get-company-connection-status"),
  enrollCompanyConnection: (input: { baseUrl: string; enrollmentCode: string; deviceLabel?: string }) =>
    invoke("umbratic:enroll-company-connection", input),
  connectCompanyConnection: () => invoke("umbratic:connect-company-connection"),
  disconnectCompanySession: () => invoke("umbratic:disconnect-company-session"),
  disconnectCompanyConnection: () => invoke("umbratic:disconnect-company-connection"),
  exportTelemetry: () => invoke("umbratic:export-telemetry"),
  exportLocalDiagnostics: () => invoke("umbratic:export-local-diagnostics"),
  clearLocalDiagnostics: () => invoke("umbratic:clear-local-diagnostics"),
  recordProductEvent: (input: {
    type: "review.opened" | "ide.selected";
    taskId?: string;
    repositoryId?: string;
    scope?: "task" | "worktree";
    target?: "task" | "project";
    ideId?: string;
    surface?: "composer" | "review";
  }) => invoke("umbratic:record-product-event", input),
  listSkills: () => invoke("umbratic:list-skills"),
  saveSkillSettings: (input: Record<string, boolean>) => invoke("umbratic:save-skill-settings", input),
  openSkillsFolder: () => invoke("umbratic:open-skills-folder"),
  openRunnerDiagnosticsFolder: () => invoke("umbratic:open-runner-diagnostics-folder"),
  openSkillInEditor: (input: { id: string }) => invoke("umbratic:open-skill-in-editor", input),
  importSkill: (input?: { sourcePath?: string }) => invoke("umbratic:import-skill", input ?? {}),
  createSkill: (input: { name: string }) => invoke("umbratic:create-skill", input),
  getSkillDocument: (input: { id: string }) => invoke("umbratic:get-skill-document", input),
  saveSkillDocument: (input: { id: string; content: string }) => invoke("umbratic:save-skill-document", input),
  resetSystemSkill: (input: { id: string }) => invoke("umbratic:reset-system-skill", input),
  setPermissionMode: (mode: PermissionMode) => invoke("umbratic:set-permission-mode", mode),
  setWebTools: (enabled: boolean) => invoke("umbratic:set-web-tools", enabled),
  listAvailableIdes: () => invoke("umbratic:list-available-ides"),
  startTask: (input: {
    repositoryId?: string;
    remoteConnectionId?: string;
    remoteDirectory?: string;
    prompt: string;
    chatId?: string;
    attachedFiles?: ChatAttachment[];
    useWorktree?: boolean;
    worktreeTaskId?: string;
  }) =>
    invoke("umbratic:start-task", input),
  steerTask: (input: { taskId: string; prompt: string; attachedFiles?: ChatAttachment[] }) =>
    invoke("umbratic:steer-task", input),
  queueFollowUpTask: (input: { taskId: string; prompt: string; attachedFiles?: ChatAttachment[] }) =>
    invoke("umbratic:queue-follow-up-task", input),
  dropQueuedTaskPrompt: (input: { taskId: string; actionId: string }) =>
    invoke("umbratic:drop-queued-task-prompt", input),
  listQueuedTaskPrompts: (input: { taskId: string }) =>
    invoke("umbratic:list-queued-task-prompts", input),
  approveWorktreeCreation: (input: { taskId: string; approved: boolean }) =>
    invoke("umbratic:approve-worktree-creation", input),
  respondToToolPermission: (input: { taskId: string; id: string; decision: "allow" | "deny" }) =>
    invoke("umbratic:respond-tool-permission", input),
  openRepositoryInIde: (input: { repositoryId: string; ideId: string }) =>
    invoke("umbratic:open-repository-in-ide", input),
  openTaskInIde: (input: { taskId: string; ideId: string; filePath?: string }) =>
    invoke("umbratic:open-task-in-ide", input),
  undoTaskChanges: (input: { taskId: string; path?: string }) => invoke("umbratic:undo-task-changes", input),
  keepWorktree: (input: { taskId: string }) => invoke("umbratic:keep-worktree", input),
  cancelTask: (input: { taskId: string }) => invoke("umbratic:cancel-task", input),
  setResponseFeedback: (input: { taskId: string; messageId: string; rating: ResponseRating | null; reason?: ResponseFeedbackReason; comment?: string }) =>
    invoke("umbratic:set-response-feedback", input),
  setWindowChromeTheme: (theme: "dark" | "light") => invoke("umbratic:set-window-chrome-theme", theme),
  openExternal: (input: { url: string }) => invoke("umbratic:open-external", input),
  requestMicrophoneAccess: () => invoke("umbratic:request-microphone-access", undefined),
  startDictation: (input: { language?: string }) => invoke("umbratic:start-dictation", input),
  sendDictationAudio: (input: { chunk: Uint8Array }) => invoke("umbratic:send-dictation-audio", input),
  stopDictation: () => invoke("umbratic:stop-dictation", undefined),
  cancelDictation: () => invoke("umbratic:cancel-dictation", undefined),
  getAppUpdateStatus: () => invoke("umbratic:get-app-update-status", undefined),
  setAutomaticAppUpdates: (input: { enabled: boolean }) => invoke("umbratic:set-automatic-app-updates", input),
  installAppUpdate: () => invoke("umbratic:install-app-update", undefined),
  onAppUpdateStatus: (callback: (status: AppUpdateStatus) => void) => {
    const listener = (_event: IpcRendererEvent, value: AppUpdateStatus) => callback(value);
    ipcRenderer.on("umbratic:app-update-status", listener);
    return () => ipcRenderer.removeListener("umbratic:app-update-status", listener);
  },
  onDictationEvent: (callback: (event: DictationEvent) => void) => {
    const listener = (_event: IpcRendererEvent, value: DictationEvent) => callback(value);
    ipcRenderer.on("umbratic:dictation-event", listener);
    return () => ipcRenderer.removeListener("umbratic:dictation-event", listener);
  },
  onModelDownloadEvent: (callback: (event: ModelDownloadEvent) => void) => {
    const listener = (_event: IpcRendererEvent, value: ModelDownloadEvent) => callback(value);
    ipcRenderer.on("umbratic:model-download", listener);
    return () => ipcRenderer.removeListener("umbratic:model-download", listener);
  },
  onWorkspaceIndex: (callback: (event: WorkspaceIndexEvent) => void) => {
    const listener = (_event: IpcRendererEvent, value: WorkspaceIndexEvent) => callback(value);
    ipcRenderer.on("umbratic:workspace-index", listener);
    return () => ipcRenderer.removeListener("umbratic:workspace-index", listener);
  },
  onBackendEvent: (callback: (event: BackendUiEvent) => void) => {
    // The main process validates at the runner boundary and constructs the rest
    // itself, so by the time an event reaches this channel its shape is settled.
    const listener = (_event: IpcRendererEvent, value: BackendUiEvent) => callback(value);
    ipcRenderer.on("umbratic:backend-event", listener);
    return () => ipcRenderer.removeListener("umbratic:backend-event", listener);
  },
} satisfies DesktopApi;

contextBridge.exposeInMainWorld("umbratic", umbraticApi);
