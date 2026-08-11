import { getMainWindow, getPermissionMode } from "./mainRuntime";
let telemetrySyncTimer: NodeJS.Timeout | null = null;

import { RunnerPromptPart, activeRunnerProcesses, recordProductTelemetry } from "./mainRuntime";
import {
  app,
  dialog,
  shell,
} from "electron";
import * as fs from "node:fs";
import * as path from "node:path";


import {
  endpointEditingAllowed,
  managedModelEndpointDefaults,
} from "./config";
import {
  probeLocalCapabilities,
} from "./capabilities";
import {
  runnerRequest,
  runnerBinaryPath,
  runnerDiagnosticsDirectory,
} from "./runnerAdapter";
import {
  umbraticPolicyVersion,
  umbraticRunnerContractVersion,
  umbraticRunnerName,
  umbraticRunnerVersion,
  companyEndpointProviderId,
  isLocalhostUrl,
  runtimeDiagnostics,
  telemetryPolicyForMode,
} from "./policy";
import {
  connectCompanySession,
  companyConnectionStatus,
  disconnectCompanyDevice,
  disconnectCompanySession,
  enrollCompanyDevice,
  ensureCompanySession,
} from "./companyIdentity";
import { companyTransportOptions, configuredEndpointModel, endpointProvider, normalizeBaseUrl } from "./endpointConfig";
import { fetchServerModels } from "./serverModels";
import { ensureLocalVeil, probeLocalModels as probeLocalRuntimeModels, stopLocalVeil } from "./localVeil";
import {
  hasStoredModelEndpointSettings,
  readContextLengthSetting,
  readLocalDiagnosticInfo,
  readLocalDiagnostics,
  readModelEndpointSettings,
  publicModelEndpointSettings,
  readProjects,
  readProductTelemetryEvents,
  readTask,
  readTasks,
  clearLocalDiagnostics,
  writeHarnessProfileSetting,
  writeCachedLocalModels,
  writeContextLengthSetting,
  writeModelEndpointSettings,
} from "./storage";
import { recordLocalDiagnostic } from "./diagnostics";
import { buildRedactedTelemetryBundle } from "./telemetry";
import {
  syncTelemetryBundle,
  telemetrySpoolDirectory,
  uploadTelemetrySpool,
} from "./telemetrySync";
import { checkEndpointHealth, telemetryUploadEndpoint } from "./modelEndpointRuntime";
import { connectedVeilFeatures, connectedVeilSupports, recordVeilFeatures, veilFeature } from "./veilFeatures";
import {
  getSkillDocument as getSkillDocumentService,
  importSkill as importSkillService,
  skillsDirectoryPath as skillsDirectoryPathService,
} from "./skills";
import type { ServerModelInfo } from "../shared/desktopApi";
import type {
  BackendStatus,
  CapabilityProbeReport,
  HarnessProfileId,
  LocalModelInfo,
  LocalModelProvider,
  LocalDiagnosticInfo,
  ReasoningMode,
  RunnerProcess,
  TelemetrySyncResult,
} from "./types";
import { isRecord, pathInside, requiredString } from "./utils";

export async function saveModelEndpointSettings(input: Partial<ReturnType<typeof readModelEndpointSettings>>) {
  if (activeRunnerProcesses.size > 0) {
    throw new Error("Wait for the active run to finish before changing the model connection.");
  }
  const current = readModelEndpointSettings();
  const candidate = { ...current, ...input };
  const baseUrl = typeof candidate.baseUrl === "string" ? candidate.baseUrl.trim() : "";
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new Error(`${candidate.mode === "local" ? "Runtime" : "Server"} URL is invalid.`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`${candidate.mode === "local" ? "Runtime" : "Server"} URL must use HTTP or HTTPS.`);
  }
  if (candidate.mode === "local" && !isLocalhostUrl(baseUrl)) {
    throw new Error("Local mode only connects to a model runtime on this computer. Use Server mode for remote infrastructure.");
  }
  if (candidate.mode === "local" && !candidate.modelId?.trim()) {
    throw new Error("Enter the local model name before connecting.");
  }
  if (candidate.mode === "server") {
    const connection = companyConnectionStatus();
    if (connection.state !== "enrolled" || normalizeBaseUrl(connection.baseUrl ?? "") !== normalizeBaseUrl(baseUrl)) {
      throw new Error("Use an Enrollment code to connect to a company server.");
    }
  }
  // The running local Veil was spawned for the previous settings. Stop it here
  // rather than relying on the next ensureLocalVeil to notice: switching to
  // Server mode never calls that path at all, and the stale process would keep
  // holding its port and its model.
  stopLocalVeil();
  const settings = writeModelEndpointSettings(candidate);
  const status = await getBackendStatus();
  return { settings: publicModelEndpointSettings(settings), status };
}

export async function submitSteeredRunnerTurn(
  run: RunnerProcess,
  sessionId: string,
  parts: RunnerPromptPart[],
  model: LocalModelInfo,
  reasoningMode?: ReasoningMode,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await runnerRequest<void>(run, `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        method: "POST",
        body: {
          model: { providerID: model.providerId, modelID: model.modelId },
          agent: "build",
          parts,
          ...(reasoningMode ? { reasoningMode } : {}),
        },
      });
      return;
    } catch (cause) {
      const message = String(cause instanceof Error ? cause.message : cause);
      if (attempt === 39 || !message.includes("409 Conflict")) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/**
 * The models the connected server-mode Veil publishes.
 *
 * Empty in local mode and on a server that does not advertise `models.list` —
 * the renderer reads an empty list as "no picker here", which is the honest
 * answer in both cases.
 */
export async function listServerModels(): Promise<ServerModelInfo[]> {
  if (readModelEndpointSettings().mode !== "server") return [];
  if (!connectedVeilSupports(veilFeature.modelsList)) return [];
  return fetchServerModels(endpointProvider());
}

export async function refreshLocalModels(baseUrl: string) {
  const result = await probeLocalRuntimeModels(baseUrl);
  return result.status === "ready"
    ? { ...result, models: writeCachedLocalModels(baseUrl, result.models) }
    : result;
}

export async function enrollCompanyConnection(input: unknown) {
  if (activeRunnerProcesses.size > 0) {
    throw new Error("Wait for the active run to finish before changing the company connection.");
  }
  if (!isRecord(input)) {
    throw new Error("Company connection details are invalid.");
  }
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
  const enrollmentCode = typeof input.enrollmentCode === "string" ? input.enrollmentCode : "";
  const label = typeof input.deviceLabel === "string" ? input.deviceLabel : undefined;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("Veil server URL is invalid.");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhostUrl(baseUrl))) {
    throw new Error("Remote Veil servers must use HTTPS.");
  }
  stopLocalVeil();
  await enrollCompanyDevice({ baseUrl, enrollmentCode, deviceLabel: label }, companyTransportOptions());
  const settings = writeModelEndpointSettings({
    mode: "server", baseUrl, modelId: "veil-managed", secret: "",
  });
  const status = await getBackendStatus();
  return { connection: companyConnectionStatus(), settings: publicModelEndpointSettings(settings), status };
}

export async function connectCompanyConnection() {
  if (activeRunnerProcesses.size > 0) {
    throw new Error("Wait for the active run to finish before connecting to the company server.");
  }
  const connection = companyConnectionStatus();
  if (connection.state !== "enrolled" || !connection.baseUrl) {
    throw new Error("Enroll this device before connecting to the company server.");
  }
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("The company server did not connect within 5 seconds. Try again."));
    }, 5000);
  });
  try {
    return await Promise.race([
      (async () => {
        await connectCompanySession({ ...companyTransportOptions(), signal: controller.signal });
        // Nothing routes to the local Veil once this succeeds.
        stopLocalVeil();
        const settings = writeModelEndpointSettings({
          mode: "server",
          baseUrl: connection.baseUrl,
          modelId: "veil-managed",
          secret: "",
        });
        const status = await getBackendStatus();
        if (status.endpoint !== "ready") {
          throw new Error(status.providers[0]?.message ?? "The company server is unavailable.");
        }
        return { connection: companyConnectionStatus(), settings: publicModelEndpointSettings(settings), status };
      })(),
      timedOut,
    ]);
  } catch (cause) {
    if (controller.signal.aborted) {
      await disconnectCompanySession(companyTransportOptions());
    }
    throw cause;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function disconnectCompanyServerSession() {
  if (activeRunnerProcesses.size > 0) {
    throw new Error("Wait for the active run to finish before disconnecting from the company server.");
  }
  await disconnectCompanySession(companyTransportOptions());
  const settings = revertToLocalMode();
  const status = await getBackendStatus();
  return { connection: companyConnectionStatus(), settings: publicModelEndpointSettings(settings), status };
}

export async function disconnectCompanyConnection() {
  if (activeRunnerProcesses.size > 0) {
    throw new Error("Wait for the active run to finish before disconnecting this device.");
  }
  await disconnectCompanyDevice(companyTransportOptions());
  const settings = revertToLocalMode();
  const status = await getBackendStatus();
  return { connection: companyConnectionStatus(), settings: publicModelEndpointSettings(settings), status };
}

/**
 * Disconnecting used to leave the app in Server mode pointing at a server it was
 * no longer allowed to call, so every subsequent run failed with a confusing
 * auth error. There is exactly one mode left that can work, so go there.
 */
function revertToLocalMode() {
  const current = readModelEndpointSettings();
  if (current.mode !== "server") return current;
  return writeModelEndpointSettings({ ...current, mode: "local", secret: "" });
}

export async function saveHarnessProfileSetting(input: unknown) {
  const settings = writeHarnessProfileSetting(input as HarnessProfileId);
  const status = await getBackendStatus();
  return { settings, status };
}

export async function saveContextLengthSetting(input: unknown) {
  if (activeRunnerProcesses.size > 0) {
    throw new Error("Wait for the active run to finish before changing the context length.");
  }
  const contextLength = writeContextLengthSetting(input);
  stopLocalVeil();
  const status = await getBackendStatus();
  return { contextLength, status };
}

export async function resolveSelectedModel(): Promise<{ providers: LocalModelProvider[]; models: LocalModelInfo[]; selected: LocalModelInfo | null }> {
  const settings = readModelEndpointSettings();
  try {
    if (settings.mode === "local") {
      await ensureLocalVeil(settings, readContextLengthSetting(), (diagnostic) => {
        recordLocalDiagnostic({
          ...diagnostic,
          source: "veil",
        });
      });
    } else {
      stopLocalVeil();
      await ensureCompanySession(companyTransportOptions());
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      providers: [{
        providerId: "company-endpoint",
        providerName: "Local Veil",
        baseUrl: settings.baseUrl,
        status: "unavailable",
        models: [],
        message,
      }],
      models: [],
      selected: null,
    };
  }
  const configured = configuredEndpointModel();
  const providerConfig = endpointProvider();
  const health = await checkEndpointHealth(providerConfig);
  recordVeilFeatures(health.features);
  const availableModel = { ...configured, capabilities: health.capabilities };
  let models: LocalModelInfo[] = health.status === "ready" ? [availableModel] : [];
  let selected: LocalModelInfo | null = health.status === "ready" ? availableModel : null;
  // A server that publishes a registry decides what the picker offers. The
  // stored id is the user's pick; `veil-managed` means they never made one, so
  // the server's own default entry answers instead.
  if (health.status === "ready" && settings.mode === "server" && connectedVeilSupports(veilFeature.modelsList)) {
    const published = await fetchServerModels(providerConfig);
    if (published.length > 0) {
      models = published.map((entry) => ({
        ...configured,
        modelId: entry.id,
        displayName: entry.display,
        ...(entry.contextLength === undefined ? {} : { contextLength: entry.contextLength }),
        capabilities: health.capabilities
          ? { ...health.capabilities, reasoning: entry.reasoning }
          : undefined,
      }));
      const chosen =
        models.find((model) => model.modelId === settings.modelId)
        ?? models.find((model) => model.modelId === published.find((entry) => entry.default)?.id)
        ?? models[0];
      selected = chosen;
    }
  }
  const provider: LocalModelProvider = {
    providerId: configured.providerId,
    providerName: configured.providerName,
    baseUrl: configured.baseUrl,
    status: health.status,
    models,
    message:
      health.status === "ready" && settings.mode === "local"
        ? `Local Veil is running with ${settings.modelId}. Telemetry is off.`
        : health.message,
  };
  return { providers: [provider], models, selected };
}

export async function getBackendStatus(): Promise<BackendStatus> {
  const { providers, models, selected } = await resolveSelectedModel();
  const runnerPath = runnerBinaryPath();
  const capabilityReport = await probeLocalCapabilities({ runnerPath });
  const managedEndpoint = managedModelEndpointDefaults();
  const endpointSettings = readModelEndpointSettings();
  const hasManagedEndpoint = !!(managedEndpoint?.baseUrl || managedEndpoint?.mode);
  const endpointStatus = providers.some((provider) => provider.status === "ready")
    ? "ready"
    : providers.some((provider) => provider.status === "degraded")
      ? "degraded"
      : "unavailable";
  const messages = [
    runnerPath ? undefined : "Umbratic runner is not built in the app bundle.",
    selected ? undefined : "Veil health check is not ready.",
    ...providers.map((provider) => provider.message).filter((message): message is string => !!message),
  ].filter((message): message is string => !!message);

  return {
    runner: runnerPath ? "ready" : "unavailable",
    endpoint: endpointStatus,
    model: selected,
    models,
    providers,
    permissionMode: getPermissionMode(),
    veilFeatures: connectedVeilFeatures(),
    endpointConfig: {
      source: managedEndpoint
        ? "managed"
        : hasStoredModelEndpointSettings()
          ? "stored"
          : endpointSettings.mode === "local"
            ? "local-default"
            : "server-default",
      endpointEditingAllowed: endpointEditingAllowed() && !hasManagedEndpoint,
    },
    privacy: {
      share: "disabled",
      enabledProviders: providers.filter((provider) => provider.status === "ready").map((provider) => provider.providerId),
      webTools: "disabled",
    },
    diagnostics: {
      runnerName: umbraticRunnerName,
      runnerVersion: umbraticRunnerVersion,
      runnerContractVersion: umbraticRunnerContractVersion,
      policyVersion: umbraticPolicyVersion,
      runnerBinary: runnerPath ? "present" : "missing",
      configAssertions: "enabled",
      providerAllowlist: [companyEndpointProviderId],
      localhostOnlyModels: models.every((model) => isLocalhostUrl(model.baseUrl)),
      commandClassifier: "enabled",
      runnerDiagnosticsDirectory: runnerDiagnosticsDirectory(app.getPath("userData")),
      localLogs: readLocalDiagnosticInfo(),
      telemetry: telemetryPolicyForMode(endpointSettings.mode),
      runtimes: runtimeDiagnostics(),
      capabilities: capabilityReport,
    },
    message: messages.length ? messages.join(" ") : undefined,
  };
}

export async function getCapabilityProbes(input: unknown): Promise<CapabilityProbeReport> {
  const force = isRecord(input) && input.force === true;
  return probeLocalCapabilities({ runnerPath: runnerBinaryPath(), force });
}

export async function openSkillsFolder(): Promise<{ ok: true; directory: string } | { ok: false; message: string }> {
  const directory = skillsDirectoryPathService();
  try {
    await fs.promises.mkdir(directory, { recursive: true });
    const failure = await shell.openPath(directory);
    if (failure) {
      return { ok: false, message: failure };
    }
    return { ok: true, directory };
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
}

export async function openRunnerDiagnosticsFolder(): Promise<{ ok: true; directory: string } | { ok: false; message: string }> {
  const directory = runnerDiagnosticsDirectory(app.getPath("userData"));
  try {
    await fs.promises.mkdir(directory, { recursive: true });
    const failure = await shell.openPath(directory);
    if (failure) return { ok: false, message: failure };
    return { ok: true, directory };
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
}

export async function openSkillInEditor(input: unknown): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  const result = await getSkillDocumentService(input as { id?: string });
  if (!result.ok) return result;
  const failure = await shell.openPath(result.skill.path);
  if (failure) return { ok: false, message: failure };
  return { ok: true, path: result.skill.path };
}

export async function importSkillFromDialog(_input?: unknown) {
  // Ignore renderer-supplied paths. Only dialog-selected paths are trusted.
  const dialogWindow = getMainWindow();
  const result = dialogWindow
    ? await dialog.showOpenDialog(dialogWindow, {
        title: "Import Umbratic Skill",
        properties: ["openFile", "openDirectory"],
        filters: [
          { name: "Skill folders or archives", extensions: ["md", "zip"] },
          { name: "All files", extensions: ["*"] },
        ],
      })
    : await dialog.showOpenDialog({
        title: "Import Umbratic Skill",
        properties: ["openFile", "openDirectory"],
        filters: [
          { name: "Skill folders or archives", extensions: ["md", "zip"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false as const, message: "Skill import was canceled." };
  }
  return importSkillService({ sourcePath: result.filePaths[0] });
}

export async function exportTelemetryBundle(): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dialogWindow = getMainWindow();
  const result = dialogWindow
    ? await dialog.showSaveDialog(dialogWindow, {
        title: "Export Umbratic Telemetry",
        defaultPath: `umbratic-telemetry-${timestamp}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      })
    : await dialog.showSaveDialog({
        title: "Export Umbratic Telemetry",
        defaultPath: `umbratic-telemetry-${timestamp}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
  if (result.canceled || !result.filePath) {
    return { ok: false, message: "Export canceled." };
  }
  const bundle = buildRedactedTelemetryBundle(readTasks(), readProjects(), readProductTelemetryEvents(), readLocalDiagnostics());
  fs.mkdirSync(path.dirname(result.filePath), { recursive: true });
  fs.writeFileSync(result.filePath, `${JSON.stringify(bundle)}\n`, "utf8");
  return { ok: true, path: result.filePath };
}

export async function exportLocalDiagnostics(): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dialogWindow = getMainWindow();
  const result = dialogWindow
    ? await dialog.showSaveDialog(dialogWindow, {
        title: "Export Umbratic Logs",
        defaultPath: `umbratic-logs-${timestamp}.jsonl`,
        filters: [{ name: "JSON Lines", extensions: ["jsonl"] }],
      })
    : await dialog.showSaveDialog({
        title: "Export Umbratic Logs",
        defaultPath: `umbratic-logs-${timestamp}.jsonl`,
        filters: [{ name: "JSON Lines", extensions: ["jsonl"] }],
      });
  if (result.canceled || !result.filePath) return { ok: false, message: "Export canceled." };
  const contents = readLocalDiagnostics().map((entry) => JSON.stringify(entry)).join("\n");
  fs.mkdirSync(path.dirname(result.filePath), { recursive: true });
  fs.writeFileSync(result.filePath, contents ? `${contents}\n` : "", "utf8");
  return { ok: true, path: result.filePath };
}

export function clearLocalDiagnosticLogs(): LocalDiagnosticInfo {
  const info = clearLocalDiagnostics();
  const logsDirectory = path.resolve(runnerDiagnosticsDirectory(app.getPath("userData")));
  if (pathInside(app.getPath("userData"), logsDirectory) && fs.existsSync(logsDirectory)) {
    fs.rmSync(logsDirectory, { recursive: true, force: true });
  }
  return info;
}

export function recordRendererProductEvent(input: unknown): void {
  if (!isRecord(input) || (input.type !== "review.opened" && input.type !== "ide.selected")) {
    throw new Error("Invalid product event input.");
  }
  const taskId = typeof input.taskId === "string" && /^task-[A-Za-z0-9_-]+$/.test(input.taskId) ? input.taskId : undefined;
  const task = taskId ? readTask(taskId) : null;
  const repositoryId = typeof input.repositoryId === "string" && input.repositoryId.length <= 128
    ? input.repositoryId
    : task?.repositoryId;
  if (input.type === "review.opened") {
    const scope = input.scope === "worktree" ? "worktree" : "task";
    const target = input.target === "project" ? "project" : "task";
    recordProductTelemetry("review.opened", {
      taskId,
      chatId: task?.chatId,
      repositoryId,
      data: { scope, target },
    });
    return;
  }
  const ideId = requiredString(input.ideId, "ideId");
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(ideId)) throw new Error("Invalid IDE selection.");
  const surface = input.surface === "review" ? "review" : "composer";
  recordProductTelemetry("ide.selected", {
    taskId,
    chatId: task?.chatId,
    repositoryId,
    data: { ideId, surface },
  });
}

export async function retryTelemetrySpoolQueue(): Promise<void> {
  if (!telemetryPolicyForMode(readModelEndpointSettings().mode).syncEnabled) return;
  const provider = endpointProvider();
  await uploadTelemetrySpool({
    directory: telemetrySpoolDirectory(app.getPath("userData")),
    endpoint: telemetryUploadEndpoint(provider),
  });
}

export async function syncTelemetryNow(): Promise<TelemetrySyncResult> {
  if (!telemetryPolicyForMode(readModelEndpointSettings().mode).syncEnabled) {
    throw new Error("Telemetry sync is disabled by policy.");
  }
  const provider = endpointProvider();
  const bundle = buildRedactedTelemetryBundle(readTasks(), readProjects(), readProductTelemetryEvents(), readLocalDiagnostics());
  return syncTelemetryBundle({
    directory: telemetrySpoolDirectory(app.getPath("userData")),
    bundle,
    endpoint: telemetryUploadEndpoint(provider),
  });
}

export function scheduleManagedTelemetrySync() {
  if (!telemetryPolicyForMode(readModelEndpointSettings().mode).syncEnabled || telemetrySyncTimer) return;
  telemetrySyncTimer = setTimeout(() => {
    telemetrySyncTimer = null;
    void syncTelemetryNow().catch((cause) => {
      recordLocalDiagnostic({
        level: "warn",
        source: "telemetry",
        event: "sync.failed",
        message: String(cause instanceof Error ? cause.message : cause),
      });
    });
  }, 5000);
  telemetrySyncTimer.unref?.();
}
