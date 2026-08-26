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
import { defaultToolSettings, enabledToolsFromSettings, isRunnerToolId, toolSettingsFromEnabledTools, webToolsEnabled } from "./toolSettings";
import { DEFAULT_CONTEXT_LENGTH, normalizeContextLength } from "../shared/contextWindow";
import { DEFAULT_REASONING_EFFORT, isReasoningEffort } from "../shared/desktopApi";
import type { DesktopStartupSettings, DictationSettings, KeyBindingSettings, ReasoningEffort } from "../shared/desktopApi";
import { assertCompanyCredentialStorageAvailable, companyConnectionStatusFromValue } from "./companyCredentialStorage";
import { decodeCompanyDeviceCredential, encodeCompanyDeviceCredential, readProtectedString, writeProtectedString } from "./companyCredentialStorage";
import type { CompanyDeviceCredential, StoredProtectedString } from "./companyCredentialStorage";
import { activeStoredEndpoint, endpointModesWithNext, storedEndpointForMode, type RawModelEndpointSettings } from "./endpointModeStorage";
import { parsePayload, withAppDatabase } from "./storageDatabase";
import { isRecord } from "./utils";
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
  reasoningEffort?: unknown;
  showThinking?: unknown;
  sendOnEnter?: unknown;
  localMtp?: unknown;
  permissionMode?: unknown;
  companyCredential?: unknown;
  dictation?: unknown;
  keybindings?: unknown;
  remoteConnections?: unknown;
  customModels?: unknown;
  localQuants?: unknown;
  automaticAppUpdates?: unknown;
  updateFeedToken?: unknown;
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
  // In server mode the stored id is the user's pick among the models the Veil
  // publishes. `veil-managed` is the sentinel for "whatever the server
  // defaults to" — it is never sent on the wire, it only means no pick.
  const storedModelId = typeof endpoint.modelId === "string" ? endpoint.modelId.trim() : "";
  const modelId =
    mode === "local"
      ? storedLocalEndpoint && storedModelId
        ? storedModelId
        : defaultLocalModelId
      : endpoint.mode === "server" && storedModelId
        ? storedModelId
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

/**
 * Forgets which local model was chosen, so every launch starts with none.
 *
 * A remembered pick is a model queued to load: the first prompt of the session
 * brings up gigabytes of weights nobody asked for that run. Choosing is cheap
 * and the collection is right there, so the session begins with the machine
 * idle and the user decides when that changes. The rest of the local endpoint —
 * mode, URL — is left alone; only the pick is per-session.
 */
export function clearLocalModelSelection(): void {
  const settings = readRawSettings();
  const local = settings.modelEndpoints?.local;
  if (!local || !local.modelId) return;
  writeRawSettings({
    ...settings,
    modelEndpoints: { ...settings.modelEndpoints, local: { ...local, modelId: "" } },
  });
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
      typeof input.modelId === "string"
        ? input.modelId.trim() || (nextMode === "local" ? defaultLocalModelId : defaultEndpointModelId)
        : current.mode === nextMode
          ? current.modelId
          : nextMode === "local"
            ? defaultLocalModelId
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

function toolSettingsFromRaw(settings: RawSettings): Record<RunnerToolId, boolean> {
  const rawTools = settings.tools && typeof settings.tools === "object" ? settings.tools : {};
  return {
    ...defaultToolSettings(),
    ...Object.fromEntries(
      Object.entries(rawTools).filter(([id, value]) => isRunnerToolId(id) && typeof value === "boolean"),
    ),
  } as Record<RunnerToolId, boolean>;
}

export function readToolSettings(): Record<RunnerToolId, boolean> {
  return toolSettingsFromRaw(readRawSettings());
}

export function writeWebToolsSetting(enabled: boolean): boolean {
  const next = writeToolSettings({ web_search: enabled, web_fetch: enabled });
  return webToolsEnabled(next);
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

/**
 * How hard a thinking model is asked to think.
 *
 * One setting for the app rather than one per model: only models that read an
 * effort are ever run at one, and a person who decided they want less thinking
 * meant it about their work, not about a particular set of weights.
 */
export function readReasoningEffortSetting(): ReasoningEffort {
  const stored = readRawSettings().reasoningEffort;
  return isReasoningEffort(stored) ? stored : DEFAULT_REASONING_EFFORT;
}

export function writeReasoningEffortSetting(value: unknown): ReasoningEffort {
  const reasoningEffort = isReasoningEffort(value) ? value : DEFAULT_REASONING_EFFORT;
  const settings = readRawSettings();
  writeRawSettings({
    ...settings,
    reasoningEffort,
  });
  return reasoningEffort;
}

/** Live thinking in Working. Absent or anything other than true is off. */
/**
 * Whether local models draft from their multi-token-prediction head. On unless
 * turned off: it is the same output faster on most machines, and the switch
 * exists for the ones where it is not.
 */
export function readLocalMtpSetting(): boolean {
  return readRawSettings().localMtp !== false;
}

export function writeLocalMtpSetting(value: unknown): boolean {
  const localMtp = value !== false;
  writeRawSettings({ ...readRawSettings(), localMtp });
  return localMtp;
}

// On unless switched off: the model's live thinking is part of the account of
// the work, and hiding it by default made the Working block a blank wait.
export function readShowThinkingSetting(): boolean {
  return readRawSettings().showThinking !== false;
}

export function writeShowThinkingSetting(value: unknown): boolean {
  const showThinking = value !== false;
  writeRawSettings({ ...readRawSettings(), showThinking });
  return showThinking;
}

export function readSendOnEnterSetting(): boolean {
  return readRawSettings().sendOnEnter !== false;
}

export function writeSendOnEnterSetting(value: unknown): boolean {
  const sendOnEnter = value !== false;
  writeRawSettings({ ...readRawSettings(), sendOnEnter });
  return sendOnEnter;
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

/**
 * Dictation is off until a model is chosen. "off" is a real stored value, not
 * an absent one: a user who turns dictation off has made a decision, and the
 * next release adding a default must not undo it.
 */
export function readDictationSettings(): DictationSettings {
  return normalizedDictationSettings(readRawSettings().dictation);
}

export function writeDictationSettings(value: unknown): DictationSettings {
  const dictation = normalizedDictationSettings(value);
  writeRawSettings({ ...readRawSettings(), dictation });
  return dictation;
}

function normalizedDictationSettings(value: unknown): DictationSettings {
  // English by default rather than automatic detection. A two-word utterance
  // carries little evidence of its language, and a confident transcript in the
  // wrong one is harder to notice than a missed word. Auto stays available for
  // anyone who switches languages.
  if (!isRecord(value)) return { model: "off", language: defaultDictationLanguage, deviceId: null };
  const model = value.model === "qwen3-asr-0.6b" || value.model === "qwen3-asr-1.7b" ? value.model : "off";
  // The chosen microphone, as the browser's own device id. Null is "whatever
  // the system calls default", which is also what a stored id that no longer
  // matches any device falls back to — the renderer checks that, because only
  // it can enumerate. Bounded here: it is an opaque string from an untrusted
  // surface, and nothing downstream should meet an unbounded one.
  const deviceId = typeof value.deviceId === "string" && value.deviceId.length > 0 && value.deviceId.length <= 256
    ? value.deviceId
    : null;
  // A language hint is a BCP-47-ish tag the runtime is given verbatim, so it is
  // bounded and character-restricted here rather than trusted. An explicitly
  // stored null means the user chose automatic detection and keeps it.
  if (value.language === null) return { model, language: null, deviceId };
  const language = typeof value.language === "string" && /^[A-Za-z]{2,8}(-[A-Za-z0-9]{2,8})*$/.test(value.language)
    ? value.language
    : defaultDictationLanguage;
  return { model, language, deviceId };
}

/** What dictation assumes it is hearing until someone says otherwise. */
export const defaultDictationLanguage = "en";

/**
 * How many rebound chords are kept.
 *
 * Comfortably more than the table has rows, and a ceiling all the same: the
 * record arrives from the renderer keyed by ids this process deliberately does
 * not know, so its size is the one thing that can be bounded here.
 */
const maxKeyBindings = 64;

/**
 * The chords the user changed.
 *
 * Only the differences are stored. Keeping the whole table would pin every
 * default to the version that wrote the file, so a release that moves one could
 * never move it for anybody who had opened the Keyboard page once.
 */
export function readKeyBindings(): KeyBindingSettings {
  return normalizedKeyBindings(readRawSettings().keybindings);
}

export function writeKeyBindings(value: unknown): KeyBindingSettings {
  const keybindings = normalizedKeyBindings(value);
  writeRawSettings({ ...readRawSettings(), keybindings });
  return keybindings;
}

function normalizedKeyBindings(value: unknown): KeyBindingSettings {
  if (!isRecord(value)) return {};
  const bindings: KeyBindingSettings = {};
  for (const [id, raw] of Object.entries(value)) {
    if (Object.keys(bindings).length >= maxKeyBindings) break;
    // The id names a shortcut in the renderer's table, which this process has no
    // copy of and no business having one of: what a chord *does* is a question
    // about the interface. Shape and size are what can be checked here, and an
    // id that no longer exists is dropped on the way back in rather than here.
    if (!/^[a-z][a-z.]{0,63}$/.test(id) || !isRecord(raw)) continue;
    // A key is one `event.key` value: a single character, or a name like
    // "Enter". Anything longer is not a key this app could ever match.
    if (typeof raw.key !== "string" || raw.key.length === 0 || raw.key.length > 20) continue;
    bindings[id] = {
      key: raw.key,
      ...(raw.primary === true ? { primary: true } : {}),
      ...(raw.shift === true ? { shift: true } : {}),
      ...(raw.alt === true ? { alt: true } : {}),
    };
  }
  return bindings;
}

/**
 * Whether the app checks downloads.umbratic.ai for a newer release on its own.
 * On until turned off: an installed app that never learns about a fix is the
 * worse default. Only an explicit `false` is off, so an older settings file
 * with nothing stored reads as on rather than as a choice nobody made.
 */
export function readAutomaticAppUpdatesSetting(): boolean {
  return readRawSettings().automaticAppUpdates !== false;
}

export function writeAutomaticAppUpdatesSetting(value: unknown): boolean {
  const automaticAppUpdates = value !== false;
  writeRawSettings({ ...readRawSettings(), automaticAppUpdates });
  return automaticAppUpdates;
}

/**
 * The token the company server minted for this device at its last session,
 * which the update feed accepts for thirty days. Stored so an app that is
 * checking for updates before it has reached Veil still has the last one, and
 * kept out of the renderer: nothing in the product shows or asks for it.
 */
export function readUpdateFeedTokenSetting(): string {
  const value = readRawSettings().updateFeedToken;
  return typeof value === "string" ? value : "";
}

export function writeUpdateFeedTokenSetting(value: string): void {
  if (!value || value === readUpdateFeedTokenSetting()) return;
  writeRawSettings({ ...readRawSettings(), updateFeedToken: value });
}

/**
 * How a stored permission mode reads, and what an absent one means.
 *
 * Absent means nobody has chosen, and the choice for anyone who has not
 * chosen is Auto: asking before every low-risk read is a question with one
 * sensible answer, and a first run spent clicking through it teaches the user
 * to approve without looking. Only an explicit "normal" turns it off, so a
 * user who did choose keeps their choice through this change.
 */
function permissionModeFromValue(value: unknown): PermissionMode {
  return value === "normal" ? "normal" : "auto_safe";
}

export function readPermissionModeSetting(): PermissionMode {
  return permissionModeFromValue(readRawSettings().permissionMode);
}

export function readStartupSettings(): DesktopStartupSettings {
  const settings = readRawSettings();
  const endpoint = modelEndpointSettings(settings);
  return {
    permissionMode: permissionModeFromValue(settings.permissionMode),
    modelEndpoint: publicModelEndpointSettings(endpoint),
    companyConnection: companyConnectionStatusFromValue(settings.companyCredential),
    harnessProfile: isHarnessProfileId(settings.harnessProfile) ? settings.harnessProfile : defaultHarnessProfileId,
    contextLength: normalizeContextLength(settings.contextLength ?? DEFAULT_CONTEXT_LENGTH),
    reasoningEffort: isReasoningEffort(settings.reasoningEffort) ? settings.reasoningEffort : DEFAULT_REASONING_EFFORT,
    showThinking: settings.showThinking !== false,
    sendOnEnter: settings.sendOnEnter !== false,
    webTools: webToolsEnabled(toolSettingsFromRaw(settings)),
  };
}

export function writePermissionModeSetting(value: unknown): PermissionMode {
  // Stricter than the read: an absent setting is nobody's choice and takes the
  // default, but an unrecognized *write* is a bug, and a bug should not be able
  // to elevate anything. It lands on "normal" and stays stored, which is also
  // what makes "normal" an explicit choice the read above will honour.
  const permissionMode: PermissionMode = value === "auto_safe" ? "auto_safe" : "normal";
  const settings = readRawSettings();
  writeRawSettings({
    ...settings,
    permissionMode,
  });
  return permissionMode;
}

/**
 * The stored remote-connection list, verbatim. Shape and secret handling belong
 * to `remoteConnections.ts`; this module only owns the settings blob.
 */
export function readStoredRemoteConnections(): unknown {
  return readRawSettings().remoteConnections;
}

export function writeStoredRemoteConnections(value: unknown): void {
  writeRawSettings({ ...readRawSettings(), remoteConnections: value });
}

/**
 * The stored custom-model list, verbatim. Shape and pinning belong to
 * `customModels.ts`; this module only owns the settings blob.
 */
export function readStoredCustomModels(): unknown {
  return readRawSettings().customModels;
}

export function writeStoredCustomModels(value: unknown): void {
  writeRawSettings({ ...readRawSettings(), customModels: value });
}

const quantPattern = /^[A-Z0-9][A-Z0-9_.-]{0,31}$/i;

/**
 * Which quantization each local model should download and run, keyed by model
 * id. Only deviations from a model's default are stored, so a later change to
 * a catalog default reaches everyone who never chose.
 */
export function readLocalQuantSelections(): Record<string, string> {
  const stored = readRawSettings().localQuants;
  if (!isRecord(stored)) return {};
  return Object.fromEntries(
    Object.entries(stored).filter(([id, quant]) =>
      /^[A-Za-z0-9][\w-]{0,160}$/.test(id) && typeof quant === "string" && quantPattern.test(quant),
    ),
  ) as Record<string, string>;
}

export function writeLocalQuantSelection(modelId: string, quant: string | null): Record<string, string> {
  const current = readLocalQuantSelections();
  const next = { ...current };
  if (quant === null) delete next[modelId];
  else if (quantPattern.test(quant)) next[modelId] = quant;
  writeRawSettings({ ...readRawSettings(), localQuants: next });
  return next;
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
