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
      onOpenProjectRequested(callback: () => void): () => void;
      onBackToChatRequested(callback: () => void): () => void;
      onToggleSidebarRequested(callback: () => void): () => void;
    };
  }
}
