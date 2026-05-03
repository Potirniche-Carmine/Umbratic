"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld("aegis", {
    getOpenCodeConnection: () => electron_1.ipcRenderer.invoke("opencode:get-connection"),
    restartOpenCode: () => electron_1.ipcRenderer.invoke("opencode:restart"),
    nativeRequest: (payload) => electron_1.ipcRenderer.invoke("aegis:native-request", payload),
    setPermissionMode: (mode) => electron_1.ipcRenderer.invoke("opencode:set-permission-mode", mode),
    pickProjectFolder: () => electron_1.ipcRenderer.invoke("project:pick-folder"),
    pickAttachments: (projectRoot) => electron_1.ipcRenderer.invoke("file:pick-attachments", projectRoot),
    openProjectInIde: (payload) => electron_1.ipcRenderer.invoke("ide:open-project", payload),
    openFileInIde: (payload) => electron_1.ipcRenderer.invoke("ide:open-file", payload),
    startTerminal: (cwd) => electron_1.ipcRenderer.invoke("terminal:start", cwd),
    writeTerminal: (data) => electron_1.ipcRenderer.invoke("terminal:write", data),
    onTerminalData: (callback) => {
        const listener = (_event, data) => callback(data);
        electron_1.ipcRenderer.on("terminal:data", listener);
        return () => electron_1.ipcRenderer.removeListener("terminal:data", listener);
    },
    onOpenProjectRequested: (callback) => {
        const listener = () => callback();
        electron_1.ipcRenderer.on("menu:open-project", listener);
        return () => electron_1.ipcRenderer.removeListener("menu:open-project", listener);
    },
    onBackToChatRequested: (callback) => {
        const listener = () => callback();
        electron_1.ipcRenderer.on("menu:back-to-chat", listener);
        return () => electron_1.ipcRenderer.removeListener("menu:back-to-chat", listener);
    },
    onToggleSidebarRequested: (callback) => {
        const listener = () => callback();
        electron_1.ipcRenderer.on("menu:toggle-sidebar", listener);
        return () => electron_1.ipcRenderer.removeListener("menu:toggle-sidebar", listener);
    },
});
