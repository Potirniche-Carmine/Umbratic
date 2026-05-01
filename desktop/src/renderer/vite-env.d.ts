/// <reference types="vite/client" />

export type DaemonConnection =
  | { status: "ready"; url: string; token: string }
  | { status: "missing"; message: string }
  | { status: "error"; message: string };

declare global {
  interface Window {
    aegis?: {
      getDaemonConnection(): Promise<DaemonConnection>;
      restartDaemon(): Promise<DaemonConnection>;
      pickProjectFolder(): Promise<
        | { canceled: true }
        | { canceled: false; rootPath: string; name: string }
      >;
      pickAttachments(projectRoot?: string): Promise<
        | { canceled: true }
        | {
            canceled: false;
            files: Array<{
              path: string;
              name: string;
              projectPath?: string;
              content?: string;
            }>;
          }
      >;
      startTerminal(cwd?: string): Promise<{ started: boolean; shell: string }>;
      writeTerminal(data: string): Promise<{ written: boolean }>;
      onTerminalData(callback: (data: string) => void): () => void;
      onOpenProjectRequested(callback: () => void): () => void;
      onBackToChatRequested(callback: () => void): () => void;
      onToggleSidebarRequested(callback: () => void): () => void;
    };
  }
}
