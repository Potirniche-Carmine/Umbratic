import { useEffect, useRef, useState } from "react";
import { Check, Cloud, Loader2, Monitor, RefreshCw } from "lucide-react";
import type {
  BackendStatus,
  CompanyConnectionStatus,
  DesktopApi,
  ModelEndpointMode,
} from "../shared/desktopApi";
import { CompanyServerActions } from "./CompanyServerActions";
import { LocalModelPicker, type LocalModelDiscoveryStatus } from "./LocalModelPicker";
import {
  defaultEndpointBaseUrlForMode,
  defaultModelEndpointSettings,
  endpointDefaultsForMode,
  endpointValidationMessage,
  normalizeEndpointSettings,
  type ModelEndpointSettings,
} from "./endpointSettings";

type ConnectionSettingsOptions = {
  api: DesktopApi;
  backend: BackendStatus | null;
  initialSettings: ModelEndpointSettings;
  initialConnection: CompanyConnectionStatus;
  settingsOpen: boolean;
  active: boolean;
  onBackendStatus: (status: BackendStatus) => void;
};

export function useConnectionSettings({
  api,
  backend,
  initialSettings,
  initialConnection,
  settingsOpen,
  active,
  onBackendStatus,
}: ConnectionSettingsOptions) {
  const normalizedInitialSettings = useRef(normalizeEndpointSettings(initialSettings)).current;
  const [settings, setSettings] = useState<ModelEndpointSettings>(normalizedInitialSettings);
  const [draft, setDraft] = useState<ModelEndpointSettings>(normalizedInitialSettings);
  const [companyConnection, setCompanyConnection] = useState<CompanyConnectionStatus>(initialConnection);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [localModelDiscovery, setLocalModelDiscovery] = useState<{
    baseUrl: string;
    models: string[];
    status: LocalModelDiscoveryStatus;
  }>({ baseUrl: "", models: [], status: "idle" });
  const saveSequenceRef = useRef(0);
  const modeLoadSequenceRef = useRef(0);
  const modeDraftsRef = useRef<Partial<Record<ModelEndpointMode, ModelEndpointSettings>>>({
    [normalizedInitialSettings.mode]: normalizedInitialSettings,
  });

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const companyEnrollmentRequired =
    draft.mode === "server"
    && (companyConnection.state !== "enrolled" || draft.baseUrl.trim() !== companyConnection.baseUrl);
  const companyServerConnected =
    draft.mode === "server"
    && companyConnection.state === "enrolled"
    && !companyEnrollmentRequired;
  const companyServerActive = companyServerConnected && settings.mode === "server" && !dirty;
  const validation =
    endpointValidationMessage(draft)
    ?? (companyEnrollmentRequired && !draft.secret.trim() ? "Enter the Enrollment code." : null);
  const editingEnabled = backend?.endpointConfig.endpointEditingAllowed ?? true;
  const formDisabled = saving || !editingEnabled;
  const localRuntimeUrlValid = endpointValidationMessage({ ...draft, modelId: "__probe__" }) === null;
  const localModelDiscoveryCurrent =
    localModelDiscovery.baseUrl === draft.baseUrl.trim().replace(/\/+$/, "");
  const localModelStatus = refreshing && draft.mode === "local"
    ? "loading"
    : localModelDiscoveryCurrent ? localModelDiscovery.status : "idle";
  const localModels = localModelDiscoveryCurrent ? localModelDiscovery.models : [];
  const refreshDisabled = refreshing || saving || (draft.mode === "server" ? dirty : !localRuntimeUrlValid);
  const displayState = backend?.endpoint === "degraded" ? "ready" : backend?.endpoint ?? "checking";
  const statusLabel =
    backend?.endpoint === "ready" || backend?.endpoint === "degraded"
      ? "Connected"
      : backend ? "Unavailable" : "Checking";

  useEffect(() => {
    if (!settingsOpen || !active) return;
    let current = true;
    void api.getCompanyConnectionStatus().then((connection) => {
      if (current) setCompanyConnection(connection);
    });
    return () => {
      current = false;
    };
  }, [active, api, settingsOpen]);

  function updateDraft(patch: Partial<ModelEndpointSettings>) {
    saveSequenceRef.current += 1;
    setSaving(false);
    setRefreshing(false);
    setDraft((current) => {
      if ("mode" in patch) {
        const mode = patch.mode === "server" ? "server" : "local";
        modeDraftsRef.current[current.mode] = current;
        const defaults = endpointDefaultsForMode(mode);
        const next = modeDraftsRef.current[mode]
          ?? (mode === "server" && companyConnection.baseUrl
            ? { ...defaults, baseUrl: companyConnection.baseUrl }
            : defaults);
        modeDraftsRef.current[mode] = next;
        return next;
      }
      let next = normalizeEndpointSettings({ ...current, ...patch });
      if ("software" in patch && current.mode === "local") {
        const wasDefault = current.baseUrl === defaultEndpointBaseUrlForMode("local", current.software);
        if (wasDefault) next = { ...next, baseUrl: defaultEndpointBaseUrlForMode("local", next.software) };
      }
      modeDraftsRef.current[next.mode] = next;
      return next;
    });
    setMessage(null);
  }

  async function selectMode(mode: ModelEndpointMode) {
    const cached = modeDraftsRef.current[mode];
    updateDraft({ mode });
    if (cached) return;
    const requestId = modeLoadSequenceRef.current + 1;
    modeLoadSequenceRef.current = requestId;
    try {
      const saved = normalizeEndpointSettings(await api.getModelEndpointSettings({ mode }));
      if (requestId !== modeLoadSequenceRef.current || saved.mode !== mode) return;
      modeDraftsRef.current[mode] = saved;
      setDraft((current) => current.mode === mode ? saved : current);
    } catch {
      // The mode defaults remain usable when stored settings cannot be read.
    }
  }

  function resetDraft() {
    saveSequenceRef.current += 1;
    setSaving(false);
    setRefreshing(false);
    setDraft(settings);
    setMessage(null);
    modeDraftsRef.current = { [settings.mode]: settings };
  }

  async function refresh() {
    if (refreshDisabled) return;
    const requestId = saveSequenceRef.current + 1;
    saveSequenceRef.current = requestId;
    const startedAt = Date.now();
    const localMode = draft.mode === "local";
    const probeBaseUrl = draft.baseUrl.trim().replace(/\/+$/, "");
    setRefreshing(true);
    if (localMode) setLocalModelDiscovery({ baseUrl: probeBaseUrl, models: [], status: "loading" });
    setMessage(null);
    try {
      const [status, modelProbe] = await Promise.all([
        dirty ? Promise.resolve(null) : api.getBackendStatus(),
        localMode
          ? api.probeLocalModels({ baseUrl: probeBaseUrl }).catch(() => ({ status: "unavailable" as const, models: [] as [] }))
          : Promise.resolve(null),
      ]);
      const remainingAnimationMs = Math.max(0, 300 - (Date.now() - startedAt));
      if (remainingAnimationMs > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, remainingAnimationMs));
      }
      if (requestId !== saveSequenceRef.current) return;
      if (status) onBackendStatus(status);
      if (modelProbe) setLocalModelDiscovery({ baseUrl: probeBaseUrl, ...modelProbe });
    } catch (cause) {
      if (requestId === saveSequenceRef.current) {
        setMessage(String(cause instanceof Error ? cause.message : cause));
      }
    } finally {
      if (requestId === saveSequenceRef.current) setRefreshing(false);
    }
  }

  async function save() {
    if (saving || refreshing || !dirty || !editingEnabled) return;
    if (validation) {
      setMessage(validation);
      return;
    }
    const requestId = saveSequenceRef.current + 1;
    saveSequenceRef.current = requestId;
    const nextDraft = normalizeEndpointSettings({
      ...draft,
      headers: draft.mode === "local" ? defaultModelEndpointSettings.headers : draft.headers,
    });
    setSaving(true);
    setMessage(null);
    if (nextDraft.mode === "server" && nextDraft.secret) setDraft({ ...nextDraft, secret: "" });
    try {
      const result =
        nextDraft.mode === "server" && companyEnrollmentRequired
          ? await api.enrollCompanyConnection({
              baseUrl: nextDraft.baseUrl,
              enrollmentCode: nextDraft.secret,
            })
          : await api.saveModelEndpointSettings(nextDraft);
      if (requestId !== saveSequenceRef.current) return;
      const normalized = normalizeEndpointSettings(result.settings);
      if ("connection" in result) setCompanyConnection(result.connection as CompanyConnectionStatus);
      setSettings(normalized);
      setDraft(normalized);
      onBackendStatus(result.status);
      modeDraftsRef.current[normalized.mode] = normalized;
    } catch (cause) {
      if (requestId === saveSequenceRef.current) {
        setMessage(String(cause instanceof Error ? cause.message : cause));
      }
    } finally {
      if (requestId === saveSequenceRef.current) setSaving(false);
    }
  }

  async function disconnect() {
    if (saving || refreshing) return;
    setSaving(true);
    setMessage(null);
    try {
      const result = await api.disconnectCompanyConnection();
      const normalized = normalizeEndpointSettings(result.settings);
      setCompanyConnection(result.connection);
      setSettings(normalized);
      setDraft(normalized);
      onBackendStatus(result.status);
      modeDraftsRef.current = { [normalized.mode]: normalized };
    } catch (cause) {
      setMessage(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setSaving(false);
    }
  }

  return {
    settings,
    draft,
    companyConnection,
    saving,
    refreshing,
    message,
    dirty,
    companyServerConnected,
    companyServerActive,
    validation,
    editingEnabled,
    formDisabled,
    localRuntimeUrlValid,
    localModelStatus,
    localModels,
    refreshDisabled,
    displayState,
    statusLabel,
    updateDraft,
    selectMode,
    clearMessage: () => setMessage(null),
    resetDraft,
    refresh,
    save,
    disconnect,
  };
}

export type ConnectionSettingsController = ReturnType<typeof useConnectionSettings>;

export function ConnectionSettingsPanel({ controller }: { controller: ConnectionSettingsController }) {
  const {
    draft,
    companyConnection,
    saving,
    refreshing,
    message,
    dirty,
    companyServerConnected,
    companyServerActive,
    validation,
    editingEnabled,
    formDisabled,
    localRuntimeUrlValid,
    localModelStatus,
    localModels,
    refreshDisabled,
    displayState,
    statusLabel,
  } = controller;

  return (
    <div className="settingsPanel">
      <div className="settingsPanelHead connectionPanelHead">
        <div>
          <h3>Connection</h3>
          <p>Use Local or connect this device to a company server.</p>
        </div>
        <div className="connectionCompactStatus">
          <span
            className={`serverHealthText ${displayState}`}
            role="status"
            aria-label={statusLabel}
            title={statusLabel}
          >
            <span className="serverStatusDot" aria-hidden="true" />
          </span>
          <button
            className="settingsIconButton connectionRefreshButton"
            type="button"
            onClick={() => void controller.refresh()}
            disabled={refreshDisabled}
            title={draft.mode === "local"
              ? localRuntimeUrlValid ? "Check runtime and models" : "Enter a valid local runtime URL"
              : dirty ? "Save changes before checking" : "Check connection"}
            aria-label={draft.mode === "local" ? "Check runtime and models" : "Check connection"}
          >
            <RefreshCw className={refreshing ? "spin" : ""} size={14} />
          </button>
        </div>
      </div>

      <div className="settingsGroup">
        <h4>Run mode</h4>
        <div className="connectionModeGrid" aria-label="Model connection type">
          <button
            className={draft.mode === "local" ? "isActive" : ""}
            type="button"
            disabled={formDisabled}
            aria-pressed={draft.mode === "local"}
            onClick={() => void controller.selectMode("local")}
          >
            <span className="connectionModeIcon"><Monitor size={16} /></span>
            <strong>Local</strong>
            {draft.mode === "local" ? <Check size={14} /> : null}
          </button>
          <button
            className={draft.mode === "server" ? "isActive" : ""}
            type="button"
            disabled={formDisabled}
            aria-pressed={draft.mode === "server"}
            onClick={() => void controller.selectMode("server")}
          >
            <span className="connectionModeIcon"><Cloud size={16} /></span>
            <strong>Company server</strong>
            {draft.mode === "server" ? <Check size={14} /> : null}
          </button>
        </div>
      </div>

      <div className="settingsGroup">
        <h4>{draft.mode === "local" ? "Local model" : "Company server"}</h4>
        {draft.mode === "local" ? (
          <>
            <label className="settingsField">
              <span>Ollama URL</span>
              <input
                value={draft.baseUrl}
                disabled={formDisabled}
                onChange={(event) => controller.updateDraft({ baseUrl: event.currentTarget.value })}
                placeholder="http://127.0.0.1:11434"
                spellCheck={false}
              />
            </label>
            <LocalModelPicker
              disabled={formDisabled}
              models={localModels}
              selectedModel={draft.modelId}
              status={localModelStatus}
              onModelChange={(modelId) => controller.updateDraft({ modelId })}
            />
          </>
        ) : companyServerConnected && companyConnection.state === "enrolled" ? (
          <div className="companyEnrollmentStatus">
            <div className="companyEnrollmentIdentity">
              <strong>{companyConnection.orgName}</strong>
              <span>{companyConnection.deviceLabel}</span>
            </div>
            <CompanyServerActions
              active={companyServerActive}
              busy={formDisabled}
              connectDisabled={saving || refreshing || !dirty || !!validation || !editingEnabled}
              onConnect={() => void controller.save()}
              onUnregister={() => void controller.disconnect()}
            />
          </div>
        ) : (
          <>
            <label className="settingsField">
              <span>Veil server URL</span>
              <input
                value={draft.baseUrl}
                disabled={formDisabled}
                onChange={(event) => controller.updateDraft({ baseUrl: event.currentTarget.value })}
                placeholder="https://veil.example.com"
                spellCheck={false}
              />
            </label>
            <label className="settingsField">
              <span>Enrollment code</span>
              <input
                value={draft.secret}
                disabled={formDisabled}
                onChange={(event) => controller.updateDraft({ secret: event.currentTarget.value })}
                placeholder="Enrollment code"
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label="Enrollment code"
              />
            </label>
          </>
        )}
        {!companyServerConnected ? (
          <div className="connectionActions">
            <button
              className="settingsInlineButton connectionSaveButton"
              type="button"
              onClick={() => void controller.save()}
              disabled={saving || refreshing || !dirty || !!validation || !editingEnabled}
            >
              {saving ? <Loader2 className="spin" size={13} /> : <Check size={13} />}
              <span>{saving ? "Connecting" : "Save & connect"}</span>
            </button>
            {dirty ? <span className="connectionUnsaved">Unsaved changes</span> : null}
          </div>
        ) : null}
        <div className="connectionFeedback" aria-live="polite">
          {!editingEnabled ? <p className="settingsMessage">This connection is managed by your organization.</p> : null}
          {message ? <p className="settingsMessage">{message}</p> : null}
        </div>
      </div>
    </div>
  );
}
