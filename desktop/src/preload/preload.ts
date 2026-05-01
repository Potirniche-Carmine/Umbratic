import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("aegis", {
  getDaemonConnection: () => ipcRenderer.invoke("daemon:get-connection"),
  restartDaemon: () => ipcRenderer.invoke("daemon:restart"),
  pickProjectFolder: () => ipcRenderer.invoke("project:pick-folder"),
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
