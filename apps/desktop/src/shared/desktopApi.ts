import type { DesktopApi } from "./desktopApiTypes";

export * from "./desktopApiTypes";

export const desktopIpcChannels = {
  listProjects: "umbratic:list-projects",
  listChats: "umbratic:list-chats",
  createChat: "umbratic:create-chat",
  updateChatDraft: "umbratic:update-chat-draft",
  updateChatProject: "umbratic:update-chat-project",
  getUnsavedDraft: "umbratic:get-unsaved-draft",
  setUnsavedDraft: "umbratic:set-unsaved-draft",
  clearUnsavedDraft: "umbratic:clear-unsaved-draft",
  deleteChat: "umbratic:delete-chat",
  deleteProjectChats: "umbratic:delete-project-chats",
  deleteProject: "umbratic:delete-project",
  getNotes: "umbratic:get-notes",
  updateNotes: "umbratic:update-notes",
  getTask: "umbratic:get-task",
  refreshTaskReview: "umbratic:refresh-task-review",
  refreshWorkspaceReview: "umbratic:refresh-workspace-review",
  readArtifactPreview: "umbratic:read-artifact-preview",
  searchFiles: "umbratic:search-files",
  pickRepository: "umbratic:pick-repository",
  pickAttachmentFiles: "umbratic:pick-attachment-files",
  savePastedAttachments: "umbratic:save-pasted-attachments",
  openChatAttachment: "umbratic:open-chat-attachment",
  getRepository: "umbratic:get-repository",
  listRepositoryBranches: "umbratic:list-repository-branches",
  checkoutRepositoryBranch: "umbratic:checkout-repository-branch",
  getBackendStatus: "umbratic:get-backend-status",
  loadLocalModel: "umbratic:load-local-model",
  unloadLocalModel: "umbratic:unload-local-model",
  getStartupSettings: "umbratic:get-startup-settings",
  getCapabilityProbes: "umbratic:get-capability-probes",
  listRemoteConnections: "umbratic:list-remote-connections",
  saveRemoteConnection: "umbratic:save-remote-connection",
  deleteRemoteConnection: "umbratic:delete-remote-connection",
  checkRemoteConnection: "umbratic:check-remote-connection",
  installRemoteRunner: "umbratic:install-remote-runner",
  browseRemoteDirectory: "umbratic:browse-remote-directory",
  setRemoteDefaultDirectory: "umbratic:set-remote-default-directory",
  pickRemoteIdentityFile: "umbratic:pick-remote-identity-file",
  getHarnessProfile: "umbratic:get-harness-profile",
  saveHarnessProfile: "umbratic:save-harness-profile",
  getContextLength: "umbratic:get-context-length",
  saveContextLength: "umbratic:save-context-length",
  getLocalMtp: "umbratic:get-local-mtp",
  saveLocalMtp: "umbratic:save-local-mtp",
  getReasoningEffort: "umbratic:get-reasoning-effort",
  saveReasoningEffort: "umbratic:save-reasoning-effort",
  saveShowThinking: "umbratic:save-show-thinking",
  saveSendOnEnter: "umbratic:save-send-on-enter",
  getLaunchAtLogin: "umbratic:get-launch-at-login",
  saveLaunchAtLogin: "umbratic:save-launch-at-login",
  getModelEndpointSettings: "umbratic:get-model-endpoint-settings",
  getDictationSettings: "umbratic:get-dictation-settings",
  saveDictationSettings: "umbratic:save-dictation-settings",
  getKeyBindings: "umbratic:get-key-bindings",
  saveKeyBindings: "umbratic:save-key-bindings",
  readGeneratedImage: "umbratic:read-generated-image",
  getImageSettings: "umbratic:get-image-settings",
  saveImageSettings: "umbratic:save-image-settings",
  listLocalModels: "umbratic:list-local-models",
  downloadLocalModel: "umbratic:download-local-model",
  cancelLocalModelDownload: "umbratic:cancel-local-model-download",
  setLocalModelQuant: "umbratic:set-local-model-quant",
  addCustomLocalModel: "umbratic:add-custom-local-model",
  removeCustomLocalModel: "umbratic:remove-custom-local-model",
  openModelsFolder: "umbratic:open-models-folder",
  listServerModels: "umbratic:list-server-models",
  saveModelEndpointSettings: "umbratic:save-model-endpoint-settings",
  getCompanyConnectionStatus: "umbratic:get-company-connection-status",
  enrollCompanyConnection: "umbratic:enroll-company-connection",
  connectCompanyConnection: "umbratic:connect-company-connection",
  disconnectCompanySession: "umbratic:disconnect-company-session",
  disconnectCompanyConnection: "umbratic:disconnect-company-connection",
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
  setWebTools: "umbratic:set-web-tools",
  listAvailableIdes: "umbratic:list-available-ides",
  startTask: "umbratic:start-task",
  steerTask: "umbratic:steer-task",
  queueFollowUpTask: "umbratic:queue-follow-up-task",
  dropQueuedTaskPrompt: "umbratic:drop-queued-task-prompt",
  listQueuedTaskPrompts: "umbratic:list-queued-task-prompts",
  approveWorktreeCreation: "umbratic:approve-worktree-creation",
  respondToToolPermission: "umbratic:respond-tool-permission",
  openRepositoryInIde: "umbratic:open-repository-in-ide",
  openTaskInIde: "umbratic:open-task-in-ide",
  undoTaskChanges: "umbratic:undo-task-changes",
  keepWorktree: "umbratic:keep-worktree",
  cancelTask: "umbratic:cancel-task",
  setResponseFeedback: "umbratic:set-response-feedback",
  setWindowChromeTheme: "umbratic:set-window-chrome-theme",
  openExternal: "umbratic:open-external",
  requestMicrophoneAccess: "umbratic:request-microphone-access",
  startDictation: "umbratic:start-dictation",
  sendDictationAudio: "umbratic:send-dictation-audio",
  stopDictation: "umbratic:stop-dictation",
  cancelDictation: "umbratic:cancel-dictation",
  getAppUpdateStatus: "umbratic:get-app-update-status",
  setAutomaticAppUpdates: "umbratic:set-automatic-app-updates",
  installAppUpdate: "umbratic:install-app-update",
} as const satisfies Record<
  Exclude<keyof DesktopApi, "onBackendEvent" | "onWorkspaceIndex" | "onDictationEvent" | "onModelDownloadEvent" | "onAppUpdateStatus">,
  string
>;

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
