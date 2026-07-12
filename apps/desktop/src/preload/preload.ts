import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";
import type { BackendUiEventV1 } from "../shared/backendEvents";

type PermissionMode = "normal" | "bypass";
type ReasoningMode = "fast" | "reasoning";
type HarnessProfileId = "marketing" | "sales" | "engineering";
type ChatInput = { id?: string; title?: string; repositoryName?: string; repositoryPath?: string; worktreeTaskId?: string; persist?: boolean };
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

function normalizedBackendEvent(value: unknown): BackendUiEventV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (typeof event.type !== "string" || typeof event.taskId !== "string") return null;
  if (event.version !== undefined && event.version !== 1) return null;
  return { ...event, version: 1 } as BackendUiEventV1;
}

const umbraticApi = {
  listProjects: () => ipcRenderer.invoke("umbratic:list-projects"),
  listChats: () => ipcRenderer.invoke("umbratic:list-chats"),
  createChat: (input?: ChatInput) => ipcRenderer.invoke("umbratic:create-chat", input ?? {}),
  updateChatDraft: (input: { chatId: string; draftPrompt: string; attachedFiles: ChatAttachment[] }) =>
    ipcRenderer.invoke("umbratic:update-chat-draft", input),
  updateChatProject: (input: { chatId: string; repositoryName: string; repositoryPath: string }) =>
    ipcRenderer.invoke("umbratic:update-chat-project", input),
  deleteChat: (input: { chatId: string }) => ipcRenderer.invoke("umbratic:delete-chat", input),
  deleteProjectChats: (input: { repositoryPath: string }) => ipcRenderer.invoke("umbratic:delete-project-chats", input),
  deleteProject: (input: { repositoryPath: string }) => ipcRenderer.invoke("umbratic:delete-project", input),
  getNotes: () => ipcRenderer.invoke("umbratic:get-notes"),
  updateNotes: (input: { content: string }) => ipcRenderer.invoke("umbratic:update-notes", input),
  getTask: (input: { taskId: string }) => ipcRenderer.invoke("umbratic:get-task", input),
  refreshTaskReview: (input: { taskId: string; scope?: "task" | "worktree"; repositoryPath?: string }) => ipcRenderer.invoke("umbratic:refresh-task-review", input),
  refreshWorkspaceReview: (input: { repositoryPath: string }) => ipcRenderer.invoke("umbratic:refresh-workspace-review", input),
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
  getCapabilityProbes: (input?: { force?: boolean }) => ipcRenderer.invoke("umbratic:get-capability-probes", input ?? {}),
  getHarnessProfile: () => ipcRenderer.invoke("umbratic:get-harness-profile"),
  saveHarnessProfile: (input: HarnessProfileId) => ipcRenderer.invoke("umbratic:save-harness-profile", input),
  getModelEndpointSettings: () => ipcRenderer.invoke("umbratic:get-model-endpoint-settings"),
  saveModelEndpointSettings: (input: {
    mode: "local" | "server";
    software: "ollama" | "vllm";
    baseUrl: string;
    modelId: string;
    secret: string;
    headers: Array<{ name: string; value: string }>;
  }) =>
    ipcRenderer.invoke("umbratic:save-model-endpoint-settings", input),
  exportTelemetry: () => ipcRenderer.invoke("umbratic:export-telemetry"),
  listSkills: () => ipcRenderer.invoke("umbratic:list-skills"),
  saveSkillSettings: (input: Record<string, boolean>) => ipcRenderer.invoke("umbratic:save-skill-settings", input),
  openSkillsFolder: () => ipcRenderer.invoke("umbratic:open-skills-folder"),
  openRunnerDiagnosticsFolder: () => ipcRenderer.invoke("umbratic:open-runner-diagnostics-folder"),
  openSkillInEditor: (input: { id: string }) => ipcRenderer.invoke("umbratic:open-skill-in-editor", input),
  importSkill: (input?: { sourcePath?: string }) => ipcRenderer.invoke("umbratic:import-skill", input ?? {}),
  createSkill: (input: { name: string }) => ipcRenderer.invoke("umbratic:create-skill", input),
  getSkillDocument: (input: { id: string }) => ipcRenderer.invoke("umbratic:get-skill-document", input),
  saveSkillDocument: (input: { id: string; content: string }) => ipcRenderer.invoke("umbratic:save-skill-document", input),
  resetSystemSkill: (input: { id: string }) => ipcRenderer.invoke("umbratic:reset-system-skill", input),
  setPermissionMode: (mode: PermissionMode) => ipcRenderer.invoke("umbratic:set-permission-mode", mode),
  listAvailableIdes: () => ipcRenderer.invoke("umbratic:list-available-ides"),
  startTask: (input: {
    repositoryId?: string;
    prompt: string;
    chatId?: string;
    attachedFiles?: ChatAttachment[];
    reasoningMode?: ReasoningMode;
    useWorktree?: boolean;
    worktreeTaskId?: string;
  }) =>
    ipcRenderer.invoke("umbratic:start-task", input),
  approveWorktreeCreation: (input: { taskId: string; approved: boolean }) =>
    ipcRenderer.invoke("umbratic:approve-worktree-creation", input),
  respondToToolPermission: (input: { taskId: string; id: string; decision: "allow" | "deny" }) =>
    ipcRenderer.invoke("umbratic:respond-tool-permission", input),
  openRepositoryInIde: (input: { repositoryId?: string; repositoryPath?: string; ideId: string }) =>
    ipcRenderer.invoke("umbratic:open-repository-in-ide", input),
  openTaskInIde: (input: { taskId: string; ideId: string; filePath?: string }) =>
    ipcRenderer.invoke("umbratic:open-task-in-ide", input),
  approveTaskMerge: (input: { taskId: string }) => ipcRenderer.invoke("umbratic:approve-task-merge", input),
  rejectTask: (input: { taskId: string; cleanup: boolean }) => ipcRenderer.invoke("umbratic:reject-task", input),
  keepWorktree: (input: { taskId: string }) => ipcRenderer.invoke("umbratic:keep-worktree", input),
  cancelTask: (input: { taskId: string }) => ipcRenderer.invoke("umbratic:cancel-task", input),
  setResponseFeedback: (input: { taskId: string; messageId: string; rating: "good" | "bad" }) =>
    ipcRenderer.invoke("umbratic:set-response-feedback", input),
  setWindowChromeTheme: (theme: "dark" | "light") => ipcRenderer.invoke("umbratic:set-window-chrome-theme", theme),
  onBackendEvent: (callback: (event: BackendUiEventV1) => void) => {
    const listener = (_event: IpcRendererEvent, value: unknown) => {
      const event = normalizedBackendEvent(value);
      if (event) callback(event);
    };
    ipcRenderer.on("umbratic:backend-event", listener);
    return () => ipcRenderer.removeListener("umbratic:backend-event", listener);
  },
};

contextBridge.exposeInMainWorld("umbratic", umbraticApi);
