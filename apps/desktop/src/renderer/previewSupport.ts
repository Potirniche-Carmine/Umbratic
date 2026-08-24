import {
  DEFAULT_CONTEXT_LENGTH,
  normalizeContextLength,
} from "../shared/contextWindow";
import { DEFAULT_REASONING_EFFORT, isReasoningEffort } from "../shared/desktopApi";
import { defaultModelEndpointSettings, normalizeEndpointSettings } from "./endpointSettings";
import { defaultHarnessProfileId, isHarnessProfileId } from "./harnessProfile";
import type {
  ChatRecord,
  HarnessProfileId,
  IdeInfo,
  PermissionMode,
  PublicModelEndpointSettings,
  ReasoningEffort,
  RepositoryInfo,
  UserNotes,
} from "../shared/desktopApi";

type ModelEndpointSettings = PublicModelEndpointSettings;

const previewProjectsKey = "umbratic-preview-projects";
const previewChatsKey = "umbratic-preview-chats";
const previewNotesKey = "umbratic-preview-notes";
const previewHarnessProfileKey = "umbratic-preview-harness-profile";
const previewContextLengthKey = "umbratic-preview-context-length";
const previewReasoningEffortKey = "umbratic-preview-reasoning-effort";
const previewEndpointSettingsKey = "umbratic-preview-endpoint-settings";
export const defaultIdeChoices: IdeInfo[] = [
  { id: "code", label: "VS Code", icon: "vscode" },
  { id: "visualstudio", label: "Visual Studio", icon: "visualstudio" },
  {
    id: "explorer",
    label: navigator.platform.toLowerCase().includes("mac") ? "Finder" : "Explorer",
    icon: navigator.platform.toLowerCase().includes("mac") ? "finder" : "explorer",
  },
];
// The app's own default for anyone who has not chosen, so the preview shows
// the composer the way a fresh install does.
let previewPermissionMode: PermissionMode = "auto_safe";

export function readPreviewProjects(): RepositoryInfo[] {
  try {
    return JSON.parse(
      window.localStorage.getItem(previewProjectsKey) ?? "[]",
    ) as RepositoryInfo[];
  } catch {
    return [];
  }
}

export function writePreviewProjects(projects: RepositoryInfo[]): void {
  window.localStorage.setItem(previewProjectsKey, JSON.stringify(projects));
}

export function readPreviewChats(): ChatRecord[] {
  try {
    return JSON.parse(
      window.localStorage.getItem(previewChatsKey) ?? "[]",
    ) as ChatRecord[];
  } catch {
    return [];
  }
}

export function writePreviewChats(chats: ChatRecord[]): void {
  window.localStorage.setItem(previewChatsKey, JSON.stringify(chats));
}

export function readPreviewNotes(): UserNotes {
  try {
    const notes = JSON.parse(
      window.localStorage.getItem(previewNotesKey) ?? "{}",
    ) as Partial<UserNotes>;
    return {
      content: typeof notes.content === "string" ? notes.content : "",
      updatedAt: typeof notes.updatedAt === "string" ? notes.updatedAt : "",
    };
  } catch {
    return { content: "", updatedAt: "" };
  }
}

export function writePreviewNotes(content: string): UserNotes {
  const notes = { content, updatedAt: new Date().toISOString() };
  window.localStorage.setItem(previewNotesKey, JSON.stringify(notes));
  return notes;
}

export function readPreviewHarnessProfile(): HarnessProfileId {
  const profileId = window.localStorage.getItem(previewHarnessProfileKey);
  return isHarnessProfileId(profileId)
    ? profileId
    : defaultHarnessProfileId;
}

export function writePreviewHarnessProfile(profileId: HarnessProfileId): void {
  window.localStorage.setItem(previewHarnessProfileKey, profileId);
}

export function readPreviewContextLength(): number {
  return normalizeContextLength(
    window.localStorage.getItem(previewContextLengthKey)
      ?? DEFAULT_CONTEXT_LENGTH,
  );
}

export function readPreviewReasoningEffort(): ReasoningEffort {
  const stored = window.localStorage.getItem(previewReasoningEffortKey);
  return isReasoningEffort(stored) ? stored : DEFAULT_REASONING_EFFORT;
}

export function writePreviewReasoningEffort(effort: ReasoningEffort): void {
  window.localStorage.setItem(previewReasoningEffortKey, effort);
}

const previewShowThinkingKey = "umbratic-preview-show-thinking";

export function readPreviewShowThinking(): boolean {
  return window.localStorage.getItem(previewShowThinkingKey) === "true";
}

export function writePreviewShowThinking(value: boolean): void {
  window.localStorage.setItem(previewShowThinkingKey, value ? "true" : "false");
}

export function writePreviewContextLength(contextLength: number): void {
  window.localStorage.setItem(
    previewContextLengthKey,
    String(normalizeContextLength(contextLength)),
  );
}


export function readPreviewEndpointSettings(): ModelEndpointSettings {
  try {
    return normalizeEndpointSettings(
      JSON.parse(
        window.localStorage.getItem(previewEndpointSettingsKey) ?? "{}",
      ),
    );
  } catch {
    return { ...defaultModelEndpointSettings };
  }
}

export function writePreviewEndpointSettings(settings: ModelEndpointSettings): void {
  window.localStorage.setItem(
    previewEndpointSettingsKey,
    JSON.stringify(settings),
  );
}

export function publicPreviewEndpointSettings(
  settings: ModelEndpointSettings,
): ModelEndpointSettings {
  return {
    ...settings,
    secret: "",
    secretConfigured: settings.secretConfigured || !!settings.secret,
    headers: settings.headers.map((header) => ({
      name: header.name,
      value: "",
      valueConfigured: header.valueConfigured || !!header.value,
    })),
  };
}

export function getPreviewPermissionMode(): PermissionMode {
  return previewPermissionMode;
}

export function setPreviewPermissionMode(mode: PermissionMode): void {
  previewPermissionMode = mode;
}
