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

const umbraticApi = {
  listChats: () => ipcRenderer.invoke("umbratic:list-chats"),
  createChat: (input?: ChatInput) => ipcRenderer.invoke("umbratic:create-chat", input ?? {}),
  updateChatDraft: (input: { chatId: string; draftPrompt: string; attachedFiles: ChatAttachment[] }) =>
    ipcRenderer.invoke("umbratic:update-chat-draft", input),
  deleteChat: (input: { chatId: string }) => ipcRenderer.invoke("umbratic:delete-chat", input),
  getNotes: () => ipcRenderer.invoke("umbratic:get-notes"),
  updateNotes: (input: { content: string }) => ipcRenderer.invoke("umbratic:update-notes", input),
  getTask: (input: { taskId: string }) => ipcRenderer.invoke("umbratic:get-task", input),
  refreshTaskReview: (input: { taskId: string }) => ipcRenderer.invoke("umbratic:refresh-task-review", input),
  searchFiles: (input: { repositoryId: string; query: string; limit?: number }) => ipcRenderer.invoke("umbratic:search-files", input),
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
  exportTelemetry: () => ipcRenderer.invoke("umbratic:export-telemetry"),
  listSkills: () => ipcRenderer.invoke("umbratic:list-skills"),
  openSkillsFolder: () => ipcRenderer.invoke("umbratic:open-skills-folder"),
  createSkill: (input: { name: string }) => ipcRenderer.invoke("umbratic:create-skill", input),
  setPermissionMode: (mode: PermissionMode) => ipcRenderer.invoke("umbratic:set-permission-mode", mode),
  listAvailableIdes: () => ipcRenderer.invoke("umbratic:list-available-ides"),
  startTask: (input: {
    repositoryId?: string;
    prompt: string;
    chatId?: string;
    attachedFiles?: ChatAttachment[];
    reasoningMode?: ReasoningMode;
    useWorktree?: boolean;
  }) =>
    ipcRenderer.invoke("umbratic:start-task", input),
  approveWorktreeCreation: (input: { taskId: string; approved: boolean }) =>
    ipcRenderer.invoke("umbratic:approve-worktree-creation", input),
  respondToToolPermission: (input: { taskId: string; id: string; decision: "allow" | "deny" }) =>
    ipcRenderer.invoke("umbratic:respond-tool-permission", input),
  openTaskInIde: (input: { taskId: string; ideId: string; filePath?: string }) =>
    ipcRenderer.invoke("umbratic:open-task-in-ide", input),
  approveTaskMerge: (input: { taskId: string }) => ipcRenderer.invoke("umbratic:approve-task-merge", input),
  rejectTask: (input: { taskId: string; cleanup: boolean }) => ipcRenderer.invoke("umbratic:reject-task", input),
  keepWorktree: (input: { taskId: string }) => ipcRenderer.invoke("umbratic:keep-worktree", input),
  cancelTask: (input: { taskId: string }) => ipcRenderer.invoke("umbratic:cancel-task", input),
  setResponseFeedback: (input: { taskId: string; messageId: string; rating: "good" | "bad" }) =>
    ipcRenderer.invoke("umbratic:set-response-feedback", input),
  setWindowChromeTheme: (theme: "dark" | "light") => ipcRenderer.invoke("umbratic:set-window-chrome-theme", theme),
  onBackendEvent: (callback: (event: BackendUiEvent) => void) => {
    const listener = (_event: IpcRendererEvent, event: BackendUiEvent) => callback(event);
    ipcRenderer.on("umbratic:backend-event", listener);
    return () => ipcRenderer.removeListener("umbratic:backend-event", listener);
  },
};

contextBridge.exposeInMainWorld("umbratic", umbraticApi);
