import { getMainWindow } from "./mainRuntime";
import { setMainWindow, setPermissionModeValue } from "./mainRuntime";
import { onWorkspaceIndexProgress } from "./indexerService";
import { clearLocalDiagnosticLogs, connectCompanyConnection, disconnectCompanyConnection, disconnectCompanyServerSession, enrollCompanyConnection, exportLocalDiagnostics, exportTelemetryBundle, getBackendStatus, getCapabilityProbes, importSkillFromDialog, launchAtLoginStatus, listServerModels, loadLocalModel, openModelsFolder, openRunnerDiagnosticsFolder, openSkillInEditor, openSkillsFolder, recordRendererProductEvent, retryTelemetrySpoolQueue, saveContextLengthSetting, saveDictationSettings, saveLaunchAtLoginSetting, saveLocalMtpSetting, saveReasoningEffortSetting, saveSendOnEnterSetting, saveShowThinkingSetting, saveHarnessProfileSetting, saveModelEndpointSettings, unloadLocalModel } from "./backendSettings";
import { createChat, deleteChat, deleteProject, deleteProjectChats, getNotes, updateChatDraft, updateChatProject, updateNotes } from "./chatStore";
import { clearUnsavedDraft, readUnsavedDraft, writeUnsavedDraft } from "./unsavedDrafts";
import { createCheckpoint, deleteCheckpoint, forkCheckpoint, listTaskCheckpoints, restoreCheckpoint, setCheckpointPinned } from "./checkpointActions";
import { cancelDictation, sendDictationAudio, startDictation, stopDictation } from "./dictation";
import { listAvailableIdes, openRepositoryInIde, openTaskInIde } from "./ideLauncher";
import { activeRunnerProcesses, appIcon, compactClosedTaskStorage, flushPendingTaskEvents, flushRendererEvents, getTask, pendingPermissions, publicTask, recordProductTelemetry, windowChromeDark, windowChromeHeight, windowChromeLight, windowChromeSymbolDark, windowChromeSymbolLight } from "./mainRuntime";
import { checkoutRepositoryBranch, getRepository, listRepositoryBranches, openChatAttachment, pickAttachmentFiles, pickRepository, savePastedAttachments } from "./repositoryOps";
import { refreshTaskReview, refreshWorkspaceReview } from "./reviewFiles";
import {
  browseRemoteDirectory,
  checkRemoteConnection,
  deleteRemoteConnection,
  installRunnerOnRemote,
  listRemoteConnections,
  pickRemoteIdentityFile,
  saveRemoteConnection,
  setRemoteDefaultDirectory,
} from "./remoteService";
import { approveWorktreeCreation, cancelTask, dropQueuedTaskPrompt, keepWorktree, listQueuedTaskPrompts, queueFollowUpTask, revertReviewFile, setResponseFeedback, startTask, steerTask } from "./taskActions";
import { respondToToolPermission } from "./taskCommands";
import { worktreeRootForRepo } from "./worktreeOps";
import {
  app,
  BrowserWindow,
  IpcMainInvokeEvent,
  Menu,
  MenuItemConstructorOptions,
  session,
} from "electron";
import { openExternalLink } from "./externalLinks";
import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { trustedRendererUrl } from "./rendererTrust";


import {
  stopRunnerProcess,
} from "./runnerAdapter";
import {
  companyConnectionStatus,
  renewCompanySession,
} from "./companyIdentity";
import { companyTransportOptions } from "./endpointConfig";
import { stopLocalVeil } from "./localVeil";
import { requestMicrophoneAccess } from "./microphone";
import { stopLocalLlama } from "./localLlama";
import { stopLocalSpeech } from "./localSpeech";
import { listLocalModels, resolveLocalModel, selectedQuant } from "./localModels";
import { addCustomModel, customModel, removeCustomModel } from "./customModels";
import { abortModelDownloads, cancelModelDownload, downloadLocalModel, downloadingModelId, modelDirectory, onModelDownloadEvent } from "./modelDownloads";
import { systemProfile } from "./hardware";
import {
  readChats,
  readContextLengthSetting,
  readLocalMtpSetting,
  readReasoningEffortSetting,
  readDictationSettings,
  readKeyBindings,
  writeKeyBindings,
  readHarnessProfileSetting,
  readModelEndpointSettings,
  readModelEndpointSettingsForMode,
  publicModelEndpointSettings,
  readProjects,
  clearLocalModelSelection,
  readStartupSettings, readTask,
  readTasks,
  writeLocalQuantSelection,
  writePermissionModeSetting,
  writeWebToolsSetting,
  writeTasks,
  closeStorageDatabases,
} from "./storage";
import { recordLocalDiagnostic, sanitizeDiagnosticValue } from "./diagnostics";
import { searchRepositoryFiles } from "./repositorySearch";
import {
  createSkill as createSkillService,
  getSkillDocument as getSkillDocumentService,
  installBundledSystemSkills as installBundledSystemSkillsService,
  listSkills as listSkillsService,
  resetSystemSkill as resetSystemSkillService,
  saveSkillDocument as saveSkillDocumentService,
  saveSkillSettings as saveSkillSettingsService,
} from "./skills";
import type { PermissionMode, TaskInfo } from "./types";
import { isRecord, normalizeRelativePath, requiredString } from "./utils";
import {
  registerDesktopIpcHandlers,
  type DesktopIpcHandlers,
} from "./ipcRegistry";
import { readArtifactPreview } from "./artifactReview";
import { reconcileCheckpointLifecycle } from "./checkpoints/reconcile";
import * as appPaths from "./appPaths";
import { startLocalCacheMaintenance, stopLocalCacheMaintenance } from "./cacheMaintenance";
import { appUpdateStatus, installAppUpdate, onAppUpdateStatus, setAutomaticAppUpdates, startAppUpdates, stopAppUpdates } from "./appUpdates";
const isDev = !app.isPackaged;
// Electron's asar fs shim constructs fs.Stats, which Node deprecates as
// DEP0180. In a packaged app the warning is internals noise printed to the
// user's terminal; development keeps every warning visible.
if (!isDev) process.noDeprecation = true;
const desktopBenchmarkStartedAt = performance.now();
const fallbackDevServerUrl = "http://127.0.0.1:5173/";
app.enableSandbox();
app.setName("Umbratic");

const benchmarkUserData = process.env.UMBRATIC_USER_DATA_DIR?.trim();
const cleanUserData = benchmarkUserData ? path.resolve(benchmarkUserData) : appPaths.defaultDesktopDataRoot();
try {
  appPaths.configureDesktopAppPaths(app, cleanUserData);
  if (isDev) {
    app.commandLine.appendSwitch("disable-http-cache");
    app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
  }
} catch {
  /* Electron will use the default userData path. */
}

function finishInterruptedRunningTasks() {
  const now = new Date().toISOString();
  const tasks = readTasks();
  let changed = false;
  const repaired = tasks.map((task) => {
    if (task.state !== "running") return task;
    const events = Array.isArray(task.events) ? [...task.events] : [];
    const started = events.filter((event) => event.type === "command.started");
    const finished = new Set(events.filter((event) => event.type === "command.finished").map((event) => event.id));
    for (const event of started) {
      if (finished.has(event.id)) continue;
      events.push({ type: "command.finished", taskId: task.id, id: event.id, exitCode: null });
      changed = true;
    }
    changed = true;
    return {
      ...task,
      state: "failed" as const,
      error: "Task was interrupted before Umbratic runner finished.",
      events: [
        ...events,
        {
          type: "task.error" as const,
          taskId: task.id,
          message: "Task was interrupted before Umbratic runner finished.",
        },
      ].slice(-500),
      latestTest: task.latestTest ?? {
        command: "umbratic runner session",
        output: "Task was interrupted before Umbratic runner finished.",
        passed: false,
        exitCode: null,
        completedAt: now,
      },
    };
  });
  if (changed) {
    writeTasks(repaired);
  }
}

function publicTaskById(input: unknown): TaskInfo | null {
  if (!isRecord(input) || typeof input.taskId !== "string" || !input.taskId.trim()) {
    return null;
  }
  const taskIdValue = input.taskId.trim();
  const task = readTask(taskIdValue);
  return task ? publicTask(task) : null;
}

async function readReviewArtifactPreview(input: unknown) {
  if (!isRecord(input)) throw new Error("Invalid artifact preview input.");
  const task = getTask(requiredString(input.taskId, "taskId"));
  const documentPath = requiredString(input.documentPath, "documentPath");
  // Only files in the task's review list can be previewed; the review is
  // what the renderer is looking at, and the preview should not read wider.
  const normalized = normalizeRelativePath(documentPath);
  if (!task.reviewFiles.some((file) => normalizeRelativePath(file.path) === normalized)) {
    return { ok: false as const, code: "not_available" as const, message: "No preview is available for this file." };
  }
  return readArtifactPreview(task, documentPath);
}

function setPermissionMode(input: unknown): PermissionMode {
  const mode = writePermissionModeSetting(input);
  setPermissionModeValue(mode);
  recordProductTelemetry("permission.mode_changed", { data: { mode } });
  return mode;
}

function devServerUrl(): URL {
  const rawUrl = process.env.UMBRATIC_DEV_SERVER_URL || fallbackDevServerUrl;
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port) {
      return url;
    }
  } catch {
    /* Fall through to the default Vite URL. */
  }
  return new URL(fallbackDevServerUrl);
}

function rendererEntryUrl(): URL {
  const url = devServerUrl();
  const params = new URLSearchParams(process.env.UMBRATIC_RENDERER_QUERY || "");
  for (const [key, value] of params) {
    if (/^[A-Za-z0-9_-]{1,40}$/.test(key) && /^[A-Za-z0-9_.:-]{0,80}$/.test(value)) {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

function packagedIndexHref(): string {
  return pathToFileURL(path.resolve(__dirname, "../../dist/index.html")).href;
}

function rendererUrlAllowed(rawUrl: string): boolean {
  return trustedRendererUrl(rawUrl, {
    isDev,
    trustedDevOrigin: devServerUrl(),
    packagedIndexHref: packagedIndexHref(),
  });
}

function trustedSender(event: IpcMainInvokeEvent): boolean {
  const window = getMainWindow();
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    return false;
  }
  return rendererUrlAllowed(event.senderFrame?.url || event.sender.getURL());
}

function setWindowChromeTheme(theme: "dark" | "light"): { ok: true } {
  const window = getMainWindow();
  if (process.platform !== "win32" || !window) return { ok: true };
  window.setTitleBarOverlay({
    color: theme === "light" ? windowChromeLight : windowChromeDark,
    symbolColor: theme === "light" ? windowChromeSymbolLight : windowChromeSymbolDark,
    height: windowChromeHeight,
  });
  return { ok: true };
}

function allowedAppUrl(rawUrl: string): boolean {
  return rendererUrlAllowed(rawUrl);
}

async function createWindow() {
  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";
  const icon = appIcon();

  // Packaged macOS apps should use the bundle icon so Liquid Glass appearances
  // can be applied by the system; this PNG override is only for dev runs.
  if (isDev && isMac && app.dock && icon) {
    app.dock.setIcon(icon);
  }

  // The microphone is the one capability this window may ask for, and only for
  // audio: dictation needs it and nothing else in the app does. The system's
  // own consent is taken separately, before the renderer opens a device — this
  // gate only decides what the page is allowed to request.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
    callback(permission === "media" && mediaTypes.length > 0 && mediaTypes.every((type) => type === "audio"));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, _origin, details) => {
    // The check handler describes one media type rather than a list, and it is
    // also asked about devices before any capture starts — the audio answer is
    // the same in both cases.
    return permission === "media" && (details as { mediaType?: string }).mediaType === "audio";
  });
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const isFrame = details.resourceType === "mainFrame" || details.resourceType === "subFrame";
    callback({ cancel: isFrame && !allowedAppUrl(details.url) });
  });

  const mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#101112",
    icon,
    title: "Umbratic",
    titleBarStyle: isMac ? "hiddenInset" : isWin ? "hidden" : "default",
    titleBarOverlay: isWin
      ? {
          color: windowChromeDark,
          symbolColor: windowChromeSymbolDark,
          height: windowChromeHeight,
        }
      : undefined,
    webPreferences: {
      preload: path.resolve(__dirname, "../preload/preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      backgroundThrottling: true,
    },
  });

  setMainWindow(mainWindow);
  mainWindow.on("closed", () => setMainWindow(null));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!allowedAppUrl(url)) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.on("context-menu", (_event, params) => {
    if (!mainWindow) return;
    const template: MenuItemConstructorOptions[] = params.isEditable
      ? [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { type: "separator" },
          { role: "selectAll" },
        ]
      : [
          { role: "copy", enabled: !!params.selectionText },
          { role: "paste" },
          { type: "separator" },
          { role: "selectAll" },
        ];
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });

  if (isDev) {
    await mainWindow.loadURL(rendererEntryUrl().toString());
  } else {
    await mainWindow.loadFile(path.resolve(__dirname, "../../dist/index.html"));
  }
  const benchmarkFile = process.env.UMBRATIC_BENCHMARK_FILE?.trim();
  if (benchmarkFile) {
    fs.mkdirSync(path.dirname(benchmarkFile), { recursive: true });
    fs.writeFileSync(
      benchmarkFile,
      `${JSON.stringify({ pid: process.pid, rendererLoadedMs: performance.now() - desktopBenchmarkStartedAt })}\n`,
      "utf8",
    );
  }
}

function desktopIpcHandlers(): DesktopIpcHandlers {
  return {
    listProjects: () => readProjects(),
    listChats: () => readChats(),
    createChat: (input) => createChat(input),
    updateChatDraft: (input) => updateChatDraft(input),
    updateChatProject: (input) => updateChatProject(input),
    getUnsavedDraft: (input) => readUnsavedDraft(input),
    setUnsavedDraft: (input) => writeUnsavedDraft(input),
    clearUnsavedDraft: (input) => clearUnsavedDraft(input),
    deleteChat: (input) => deleteChat(input),
    deleteProjectChats: (input) => deleteProjectChats(input),
    deleteProject: (input) => deleteProject(input),
    getNotes: () => getNotes(),
    updateNotes: (input) => updateNotes(input),
    getTask: (input) => publicTaskById(input),
    listTaskCheckpoints: (input) => listTaskCheckpoints(input),
    createTaskCheckpoint: (input) => createCheckpoint(input),
    setTaskCheckpointPinned: (input) => setCheckpointPinned(input),
    deleteTaskCheckpoint: (input) => deleteCheckpoint(input),
    forkTaskCheckpoint: (input) => forkCheckpoint(input),
    restoreTaskCheckpoint: (input) => restoreCheckpoint(input),
    refreshTaskReview: (input) => refreshTaskReview(input),
    refreshWorkspaceReview: (input) => refreshWorkspaceReview(input),
    readArtifactPreview: (input) => readReviewArtifactPreview(input),
    searchFiles: (input) => searchRepositoryFiles(input),
    pickRepository: () => pickRepository(),
    pickAttachmentFiles: (input) => pickAttachmentFiles(input),
    savePastedAttachments: (input) => savePastedAttachments(input),
    openChatAttachment: (input) => openChatAttachment(input),
    getRepository: (input) => getRepository(input),
    listRepositoryBranches: (input) => listRepositoryBranches(input),
    checkoutRepositoryBranch: (input) => checkoutRepositoryBranch(input),
    getBackendStatus: () => getBackendStatus(),
    loadLocalModel: () => loadLocalModel(),
    unloadLocalModel: () => unloadLocalModel(),
    getStartupSettings: () => readStartupSettings(),
    getCapabilityProbes: (input) => getCapabilityProbes(input),
    listRemoteConnections: () => listRemoteConnections(),
    saveRemoteConnection: (input) => saveRemoteConnection(input),
    deleteRemoteConnection: (input) => deleteRemoteConnection(input),
    checkRemoteConnection: (input) => checkRemoteConnection(input),
    installRemoteRunner: (input) => installRunnerOnRemote(input),
    browseRemoteDirectory: (input) => browseRemoteDirectory(input),
    setRemoteDefaultDirectory: (input) => setRemoteDefaultDirectory(input),
    pickRemoteIdentityFile: () => pickRemoteIdentityFile(),
    getModelEndpointSettings: (input) => {
      const mode = input?.mode;
      return publicModelEndpointSettings(mode ? readModelEndpointSettingsForMode(mode) : readModelEndpointSettings());
    },
    getDictationSettings: async () => readDictationSettings(),
    saveDictationSettings: (input) => saveDictationSettings(input),
    getKeyBindings: async () => readKeyBindings(),
    saveKeyBindings: async (input) => writeKeyBindings(input),
    listLocalModels: async (input) =>
      listLocalModels(app.getPath("userData"), input?.kind === "dictation" ? "dictation" : "chat"),
    downloadLocalModel: async (input) => {
      try {
        const model = resolveLocalModel(String(input?.id ?? ""), app.getPath("userData"));
        if (!model) throw new Error("That model is not in the collection.");
        await downloadLocalModel(app.getPath("userData"), model, selectedQuant(model));
        return { ok: true as const };
      } catch (cause) {
        // The download's own failures name checksums and models, never paths or
        // addresses, so this message is safe to show as written.
        return { ok: false as const, message: cause instanceof Error ? cause.message : "The download failed." };
      }
    },
    openModelsFolder: () => openModelsFolder(),
    cancelLocalModelDownload: async (input) => {
      cancelModelDownload(String(input?.id ?? ""));
      return { ok: true as const };
    },
    setLocalModelQuant: async (input) => {
      const model = resolveLocalModel(String(input?.id ?? ""), app.getPath("userData"));
      const quant = String(input?.quant ?? "");
      if (!model) return { ok: false as const, message: "That model is not in the collection." };
      if (!model.quants.some((entry) => entry.quant === quant)) {
        return { ok: false as const, message: "That model does not offer that quantization." };
      }
      writeLocalQuantSelection(model.id, quant);
      return { ok: true as const };
    },
    addCustomLocalModel: async (input) => {
      try {
        await addCustomModel(String(input?.reference ?? ""));
        return { ok: true as const };
      } catch (cause) {
        // addCustomModel's failures name Hugging Face and the reference, never
        // paths, so the message is safe to show as written.
        return { ok: false as const, message: cause instanceof Error ? cause.message : "The model could not be added." };
      }
    },
    removeCustomLocalModel: async (input) => {
      const id = String(input?.id ?? "");
      if (!customModel(id)) return { ok: false as const, message: "That model is not in the collection." };
      if (downloadingModelId() === id) cancelModelDownload(id);
      const removed = removeCustomModel(id);
      if (removed) {
        try {
          fs.rmSync(modelDirectory(app.getPath("userData"), removed), { recursive: true, force: true });
        } catch {
          // The entry is gone either way; stray files remain reachable through
          // the models folder.
        }
      }
      return { ok: true as const };
    },
    listServerModels: () => listServerModels(),
    saveModelEndpointSettings: (input) =>
      saveModelEndpointSettings(
        input as Partial<ReturnType<typeof readModelEndpointSettings>>,
      ),
    getCompanyConnectionStatus: async () => {
      if (companyConnectionStatus().state === "enrolled") {
        await renewCompanySession(companyTransportOptions()).catch(() => undefined);
      }
      return companyConnectionStatus();
    },
    enrollCompanyConnection: (input) => enrollCompanyConnection(input),
    connectCompanyConnection: () => connectCompanyConnection(),
    disconnectCompanySession: () => disconnectCompanyServerSession(),
    disconnectCompanyConnection: () => disconnectCompanyConnection(),
    getHarnessProfile: () => readHarnessProfileSetting(),
    saveHarnessProfile: (input) => saveHarnessProfileSetting(input),
    getContextLength: () => readContextLengthSetting(),
    saveContextLength: (input) => saveContextLengthSetting(input),
    getLocalMtp: () => readLocalMtpSetting(),
    saveLocalMtp: (input) => saveLocalMtpSetting(input),
    getReasoningEffort: () => readReasoningEffortSetting(),
    saveReasoningEffort: (input) => saveReasoningEffortSetting(input),
    saveShowThinking: (input) => saveShowThinkingSetting(input),
    saveSendOnEnter: (input) => saveSendOnEnterSetting(input),
    getLaunchAtLogin: () => launchAtLoginStatus(),
    saveLaunchAtLogin: (input) => saveLaunchAtLoginSetting(input),
    exportTelemetry: () => exportTelemetryBundle(),
    exportLocalDiagnostics: () => exportLocalDiagnostics(),
    clearLocalDiagnostics: () => clearLocalDiagnosticLogs(),
    recordProductEvent: (input) => recordRendererProductEvent(input),
    listSkills: () => listSkillsService(),
    saveSkillSettings: (input) => saveSkillSettingsService(input),
    openSkillsFolder: () => openSkillsFolder(),
    openRunnerDiagnosticsFolder: () => openRunnerDiagnosticsFolder(),
    openSkillInEditor: (input) => openSkillInEditor(input),
    importSkill: (input) => importSkillFromDialog(input),
    createSkill: (input) => createSkillService(input),
    getSkillDocument: (input) => getSkillDocumentService(input),
    saveSkillDocument: (input) => saveSkillDocumentService(input),
    resetSystemSkill: (input) => resetSystemSkillService(input),
    setPermissionMode: (mode) => setPermissionMode(mode),
    setWebTools: (enabled) => writeWebToolsSetting(enabled === true),
    listAvailableIdes: () => listAvailableIdes(),
    openRepositoryInIde: (input) => openRepositoryInIde(input),
    startTask: (input) => startTask(input),
    steerTask: (input) => steerTask(input),
    queueFollowUpTask: (input) => queueFollowUpTask(input),
    dropQueuedTaskPrompt: (input) => dropQueuedTaskPrompt(input),
    listQueuedTaskPrompts: (input) => listQueuedTaskPrompts(input),
    approveWorktreeCreation: (input) => approveWorktreeCreation(input),
    respondToToolPermission: (input) => respondToToolPermission(input),
    openTaskInIde: (input) => openTaskInIde(input),
    revertReviewFile: (input) => revertReviewFile(input),
    keepWorktree: (input) => keepWorktree(input),
    cancelTask: (input) => cancelTask(input),
    setResponseFeedback: (input) => setResponseFeedback(input),
    setWindowChromeTheme: (input) =>
      setWindowChromeTheme(input === "light" ? "light" : "dark"),
    openExternal: (input) => openExternalLink(input?.url),
    // The sender is the trusted renderer by the time a handler runs, and it is
    // also where the transcripts have to be delivered.
    requestMicrophoneAccess: () => requestMicrophoneAccess(),
    startDictation: (input, event) => startDictation(input ?? {}, event.sender),
    sendDictationAudio: async (input) => sendDictationAudio(input),
    stopDictation: async () => stopDictation(),
    cancelDictation: async () => cancelDictation(),
    getAppUpdateStatus: async () => appUpdateStatus(),
    setAutomaticAppUpdates: async (input) => setAutomaticAppUpdates(input?.enabled),
    installAppUpdate: async () => installAppUpdate(),
  };
}

function registerMainIpc(): void {
  registerDesktopIpcHandlers(desktopIpcHandlers(), {
    trustedSender,
    onError: ({ channel, request, cause }) => {
      const message = String(cause instanceof Error ? cause.message : cause);
      recordLocalDiagnostic({
        level: "error",
        source: "ipc",
        event: channel,
        taskId:
          isRecord(request) && typeof request.taskId === "string"
            ? request.taskId
            : undefined,
        message,
        data: {
          input: sanitizeDiagnosticValue(request),
          stack: cause instanceof Error ? cause.stack : undefined,
        },
      });
    },
  });
}
app.whenReady().then(async () => {
  // A remembered model pick is a model queued to load, so the pick does not
  // survive the process: every launch opens with none chosen and the machine
  // idle until the user says otherwise. Cleared before anything reads settings.
  try {
    clearLocalModelSelection();
  } catch {
    // A settings file that cannot be written still gives a usable session.
  }
  try {
    installBundledSystemSkillsService();
  } catch (error) {
    recordLocalDiagnostic({
      level: "error",
      source: "desktop",
      event: "skills.install.failed",
      message: String(error instanceof Error ? error.message : error),
      data: { stack: error instanceof Error ? error.stack : undefined },
    });
    console.error("Unable to install bundled skills.", error);
  }
  await startLocalCacheMaintenance(session.defaultSession, appPaths.runtimesDirectory(app.getPath("userData")), () => activeRunnerProcesses.size === 0, (error) => recordLocalDiagnostic({ level: "warn", source: "desktop", event: "cache.maintenance.failed", message: error instanceof Error ? error.message : String(error) }));
  registerMainIpc();
  // Indexing starts on folder open, before any task exists, so it reaches the
  // renderer on its own channel rather than through the task event bus.
  onWorkspaceIndexProgress((event) => {
    getMainWindow()?.webContents.send("umbratic:workspace-index", event);
  });
  onModelDownloadEvent((event) => {
    getMainWindow()?.webContents.send("umbratic:model-download", event);
  });
  onAppUpdateStatus((status) => {
    getMainWindow()?.webContents.send("umbratic:app-update-status", status);
  });
  Menu.setApplicationMenu(null);
  // No model is loaded at startup — loading gigabytes of weights is something
  // the user asks for from the connection panel or by sending a prompt. The
  // hardware probe does warm here, so the first look at settings answers from
  // cache instead of paying for `llama-server --list-devices`.
  void systemProfile();
  await createWindow();
  startAppUpdates();
  void retryTelemetrySpoolQueue().catch((cause) => {
    recordLocalDiagnostic({
      level: "warn",
      source: "telemetry",
      event: "spool.retry.failed",
      message: String(cause instanceof Error ? cause.message : cause),
    });
  });
  // Heavy repair runs after the window is up so startup stays responsive.
  setImmediate(() => {
    try {
      finishInterruptedRunningTasks();
      compactClosedTaskStorage();
    } catch (error) {
      recordLocalDiagnostic({
        level: "error",
        source: "desktop",
        event: "startup.task_repair.failed",
        message: String(error instanceof Error ? error.message : error),
      });
    }
    void reconcileCheckpointLifecycle((task) => worktreeRootForRepo(task.originalRepoPath))
      .then((checkpointRecovery) => {
        if (checkpointRecovery.inspectedTasks > 0) {
          recordLocalDiagnostic({
            level: checkpointRecovery.missingActiveWorkspaces > 0 ? "error" : "warn",
            source: "desktop",
            event: "checkpoint.reconciled",
            message: "Recovered interrupted checkpoint lifecycle records.",
            data: checkpointRecovery,
          });
        }
      })
      .catch((error) => {
        recordLocalDiagnostic({
          level: "error",
          source: "desktop",
          event: "checkpoint.reconcile.failed",
          message: String(error instanceof Error ? error.message : error),
        });
      });
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  stopAppUpdates();
  stopLocalCacheMaintenance();
  // A download in flight leaves its .partial file behind on purpose: the next
  // attempt resumes from it rather than starting the gigabytes over.
  abortModelDownloads();
  stopLocalVeil();
  stopLocalLlama();
  stopLocalSpeech();
  flushRendererEvents();
  flushPendingTaskEvents();
  closeStorageDatabases();
  for (const [id, pending] of pendingPermissions) {
    pendingPermissions.delete(id);
    void pending.onDeny();
  }
  for (const [taskId, run] of activeRunnerProcesses) {
    activeRunnerProcesses.delete(taskId);
    stopRunnerProcess(run);
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});
