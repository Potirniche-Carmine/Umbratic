import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";

contextBridge.exposeInMainWorld("aegis", {
  getOpenCodeConnection: () => ipcRenderer.invoke("opencode:get-connection"),
  restartOpenCode: () => ipcRenderer.invoke("opencode:restart"),
  nativeRequest: (payload: unknown) => ipcRenderer.invoke("aegis:native-request", payload),
  setPermissionMode: (mode: "default" | "bypass") => ipcRenderer.invoke("opencode:set-permission-mode", mode),
  pickProjectFolder: () => ipcRenderer.invoke("project:pick-folder"),
  pickAttachments: (projectRoot?: string) => ipcRenderer.invoke("file:pick-attachments", projectRoot),
  openProjectInIde: (payload: { ideId: string; command: string; projectRoot: string }) =>
    ipcRenderer.invoke("ide:open-project", payload),
  openFileInIde: (payload: { ideId: string; command: string; projectRoot: string; file: string; line?: number | null }) =>
    ipcRenderer.invoke("ide:open-file", payload),
  startTerminal: (cwd?: string) => ipcRenderer.invoke("terminal:start", cwd),
  writeTerminal: (data: string) => ipcRenderer.invoke("terminal:write", data),
  onTerminalData: (callback: (data: string) => void) => {
    const listener = (_event: IpcRendererEvent, data: string) => callback(data);
    ipcRenderer.on("terminal:data", listener);
    return () => ipcRenderer.removeListener("terminal:data", listener);
  },
  onOpenProjectRequested: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("menu:open-project", listener);
    return () => ipcRenderer.removeListener("menu:open-project", listener);
  },
  onBackToChatRequested: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("menu:back-to-chat", listener);
    return () => ipcRenderer.removeListener("menu:back-to-chat", listener);
  },
  onToggleSidebarRequested: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("menu:toggle-sidebar", listener);
    return () => ipcRenderer.removeListener("menu:toggle-sidebar", listener);
  },
});
