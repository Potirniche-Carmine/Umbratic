import {
  DEFAULT_CONTEXT_LENGTH,
  normalizeContextLength,
} from "../shared/contextWindow";
import type {
  AppUpdateStatus,
  BackendUiEvent,
  CapabilityProbeReport,
  CapabilityProbeResult,
  ChatAttachment,
  ChatRecord,
  CompanyConnectionStatus,
  DesktopApi,
  HarnessProfileId,
  IdeInfo,
  ModelEndpointMode,
  PermissionMode,
  PublicModelEndpointSettings,
  RemoteConnectionInfo,
  RepositoryInfo,
  SkillInfo,
  TaskInfo,
  UnsavedChatDraft,
  UserNotes,
} from "../shared/desktopApi";
import { DEFAULT_REASONING_EFFORT, isReasoningEffort } from "../shared/desktopApi";
import type { ReasoningEffort } from "../shared/desktopApi";
import type { ReviewFile } from "../shared/reviewDiff";
import { harnessSystemSkillIds } from "../shared/harnessSkills";
import { previewCatalog } from "./previewModels";
import { createPreviewComposerFixtures } from "./previewComposerFixtures";
import {
  previewCapabilityReport,
  previewDefaultSkills,
  previewSkillContent,
} from "./previewCapabilities";
import { previewDictation } from "./previewDictation";
import { previewRemoteApi } from "./previewRemoteFixtures";
import { normalizeAttachment } from "./chatListPresentation";
import { normalizeEndpointSettings } from "./endpointSettings";
import { defaultHarnessProfileId, isHarnessProfileId } from "./harnessProfile";
import {
  defaultIdeChoices,
  getPreviewPermissionMode,
  publicPreviewEndpointSettings,
  readPreviewChats,
  readPreviewContextLength,
  readPreviewReasoningEffort,
  readPreviewShowThinking,
  readPreviewEndpointSettings,
  readPreviewHarnessProfile,
  readPreviewNotes,
  readPreviewProjects,
  setPreviewPermissionMode,
  writePreviewChats,
  writePreviewContextLength,
  writePreviewReasoningEffort,
  writePreviewShowThinking,
  writePreviewEndpointSettings,
  writePreviewHarnessProfile,
  writePreviewNotes,
  writePreviewProjects,
} from "./previewSupport";

export type PreviewEnvironment = {
  api: DesktopApi;
  attachments: ChatAttachment[];
  events: BackendUiEvent[];
  params: URLSearchParams;
  prompt: string;
  repository: RepositoryInfo;
  reviewFiles: ReviewFile[];
  task: TaskInfo;
};

let previewSkills = previewDefaultSkills.map((skill) => ({
  ...skill,
  enabled: harnessSystemSkillIds[readPreviewHarnessProfile()].has(skill.id),
}));
let previewWebTools = false;

export function createPreviewEnvironment() {
  const {
    composerTestParams,
    composerTestAttachments,
    composerTestPrompt,
    composerTestRepository,
    composerTestVisibleEvents,
    composerTestDocumentPath,
    composerTestDocumentPreview,
    composerTestReviewFiles,
    composerTestWholeDiffFiles,
    composerTestTask,
    previewChatModel,
    previewUpdateStatus,
  } = createPreviewComposerFixtures();


function createPreviewApi(): DesktopApi {
  let previewCompanyConnection: CompanyConnectionStatus = { state: "not_enrolled" };
  let previewCompanySessionConnected = false;
  const previewUnsavedDrafts = new Map<string, UnsavedChatDraft>();
let previewLocalMtp = true;

  const previewApi: DesktopApi = {
  listProjects: async () => readPreviewProjects(),
  listChats: async () => readPreviewChats(),
  createChat: async (input) => {
    const now = new Date().toISOString();
    const chat: ChatRecord = {
      id: input?.id ?? `preview-${Date.now().toString(36)}`,
      title: input?.title?.trim() || "New chat",
      createdAt: now,
      updatedAt: now,
      modelEndpointMode: readPreviewEndpointSettings().mode,
      repositoryName: input?.repositoryName,
      repositoryPath: input?.repositoryPath,
      draftPrompt: "",
      attachedFiles: [],
    };
    writePreviewChats([chat, ...readPreviewChats().filter((row) => row.id !== chat.id)]);
    return chat;
  },
  // The preview harness runs without a main process, so the unsaved draft lives
  // in this module for the life of the page — same lifetime guarantee as the
  // real thing, one process down.
  getUnsavedDraft: async (input) => previewUnsavedDrafts.get(input.scope) ?? { draftPrompt: "", attachedFiles: [] },
  setUnsavedDraft: async (input) => {
    const draft = { draftPrompt: input.draftPrompt, attachedFiles: input.attachedFiles };
    if (!draft.draftPrompt && draft.attachedFiles.length === 0) previewUnsavedDrafts.delete(input.scope);
    else previewUnsavedDrafts.set(input.scope, draft);
    return draft;
  },
  clearUnsavedDraft: async (input) => {
    previewUnsavedDrafts.delete(input.scope);
    return { ok: true };
  },
  updateChatDraft: async (input) => {
    const chats = readPreviewChats();
    const existing = chats.find((chat) => chat.id === input.chatId);
    if (!existing) throw new Error("Chat was not found.");
    const next = {
      ...existing,
      draftPrompt: input.draftPrompt,
      attachedFiles: input.attachedFiles.map(normalizeAttachment),
    };
    writePreviewChats([next, ...chats.filter((chat) => chat.id !== input.chatId)]);
    return next;
  },
  updateChatProject: async (input) => {
    const chats = readPreviewChats();
    const existing = chats.find((chat) => chat.id === input.chatId);
    if (!existing) throw new Error("Chat was not found.");
    const next = {
      ...existing,
      repositoryName: input.repositoryName,
      repositoryPath: input.repositoryPath,
    };
    writePreviewChats([next, ...chats.filter((chat) => chat.id !== input.chatId)]);
    return next;
  },
  deleteChat: async (input) => {
    writePreviewChats(readPreviewChats().filter((chat) => chat.id !== input.chatId));
    return { ok: true };
  },
  deleteProjectChats: async (input) => {
    const project = readPreviewProjects().find((row) => row.id === input.projectId);
    const repositoryPath = project?.rootPath;
    const deletedChatIds = readPreviewChats()
      .filter((chat) => repositoryPath && chat.repositoryPath === repositoryPath)
      .map((chat) => chat.id);
    if (repositoryPath) {
      writePreviewChats(readPreviewChats().filter((chat) => chat.repositoryPath !== repositoryPath));
    }
    return { ok: true, deletedChatIds };
  },
  deleteProject: async (input) => {
    const project = readPreviewProjects().find((row) => row.id === input.projectId);
    const repositoryPath = project?.rootPath;
    const deletedChatIds = readPreviewChats()
      .filter((chat) => repositoryPath && chat.repositoryPath === repositoryPath)
      .map((chat) => chat.id);
    if (repositoryPath) {
      writePreviewChats(readPreviewChats().filter((chat) => chat.repositoryPath !== repositoryPath));
      writePreviewProjects(readPreviewProjects().filter((row) => row.rootPath !== repositoryPath));
    }
    return { ok: true, deletedChatIds };
  },
  getNotes: async () => readPreviewNotes(),
  updateNotes: async (input) => writePreviewNotes(input.content),
  getTask: async () => null,
  refreshTaskReview: async (input) => {
    const scope = input.scope === "worktree" ? "worktree" : "task";
    const reviewFiles = scope === "worktree" ? composerTestWholeDiffFiles : composerTestReviewFiles;
    return {
      ...composerTestTask,
      changedFiles: reviewFiles.map((file) => file.path),
      reviewFiles,
      reviewScope: scope,
      reviewBaselineLabel: scope === "worktree" ? "Whole diff" : "Turn changes",
      reviewBaselineOid: scope === "worktree" ? "HEAD" : "task start",
    };
  },
  refreshWorkspaceReview: async () => ({ reviewFiles: composerTestWholeDiffFiles, baselineOid: "HEAD" }),
  readArtifactPreview: async (input) => input.documentPath === composerTestDocumentPath
    ? { ok: true, preview: composerTestDocumentPreview }
    : { ok: false, code: "not_available", message: "This document does not include a review preview." },
  searchFiles: async (input) => {
    const query = input.query.toLowerCase();
    const kind = input.kind ?? "file";
    const startsWith = (entry: { name: string }) => Number(entry.name.toLowerCase().startsWith(query));
    return [
      { path: "apps/desktop/src/renderer", name: "renderer", kind: "folder" as const },
      { path: "apps/desktop/src/main", name: "main", kind: "folder" as const },
      { path: "apps/desktop/src/renderer/components", name: "components", kind: "folder" as const },
      { path: "apps/desktop/src/renderer/styles", name: "styles", kind: "folder" as const },
      { path: "apps/desktop/src/renderer/main.tsx", name: "main.tsx", kind: "file" as const },
      { path: "apps/desktop/src/renderer/styles.css", name: "styles.css", kind: "file" as const },
      { path: "apps/desktop/src/renderer/composerText.ts", name: "composerText.ts", kind: "file" as const },
      { path: "apps/desktop/src/renderer/eventDisplay.ts", name: "eventDisplay.ts", kind: "file" as const },
      { path: "apps/desktop/src/renderer/previewSupport.ts", name: "previewSupport.ts", kind: "file" as const },
      { path: "apps/desktop/src/main/main.ts", name: "main.ts", kind: "file" as const },
      { path: "apps/desktop/src/main/fileSearch.ts", name: "fileSearch.ts", kind: "file" as const },
      { path: "apps/desktop/src/main/taskActions.ts", name: "taskActions.ts", kind: "file" as const },
      { path: "apps/desktop/src/shared/desktopApi.ts", name: "desktopApi.ts", kind: "file" as const },
    ]
      .filter((file) => (kind === "all" ? true : file.kind === kind))
      .filter((file) => file.path.toLowerCase().includes(query))
      .sort((left, right) => startsWith(right) - startsWith(left));
  },
  pickRepository: async () => {
    const repository = {
      id: "preview-umbratic",
      name: "Umbratic",
      rootPath: "/workspace/Umbratic",
      kind: "folder",
      originalBranch: "folder",
      baseCommit: "preview",
      dirty: false,
      statusSummary: "preview",
    } satisfies RepositoryInfo;
    writePreviewProjects([repository, ...readPreviewProjects().filter((project) => project.id !== repository.id)]);
    return {
      canceled: false,
      repository,
    };
  },
  pickAttachmentFiles: async () => ({
    canceled: false,
    files: [{ path: "apps/desktop/src/renderer/main.tsx", name: "main.tsx", source: "workspace" }],
  }),
  savePastedAttachments: async (input) => ({
    files: input.files.map((file, index) =>
      normalizeAttachment({
        path: `attachments/preview-${index}-${file.name || "pasted-file"}`,
        name: file.name || "pasted-file",
        source: "chat",
        originalPath: "clipboard",
        previewDataUrl: file.dataUrl.startsWith("data:image/") ? file.dataUrl : undefined,
      }),
    ),
  }),
  openChatAttachment: async () => ({ ok: false, message: "Electron preload is not available." }),
  getRepository: async (input) =>
    input.repositoryPath
      ? {
          id: `preview-${input.repositoryPath}`,
          name: input.repositoryPath.split(/[\\/]/).filter(Boolean).pop() || input.repositoryPath,
          rootPath: input.repositoryPath,
          kind: "folder",
          originalBranch: "folder",
          baseCommit: "preview",
          dirty: false,
          statusSummary: "preview",
        }
      : null,
  listRepositoryBranches: async () => ({ ok: true, current: "main", branches: ["main", "develop"] }),
  checkoutRepositoryBranch: async () => ({ ok: false, message: "Open the Electron app to switch branches." }),
  getBackendStatus: async () => ({
    runner: "unavailable",
    endpoint: previewCompanySessionConnected ? "ready" : "unavailable",
    // A model is named so the composer's bottom rail is exercisable here: with
    // none selected the rail has nothing to say about what answers, which is
    // the one state that hides the controls being designed.
    model: previewChatModel,
    models: [previewChatModel],
    providers: [],
    permissionMode: getPreviewPermissionMode(),
    // `?dictation` advertises the speech feature so the composer's microphone
    // can be exercised in the preview harness, which has no Veil behind it.
    veilFeatures: ["chat.reasoning_visible", ...(composerTestParams.has("dictation") ? ["speech.transcribe"] : [])],
    localDictationReady: composerTestParams.has("dictation"),
    system: { totalRamGB: 32, vramGB: 12, accelerator: "Vulkan", acceleratorDevice: "NVIDIA GeForce RTX 4070", quality: "optimal" as const },
    endpointConfig: {
      source: "local-default",
      endpointEditingAllowed: true,
    },
    privacy: {
      share: "disabled",
      enabledProviders: [],
      webTools: "off",
    },
    diagnostics: {
      runnerName: "UmbraticRunner",
      runnerVersion: "package-adapter-1",
      runnerContractVersion: "umbratic-runner-1",
      policyVersion: "umbratic-enterprise-mvp-1",
      runnerBinary: "missing",
      configAssertions: "enabled",
      providerAllowlist: ["company-endpoint"],
      localhostOnlyModels: false,
      commandClassifier: "enabled",
      runnerDiagnosticsDirectory: "Umbratic/logs/runner",
      localLogs: { bytes: 0, entries: 0 },
      telemetry: {
        mode: readPreviewEndpointSettings().mode === "local" ? "managed_disabled" : "managed_required",
        localEnabled: false,
        syncEnabled: readPreviewEndpointSettings().mode === "server",
        retentionDays: readPreviewEndpointSettings().mode === "server" ? 30 : 0,
        exportFormat: "redacted-json",
        storage: readPreviewEndpointSettings().mode === "server" ? "company-managed-telemetry" : "task-event-snapshots",
      },
      runtimes: {
        python: {
          runtimeVersion: "python-uv-venv-1",
          barePythonVerification: "allowed_uv_preferred",
          generatedPaths: [".venv", "__pycache__", ".pyc", ".umbratic/runtime"],
        },
        markdown: { docsOnlyClassification: "enabled" },
        cmake: { runtimeVersion: "cmake-umbratic-build-1", buildDir: ".umbratic/build" },
        toolchain: {
          bundledHelperCommands: ["rg", "fd/fdfind", "tree-sitter", "bat/batcat"],
          optionalCapabilityCommands: ["jq", "yq", "cmake", "compiler", "build backend"],
        },
        shell: { platform: navigator.platform, preferred: "posix", nonInteractive: true },
      },
      capabilities: previewCapabilityReport(),
    },
    message: "Electron preload is not available in this browser preview.",
  }),
  getStartupSettings: async () => ({
    permissionMode: getPreviewPermissionMode(),
    modelEndpoint: readPreviewEndpointSettings(),
    companyConnection: previewCompanyConnection,
    harnessProfile: readPreviewHarnessProfile(),
    contextLength: readPreviewContextLength(),
    reasoningEffort: readPreviewReasoningEffort(),
    showThinking: readPreviewShowThinking(),
    sendOnEnter: true,
    webTools: previewWebTools,
  }),
  getCapabilityProbes: async () => previewCapabilityReport(),
  ...previewRemoteApi,
  getHarnessProfile: async () => readPreviewHarnessProfile(),
  saveHarnessProfile: async (input) => {
    const settings = isHarnessProfileId(input) ? input : defaultHarnessProfileId;
    writePreviewHarnessProfile(settings);
    previewSkills = previewSkills.map((skill) => (
      skill.source === "system"
        ? { ...skill, enabled: harnessSystemSkillIds[settings].has(skill.id) }
        : skill
    ));
    return { settings, status: await previewApi.getBackendStatus() };
  },
  getReasoningEffort: async () => readPreviewReasoningEffort(),
  saveReasoningEffort: async (input) => {
    const reasoningEffort = isReasoningEffort(input) ? input : DEFAULT_REASONING_EFFORT;
    writePreviewReasoningEffort(reasoningEffort);
    return { reasoningEffort, status: await previewApi.getBackendStatus() };
  },
  saveShowThinking: async (input) => {
    writePreviewShowThinking(input === true);
    return readPreviewShowThinking();
  },
  saveSendOnEnter: async (input) => input !== false,
  // The preview has no OS session to attach to.
  getLaunchAtLogin: async () => ({ enabled: false, available: false }),
  saveLaunchAtLogin: async () => ({ enabled: false, available: false }),
  getContextLength: async () => readPreviewContextLength(),
  saveContextLength: async (input) => {
    const contextLength = normalizeContextLength(input);
    writePreviewContextLength(contextLength);
    return { contextLength, status: await previewApi.getBackendStatus() };
  },
  getLocalMtp: async () => previewLocalMtp,
  saveLocalMtp: async (input) => {
    previewLocalMtp = input !== false;
    return { mtp: previewLocalMtp, status: await previewApi.getBackendStatus() };
  },
  getModelEndpointSettings: async () => readPreviewEndpointSettings(),
  getDictationSettings: async () => ({ model: "off" as const, language: null, deviceId: null }),
  saveDictationSettings: async (input) => ({ dictation: input, status: await previewApi.getBackendStatus() }),
  getKeyBindings: async () => ({}),
  saveKeyBindings: async (input) => input,
  readGeneratedImage: async () => ({ dataUrl: null }),
  getImageSettings: async () => ({ model: "qwen-image-2.1", runtimeAvailable: true }),
  saveImageSettings: async ({ model }) => ({ model, runtimeAvailable: true }),
  listLocalModels: async ({ kind }) => previewCatalog(kind),
  downloadLocalModel: async () => ({ ok: true as const }),
  cancelLocalModelDownload: async () => ({ ok: true as const }),
  setLocalModelQuant: async () => ({ ok: true as const }),
  loadLocalModel: async () => ({ status: await previewApi.getBackendStatus() }),
  unloadLocalModel: async () => ({ status: await previewApi.getBackendStatus() }),
  addCustomLocalModel: async () => ({ ok: true as const }),
  removeCustomLocalModel: async () => ({ ok: true as const }),
  openModelsFolder: async () => ({ ok: true as const, directory: "/preview/models" }),
  onModelDownloadEvent: () => () => undefined,
  // The preview is not an installed build; it shows the state one would.
  getAppUpdateStatus: async () => previewUpdateStatus,
  setAutomaticAppUpdates: async ({ enabled }) => ({ ...previewUpdateStatus, automatic: enabled }),
  installAppUpdate: async () => undefined,
  onAppUpdateStatus: () => () => undefined,
  // The browser preview has no Veil, so it publishes no registry: the composer
  // model picker stays hidden here exactly as it does against an older server.
  listServerModels: async () => [],
  saveModelEndpointSettings: async (input) => {
    const settings = publicPreviewEndpointSettings(normalizeEndpointSettings(input));
    writePreviewEndpointSettings(settings);
    return { settings, status: await previewApi.getBackendStatus() };
  },
  getCompanyConnectionStatus: async () => previewCompanyConnection,
  enrollCompanyConnection: async (input) => {
    const settings = publicPreviewEndpointSettings(normalizeEndpointSettings({
      ...readPreviewEndpointSettings(),
      mode: "server",
      baseUrl: input.baseUrl,
      modelId: "veil-managed",
      secret: "",
    }));
    writePreviewEndpointSettings(settings);
    previewCompanyConnection = {
      state: "enrolled",
      baseUrl: input.baseUrl,
      orgName: "Preview organization",
      deviceLabel: "Preview device",
    };
    previewCompanySessionConnected = true;
    return { connection: previewCompanyConnection, settings, status: await previewApi.getBackendStatus() };
  },
  connectCompanyConnection: async () => {
    previewCompanySessionConnected = true;
    return {
      connection: previewCompanyConnection,
      settings: readPreviewEndpointSettings(),
      status: await previewApi.getBackendStatus(),
    };
  },
  disconnectCompanySession: async () => {
    previewCompanySessionConnected = false;
    return {
      connection: previewCompanyConnection,
      settings: readPreviewEndpointSettings(),
      status: await previewApi.getBackendStatus(),
    };
  },
  disconnectCompanyConnection: async () => {
    previewCompanySessionConnected = false;
    previewCompanyConnection = { state: "not_enrolled" };
    return {
      connection: previewCompanyConnection,
      settings: readPreviewEndpointSettings(),
      status: await previewApi.getBackendStatus(),
    };
  },
  exportTelemetry: async () => ({ ok: false, message: "Electron preload is not available." }),
  exportLocalDiagnostics: async () => ({ ok: false, message: "Electron preload is not available." }),
  clearLocalDiagnostics: async () => ({ bytes: 0, entries: 0 }),
  recordProductEvent: async () => undefined,
  listSkills: async () => ({ skills: previewSkills, directory: "~/.umbratic/skills" }),
  saveSkillSettings: async (input) => {
    previewSkills = previewSkills.map((skill) => ({ ...skill, enabled: input[skill.id] ?? skill.enabled }));
    return { skills: previewSkills, directory: "~/.umbratic/skills" };
  },
  openSkillsFolder: async () => ({ ok: false, message: "Electron preload is not available." }),
  openRunnerDiagnosticsFolder: async () => ({ ok: false, message: "Electron preload is not available." }),
  openSkillInEditor: async () => ({ ok: false, message: "Electron preload is not available." }),
  importSkill: async () => ({ ok: false, message: "Electron preload is not available." }),
  createSkill: async () => ({ ok: false, message: "Electron preload is not available." }),
  getSkillDocument: async (input) => {
    const skill = previewSkills.find((row) => row.id === input.id);
    return skill
      ? { ok: true, skill: { ...skill, path: `~/.umbratic/skills/${skill.id}.md`, content: previewSkillContent(skill) }, directory: "~/.umbratic/skills" }
      : { ok: false, message: "Electron preload is not available." };
  },
  saveSkillDocument: async () => ({ ok: false, message: "Electron preload is not available." }),
  resetSystemSkill: async () => ({ ok: false, message: "Electron preload is not available." }),
  setPermissionMode: async (mode) => {
    setPreviewPermissionMode(mode);
    return getPreviewPermissionMode();
  },
  setWebTools: async (enabled) => {
    previewWebTools = enabled === true;
    return previewWebTools;
  },
  listAvailableIdes: async () => defaultIdeChoices,
  startTask: async () => { throw new Error("Open the Electron app to run a task."); },
  steerTask: async () => undefined,
  queueFollowUpTask: async () => ({ actionId: "preview-follow-up" }),
  dropQueuedTaskPrompt: async () => undefined,
  listQueuedTaskPrompts: async () => [],
  approveWorktreeCreation: async () => undefined,
  respondToToolPermission: async () => undefined,
  openRepositoryInIde: async () => ({ ok: false, message: "Electron preload is not available." }),
  openTaskInIde: async () => ({ ok: false, message: "Electron preload is not available." }),
  undoTaskChanges: async () => null,
  keepWorktree: async () => undefined,
  cancelTask: async () => undefined,
  setResponseFeedback: async () => undefined,
  setWindowChromeTheme: async () => ({ ok: true }),
  // The preview has no main process to hand a URL to, so a link click is a
  // no-op rather than a broken promise.
  openExternal: async () => ({ ok: false }),
  onBackendEvent: () => () => undefined,
  requestMicrophoneAccess: async () => ({ granted: true }),
  startDictation: async () => previewDictation.start(),
  sendDictationAudio: async () => undefined,
  stopDictation: async () => {
    previewDictation.stop();
    return { stopping: true };
  },
  cancelDictation: async () => previewDictation.cancel(),
  onDictationEvent: (callback) => previewDictation.subscribe(callback),
  // `?indexing` holds the first-index status on so it can be seen without
  // opening a real folder.
  onWorkspaceIndex: (callback) => {
    if (composerTestParams.has("indexing")) {
      callback({ workspacePath: composerTestRepository.rootPath, phase: "started" });
    }
    return () => undefined;
  },
  };
  return previewApi;
}

return {
  api: createPreviewApi(),
  attachments: composerTestAttachments,
  events: composerTestVisibleEvents,
  params: composerTestParams,
  prompt: composerTestPrompt,
  repository: composerTestRepository,
  reviewFiles: composerTestReviewFiles,
  task: composerTestTask,
};
}
