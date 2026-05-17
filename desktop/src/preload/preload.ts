import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";

type PermissionMode = "normal" | "bypass";
type ReasoningMode = "fast" | "reasoning";
type BackendUiEvent = Record<string, unknown>;
type ChatInput = { title?: string; repositoryName?: string; repositoryPath?: string };
type ChatAttachment = {
  path: string;
  name: string;
  source?: "workspace" | "chat";
  storedPath?: string;
  originalPath?: string;
  previewDataUrl?: string;
};
type PastedAttachmentInput = {
  name?: string;
  mimeType?: string;
  dataUrl: string;
};

contextBridge.exposeInMainWorld("aegis", {
  listChats: () => ipcRenderer.invoke("aegis:list-chats"),
  createChat: (input?: ChatInput) => ipcRenderer.invoke("aegis:create-chat", input ?? {}),
  updateChatDraft: (input: { chatId: string; draftPrompt: string; attachedFiles: ChatAttachment[] }) =>
    ipcRenderer.invoke("aegis:update-chat-draft", input),
  deleteChat: (input: { chatId: string }) => ipcRenderer.invoke("aegis:delete-chat", input),
  getNotes: () => ipcRenderer.invoke("aegis:get-notes"),
  updateNotes: (input: { content: string }) => ipcRenderer.invoke("aegis:update-notes", input),
  getTask: (input: { taskId: string }) => ipcRenderer.invoke("aegis:get-task", input),
  refreshTaskReview: (input: { taskId: string }) => ipcRenderer.invoke("aegis:refresh-task-review", input),
  searchFiles: (input: { repositoryId: string; query: string; limit?: number }) => ipcRenderer.invoke("aegis:search-files", input),
  pickRepository: () => ipcRenderer.invoke("aegis:pick-repository"),
  pickAttachmentFiles: (input: { chatId: string; repositoryId?: string }) => ipcRenderer.invoke("aegis:pick-attachment-files", input),
  savePastedAttachments: (input: { chatId: string; files: PastedAttachmentInput[] }) =>
    ipcRenderer.invoke("aegis:save-pasted-attachments", input),
  getRepository: (input: { repositoryId?: string; repositoryPath?: string }) => ipcRenderer.invoke("aegis:get-repository", input),
  listRepositoryBranches: (input: { repositoryId?: string; repositoryPath?: string }) =>
    ipcRenderer.invoke("aegis:list-repository-branches", input),
  checkoutRepositoryBranch: (input: { repositoryId?: string; repositoryPath?: string; branch: string }) =>
    ipcRenderer.invoke("aegis:checkout-repository-branch", input),
  getBackendStatus: () => ipcRenderer.invoke("aegis:get-backend-status"),
  exportTelemetry: () => ipcRenderer.invoke("aegis:export-telemetry"),
  listSkills: () => ipcRenderer.invoke("aegis:list-skills"),
  openSkillsFolder: () => ipcRenderer.invoke("aegis:open-skills-folder"),
  createSkill: (input: { name: string }) => ipcRenderer.invoke("aegis:create-skill", input),
  setPermissionMode: (mode: PermissionMode) => ipcRenderer.invoke("aegis:set-permission-mode", mode),
  listAvailableIdes: () => ipcRenderer.invoke("aegis:list-available-ides"),
  startTask: (input: {
    repositoryId?: string;
    prompt: string;
    chatId?: string;
    attachedFiles?: ChatAttachment[];
    reasoningMode?: ReasoningMode;
    useWorktree?: boolean;
  }) =>
    ipcRenderer.invoke("aegis:start-task", input),
  approveWorktreeCreation: (input: { taskId: string; approved: boolean }) =>
    ipcRenderer.invoke("aegis:approve-worktree-creation", input),
  respondToToolPermission: (input: { taskId: string; id: string; decision: "allow" | "deny" }) =>
    ipcRenderer.invoke("aegis:respond-tool-permission", input),
  openTaskInIde: (input: { taskId: string; ideId: string; filePath?: string }) =>
    ipcRenderer.invoke("aegis:open-task-in-ide", input),
  approveTaskMerge: (input: { taskId: string }) => ipcRenderer.invoke("aegis:approve-task-merge", input),
  rejectTask: (input: { taskId: string; cleanup: boolean }) => ipcRenderer.invoke("aegis:reject-task", input),
  keepWorktree: (input: { taskId: string }) => ipcRenderer.invoke("aegis:keep-worktree", input),
  cancelTask: (input: { taskId: string }) => ipcRenderer.invoke("aegis:cancel-task", input),
  setResponseFeedback: (input: { taskId: string; messageId: string; rating: "good" | "bad" }) =>
    ipcRenderer.invoke("aegis:set-response-feedback", input),
  setWindowChromeTheme: (theme: "dark" | "light") => ipcRenderer.invoke("aegis:set-window-chrome-theme", theme),
  onBackendEvent: (callback: (event: BackendUiEvent) => void) => {
    const listener = (_event: IpcRendererEvent, event: BackendUiEvent) => callback(event);
    ipcRenderer.on("aegis:backend-event", listener);
    return () => ipcRenderer.removeListener("aegis:backend-event", listener);
  },
});
