import { useEffect, useRef, useState } from "react";
import { Check, Cloud, Loader2, Monitor, RefreshCw } from "lucide-react";
import type {
  BackendStatus,
  CompanyConnectionStatus,
  DesktopApi,
  ModelEndpointMode,
  ServerModelInfo,
} from "../shared/desktopApi";
import { CompanyServerActions } from "./CompanyServerActions";
import { Combobox } from "./Combobox";
import { contextBadge } from "./ComposerControls";
import { CustomModelAdd, LocalModelFolder, LocalModelMenu, useLocalModelCatalog } from "./LocalModelList";
import {
  defaultModelEndpointSettings,
  endpointDefaultsForMode,
  endpointValidationMessage,
  normalizeEndpointSettings,
  type ModelEndpointSettings,
} from "./endpointSettings";

/** How far a model list has got. The picker is often the only place a runtime's
 * state is reported, so each state names what happened. */
type ModelDiscoveryStatus = "idle" | "loading" | "ready" | "unavailable";

function modelPlaceholder(
  status: ModelDiscoveryStatus,
  count: number,
  texts: { loading: string; unavailable: string; empty: string },
): string {
  if (status === "loading") return texts.loading;
  if (status === "unavailable") return texts.unavailable;
  return count > 0 ? "Choose a model" : texts.empty;
}

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
  const [saveFeedback, setSaveFeedback] = useState<"idle" | "saved">("idle");
  const [companyAction, setCompanyAction] = useState<"connect" | "disconnect" | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // True while a picked model's weights are loading, so the model card can say
  // so. Counted, not boolean: a quick second pick must not clear the first
  // pick's indicator early.
  const [localModelLoading, setLocalModelLoading] = useState(false);
  const [localModelUnloading, setLocalModelUnloading] = useState(false);
  const localLoadCountRef = useRef(0);
  const [message, setMessage] = useState<string | null>(null);
  const localCatalog = useLocalModelCatalog(api, "chat", settingsOpen && active);
  // What the connected Veil publishes. Empty on a server too old to publish a
  // registry, which is the same state as "not connected yet" — both mean there
  // is no choice to offer here.
  const [serverModels, setServerModels] = useState<ServerModelInfo[]>([]);
  const [serverModelStatus, setServerModelStatus] = useState<ModelDiscoveryStatus>("idle");
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
  const companyServerActive =
    companyServerConnected
    && settings.mode === "server"
    && !dirty
    && backend?.endpoint === "ready";
  const validation =
    endpointValidationMessage(draft)
    ?? (companyEnrollmentRequired && !draft.secret.trim() ? "Enter the Enrollment code." : null);
  const editingEnabled = backend?.endpointConfig.endpointEditingAllowed ?? true;
  const formDisabled = !editingEnabled;
  const refreshDisabled = refreshing || saving || (draft.mode === "server" && dirty);
  // Local mode with nothing loaded is a resting state, not a failure: the
  // backend leaves the provider message empty for it, and the panel shows a
  // quiet "Not loaded" instead of an alarmed "Unavailable".
  const notLoaded =
    draft.mode === "local"
    && backend?.endpoint === "unavailable"
    && !backend.providers[0]?.message;
  const displayState = notLoaded ? "idle" : backend?.endpoint === "degraded" ? "ready" : backend?.endpoint ?? "checking";
  const statusLabel =
    backend?.endpoint === "ready" || backend?.endpoint === "degraded"
      ? "Connected"
      : notLoaded ? "Not loaded" : backend ? "Unavailable" : "Checking";

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

  // Server mode asks the server, for the same reason local mode probes the
  // runtime: a list the user has to press refresh to see is a list they will
  // assume is empty.
  useEffect(() => {
    if (!settingsOpen || !active || draft.mode !== "server") {
      setServerModelStatus("idle");
      return;
    }
    let current = true;
    setServerModelStatus("loading");
    void api.listServerModels().then(
      (published) => {
        if (!current) return;
        setServerModels(published);
        setServerModelStatus(published.length > 0 ? "ready" : "unavailable");
      },
      () => {
        if (!current) return;
        setServerModels([]);
        setServerModelStatus("unavailable");
      },
    );
    return () => {
      current = false;
    };
  }, [active, api, draft.mode, settingsOpen]);

  function updateDraft(patch: Partial<ModelEndpointSettings>) {
    saveSequenceRef.current += 1;
    setSaving(false);
    setSaveFeedback("idle");
    setCompanyAction(null);
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
      const next = normalizeEndpointSettings({ ...current, ...patch });
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
    setSaveFeedback("idle");
    setCompanyAction(null);
    setRefreshing(false);
    setDraft(settings);
    setMessage(null);
    modeDraftsRef.current = { [settings.mode]: settings };
  }

  // In local mode there is nothing to confirm: no URL, no secret, no headers.
  // Choosing a downloaded model is the whole decision, so choosing it saves it,
  // which restarts llama-server on the new weights.
  //
  // Returns the failure, if there was one, as well as showing it here: the
  // composer's picker calls this too, and a failure raised while the settings
  // panel is closed would otherwise be reported to nobody.
  async function selectLocalModel(modelId: string): Promise<string | null> {
    // Re-picking the model that is already shown is not a settings change: if
    // it is running there is nothing to do, and if it is not, this is the ask
    // to load it — without restarting anything else.
    if (modelId === draft.modelId && modelId === settings.modelId) {
      if (backend?.endpoint === "ready" || backend?.endpoint === "degraded") return null;
      const requestId = saveSequenceRef.current + 1;
      saveSequenceRef.current = requestId;
      setMessage(null);
      localLoadCountRef.current += 1;
      setLocalModelLoading(true);
      try {
        const result = await api.loadLocalModel();
        if (requestId === saveSequenceRef.current) onBackendStatus(result.status);
      } catch (cause) {
        const failure = String(cause instanceof Error ? cause.message : cause);
        if (requestId === saveSequenceRef.current) setMessage(failure);
        return failure;
      } finally {
        localLoadCountRef.current -= 1;
        if (localLoadCountRef.current === 0) setLocalModelLoading(false);
      }
      return null;
    }
    const next = normalizeEndpointSettings({
      ...(modeDraftsRef.current.local ?? draft),
      modelId,
      headers: defaultModelEndpointSettings.headers,
      secret: "",
    });
    const invalid = endpointValidationMessage(next);
    if (invalid) return invalid;
    const requestId = saveSequenceRef.current + 1;
    saveSequenceRef.current = requestId;
    const previous = settings;
    setSettings(next);
    setDraft(next);
    modeDraftsRef.current.local = next;
    setSaveFeedback("saved");
    setMessage(null);
    localLoadCountRef.current += 1;
    setLocalModelLoading(true);
    try {
      const result = await api.saveModelEndpointSettings(next);
      if (requestId !== saveSequenceRef.current) return null;
      const normalized = normalizeEndpointSettings(result.settings);
      setSettings(normalized);
      setDraft(normalized);
      modeDraftsRef.current.local = normalized;
      onBackendStatus(result.status);
    } catch (cause) {
      const failure = String(cause instanceof Error ? cause.message : cause);
      if (requestId !== saveSequenceRef.current) return failure;
      setSettings(previous);
      setDraft(previous);
      modeDraftsRef.current.local = previous;
      setSaveFeedback("idle");
      setMessage(failure);
      return failure;
    } finally {
      localLoadCountRef.current -= 1;
      if (localLoadCountRef.current === 0) setLocalModelLoading(false);
    }
    return null;
  }
  /**
   * Gives the weights back. The counterpart of picking a model, and the only
   * way short of quitting to reclaim the gigabytes a resident model holds.
   */
  async function unloadLocalModel() {
    const requestId = saveSequenceRef.current + 1;
    saveSequenceRef.current = requestId;
    setMessage(null);
    // Its own flag rather than the loading one: a trigger that reads "Loading"
    // while the model is being released says the opposite of what is happening.
    setLocalModelUnloading(true);
    try {
      const result = await api.unloadLocalModel();
      if (requestId === saveSequenceRef.current) onBackendStatus(result.status);
    } catch (cause) {
      if (requestId === saveSequenceRef.current) {
        setMessage(String(cause instanceof Error ? cause.message : cause));
      }
    } finally {
      if (requestId === saveSequenceRef.current) setLocalModelUnloading(false);
    }
  }

  // In local mode this is the manual load: the one action that starts the
  // model stack outside of picking a model or sending a prompt. Server mode
  // keeps it as a plain re-check.
  async function refresh() {
    if (refreshDisabled) return;
    const requestId = saveSequenceRef.current + 1;
    saveSequenceRef.current = requestId;
    setRefreshing(true);
    setMessage(null);
    try {
      if (draft.mode === "local") await localCatalog.reload();
      const status = dirty
        ? null
        : draft.mode === "local"
          ? (await api.loadLocalModel()).status
          : await api.getBackendStatus();
      if (requestId !== saveSequenceRef.current) return;
      if (status) onBackendStatus(status);
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
    const previousSettings = settings;
    const previousDraft = draft;
    const optimisticLocalSettings = nextDraft.mode === "local"
      ? { ...nextDraft, secret: "" }
      : null;
    const feedbackStartedAt = Date.now();
    setSaving(true);
    setSaveFeedback(optimisticLocalSettings ? "saved" : "idle");
    setCompanyAction(nextDraft.mode === "server" ? "connect" : null);
    setMessage(null);
    if (optimisticLocalSettings) {
      setSettings(optimisticLocalSettings);
      setDraft(optimisticLocalSettings);
      modeDraftsRef.current.local = optimisticLocalSettings;
    }
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
        setSaveFeedback("idle");
        if (optimisticLocalSettings) {
          setSettings(previousSettings);
          setDraft(previousDraft);
          modeDraftsRef.current[previousSettings.mode] = previousSettings;
          modeDraftsRef.current[previousDraft.mode] = previousDraft;
        }
        setMessage(String(cause instanceof Error ? cause.message : cause));
      }
    } finally {
      if (requestId === saveSequenceRef.current) {
        const remainingFeedbackMs = Math.max(0, 500 - (Date.now() - feedbackStartedAt));
        if (remainingFeedbackMs > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, remainingFeedbackMs));
        }
        if (requestId === saveSequenceRef.current) {
          setSaving(false);
          setSaveFeedback("idle");
          setCompanyAction(null);
        }
      }
    }
  }

  async function connect() {
    if (saving || refreshing || !editingEnabled) return;
    setSaving(true);
    setCompanyAction("connect");
    setMessage(null);
    try {
      const result = await api.connectCompanyConnection();
      const normalized = normalizeEndpointSettings(result.settings);
      setCompanyConnection(result.connection);
      setSettings(normalized);
      setDraft(normalized);
      onBackendStatus(result.status);
      modeDraftsRef.current.server = normalized;
    } catch (cause) {
      setMessage(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setSaving(false);
      setCompanyAction(null);
    }
  }

  async function disconnectSession() {
    if (saving || refreshing) return;
    setSaving(true);
    setCompanyAction("disconnect");
    setMessage(null);
    try {
      const result = await api.disconnectCompanySession();
      setCompanyConnection(result.connection);
      onBackendStatus(result.status);
    } catch (cause) {
      setMessage(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setSaving(false);
      setCompanyAction(null);
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

  async function refreshServerModels() {
    setServerModelStatus("loading");
    try {
      const published = await api.listServerModels();
      setServerModels(published);
      setServerModelStatus(published.length > 0 ? "ready" : "unavailable");
    } catch {
      setServerModels([]);
      setServerModelStatus("unavailable");
    }
  }

  /**
   * Picking a server model is a settings write like any other, not a
   * connection change: the enrollment, the URL, and the session all stay.
   *
   * Returns the failure the same way `selectLocalModel` does, and for the same
   * reason — the composer's picker shares this path.
   */
  async function selectServerModel(modelId: string): Promise<string | null> {
    const next = normalizeEndpointSettings({
      ...(modeDraftsRef.current.server ?? draft),
      modelId,
    });
    const requestId = saveSequenceRef.current + 1;
    saveSequenceRef.current = requestId;
    const previous = settings;
    setSettings(next);
    setDraft(next);
    modeDraftsRef.current.server = next;
    setMessage(null);
    try {
      const result = await api.saveModelEndpointSettings(next);
      if (requestId !== saveSequenceRef.current) return null;
      const normalized = normalizeEndpointSettings(result.settings);
      setSettings(normalized);
      setDraft(normalized);
      modeDraftsRef.current.server = normalized;
      onBackendStatus(result.status);
    } catch (cause) {
      const failure = String(cause instanceof Error ? cause.message : cause);
      if (requestId !== saveSequenceRef.current) return failure;
      setSettings(previous);
      setDraft(previous);
      modeDraftsRef.current.server = previous;
      setMessage(failure);
      return failure;
    }
    return null;
  }

  return {
    api,
    backend,
    settings,
    draft,
    serverModels,
    serverModelStatus,
    refreshServerModels,
    selectServerModel,
    companyConnection,
    saving,
    saveFeedback,
    companyAction,
    refreshing,
    localModelLoading,
    localModelUnloading,
    message,
    dirty,
    companyServerConnected,
    companyServerActive,
    validation,
    editingEnabled,
    formDisabled,
    localCatalog,
    refreshDisabled,
    displayState,
    statusLabel,
    updateDraft,
    selectLocalModel,
    unloadLocalModel,
    selectMode,
    clearMessage: () => setMessage(null),
    resetDraft,
    refresh,
    save,
    connect,
    disconnectSession,
    disconnect,
  };
}

export type ConnectionSettingsController = ReturnType<typeof useConnectionSettings>;

export function ConnectionSettingsPanel({ controller }: { controller: ConnectionSettingsController }) {
  const {
    backend,
    draft,
    companyConnection,
    saving,
    saveFeedback,
    companyAction,
    refreshing,
    localModelLoading,
    localModelUnloading,
    message,
    dirty,
    companyServerConnected,
    companyServerActive,
    validation,
    editingEnabled,
    formDisabled,
    localCatalog,
    serverModels,
    serverModelStatus,
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
          >
            <span className="serverStatusDot" aria-hidden="true" />
            <span className="serverHealthLabel">
              {refreshing ? draft.mode === "local" ? "Loading model…" : "Checking" : statusLabel}
            </span>
          </span>
          <button
            className="settingsIconButton"
            type="button"
            onClick={() => void controller.refresh()}
            disabled={refreshDisabled}
            title={dirty && draft.mode === "server"
              ? "Save changes before checking"
              : draft.mode === "local" ? "Load the model and check again" : "Check again"}
            aria-label={draft.mode === "local" ? "Load the model and check again" : "Check again"}
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
        <h4>{draft.mode === "local" ? "Local collection" : "Company server"}</h4>
        {draft.mode === "local" ? (
          <>
            <LocalModelMenu
              label="Model"
              models={localCatalog.models}
              progress={localCatalog.progress}
              selectedId={draft.modelId}
              disabled={formDisabled || localModelUnloading}
              loading={localModelLoading || refreshing}
              loaded={backend?.endpoint === "ready" || backend?.endpoint === "degraded"}
              placeholder="Choose or download a model"
              onSelect={(modelId) => void controller.selectLocalModel(modelId)}
              onDownload={(modelId) => void localCatalog.download(modelId)}
              onCancel={(modelId) => void localCatalog.cancel(modelId)}
              onQuantChange={(modelId, quant) => void localCatalog.setQuant(modelId, quant)}
              onRemove={(modelId) => void localCatalog.removeCustom(modelId)}
              onUnload={() => void controller.unloadLocalModel()}
            />
            <CustomModelAdd disabled={formDisabled} onAdd={(reference) => localCatalog.addCustom(reference)} />
            {localCatalog.message ? <p className="settingsMessage">{localCatalog.message}</p> : null}
            <LocalModelFolder api={controller.api} />
          </>
        ) : companyServerConnected && companyConnection.state === "enrolled" ? (
          <div className="companyEnrollmentStatus">
            <div className="companyEnrollmentIdentity">
              <strong>{companyConnection.orgName}</strong>
              <span>{companyConnection.deviceLabel}</span>
            </div>
            {serverModels.length > 0 ? (
              <div className="connectionServerModelRow">
                <Combobox
                  label="Model"
                  disabled={formDisabled}
                  items={serverModels.map((model) => ({
                    id: model.id,
                    label: model.default ? `${model.display} (default)` : model.display,
                    available: model.available,
                    badge: contextBadge(model.contextLength),
                  }))}
                  selectedId={draft.modelId === "veil-managed" ? serverModels.find((model) => model.default)?.id ?? "" : draft.modelId}
                  placeholder={modelPlaceholder(serverModelStatus, serverModels.length, {
                    loading: "Asking the server…",
                    unavailable: "Model list unavailable on this server",
                    empty: "Model list unavailable on this server",
                  })}
                  onSelect={(modelId) => void controller.selectServerModel(modelId)}
                />
                <button
                  className="connectionModelRefresh"
                  type="button"
                  disabled={formDisabled || serverModelStatus === "loading"}
                  onClick={() => void controller.refreshServerModels()}
                  aria-label="Refresh model list"
                  title="Refresh model list"
                >
                  {serverModelStatus === "loading" ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
                </button>
              </div>
            ) : (
              <p className="connectionModelUnavailable">Model list unavailable on this server</p>
            )}
            <CompanyServerActions
              active={companyServerActive}
              busy={saving}
              busyAction={companyAction}
              connectDisabled={saving || refreshing || !editingEnabled}
              onConnect={() => void controller.connect()}
              onDisconnect={() => void controller.disconnectSession()}
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
        {!companyServerConnected && draft.mode === "server" ? (
          <div className="connectionActions">
            <button
              className={`settingsInlineButton connectionSaveButton ${saving || saveFeedback === "saved" ? "isSuccess" : ""}`}
              type="button"
              onClick={() => void controller.save()}
              disabled={saving || refreshing || !dirty || !!validation || !editingEnabled}
            >
              {saving ? <Loader2 className="spin" size={13} /> : <Check size={13} />}
              <span>{saving ? "Connecting" : "Save & connect"}</span>
            </button>
          </div>
        ) : null}
        <div className="connectionFeedback" aria-live="polite">
          {!editingEnabled ? <p className="settingsMessage">This connection is managed by your organization.</p> : null}
          {message ? <p className="settingsMessage">{message}</p> : null}
          {/* The runtime's own account of why it is not up. Without it the
              status dot says "Unavailable" and nothing says why. */}
          {!message && draft.mode === "local" && backend?.endpoint === "unavailable" && backend.providers[0]?.message
            ? <p className="settingsMessage">{backend.providers[0].message}</p>
            : null}
        </div>
      </div>

      {/* The machine's own capabilities only matter when the model runs on this
          machine; a company server brings its own hardware. */}
      {backend && draft.mode === "local" ? <DetectedSystem system={backend.system} /> : null}
    </div>
  );
}

/**
 * What the machine itself brings, independent of the selected model.
 *
 * Worth stating plainly: a driver that leaves the runtime on the processor is
 * invisible otherwise, and the user's only symptom is that answers are slow.
 */
function DetectedSystem({ system }: { system: BackendStatus["system"] }) {
  const quality = system.quality === "optimal"
    ? "Optimal"
    : system.quality === "good" ? "Good" : "CPU only";
  return (
    <p className="detectedSystem" title={system.acceleratorDevice ?? undefined}>
      <span className="detectedSystemLabel">Detected system</span>
      <span>{system.totalRamGB} GB RAM</span>
      <span aria-hidden="true">·</span>
      <span>{system.accelerator ?? "No GPU acceleration"}</span>
      <span className={`detectedSystemQuality is-${system.quality}`}>{quality}</span>
      {system.quality === "cpu" ? (
        <span className="detectedSystemHint">Updating your graphics driver may speed up responses.</span>
      ) : null}
    </p>
  );
}
