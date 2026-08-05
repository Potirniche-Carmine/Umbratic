import { getMainWindow } from "./mainRuntime";
import { setMainWindow, setPermissionModeValue } from "./mainRuntime";
import { clearLocalDiagnosticLogs, connectCompanyConnection, disconnectCompanyConnection, disconnectCompanyServerSession, enrollCompanyConnection, exportLocalDiagnostics, exportTelemetryBundle, getBackendStatus, getCapabilityProbes, importSkillFromDialog, openRunnerDiagnosticsFolder, openSkillInEditor, openSkillsFolder, recordRendererProductEvent, refreshLocalModels, retryTelemetrySpoolQueue, saveContextLengthSetting, saveHarnessProfileSetting, saveModelEndpointSettings } from "./backendSettings";
import { createChat, deleteChat, deleteProject, deleteProjectChats, getNotes, pathKey, updateChatDraft, updateChatProject, updateNotes } from "./chatStore";
import { createCheckpoint, deleteCheckpoint, forkCheckpoint, listTaskCheckpoints, restoreCheckpoint, setCheckpointPinned } from "./checkpointActions";
import { listAvailableIdes, openRepositoryInIde, openTaskInIde } from "./ideLauncher";
import { activeRunnerProcesses, appIcon, compactClosedTaskStorage, flushPendingTaskEvents, flushRendererEvents, getTask, pendingPermissions, publicTask, recordProductTelemetry, windowChromeDark, windowChromeHeight, windowChromeLight, windowChromeSymbolDark, windowChromeSymbolLight } from "./mainRuntime";
import { checkoutRepositoryBranch, getRepository, listRepositoryBranches, openChatAttachment, pickAttachmentFiles, pickRepository, savePastedAttachments } from "./repositoryOps";
import { refreshTaskReview, refreshWorkspaceReview } from "./reviewFiles";
import { approveTaskMerge, approveWorktreeCreation, cancelTask, keepWorktree, rejectTask, setResponseFeedback, startTask, steerTask } from "./taskActions";
import { respondToToolPermission } from "./taskCommands";
import { worktreeRootForRepo } from "./worktreeOps";
import {
  app,
  BrowserWindow,
  dialog,
  IpcMainInvokeEvent,
  Menu,
  MenuItemConstructorOptions,
  nativeImage,
  OpenDialogOptions,
  shell,
  session,
} from "electron";
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { chatTitleFromFirstMessage, stableChatTitle } from "../shared/chatTitle";
import {
  attachmentPromptTokenBudget,
  attachmentTextExcerpt,
  estimateTextTokens,
} from "../shared/contextWindow";

import {
  endpointEditingAllowed,
  managedModelEndpointDefaults,
  taskStatesThatCanOpen,
} from "./config";
import {
  capabilityPromptGuidance,
  capabilityTelemetrySnapshot,
  probeLocalCapabilities,
  type CapabilityPromptNeeds,
} from "./capabilities";
import { promptLooksLikeArtifactTask, promptLooksLikeOcrTask, type OcrInputKind } from "./artifactRuntime";
import { attachmentContextTokens, priorChatAttachments, readAttachmentTextIfSafe } from "./attachmentContext";
import { generateOcrDocument, writeOcrArtifacts, type OcrDocument, type OcrPageInput } from "./ocrRuntime";
import {
  beginRunnerEventStream,
  runnerRequest,
  runnerBinaryPath,
  runnerDiagnosticsDirectory,
  replyRunnerPermission,
  setRunnerProviderSession,
  startUmbraticRunnerServer,
  stopRunnerProcess,
} from "./runnerAdapter";
import {
  umbraticPolicyVersion,
  umbraticRunnerContractVersion,
  umbraticRunnerName,
  umbraticRunnerVersion,
  allowedLocalProviderIds,
  baseUrlHost,
  canAutoResolvePermission,
  classifyCommandText,
  isBlockedPath,
  isGeneratedRuntimePath,
  isLocalhostUrl,
  isWorkspaceReadPermission,
  promptLooksLikeCmakeTask,
  promptLooksLikePythonTask,
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
  renewCompanySession,
} from "./companyIdentity";
import { companyTransportOptions, configuredEndpointModel, endpointProvider, normalizeBaseUrl } from "./endpointConfig";
import { ensureLocalVeil, probeLocalModels as probeLocalRuntimeModels, stopLocalVeil } from "./localVeil";
import { loadWindowWithModelWarmup } from "./modelWarmup";
import { shouldProbeVeilContext } from "./veilContext";
import {
  readChat,
  readChats,
  hasStoredModelEndpointSettings,
  readContextLengthSetting,
  readCachedLocalModels,
  readLocalDiagnosticInfo,
  readLocalDiagnostics,
  readHarnessProfileSetting,
  readModelEndpointSettings,
  readModelEndpointSettingsForMode,
  publicModelEndpointSettings,
  readNotes,
  readPermissionModeSetting,
  readProjects,
  readProductTelemetryEvents,
  readStartupSettings, readTask,
  readTaskCheckpoints,
  readTasks,
  clearLocalDiagnostics,
  writeHarnessProfileSetting,
  writeCachedLocalModels,
  writeContextLengthSetting,
  writeModelEndpointSettings,
  writeChat,
  writeChats,
  writeJsonFile,
  writeNotes,
  writePermissionModeSetting,
  writeProjects,
  writeProductTelemetryEvent,
  writeTask,
  writeTasks,
  closeStorageDatabases,
  normalizeConversationState,
} from "./storage";
import { recordBackendEventDiagnostic, recordLocalDiagnostic, sanitizeDiagnosticValue } from "./diagnostics";
import { buildRedactedTelemetryBundle } from "./telemetry";
import {
  syncTelemetryBundle,
  telemetrySpoolDirectory,
  uploadTelemetrySpool,
} from "./telemetrySync";
import { checkEndpointHealth, modelWithFreshContextLength as refreshModelContextLength, telemetryUploadEndpoint } from "./modelEndpointRuntime";
import { commandAvailable, execFileOutput, execFileResult, gitOutput, gitResult } from "./processCommands";
import { searchRepositoryFiles } from "./repositorySearch";
import { enabledToolsFromSettings, normalizeEnabledTools } from "./toolSettings";
import { RunnerEventAdapter } from "./runnerEventAdapter";
import { appendBufferedBackendEvent, shouldBufferBackendEvent } from "./backendEventBuffer";
import {
  applyHarnessSystemSkillSettings,
  createSkill as createSkillService,
  getSkillDocument as getSkillDocumentService,
  importSkill as importSkillService,
  installBundledSystemSkills as installBundledSystemSkillsService,
  listSkills as listSkillsService,
  resetSystemSkill as resetSystemSkillService,
  saveSkillDocument as saveSkillDocumentService,
  saveSkillSettings as saveSkillSettingsService,
  skillsDirectoryPath as skillsDirectoryPathService,
} from "./skills";
import type {
  ApproveResult,
  BackendStatus,
  BackendUiEvent,
  CapabilityProbeReport,
  ChatAttachment,
  ChatRecord,
  CommandClass,
  CommandOutput,
  CommandResult,
  HarnessProfileId,
  IdeInfo,
  IdeOpenResult,
  LocalModelInfo,
  LocalModelProvider,
  LocalDiagnosticInfo,
  ProductTelemetryEventType,
  RunnerProcess,
  RunnerToolId,
  PendingPermission,
  PermissionMode,
  PermissionRequest,
  PastedAttachmentInput,
  ReasoningMode,
  RepositoryInfo,
  ReviewFile,
  ServiceStatus,
  TelemetrySyncResult,
  TaskInfo,
  TaskCheckpoint,
  TaskRecord,
  TaskState,
  UserNotes,
  WorkspaceKind,
  WorkspaceMode,
} from "./types";
import { commandText, hasSymlinkComponent, isRecord, normalizeRelativePath, pathInside, requiredString, shortHash, slugify } from "./utils";
import { normalizeReviewFile, parseGitPorcelainPaths, reviewContextLines, buildTextDiff } from "../shared/reviewDiff";
import { isResponseFeedbackReason, removeResponseFeedback } from "../shared/taskEvents";
import { backendEventDiagnostic, parseBackendUiEvent } from "../shared/backendEvents";
import {
  registerDesktopIpcHandlers,
  type DesktopIpcHandlers,
} from "./ipcRegistry";
import { readTaskDocumentReview } from "./documentReview";
import {
  assertFolderRejectBaseline,
  createTaskCheckpoint,
  createTurnCheckpoint,
  forkTaskFromCheckpoint,
  removeTaskCheckpoint,
  restoreIsolatedWorktreeForReject,
  restoreTaskCheckpoint,
  setTaskCheckpointPinned,
} from "./checkpoints/service";
import { reconcileCheckpointLifecycle } from "./checkpoints/reconcile";
import { codeLikeIdeArgs, macCodeLikeIdeArgs } from "./ideLaunch";
import { boundedRecentLines } from "./historyContext";
import { limitPromptImages, shouldIncludeWorkspaceContext, type ContextPromptPart } from "./promptContext";
import { findAgentInstructionFiles } from "./repositoryInstructions";
import * as appPaths from "./appPaths";
import { startLocalCacheMaintenance, stopLocalCacheMaintenance } from "./cacheMaintenance";
import {
  appendTaskEvent,
  compactTaskEvents,
  filterReviewPaths,
  hiddenRendererReviewPaths,
  isReviewReadyAssistantEvent,
  mergeTaskEvents,
  rendererReviewFiles,
  visibleTaskEvents,
} from "./taskReviewPresentation";
const isDev = !app.isPackaged;
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

function taskEnabledTools(task: TaskRecord): RunnerToolId[] {
  return normalizeEnabledTools(task.enabledTools, enabledToolsFromSettings({}));
}

function publicTaskById(input: unknown): TaskInfo | null {
  if (!isRecord(input) || typeof input.taskId !== "string" || !input.taskId.trim()) {
    return null;
  }
  const taskIdValue = input.taskId.trim();
  const task = readTask(taskIdValue);
  return task ? publicTask(task) : null;
}

function readDocumentReview(input: unknown) {
  if (!isRecord(input)) throw new Error("Invalid document review input.");
  const task = getTask(requiredString(input.taskId, "taskId"));
  return readTaskDocumentReview(task, requiredString(input.documentPath, "documentPath"));
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

function isTrustedDevUrl(url: URL): boolean {
  const trusted = devServerUrl();
  return url.protocol === trusted.protocol && url.hostname === trusted.hostname && url.port === trusted.port;
}

function trustedSender(event: IpcMainInvokeEvent): boolean {
  const window = getMainWindow();
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    return false;
  }
  const rawUrl = event.senderFrame?.url || event.sender.getURL();
  try {
    const url = new URL(rawUrl);
    if (isDev) {
      return isTrustedDevUrl(url);
    }
    return url.href === pathToFileURL(path.resolve(__dirname, "../../dist/index.html")).href;
  } catch {
    return false;
  }
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
  try {
    const url = new URL(rawUrl);
    if (isDev) {
      return isTrustedDevUrl(url);
    }
    return url.href === pathToFileURL(path.resolve(__dirname, "../../dist/index.html")).href;
  } catch {
    return false;
  }
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

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
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
    readDocumentReview: (input) => readDocumentReview(input),
    searchFiles: (input) => searchRepositoryFiles(input),
    pickRepository: () => pickRepository(),
    pickAttachmentFiles: (input) => pickAttachmentFiles(input),
    savePastedAttachments: (input) => savePastedAttachments(input),
    openChatAttachment: (input) => openChatAttachment(input),
    getRepository: (input) => getRepository(input),
    listRepositoryBranches: (input) => listRepositoryBranches(input),
    checkoutRepositoryBranch: (input) => checkoutRepositoryBranch(input),
    getBackendStatus: () => getBackendStatus(),
    getStartupSettings: () => readStartupSettings(),
    getCapabilityProbes: (input) => getCapabilityProbes(input),
    getModelEndpointSettings: (input) => {
      const mode = input?.mode;
      return publicModelEndpointSettings(mode ? readModelEndpointSettingsForMode(mode) : readModelEndpointSettings());
    },
    getCachedLocalModels: (input) =>
      readCachedLocalModels(typeof input?.baseUrl === "string" ? input.baseUrl : ""),
    probeLocalModels: (input) =>
      refreshLocalModels(typeof input?.baseUrl === "string" ? input.baseUrl : ""),
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
    listAvailableIdes: () => listAvailableIdes(),
    openRepositoryInIde: (input) => openRepositoryInIde(input),
    startTask: (input) => startTask(input),
    steerTask: (input) => steerTask(input),
    approveWorktreeCreation: (input) => approveWorktreeCreation(input),
    respondToToolPermission: (input) => respondToToolPermission(input),
    openTaskInIde: (input) => openTaskInIde(input),
    approveTaskMerge: (input) => approveTaskMerge(input),
    rejectTask: (input) => rejectTask(input),
    keepWorktree: (input) => keepWorktree(input),
    cancelTask: (input) => cancelTask(input),
    setResponseFeedback: (input) => setResponseFeedback(input),
    setWindowChromeTheme: (input) =>
      setWindowChromeTheme(input === "light" ? "light" : "dark"),
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
  Menu.setApplicationMenu(null);
  await loadWindowWithModelWarmup(createWindow);
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
  stopLocalCacheMaintenance();
  stopLocalVeil();
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
