import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";

type PermissionMode = "normal" | "bypass";
type BackendUiEvent = Record<string, unknown>;
type ChatInput = { title?: string; repositoryName?: string; repositoryPath?: string };
type ChatAttachment = { path: string; name: string };

contextBridge.exposeInMainWorld("aegis", {
  listChats: () => ipcRenderer.invoke("aegis:list-chats"),
  createChat: (input?: ChatInput) => ipcRenderer.invoke("aegis:create-chat", input ?? {}),
  updateChatDraft: (input: { chatId: string; draftPrompt: string; attachedFiles: ChatAttachment[] }) =>
    ipcRenderer.invoke("aegis:update-chat-draft", input),
  deleteChat: (input: { chatId: string }) => ipcRenderer.invoke("aegis:delete-chat", input),
  getTask: (input: { taskId: string }) => ipcRenderer.invoke("aegis:get-task", input),
  refreshTaskReview: (input: { taskId: string }) => ipcRenderer.invoke("aegis:refresh-task-review", input),
  searchFiles: (input: { repositoryId: string; query: string; limit?: number }) => ipcRenderer.invoke("aegis:search-files", input),
  pickRepository: () => ipcRenderer.invoke("aegis:pick-repository"),
  getRepository: (input: { repositoryId?: string; repositoryPath?: string }) => ipcRenderer.invoke("aegis:get-repository", input),
  getBackendStatus: () => ipcRenderer.invoke("aegis:get-backend-status"),
  setPermissionMode: (mode: PermissionMode) => ipcRenderer.invoke("aegis:set-permission-mode", mode),
  setSelectedModel: (input: { providerId: string; modelId: string }) => ipcRenderer.invoke("aegis:set-selected-model", input),
  listAvailableIdes: () => ipcRenderer.invoke("aegis:list-available-ides"),
  startTask: (input: { repositoryId: string; prompt: string; chatId?: string; attachedFiles?: ChatAttachment[] }) =>
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
  onBackendEvent: (callback: (event: BackendUiEvent) => void) => {
    const listener = (_event: IpcRendererEvent, event: BackendUiEvent) => callback(event);
    ipcRenderer.on("aegis:backend-event", listener);
    return () => ipcRenderer.removeListener("aegis:backend-event", listener);
  },
});
