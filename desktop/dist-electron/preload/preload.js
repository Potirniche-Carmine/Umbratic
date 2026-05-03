"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld("aegis", {
    listChats: () => electron_1.ipcRenderer.invoke("aegis:list-chats"),
    createChat: (input) => electron_1.ipcRenderer.invoke("aegis:create-chat", input ?? {}),
    updateChatDraft: (input) => electron_1.ipcRenderer.invoke("aegis:update-chat-draft", input),
    deleteChat: (input) => electron_1.ipcRenderer.invoke("aegis:delete-chat", input),
    getTask: (input) => electron_1.ipcRenderer.invoke("aegis:get-task", input),
    refreshTaskReview: (input) => electron_1.ipcRenderer.invoke("aegis:refresh-task-review", input),
    searchFiles: (input) => electron_1.ipcRenderer.invoke("aegis:search-files", input),
    pickRepository: () => electron_1.ipcRenderer.invoke("aegis:pick-repository"),
    getBackendStatus: () => electron_1.ipcRenderer.invoke("aegis:get-backend-status"),
    setPermissionMode: (mode) => electron_1.ipcRenderer.invoke("aegis:set-permission-mode", mode),
    listAvailableIdes: () => electron_1.ipcRenderer.invoke("aegis:list-available-ides"),
    startTask: (input) => electron_1.ipcRenderer.invoke("aegis:start-task", input),
    approveWorktreeCreation: (input) => electron_1.ipcRenderer.invoke("aegis:approve-worktree-creation", input),
    respondToToolPermission: (input) => electron_1.ipcRenderer.invoke("aegis:respond-tool-permission", input),
    openTaskInIde: (input) => electron_1.ipcRenderer.invoke("aegis:open-task-in-ide", input),
    approveTaskMerge: (input) => electron_1.ipcRenderer.invoke("aegis:approve-task-merge", input),
    rejectTask: (input) => electron_1.ipcRenderer.invoke("aegis:reject-task", input),
    keepWorktree: (input) => electron_1.ipcRenderer.invoke("aegis:keep-worktree", input),
    cancelTask: (input) => electron_1.ipcRenderer.invoke("aegis:cancel-task", input),
    onBackendEvent: (callback) => {
        const listener = (_event, event) => callback(event);
        electron_1.ipcRenderer.on("aegis:backend-event", listener);
        return () => electron_1.ipcRenderer.removeListener("aegis:backend-event", listener);
    },
});
