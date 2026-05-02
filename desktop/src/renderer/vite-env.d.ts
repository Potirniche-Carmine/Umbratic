/// <reference types="vite/client" />

export type OpenCodeConnection =
  | {
      status: "ready";
      url: string;
      username: string;
      password: string;
      authHeader: string;
      model: {
        providerId: "aegis-lmstudio";
        modelId: string;
        displayName: string;
        lmStudioBaseUrl: string;
        lmStudio: "ready" | "degraded" | "unavailable";
      };
      privacy: {
        share: "disabled";
        enabledProviders: string[];
        disabledProviders: string[];
        webTools: "disabled";
      };
    }
  | { status: "missing"; message: string }
  | { status: "error"; message: string };

declare global {
  interface Window {
    aegis?: {
      getOpenCodeConnection(): Promise<OpenCodeConnection>;
      restartOpenCode(): Promise<OpenCodeConnection>;
      nativeRequest<T = unknown>(payload: unknown): Promise<T>;
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
