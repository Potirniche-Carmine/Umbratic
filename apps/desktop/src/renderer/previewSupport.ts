import {
  DEFAULT_CONTEXT_LENGTH,
  normalizeContextLength,
} from "../shared/contextWindow";
import type {
  ChatAttachment,
  ChatRecord,
  HarnessProfileId,
  IdeInfo,
  ModelEndpointMode,
  ModelEndpointSoftware,
  PermissionMode,
  PublicModelEndpointSettings,
  RepositoryInfo,
  UserNotes,
} from "../shared/desktopApi";

type ModelEndpointSettings = PublicModelEndpointSettings;

const previewProjectsKey = "umbratic-preview-projects";
const previewChatsKey = "umbratic-preview-chats";
const previewNotesKey = "umbratic-preview-notes";
const previewHarnessProfileKey = "umbratic-preview-harness-profile";
const previewContextLengthKey = "umbratic-preview-context-length";
const previewEndpointSettingsKey = "umbratic-preview-endpoint-settings";
export const defaultHarnessProfileId: HarnessProfileId = "engineering";
const defaultModelEndpointSettings: ModelEndpointSettings = {
  mode: "local",
  software: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  modelId: "",
  secret: "",
  secretConfigured: false,
  headers: [
    { name: "", value: "", valueConfigured: false },
    { name: "", value: "", valueConfigured: false },
  ],
};
export const harnessSystemSkillIds: Record<HarnessProfileId, ReadonlySet<string>> = {
  engineering: new Set([
    "umbratic-skill-creator",
    "umbratic-git-worktree",
    "umbratic-markdown",
    "umbratic-python",
  ]),
  marketing: new Set([
    "umbratic-markdown",
    "umbratic-python",
    "umbratic-pdf",
    "umbratic-data-analysis",
    "umbratic-presentations",
    "umbratic-documents",
    "umbratic-spreadsheets",
  ]),
  sales: new Set([
    "umbratic-markdown",
    "umbratic-python",
    "umbratic-pdf",
    "umbratic-data-analysis",
    "umbratic-presentations",
    "umbratic-documents",
    "umbratic-spreadsheets",
  ]),
};
export const defaultIdeChoices: IdeInfo[] = [
  { id: "code", label: "VS Code", icon: "vscode" },
  { id: "visualstudio", label: "Visual Studio", icon: "visualstudio" },
  {
    id: "explorer",
    label: navigator.platform.toLowerCase().includes("mac") ? "Finder" : "Explorer",
    icon: navigator.platform.toLowerCase().includes("mac") ? "finder" : "explorer",
  },
];
let previewPermissionMode: PermissionMode = "normal";

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

export function isHarnessProfileId(value: unknown): value is HarnessProfileId {
  return value === "marketing" || value === "sales" || value === "engineering";
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

export function writePreviewContextLength(contextLength: number): void {
  window.localStorage.setItem(
    previewContextLengthKey,
    String(normalizeContextLength(contextLength)),
  );
}

function normalizeEndpointHeaders(
  value: unknown,
): Array<{ name: string; value: string; valueConfigured: boolean }> {
  const rows = Array.isArray(value) ? value : [];
  const headers = rows.slice(0, 2).map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return { name: "", value: "", valueConfigured: false };
    }
    const record = row as Record<string, unknown>;
    return {
      name: typeof record.name === "string" ? record.name : "",
      value: typeof record.value === "string" ? record.value : "",
      valueConfigured: record.valueConfigured === true,
    };
  });
  while (headers.length < 2) {
    headers.push({ name: "", value: "", valueConfigured: false });
  }
  return headers;
}

function defaultEndpointBaseUrlForMode(
  mode: ModelEndpointMode,
  _software: ModelEndpointSoftware,
): string {
  return mode === "local"
    ? "http://127.0.0.1:11434"
    : "https://your-veil-server.example";
}

export function normalizeEndpointSettings(value: unknown): ModelEndpointSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...defaultModelEndpointSettings };
  }
  const settings = value as Partial<ModelEndpointSettings>;
  const mode =
    settings.mode === "local" || settings.mode === "server"
      ? settings.mode
      : defaultModelEndpointSettings.mode;
  const software =
    mode === "local"
      ? "ollama"
      : settings.software === "ollama" || settings.software === "vllm"
        ? settings.software
        : "vllm";
  return {
    mode,
    software,
    baseUrl:
      typeof settings.baseUrl === "string"
        ? settings.baseUrl
        : defaultEndpointBaseUrlForMode(mode, software),
    modelId:
      typeof settings.modelId === "string"
        ? settings.modelId
        : mode === "local"
          ? ""
          : "veil-managed",
    secret: typeof settings.secret === "string" ? settings.secret : "",
    secretConfigured: settings.secretConfigured === true,
    headers: normalizeEndpointHeaders(settings.headers),
  };
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

export function normalizeAttachment(file: ChatAttachment): ChatAttachment {
  const normalized: ChatAttachment = {
    path: file.path,
    name: file.name || file.path.split(/[\\/]/).pop() || file.path,
  };
  if (file.source === "chat" || file.source === "workspace") {
    normalized.source = file.source;
  }
  if (file.storedPath) normalized.storedPath = file.storedPath;
  if (file.originalPath) normalized.originalPath = file.originalPath;
  if (file.previewDataUrl?.startsWith("data:image/")) {
    normalized.previewDataUrl = file.previewDataUrl;
  }
  if (
    Number.isSafeInteger(file.contextTokens)
    && (file.contextTokens ?? -1) >= 0
  ) {
    normalized.contextTokens = file.contextTokens;
  }
  return normalized;
}

export function getPreviewPermissionMode(): PermissionMode {
  return previewPermissionMode;
}

export function setPreviewPermissionMode(mode: PermissionMode): void {
  previewPermissionMode = mode;
}
