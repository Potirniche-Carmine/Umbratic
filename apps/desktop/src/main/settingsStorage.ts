import {
  defaultEndpointApiKey,
  defaultEndpointBaseUrlForMode,
  defaultEndpointModelId,
  defaultHarnessProfileId,
  defaultLocalModelId,
  defaultModelEndpointMode,
  endpointEditingAllowed,
  isHarnessProfileId,
  isModelEndpointMode,
  localEndpointForced,
  managedModelEndpointDefaults,
} from "./config";
import { defaultToolSettings, enabledToolsFromSettings, isRunnerToolId, toolSettingsFromEnabledTools } from "./toolSettings";
import { DEFAULT_CONTEXT_LENGTH, normalizeContextLength } from "../shared/contextWindow";
import type { DesktopStartupSettings } from "../shared/desktopApi";
import { assertCompanyCredentialStorageAvailable, companyConnectionStatusFromValue } from "./companyCredentialStorage";
import { decodeCompanyDeviceCredential, encodeCompanyDeviceCredential, readProtectedString, writeProtectedString } from "./companyCredentialStorage";
import type { CompanyDeviceCredential, StoredProtectedString } from "./companyCredentialStorage";
import { activeStoredEndpoint, endpointModesWithNext, storedEndpointForMode, type RawModelEndpointSettings } from "./endpointModeStorage";
import { isRecord, parsePayload, withAppDatabase } from "./storageDatabase";
import type {
  ActiveModelEndpointSettings,
  HarnessProfileId,
  ModelEndpointMode,
  PermissionMode,
  RunnerToolId,
  UserNotes,
} from "./types";

type RawSettings = {
  selectedModel?: { providerId?: string; modelId?: string };
  modelEndpoint?: RawModelEndpointSettings;
  modelEndpoints?: Partial<Record<ModelEndpointMode, RawModelEndpointSettings>>;
  tools?: Partial<Record<RunnerToolId, boolean>>;
  skills?: Record<string, boolean>;
  harnessProfile?: unknown;
  contextLength?: unknown;
  permissionMode?: unknown;
  companyCredential?: unknown;
  localModelCache?: unknown;
};

type SettingsRow = {
  payload: string;
};
type NoteRow = {
  content: string;
  updated_at: string;
};
const appSettingsKey = "app";
const userNotesId = "user";
const localModelCacheLimit = 8;
const localModelLimit = 200;
type StoredLocalModelCacheEntry = {
  baseUrl: string;
  models: string[];
  updatedAt: string;
};

function localModelCacheKey(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function normalizedLocalModelCache(value: unknown): StoredLocalModelCacheEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.baseUrl !== "string" || !Array.isArray(entry.models)) return [];
    const baseUrl = localModelCacheKey(entry.baseUrl);
    if (!baseUrl) return [];
    const models = Array.from(new Set(
      entry.models
        .filter((model): model is string => typeof model === "string")
        .map((model) => model.trim())
        .filter((model) => model.length > 0 && model.length <= 256),
    )).slice(0, localModelLimit);
    return [{
      baseUrl,
      models,
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
    }];
  }).slice(0, localModelCacheLimit);
}

function cachedLocalModels(settings: RawSettings, baseUrl: string): string[] {
  const key = localModelCacheKey(baseUrl);
  return normalizedLocalModelCache(settings.localModelCache)
    .find((entry) => entry.baseUrl === key)?.models ?? [];
}

export function readCachedLocalModels(baseUrl: string): string[] {
  return cachedLocalModels(readRawSettings(), baseUrl);
}

export function writeCachedLocalModels(baseUrl: string, models: readonly string[]): string[] {
  const key = localModelCacheKey(baseUrl);
  if (!key) return [];
  const normalized = Array.from(new Set(
    models.map((model) => model.trim()).filter((model) => model.length > 0 && model.length <= 256),
  )).slice(0, localModelLimit);
  const settings = readRawSettings();
  const entries = normalizedLocalModelCache(settings.localModelCache)
    .filter((entry) => entry.baseUrl !== key);
  writeRawSettings({
    ...settings,
    localModelCache: [{ baseUrl: key, models: normalized, updatedAt: new Date().toISOString() }, ...entries]
      .slice(0, localModelCacheLimit),
  });
  return normalized;
}

function readRawSettings(): RawSettings {
  return withAppDatabase((db) => {
    const row = db.prepare("SELECT payload FROM settings WHERE key = ?").get(appSettingsKey) as SettingsRow | undefined;
    const settings = row ? parsePayload(row.payload) : {};
    return isRecord(settings) ? (settings as RawSettings) : {};
  });
}

function writeRawSettings(settings: RawSettings) {
  withAppDatabase((db) => {
    db.prepare("INSERT OR REPLACE INTO settings (key, payload) VALUES (?, ?)").run(appSettingsKey, JSON.stringify(settings));
  });
}

type StoredModelEndpointSettings = Omit<ActiveModelEndpointSettings, "headers" | "secret"> & {
  secret: "" | StoredProtectedString;
  headers: Array<{ name: string; value: "" | StoredProtectedString }>;
};

export type PublicModelEndpointSettings = Omit<ActiveModelEndpointSettings, "headers"> & {
  secretConfigured: boolean;
  headers: Array<{ name: string; value: string; valueConfigured: boolean }>;
};

function normalizeHeaderRows(
  value: unknown,
  readValue: (value: unknown) => string,
): Array<{ name: string; value: string }> {
  const rows = Array.isArray(value) ? value : [];
  const headers = rows.slice(0, 2).map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return { name: "", value: "" };
    const record = row as Record<string, unknown>;
    return {
      name: typeof record.name === "string" ? record.name.trim() : "",
      value: readValue(record.value),
    };
  });
  while (headers.length < 2) headers.push({ name: "", value: "" });
  return headers;
}

/** Headers arriving from the renderer or already-decrypted settings. */
function normalizeEndpointHeaders(value: unknown): Array<{ name: string; value: string }> {
  return normalizeHeaderRows(value, (raw) => (typeof raw === "string" ? raw : ""));
}

/** Headers read off disk, where every value must be an encrypted envelope. */
function normalizeStoredEndpointHeaders(value: unknown): Array<{ name: string; value: string }> {
  return normalizeHeaderRows(value, (raw) => readProtectedString(raw) ?? "");
}

const activeModelEndpointSettings = (settings: RawSettings) => activeStoredEndpoint(settings);
const storedModelEndpointSettings = (settings: RawSettings, mode: ModelEndpointMode) =>
  storedEndpointForMode(settings, mode);

export function hasStoredModelEndpointSettings(): boolean {
  const settings = readRawSettings();
  return !!activeModelEndpointSettings(settings);
}

function modelEndpointSettings(
  settings: RawSettings,
  requestedMode?: ModelEndpointMode,
): ActiveModelEndpointSettings {
  const activeEndpoint = activeModelEndpointSettings(settings) ?? {};
  const managed = managedModelEndpointDefaults();
  const forceLocal = localEndpointForced();
  const mode =
    forceLocal ? "local" : managed?.mode ??
    requestedMode ??
    (activeEndpoint.mode === "local" || activeEndpoint.mode === "server" ? activeEndpoint.mode : defaultModelEndpointMode());
  const endpoint = storedModelEndpointSettings(settings, mode) ?? {};
  const managedBaseUrl = forceLocal ? undefined : managed?.baseUrl;
  const storedLocalEndpoint = endpoint.mode === "local";
  const storedEndpointAllowed = !forceLocal || storedLocalEndpoint;
  const storedBaseUrl = storedEndpointAllowed && typeof endpoint.baseUrl === "string" && endpoint.baseUrl.trim()
    ? endpoint.baseUrl.trim()
    : undefined;
  const modelId =
    mode === "local"
      ? storedLocalEndpoint && typeof endpoint.modelId === "string" && endpoint.modelId.trim()
        ? endpoint.modelId.trim()
        : defaultLocalModelId
      : defaultEndpointModelId;
  return {
    mode,
    baseUrl: managedBaseUrl ?? storedBaseUrl ?? defaultEndpointBaseUrlForMode(mode),
    modelId,
    secret: mode === "local" ? "" : managed?.secret ?? readProtectedString(endpoint.secret) ?? defaultEndpointApiKey,
    headers: mode === "local" ? normalizeEndpointHeaders([]) : normalizeStoredEndpointHeaders(endpoint.headers),
  };
}

export function readCompanyDeviceCredential(): CompanyDeviceCredential | null {
  const stored = readRawSettings().companyCredential;
  const credential = decodeCompanyDeviceCredential(stored);
  // A record that will not decode is corrupt or tampered with. Drop it so the
  // device re-enrolls instead of carrying an unusable credential forward.
  if (!credential && stored !== undefined) clearCompanyDeviceCredential();
  return credential;
}

export function writeCompanyDeviceCredential(input: CompanyDeviceCredential): CompanyDeviceCredential {
  const settings = readRawSettings();
  writeRawSettings({ ...settings, companyCredential: encodeCompanyDeviceCredential(input) });
  return input;
}

export { assertCompanyCredentialStorageAvailable };

export function clearCompanyDeviceCredential(): void {
  const settings = readRawSettings();
  writeRawSettings({ ...settings, companyCredential: undefined });
}

export function companyConnectionStatus() {
  return companyConnectionStatusFromValue(readRawSettings().companyCredential);
}

export function readModelEndpointSettings(): ActiveModelEndpointSettings { return modelEndpointSettings(readRawSettings()); }

export function readModelEndpointSettingsForMode(mode: ModelEndpointMode): ActiveModelEndpointSettings {
  return modelEndpointSettings(readRawSettings(), mode);
}

export function publicModelEndpointSettings(settings: ActiveModelEndpointSettings): PublicModelEndpointSettings {
  return {
    ...settings,
    secret: "",
    secretConfigured: !!settings.secret,
    headers: settings.headers.map((header) => ({
      name: header.name,
      value: "",
      valueConfigured: !!header.value,
    })),
  };
}

function protectEndpointSettings(settings: ActiveModelEndpointSettings): StoredModelEndpointSettings {
  return {
    ...settings,
    secret: writeProtectedString(settings.secret),
    headers: settings.headers.map((header) => ({
      name: header.name,
      value: writeProtectedString(header.value),
    })),
  };
}

export function writeModelEndpointSettings(input: Partial<ActiveModelEndpointSettings>): ActiveModelEndpointSettings {
  const current = readModelEndpointSettings();
  const managed = managedModelEndpointDefaults();
  const hasManagedEndpoint = !!(managed?.baseUrl || managed?.mode);
  const canEditEndpoint = endpointEditingAllowed() && !hasManagedEndpoint;
  const nextMode = canEditEndpoint && isModelEndpointMode(input.mode) ? input.mode : current.mode;
  const next: ActiveModelEndpointSettings = {
    mode: nextMode,
    baseUrl:
      !canEditEndpoint
        ? current.baseUrl
        : typeof input.baseUrl === "string" && input.baseUrl.trim()
          ? input.baseUrl.trim()
          : defaultEndpointBaseUrlForMode(nextMode),
    modelId:
      nextMode === "local"
        ? typeof input.modelId === "string"
          ? input.modelId.trim()
          : current.mode === "local"
            ? current.modelId
            : defaultLocalModelId
        : defaultEndpointModelId,
    secret:
      nextMode === "local"
        ? ""
        : managed?.secret ?? (typeof input.secret === "string" && input.secret ? input.secret : current.mode === "server" ? current.secret : ""),
    headers:
      nextMode === "local"
        ? normalizeEndpointHeaders([])
        : normalizeEndpointHeaders(input.headers ?? (current.mode === "server" ? current.headers : [])).map((header) => ({
            name: header.name,
            value: header.value || current.headers.find((existing) => existing.name === header.name)?.value || "",
          })),
  };
  const settings = readRawSettings();
  const protectedNext = protectEndpointSettings(next);
  writeRawSettings({
    ...settings,
    selectedModel: { providerId: "company-endpoint", modelId: next.modelId },
    modelEndpoint: protectedNext,
    modelEndpoints: endpointModesWithNext(settings, protectedNext),
  });
  return next;
}

export function readToolSettings(): Record<RunnerToolId, boolean> {
  const settings = readRawSettings();
  const rawTools = settings.tools && typeof settings.tools === "object" ? settings.tools : {};
  return {
    ...defaultToolSettings(),
    ...Object.fromEntries(
      Object.entries(rawTools).filter(([id, value]) => isRunnerToolId(id) && typeof value === "boolean"),
    ),
  } as Record<RunnerToolId, boolean>;
}

export function writeToolSettings(input: Partial<Record<RunnerToolId, boolean>>): Record<RunnerToolId, boolean> {
  const current = readToolSettings();
  const sanitized: Partial<Record<RunnerToolId, boolean>> = {};
  for (const [id, value] of Object.entries(input)) {
    if (isRunnerToolId(id) && typeof value === "boolean") {
      sanitized[id] = value;
    }
  }
  const next = {
    ...current,
    ...sanitized,
  };
  const settings = readRawSettings();
  writeRawSettings({
    ...settings,
    tools: toolSettingsFromEnabledTools(enabledToolsFromSettings(next)),
  });
  return next;
}

export function readSkillSettings(): Record<string, boolean> {
  const settings = readRawSettings();
  const rawSkills = settings.skills && typeof settings.skills === "object" ? settings.skills : {};
  return Object.fromEntries(
    Object.entries(rawSkills).filter(([id, value]) => /^[A-Za-z0-9_-]{1,96}$/.test(id) && typeof value === "boolean"),
  );
}

export function writeSkillSettings(input: Record<string, boolean>): Record<string, boolean> {
  const current = readSkillSettings();
  const sanitized: Record<string, boolean> = {};
  for (const [id, value] of Object.entries(input)) {
    if (/^[A-Za-z0-9_-]{1,96}$/.test(id) && typeof value === "boolean") {
      sanitized[id] = value;
    }
  }
  const next = { ...current, ...sanitized };
  const settings = readRawSettings();
  writeRawSettings({
    ...settings,
    skills: next,
  });
  return next;
}

export function readHarnessProfileSetting(): HarnessProfileId {
  const settings = readRawSettings();
  return isHarnessProfileId(settings.harnessProfile) ? settings.harnessProfile : defaultHarnessProfileId;
}

export function writeHarnessProfileSetting(profileId: HarnessProfileId): HarnessProfileId {
  const next = isHarnessProfileId(profileId) ? profileId : defaultHarnessProfileId;
  const settings = readRawSettings();
  writeRawSettings({
    ...settings,
    harnessProfile: next,
  });
  return next;
}

export function readContextLengthSetting(): number {
  return normalizeContextLength(readRawSettings().contextLength ?? DEFAULT_CONTEXT_LENGTH);
}

export function writeContextLengthSetting(value: unknown): number {
  const contextLength = normalizeContextLength(value);
  const settings = readRawSettings();
  writeRawSettings({
    ...settings,
    contextLength,
  });
  return contextLength;
}

export function readPermissionModeSetting(): PermissionMode {
  return readRawSettings().permissionMode === "auto_safe" ? "auto_safe" : "normal";
}

export function readStartupSettings(): DesktopStartupSettings {
  const settings = readRawSettings();
  const endpoint = modelEndpointSettings(settings);
  return {
    permissionMode: settings.permissionMode === "auto_safe" ? "auto_safe" : "normal",
    modelEndpoint: publicModelEndpointSettings(endpoint),
    localModels: endpoint.mode === "local"
      ? Array.from(new Set([endpoint.modelId, ...cachedLocalModels(settings, endpoint.baseUrl)].filter(Boolean)))
      : [],
    companyConnection: companyConnectionStatusFromValue(settings.companyCredential),
    harnessProfile: isHarnessProfileId(settings.harnessProfile) ? settings.harnessProfile : defaultHarnessProfileId,
    contextLength: normalizeContextLength(settings.contextLength ?? DEFAULT_CONTEXT_LENGTH),
  };
}

export function writePermissionModeSetting(value: unknown): PermissionMode {
  const permissionMode: PermissionMode = value === "auto_safe" ? "auto_safe" : "normal";
  const settings = readRawSettings();
  writeRawSettings({
    ...settings,
    permissionMode,
  });
  return permissionMode;
}

export function readNotes(): UserNotes {
  const notes = withAppDatabase((db) => db.prepare("SELECT content, updated_at FROM notes WHERE id = ?").get(userNotesId) as NoteRow | undefined);
  return {
    content: typeof notes?.content === "string" ? notes.content : "",
    updatedAt: typeof notes?.updated_at === "string" ? notes.updated_at : "",
  };
}

export function writeNotes(content: string): UserNotes {
  const notes = {
    content,
    updatedAt: new Date().toISOString(),
  };
  withAppDatabase((db) => {
    db.prepare("INSERT OR REPLACE INTO notes (id, content, updated_at) VALUES (?, ?, ?)").run(userNotesId, notes.content, notes.updatedAt);
  });
  return notes;
}
