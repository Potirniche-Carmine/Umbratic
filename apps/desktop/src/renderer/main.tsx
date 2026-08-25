import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  BackendStatus,
  BackendUiEvent,
  CapabilityProbeCategory,
  CapabilityProbeImportance,
  CapabilityProbeReport,
  CapabilityProbeResult,
  CapabilityProbeStatus,
  ChatAttachment,
  ChatRecord,
  DesktopStartupSettings,
  DesktopApi,
  FileSearchKind,
  FileSearchResult,
  HarnessProfileId,
  IdeInfo,
  LocalCatalogModel,
  LocalModelInfo,
  PastedAttachmentInput,
  PermissionMode,
  ReasoningEffort,
  RepositoryInfo,
  ServerModelInfo,
  SkillDocument,
  SkillInfo,
  TaskInfo,
  UserNotes,
  WorkspaceMode,
} from "../shared/desktopApi";
import { DEFAULT_REASONING_EFFORT, isReasoningEffort } from "../shared/desktopApi";
import { chatTitleFromFirstMessage, stableChatTitle } from "../shared/chatTitle";
import {
  attachmentDetail,
  chatAfterDeletion,
  chatAttachmentsMatch,
  chatAttachmentsSignature,
  chatCountLabel,
  chatDisplayTitle,
  chatJumpNumbers,
  visibleChatOrder,
  chatProjectKey,
  chatSubline,
  chatWorktreeKey,
  closedChatMessage,
  deleteCandidateActionLabel,
  deleteCandidateDescription,
  deleteCandidateTitle,
  draftMatchesTaskPrompt,
  eventTimelineTime,
  folderName,
  isImageAttachment,
  chatActivityUtcIso,
  samePathKey,
  shortHash,
  stateLabel,
  titleFromPrompt,
  worktreeSubline,
  worktreeTitle,
  type ChatProjectGroup,
  type DeleteCandidate,
  type ProjectDeleteTarget,
  type WorktreeChatGroup,
} from "./chatListPresentation";
import type {
  AppearanceSettings, ComposerActivitySegment, ComposerSubmission,
  ComposerTimelineItem, IdeChoice, PermissionRequest, PromptMention, QueuedComposerPrompt,
  ResponseFeedbackDialogState, ReviewFile, SkillSourceFilter,
} from "./rendererTypes";
import { readQueuedPrompts } from "./queuedPrompts";
import { QueuedPromptList } from "./queuedPromptList";
import {
  CONTEXT_LENGTH_OPTIONS,
  DEFAULT_CONTEXT_LENGTH,
  contextMeterState,
  estimateContextUsage,
  normalizeContextLength,
  shouldShowContextMeter,
  type ContextEstimateMessage,
} from "../shared/contextWindow";
import { ContextMeter } from "./contextMeter";
import {
  BranchPicker,
  ComposerModelPicker,
  DictationControl,
  PermissionModePicker,
  WebToolsControl, WorktreeToggle,
  type ComposerModelOption,
} from "./ComposerControls";
import { insertTranscript, useDictation } from "./dictation";
import {
  chatJumpFromEvent,
  chatJumpLimit,
  chatJumpModifierHeld,
  setShortcutOverrides,
  shortcutForEvent,
  type ShortcutId,
  type ShortcutOverrides,
} from "./keyboardShortcuts";
import { ShortcutTooltip } from "./Tooltip";
import { KeyboardSettingsPanel } from "./KeyboardSettings";
import { AboutSettingsPanel } from "./AboutSettings";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { eventDetail, eventTitle } from "./eventDisplay";
import {
  AtSign,
  BarChart3,
  Brain,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  CircleDashed,
  Cloud,
  Copy,
  Ellipsis,
  File,
  Folder,
  FolderPlus,
  FolderX,
  FolderOpen,
  GitBranch,
  Hand,
  Loader2,
  MessageSquareX,
  MessageSquareText,
  Mic,
  MicOff,
  Monitor,
  Moon,
  PanelRight,
  Paperclip,
  Play,
  RefreshCw,
  Send,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  SquarePen,
  Sun,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Type,
  User,
  X,
} from "lucide-react";
import {
  attachmentLabel,
  attachmentMention,
  composerPromptForSend,
  continueNumberedList,
  insertPastedComposerText,
  promptMentionsAttachment,
  rankSkillMatches,
} from "./composerText";
import { restoreUnsavedDraft, unsavedDraftScopeFor } from "./unsavedDraft";
import { AssistantMessage } from "./assistantMessage";
import { normalizeReviewFile, type ReviewFile as NormalizedReviewFile } from "../shared/reviewDiff";
import { isArtifactPath } from "../shared/artifactReview";
import type { DocumentReviewSnapshot } from "../shared/documentReview";
import { appendTaskEvent, appendTaskEvents, compactTaskEvents, removeResponseFeedback } from "../shared/taskEvents";
import {
  responseFeedbackReasons,
  type ResponseFeedbackReason,
  type ResponseRating,
} from "../shared/responseFeedback";
import { ReviewPanel } from "./review/ReviewPanel";
import { defaultModelEndpointSettings } from "./endpointSettings";
import { ConnectionSettingsPanel, useConnectionSettings } from "./ConnectionSettings";
import { AppearanceSettingsPanel } from "./AppearanceSettings";
import { VoiceSettings } from "./VoiceSettings";
import { SettingsNav, type SettingsTab } from "./SettingsNav";
import { TelemetrySettingsPanel } from "./TelemetrySettings";
import { RemoteChatBadge, RemoteHostPicker } from "./RemoteControls";
import { RemoteSettingsPanel, useRemoteSettings } from "./RemoteSettings";
import { appendReviewFeedback, reviewCommentLineLabel, visibleReviewPrompt, type ReviewCommentDraft, type ReviewFeedbackReference } from "./review/reviewComments";
import {
  reducePendingPermission,
  reduceVisibleTask,
  taskEventEffects,
  type TaskPermissionRequest,
} from "./taskEventReducer";
import { composerTimelineFromEvents } from "./composerTimeline";
import {
  pendingPermissionFromEvents,
  reconcileActivityDisclosureState,
} from "./composerActivity";
import { copyPlainText } from "./copyPlainText";
import {
  AssistantAnswerContent,
  MarkdownContent,
} from "./markdownContent";
import { useActivityTuckDelay } from "./activityTuck";
import { WorkingBlock } from "./workingBlock";
import { filterSkillsBySource, skillPreviewMarkdown } from "./skillDisplay";
import { reviewCloseSpring, reviewOpenSpring, reviewSpringStep, type ReviewSpring } from "./reviewSpring";
import {
  cssFontValue,
  defaultMonoFontChoices,
  defaultUiFontChoices,
  localFontAccessAvailable,
  listLocalFontFamilies,
  readAppearanceSettings,
  readWorkspaceMode,
  uniqueFonts,
  writeAppearanceSettings,
  writeWorkspaceMode,
} from "./appearanceStorage";
import { AttachmentPreviewList, normalizeAttachment } from "./attachmentPreview";
import {
  ComposerGreeting,
  DocumentReviewResponseLink,
  ModelStartupNotice,
  ReviewSummaryCard,
} from "./composerChrome";
import {
  clamp,
  followElementToBottom,
  isElementAtBottom,
  isElementNearBottom,
  placeElementAtBottom,
} from "./composerScroll";
import { defaultHarnessProfileId, isHarnessProfileId } from "./harnessProfile";
import { HarnessSettingsPanel } from "./HarnessSettings";
import {
  MentionMatchText,
  mentionAtCursor,
  mentionCategories,
  mentionCategoryIcon,
  renderPromptHighlights,
  skillMention,
  type MentionCategoryId,
} from "./promptMentions";
import { SkillsSettingsPanel } from "./SkillsSettings";
import { formatFileSize, taskStatusDetail, taskStatusTitle } from "./taskStatusDisplay";
import { CompactionRow } from "./compactionRow";
import { providerReconnectFromEvents } from "./connectionStatus";
import { ConnectionNotice } from "./connectionNotice";
import { ErrorToast } from "./errorToast";
import { IdeIcon } from "./ideLogos";

export const streamingMarkdownRenderBatchIntervalMs = 50;
const maxCachedTaskEventGroups = 24;
const isMacLike = /Mac|iPhone|iPad/i.test(navigator.platform);
const defaultStartupSettings: DesktopStartupSettings = {
  // Matches the main-process default so a failed startup read does not flip modes.
  permissionMode: "auto_safe",
  modelEndpoint: defaultModelEndpointSettings,
  companyConnection: { state: "not_enrolled" },
  harnessProfile: defaultHarnessProfileId,
  contextLength: DEFAULT_CONTEXT_LENGTH,
  reasoningEffort: DEFAULT_REASONING_EFFORT,
  showThinking: false, webTools: false,
};
const initialPrompt = "";
const emptyReviewFiles: ReviewFile[] = [];
const defaultIdeChoices: IdeChoice[] = [
  { id: "code", label: "VS Code", icon: "vscode" },
  { id: "visualstudio", label: "Visual Studio", icon: "visualstudio" },
  { id: "explorer", label: isMacLike ? "Finder" : "Explorer", icon: isMacLike ? "finder" : "explorer" },
];
const previewBuildEnabled =
  typeof __UMBRATIC_PREVIEW_BUILD__ !== "undefined" && __UMBRATIC_PREVIEW_BUILD__;
const composerTestMode =
  previewBuildEnabled && window.__UMBRATIC_PREVIEW__ === true;

const previewEnvironment = composerTestMode
  ? window.__UMBRATIC_PREVIEW_ENVIRONMENT__ ?? null
  : null;
let api: DesktopApi;

function appendBackendEvent(events: BackendUiEvent[], event: BackendUiEvent, limit = 500): BackendUiEvent[] {
  return appendTaskEvent(events, event, limit) as BackendUiEvent[];
}

function appendBackendEvents(events: BackendUiEvent[], batch: readonly BackendUiEvent[], limit = 500): BackendUiEvent[] {
  return appendTaskEvents(events, batch, limit) as BackendUiEvent[];
}

export function compactBackendEvents(events: BackendUiEvent[], limit = 500): BackendUiEvent[] {
  return compactTaskEvents(events, limit) as BackendUiEvent[];
}

export function takeBatchedBackendEvents(pendingEvents: BackendUiEvent[]): BackendUiEvent[] {
  return pendingEvents.splice(0);
}

const sidebarDefaultWidth = 230;
const sidebarMinWidth = 168;
const sidebarMaxWidth = 230;
const reviewMinWidth = 360;
const reviewDefaultWidth = 440;
const reviewOpenWidthRatio = 0.65;
const reviewMaxWidthRatio = 0.95;
const sidebarMaxRatio = 0.28;

function App({ startupSettings }: { startupSettings: DesktopStartupSettings }) {
  const initialHarnessProfile = isHarnessProfileId(startupSettings.harnessProfile) ? startupSettings.harnessProfile : defaultHarnessProfileId;
  const initialContextLength = normalizeContextLength(startupSettings.contextLength);
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  const [repository, setRepository] = useState<RepositoryInfo | null>(previewEnvironment?.repository ?? null);
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>(startupSettings.permissionMode);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(() => readWorkspaceMode());
  const [projects, setProjects] = useState<RepositoryInfo[]>(previewEnvironment ? [previewEnvironment.repository] : []);
  const [chats, setChats] = useState<ChatRecord[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [task, setTask] = useState<TaskInfo | null>(previewEnvironment?.task ?? null);
  const [prompt, setPrompt] = useState(previewEnvironment?.prompt ?? initialPrompt);
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedComposerPrompt[]>([]);
  const unsavedDraftScope = unsavedDraftScopeFor(repository?.rootPath);
  const [steerPending, setSteerPending] = useState(false);
  const [reviewPromptFeedback, setReviewPromptFeedback] = useState<ReviewCommentDraft[]>([]);
  const [reviewFeedbackDialogOpen, setReviewFeedbackDialogOpen] = useState(false);
  const [reviewFeedbackPreview, setReviewFeedbackPreview] = useState<ReviewFeedbackReference[] | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<ChatAttachment[]>(previewEnvironment?.attachments ?? []);
  const [previewAttachment, setPreviewAttachment] = useState<ChatAttachment | null>(null);
  const [fileMatches, setFileMatches] = useState<FileSearchResult[]>([]);
  const [mention, setMention] = useState<PromptMention | null>(null);
  const [mentionScope, setMentionScope] = useState<MentionCategoryId | null>(null);
  const [selectedCategoryIndex, setSelectedCategoryIndex] = useState(0);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [selectedSkillIndex, setSelectedSkillIndex] = useState(0);
  const [promptScrollTop, setPromptScrollTop] = useState(0);
  const [deleteCandidate, setDeleteCandidate] = useState<DeleteCandidate | null>(null);
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<Set<string>>(() => new Set());
  const [collapsedWorktreeKeys, setCollapsedWorktreeKeys] = useState<Set<string>>(() => new Set());
  // True while the modifier that jumps to a chat is held down, which is when
  // the sidebar wears its numbers. Holding the key is how the shortcut is
  // discovered at all: the rows say nothing about it the rest of the time.
  const [chatJumpKeysVisible, setChatJumpKeysVisible] = useState(false);
  const [projectActionMenuKey, setProjectActionMenuKey] = useState<string | null>(null);
  const [events, setEvents] = useState<BackendUiEvent[]>(previewEnvironment?.events ?? []);
  const [responseFeedbackDialog, setResponseFeedbackDialog] = useState<ResponseFeedbackDialogState | null>(null);
  const [responseFeedbackSubmitting, setResponseFeedbackSubmitting] = useState(false);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [expandedReviewPaths, setExpandedReviewPaths] = useState<Set<string>>(() =>
    previewEnvironment ? new Set(previewEnvironment.reviewFiles.map((file) => file.path)) : new Set(),
  );
  const [expandedActivityIds, setExpandedActivityIds] = useState<Set<string>>(() => new Set());
  const autoOpenedActivityIdsRef = useRef<Set<string>>(new Set());
  const [expandedActivityToolIds, setExpandedActivityToolIds] = useState<Set<string>>(() => new Set());
  const [activityClock, setActivityClock] = useState(() => Date.now());
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewClosing, setReviewClosing] = useState(false);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [reviewTargetPath, setReviewTargetPath] = useState<string | undefined>();
  const [workspaceReview, setWorkspaceReview] = useState<{ reviewFiles: ReviewFile[]; baselineOid: string } | null>(null);
  /** Workspace currently being indexed for the first time, if any. */
  const [indexingWorkspace, setIndexingWorkspace] = useState<string | null>(null);
  const [tasklessReviewScope, setTasklessReviewScope] = useState<"task" | "worktree">("task");
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [checkoutPending, setCheckoutPending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The dictation offer, raised by pressing a microphone that is not set up.
  const [dictationSetupOffer, setDictationSetupOffer] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("account");
  const [harnessProfile, setHarnessProfile] = useState<HarnessProfileId>(initialHarnessProfile);
  const [harnessDraftProfile, setHarnessDraftProfile] = useState<HarnessProfileId>(initialHarnessProfile);
  const [contextLength, setContextLength] = useState(initialContextLength);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(
    isReasoningEffort(startupSettings.reasoningEffort) ? startupSettings.reasoningEffort : DEFAULT_REASONING_EFFORT,
  );
  const [showThinking, setShowThinking] = useState(startupSettings.showThinking === true);
  const [harnessDraftContextLength, setHarnessDraftContextLength] = useState(initialContextLength);
  const [harnessMessage, setHarnessMessage] = useState<string | null>(null);
  const [harnessSaving, setHarnessSaving] = useState(false);
  const [harnessSaveFeedback, setHarnessSaveFeedback] = useState<"idle" | "saved">("idle");
  const [appearanceSettings, setAppearanceSettings] = useState<AppearanceSettings>(() => {
    const saved = readAppearanceSettings();
    const fixtureTheme = previewEnvironment?.params.get("theme");
    return previewEnvironment && (fixtureTheme === "light" || fixtureTheme === "dark")
      ? { ...saved, theme: fixtureTheme }
      : saved;
  });
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true);
  const [availableFontFamilies, setAvailableFontFamilies] = useState<string[]>(() =>
    uniqueFonts([...defaultUiFontChoices, ...defaultMonoFontChoices]),
  );
  const [fontScanMessage, setFontScanMessage] = useState<string | null>(null);
  const [fontScanPending, setFontScanPending] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [skillsEnabled, setSkillsEnabled] = useState<Record<string, boolean>>({});
  const [skillsMessage, setSkillsMessage] = useState<string | null>(null);
  const [localLogsBusy, setLocalLogsBusy] = useState(false);
  const [newSkillFormOpen, setNewSkillFormOpen] = useState(false);
  const [newSkillName, setNewSkillName] = useState("");
  const [creatingSkill, setCreatingSkill] = useState(false);
  const [skillSourceFilter, setSkillSourceFilter] = useState<SkillSourceFilter>("local");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [skillDocument, setSkillDocument] = useState<SkillDocument | null>(null);
  const [skillPreviewLoading, setSkillPreviewLoading] = useState(false);
  const [ideMenuOpen, setIdeMenuOpen] = useState<"composer" | "review" | null>(null);
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [availableIdes, setAvailableIdes] = useState<IdeChoice[]>(defaultIdeChoices);
  const [selectedIdeId, setSelectedIdeId] = useState(defaultIdeChoices[0].id);
  const [sidebarWidth, setSidebarWidth] = useState(sidebarDefaultWidth);
  const [reviewWidth, setReviewWidth] = useState(reviewDefaultWidth);
  const [reviewHasSessionWidth, setReviewHasSessionWidth] = useState(false);
  const [showElevatedPermissionsDialog, setShowElevatedPermissionsDialog] = useState(false);
  // Closing the "Starting model…" card hides this load, not the next one.
  const [modelStartupDismissed, setModelStartupDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connectionSettings = useConnectionSettings({
    api,
    backend,
    initialSettings: startupSettings.modelEndpoint,
    initialConnection: startupSettings.companyConnection,
    settingsOpen,
    active: settingsTab === "account",
    onBackendStatus: (status) => {
      setBackend(status);
      setPermissionModeState(status.permissionMode);
    },
  });
  const remoteSettings = useRemoteSettings({ api, active: settingsOpen });
  // Where the next run happens. A chat that has already started keeps the host
  // it started on: the runner, its session, and its workspace all live there.
  const [remoteConnectionId, setRemoteConnectionId] = useState("");
  const [remoteDirectory, setRemoteDirectory] = useState("");
  const activeRemote = task?.remote;
  const pendingRemote = remoteSettings.connections.find((connection) => connection.id === remoteConnectionId);
  // What the chat header says. A chat that has run names the host it ran on;
  // one that has not yet run names the host it is about to use, so the choice
  // is visible before it matters rather than only after.
  const remoteBadge = activeRemote
    ?? (pendingRemote ? { name: pendingRemote.name, directory: remoteDirectory || pendingRemote.defaultDirectory } : null);
  // Opening a chat adopts the host it belongs to. A chat that ran here shows
  // this computer again, rather than inheriting the previous chat's remote.
  useEffect(() => {
    if (!task) return;
    setRemoteConnectionId(task.remote?.connectionId ?? "");
    setRemoteDirectory(task.remote?.directory ?? "");
  }, [task?.id, task?.remote?.connectionId, task?.remote?.directory]);
  const endpointSettings = connectionSettings.settings;
  const endpointDraftSettings = connectionSettings.draft;
  const streamRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentMenuRef = useRef<HTMLDivElement | null>(null);
  // Where the caret was the last time the composer was touched. Null until it
  // is touched at all, which dictation has to tell apart from a caret at 0.
  const promptCaretRef = useRef<number | null>(null);
  const dictation = useDictation(api, (text) => {
    setPrompt((current) => {
      const next = insertTranscript(current, promptCaretRef.current, text);
      promptCaretRef.current = next.caret;
      return next.prompt;
    });
    textareaRef.current?.focus();
  });
  // What the server advertises, or — locally — a downloaded dictation model. Not whether one is loaded: the mic press loads it.
  const dictationAvailable = backend?.veilFeatures.includes("speech.transcribe") === true || backend?.localDictationReady === true;
  const draftSaveRef = useRef<number | null>(null);
  const lastPersistedDraftRef = useRef<Map<string, { draftPrompt: string; filesSignature: string }>>(new Map());
  const reviewAnimationRef = useRef<number | null>(null);
  const reviewOffsetRef = useRef(0);
  const reviewVelocityRef = useRef(0);
  const reviewScopeRequestRef = useRef(0);
  const modalTriggerRef = useRef<HTMLElement | null>(null);
  const modalRef = useRef<HTMLElement | null>(null);
  const responseFeedbackInputRef = useRef<HTMLTextAreaElement | null>(null);
  const skillsSaveSequenceRef = useRef(0);
  const skillsLoadedRef = useRef(false);
  const suppressDraftSaveRef = useRef(false);
  // Read by the async unsaved-draft restore, which must see the live value
  // rather than the one captured when it started.
  const activeChatIdRef = useRef<string | null>(null);
  activeChatIdRef.current = activeChatId;
  const reviewRefreshRef = useRef(false);
  const appBlurredRef = useRef(false);
  const startTaskInFlightRef = useRef(false);
  const chatSelectionSequenceRef = useRef(0);
  const focusRefreshTimerRef = useRef<number | null>(null);
  const followComposerScrollRef = useRef(true);
  const forceComposerBottomScrollRef = useRef(false);
  const composerScrollInputRef = useRef(false);
  const activityBodyRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const activityFollowScrollRef = useRef<Map<string, boolean>>(new Map());
  const activityScrollInputRef = useRef<Set<string>>(new Set());
  // What each keyboard shortcut does, and whether any of them may fire. Refs
  // rather than effect dependencies: see where they are filled in below.
  const shortcutActionsRef = useRef<Partial<Record<ShortcutId, () => void>>>({});
  // The numbered rows, read by the one key listener below. Same reason as the
  // action table beside it: the listener subscribes once and the sidebar is
  // rebuilt on every chat that arrives.
  const chatJumpTargetsRef = useRef<ChatRecord[]>([]);
  const shortcutsBlockedRef = useRef(false);
  const visibleTaskIdRef = useRef<string | null>(previewEnvironment?.task.id ?? null);
  const taskEventsByTaskIdRef = useRef<Map<string, BackendUiEvent[]>>(new Map());

  const latestTaskId = task?.id;
  const rawReviewFiles = task?.reviewFiles ?? workspaceReview?.reviewFiles ?? emptyReviewFiles;
  // Review refreshes usually return byte-identical files. Reusing the previous
  // object for an unchanged path keeps identity stable, so the open file's
  // side-by-side alignment memo survives the refresh instead of recomputing.
  const normalizedReviewFilesRef = useRef(new Map<string, ReviewFile>());
  const reviewFiles = useMemo(() => {
    const previous = normalizedReviewFilesRef.current;
    const byPath = new Map<string, ReviewFile>();
    for (const file of rawReviewFiles) {
      const normalized = normalizeReviewFile(file);
      const cached = previous.get(normalized.path);
      byPath.set(
        normalized.path,
        cached && cached.contentHash === normalized.contentHash ? cached : normalized,
      );
    }
    normalizedReviewFilesRef.current = byPath;
    return Array.from(byPath.values());
  }, [rawReviewFiles]);
  const documentReviewFiles = useMemo(() => reviewFiles.filter((file) => isArtifactPath(file.path)), [reviewFiles]);
  const codeReviewFiles = useMemo(() => reviewFiles.filter((file) => !isArtifactPath(file.path)), [reviewFiles]);
  const codeReviewTotals = useMemo(
    () =>
      codeReviewFiles.reduce(
        (total, file) => {
          total.additions += file.additions;
          total.deletions += file.deletions;
          return total;
        },
        { additions: 0, deletions: 0 },
      ),
    [codeReviewFiles],
  );
  const selectedIde = availableIdes.find((ide) => ide.id === selectedIdeId) ?? availableIdes[0] ?? defaultIdeChoices[0];
  const selectedModel = backend?.model ?? null;
  const [serverModels, setServerModels] = useState<ServerModelInfo[]>([]);
  // What is on this computer and ready to load. Local mode runs one model per
  // Veil process, so the backend only ever reports the loaded one — but the
  // choice a person actually has is every chat model they have downloaded, and
  // switching is what the picker is for. Dictation weights are excluded by the
  // kind, not by a filter here: an ASR model cannot answer a prompt.
  const [downloadedChatModels, setDownloadedChatModels] = useState<LocalCatalogModel[]>([]);
  // Availability is a server concept: it comes from the published registry,
  // which reports whether each model's process is answering right now.
  const composerModels = useMemo<ComposerModelOption[]>(
    () => {
      if (endpointSettings.mode === "server" && serverModels.length > 0) {
        return serverModels.map((model) => ({
          id: model.id,
          label: model.display,
          available: model.available,
        }));
      }
      if (endpointSettings.mode === "local" && downloadedChatModels.length > 0) {
        return downloadedChatModels.map((model) => ({
          id: model.id,
          label: model.displayName,
        }));
      }
      return (backend?.models ?? []).map((model) => ({
        id: model.modelId,
        label: model.displayName,
      }));
    },
    [backend?.models, downloadedChatModels, endpointSettings.mode, selectedModel, serverModels],
  );
  // Re-read when the mode changes and when a different model finishes loading:
  // the second is what a download completing looks like from here.
  useEffect(() => {
    if (endpointSettings.mode !== "local") {
      setDownloadedChatModels([]);
      return;
    }
    void refreshDownloadedChatModels();
  }, [endpointSettings.mode, selectedModel?.modelId]);
  // The levels the selected model reads. Empty for a model that takes no
  // direction on how hard to think, which is what keeps the section out of the
  // menu rather than showing a choice the chat template would ignore.
  const modelReasoningEfforts = selectedModel?.capabilities?.reasoningEfforts ?? [];
  const harnessDirty = harnessDraftProfile !== harnessProfile || harnessDraftContextLength !== contextLength;
  const harnessDraftContextIndex = Math.max(
    0,
    CONTEXT_LENGTH_OPTIONS.findIndex((option) => option === harnessDraftContextLength),
  );
  // A local model is reading itself into memory. The Connection panel says so
  // inline, so the floating card is for every other moment — above all the one
  // the composer's picker starts, where Settings is closed and the only other
  // sign of life would be an app that has stopped answering.
  const localModelStarting =
    connectionSettings.localModelLoading
    && endpointSettings.mode === "local"
    && !(settingsOpen && settingsTab === "account");
  const startingModelName =
    downloadedChatModels.find((model) => model.id === endpointDraftSettings.modelId)?.displayName
    || endpointDraftSettings.modelId
    || "the model";
  // Pressing the microphone loads the speech weights before the device opens,
  // and in local mode that is the slow part of the first dictation of a
  // session. Same card, same reason: a control that spins in silence for
  // twenty seconds reads as a control that did nothing. But only when the
  // main process says a load is actually happening — a warm press is over in
  // a beat, and a card flashing "loading the model" on every dictation taught
  // the user the card means nothing.
  const dictationStarting = dictation.status.state === "starting" && dictation.status.loadingModel === true;
  useEffect(() => {
    if (!connectionSettings.localModelLoading && !dictationStarting) setModelStartupDismissed(false);
  }, [connectionSettings.localModelLoading, dictationStarting]);
  const telemetrySyncEnabled = backend?.diagnostics.telemetry.syncEnabled ?? endpointSettings.mode === "server";
  const localLogInfo = backend?.diagnostics.localLogs ?? { bytes: 0, entries: 0 };
  const activeChat = activeChatId ? chats.find((chat) => chat.id === activeChatId) : undefined;
  const closedChatNotice = closedChatMessage(task?.state ?? activeChat?.taskState);
  const isGenerating = task?.state === "running";
  const hasComposerMessage = prompt.trim().length > 0 || reviewPromptFeedback.length > 0;
  const activeQueuedPrompts = task ? queuedPrompts.filter((item) => item.taskId === task.id) : [];
  // Only the files the prompt does not already name get a chip. An `@` mention
  // is drawn in the text where it was typed, so a chip beside it would be the
  // same reference twice; the paperclip count still covers both kinds.
  const pickedAttachments = attachedFiles.filter(
    (file) => !promptMentionsAttachment(prompt, normalizeAttachment(file)),
  );
  const canStart = (prompt.trim().length > 0 || reviewPromptFeedback.length > 0) && !busy && !isGenerating && !closedChatNotice;
  const canQueue = hasComposerMessage && isGenerating && !busy && !steerPending && !closedChatNotice;
  // Per file, never per turn: undo puts one reviewed file back, and taking
  // back more than that is a thing to ask the model for.
  const canUndoFile =
    !!task && task.state !== "approved" && task.state !== "merged" && task.state !== "rejected" && task.state !== "completed" && !busy;
  const canOpenIde = !!task && task.state !== "merged" && task.state !== "rejected" && task.state !== "completed";
  const approvalPending = task?.state === "awaiting_worktree_approval" || !!pendingPermission;
  const reviewEmptyLabel = !task
    ? "No active review"
    : task.state === "review_ready"
      ? "No file changes found"
      : stateLabel(task.state);
  const mentionQuery = mention?.query ?? "";
  // The @ menu walks through modes: "category" (just pressed @ — pick Files,
  // Folders, or Skills), a scoped search, or "all" (typed straight through the
  // category list). The $ trigger jumps directly to skills.
  const mentionMode: "category" | FileSearchKind | "skill" | null = !mention
    ? null
    : mention.kind === "skill" || mentionScope === "skill"
      ? "skill"
      : mentionScope === "file" || mentionScope === "folder"
        ? mentionScope
        : mentionQuery
          ? "all"
          : "category";
  const promptReferenceMenuOpen = mentionMode !== null;
  const categoryMenuOpen = mentionMode === "category";
  const fileSearchKind: FileSearchKind | null =
    mentionMode === "file" || mentionMode === "folder" || mentionMode === "all" ? mentionMode : null;
  const attachmentSearchQuery = fileSearchKind ? mentionQuery : "";
  const skillMenuOpen = mentionMode === "skill";
  const skillSearchQuery = skillMenuOpen ? mentionQuery : "";
  const skillMatches = useMemo(() => rankSkillMatches(skills, skillSearchQuery, 10), [skillSearchQuery, skills]);
  const selectedSkillPreview = useMemo(
    () => (skillDocument ? skillPreviewMarkdown(skillDocument.content, skillDocument.name) : ""),
    [skillDocument],
  );
  const visibleSkills = useMemo(
    () => filterSkillsBySource(skills, skillSourceFilter),
    [skillSourceFilter, skills],
  );
  const canAttachFiles = !busy && !closedChatNotice;
  const canUseWorktreeMode = repository?.kind === "git";
  const activeTaskWorkspaceMode = task?.chatId === activeChatId ? task.workspaceMode : undefined;
  const activeChatWorktreeTaskId = activeChat?.worktreeRootTaskId || (activeChat?.worktreePath ? activeChat.taskId : undefined);
  const workspaceModeLocked = activeTaskWorkspaceMode === "worktree" || !!activeChatWorktreeTaskId;
  const useWorktreeForNextRun = canUseWorktreeMode && (workspaceModeLocked || workspaceMode === "worktree");
  const visibleEvents = events;
  const responseFeedback = useMemo(() => {
    const ratings = new Map<string, "good" | "bad">();
    for (const event of visibleEvents) {
      if (event.type === "response.feedback") {
        ratings.set(event.messageId, event.rating);
      }
    }
    return ratings;
  }, [visibleEvents]);
  const composerItems = useMemo(() => {
    const items = composerTimelineFromEvents(visibleEvents, task?.prompt, task?.state);
    // Soft bound for very long chats: keep the newest composer items without a full virtualizer rewrite.
    const composerItemSoftLimit = 120;
    return items.length <= composerItemSoftLimit ? items : items.slice(-composerItemSoftLimit);
  }, [task?.prompt, task?.state, visibleEvents]);
  const keepFinishedOpen = useActivityTuckDelay(composerItems);
  const lastAssistantItemId = [...composerItems].reverse().find((item) => item.type === "assistant")?.id;
  const reviewReadyForDisplay =
    task?.state === "review_ready"
    || task?.state === "approving"
    || task?.state === "approved"
    || task?.state === "merged"
    || task?.state === "rejected";
  const runnerContextUsage = useMemo(() => {
    for (let index = visibleEvents.length - 1; index >= 0; index -= 1) {
      const event = visibleEvents[index];
      if (event.type === "context.usage") return event;
    }
    return null;
  }, [visibleEvents]);
  // The meter's own busy state, read from the compaction lifecycle rather than
  // inferred from a stale usage number: while the prefix is being rewritten the
  // figure on the ring describes a conversation that no longer exists.
  const contextCompacting = useMemo(() => {
    for (let index = visibleEvents.length - 1; index >= 0; index -= 1) {
      const event = visibleEvents[index];
      if (event.type === "context.compaction") return event.phase === "started";
    }
    return false;
  }, [visibleEvents]);
  const providerReconnect = useMemo(
    () => providerReconnectFromEvents(visibleEvents),
    [visibleEvents],
  );
  const contextMeterLabel = contextMeterState(runnerContextUsage);
  const contextEstimateMessages = useMemo<ContextEstimateMessage[]>(() => {
    const messages = runnerContextUsage ? [] : composerItems.map((item): ContextEstimateMessage => {
      if (item.type === "user") return { text: item.rawText, attachments: item.attachedFiles };
      if (item.type === "assistant") return { text: item.text };
      // A compaction marker is UI, not conversation: it contributes no tokens
      // to the context it is describing.
      if (item.type === "compaction") return { text: "" };
      return {
        text: item.segments
          .map((segment) =>
            segment.type === "reasoning"
              ? segment.text
              : segment.type === "skill"
                ? segment.skillId
                : [segment.run.command, segment.run.stdout, segment.run.stderr].filter(Boolean).join("\n"),
          )
          .filter(Boolean)
          .join("\n"),
      };
    });
    if (prompt.trim() || attachedFiles.length) messages.push({ text: prompt, attachments: attachedFiles });
    return messages;
  }, [attachedFiles, composerItems, prompt, runnerContextUsage]);
  const contextEstimate = useMemo(
    () => estimateContextUsage(
      contextEstimateMessages,
      runnerContextUsage?.contextLength ?? contextLength,
      runnerContextUsage
        ? {
            contentTokens: runnerContextUsage.contentTokens,
            reserveTokens: prompt.trim() || attachedFiles.length ? undefined : runnerContextUsage.reserveTokens,
            protectedTokens: runnerContextUsage.protectedTokens,
          }
        : undefined,
    ),
    [attachedFiles.length, contextEstimateMessages, contextLength, prompt, runnerContextUsage],
  );
  // What the composer adds on top of whatever the runner last reported. Before
  // the first response there is no measured base, and the local estimate folds
  // the protected reserve into contentTokens, so that reserve is subtracted
  // here — otherwise the draft row would report the system prompt as typing.
  const composerDraftTokens = Math.max(
    0,
    contextEstimate.contentTokens - (runnerContextUsage?.contentTokens ?? contextEstimate.protectedTokens),
  );
  const showContextMeter = shouldShowContextMeter({
    hasRunnerUsage: !!runnerContextUsage,
    timelineItemCount: composerItems.length,
    prompt,
    attachmentCount: attachedFiles.length,
  });
  const chatProjectGroups = useMemo(() => {
    type ChatProjectGroupBuilder = ChatProjectGroup & { worktreeMap: Map<string, WorktreeChatGroup> };
    const groups = new Map<string, ChatProjectGroupBuilder>();
    for (const project of projects) {
      groups.set(project.rootPath, {
        key: project.rootPath,
        name: project.name,
        path: project.rootPath,
        chats: [],
        worktrees: [],
        worktreeMap: new Map(),
      });
    }
    for (const chat of chats) {
      const key = chatProjectKey(chat);
      let existing = groups.get(key);
      if (!existing) {
        existing = {
          key,
          name: chat.repositoryName || folderName(chat.repositoryPath),
          path: chat.repositoryPath,
          chats: [],
          worktrees: [],
          worktreeMap: new Map(),
        };
        groups.set(key, existing);
      }
      const worktreeKey = chatWorktreeKey(chat);
      if (worktreeKey && chat.worktreePath) {
        let worktree = existing.worktreeMap.get(worktreeKey);
        if (!worktree) {
          worktree = {
            key: worktreeKey,
            rootTaskId: chat.worktreeRootTaskId || chat.taskId || worktreeKey,
            branch: chat.worktreeBranch || folderName(chat.worktreePath),
            path: chat.worktreePath,
            baseCommit: chat.worktreeBaseCommit,
            chats: [],
          };
          existing.worktreeMap.set(worktreeKey, worktree);
        }
        worktree.chats.push(chat);
      } else {
        existing.chats.push(chat);
      }
    }
    return Array.from(groups.values())
      .map((group) => ({
        key: group.key,
        name: group.name,
        path: group.path,
        chats: [...group.chats].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
        worktrees: Array.from(group.worktreeMap.values())
          .map((worktree) => ({
            ...worktree,
            chats: [...worktree.chats].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
          }))
          .sort((left, right) => {
            const leftUpdated = left.chats[0]?.updatedAt ?? "";
            const rightUpdated = right.chats[0]?.updatedAt ?? "";
            return rightUpdated.localeCompare(leftUpdated) || worktreeTitle(left).localeCompare(worktreeTitle(right));
          }),
      }))
      .sort((left, right) => {
        if (left.key === "__unassigned__") return 1;
        if (right.key === "__unassigned__") return -1;
        return left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) || left.key.localeCompare(right.key);
      });
  }, [chats, projects]);
  // Position badges for the visible rows, and the rows themselves in that same
  // order — one is what the sidebar draws while the modifier is down, the other
  // is what a number press lands on, and they cannot be allowed to disagree.
  const visibleChats = useMemo(
    () => visibleChatOrder(chatProjectGroups, collapsedProjectKeys, collapsedWorktreeKeys),
    [chatProjectGroups, collapsedProjectKeys, collapsedWorktreeKeys],
  );
  const chatJumpNumbersById = useMemo(() => chatJumpNumbers(visibleChats), [visibleChats]);
  const layoutStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    "--sidebar-reserved-width": `${sidebarDefaultWidth}px`,
    "--sidebar-visual-gap": `${Math.max(0, sidebarDefaultWidth - sidebarWidth)}px`,
    "--review-width": `${reviewWidth}px`,
  } as React.CSSProperties;
  const reviewLayoutOpen = reviewOpen || reviewClosing;
  const todayPromptLabel = repository ? `What should we build in ${repository.name}?` : "What should we build today?";
  // Shown only while the *open* workspace is being indexed for the first time.
  // The artifact lives outside the workspace, so nothing in the user's own tree
  // hints that work is happening; without this the first open just feels slow.
  const indexingThisWorkspace = !!indexingWorkspace && !!repository
    && samePathKey(indexingWorkspace, repository.rootPath);
  const composerHeaderTitle = activeChat
    ? chatDisplayTitle(activeChat)
    : task?.prompt
      ? titleFromPrompt(task.prompt)
      : "New chat";
  const composerHeaderMeta = repository?.name ?? "No folder selected";
  const effectiveTheme = appearanceSettings.theme === "system" ? (systemPrefersDark ? "dark" : "light") : appearanceSettings.theme;
  const uiFontOptions = useMemo(
    () => uniqueFonts([...defaultUiFontChoices, appearanceSettings.uiFont, ...availableFontFamilies]),
    [appearanceSettings.uiFont, availableFontFamilies],
  );
  const monoFontOptions = useMemo(
    () => uniqueFonts([...defaultMonoFontChoices, appearanceSettings.monoFont, ...availableFontFamilies]),
    [appearanceSettings.monoFont, availableFontFamilies],
  );

  function cacheTaskEvents(nextEvents: BackendUiEvent[]) {
    if (!nextEvents.length) return;
    const grouped = new Map<string, BackendUiEvent[]>();
    for (const event of nextEvents) {
      const group = grouped.get(event.taskId) ?? [];
      group.push(event);
      grouped.set(event.taskId, group);
    }
    for (const [taskId, group] of grouped) {
      const cached = taskEventsByTaskIdRef.current.get(taskId) ?? [];
      taskEventsByTaskIdRef.current.delete(taskId);
      // Fold the batch into what is already cached rather than replaying the
      // whole task through the reducer again. This runs on every flush — about
      // twenty times a second while a run streams — so replaying was doing
      // quadratic work against a chat that only grows.
      taskEventsByTaskIdRef.current.set(taskId, appendBackendEvents(cached, group, 500));
    }
    while (taskEventsByTaskIdRef.current.size > maxCachedTaskEventGroups) {
      const oldestTaskId = taskEventsByTaskIdRef.current.keys().next().value;
      if (!oldestTaskId) break;
      taskEventsByTaskIdRef.current.delete(oldestTaskId);
    }
  }

  function cachedEventsForTask(taskId?: string): BackendUiEvent[] {
    return taskId ? (taskEventsByTaskIdRef.current.get(taskId) ?? []) : [];
  }

  function visibleEventsForTask(nextTask: TaskInfo): BackendUiEvent[] {
    const cached = cachedEventsForTask(nextTask.id);
    const persisted = nextTask.events ?? [];
    if (nextTask.state === "running" && persisted.length && cached.length) {
      const latestPersistedTime = persisted.reduce((latest, event) => {
        const current = eventTimelineTime(event);
        return current > latest ? current : latest;
      }, "");
      return compactBackendEvents([
        ...persisted,
        ...cached.filter((event) => eventTimelineTime(event) > latestPersistedTime),
      ], 500);
    }
    if (persisted.length) {
      return compactBackendEvents(persisted, 500);
    }
    return compactBackendEvents(cached, 500);
  }

  function setVisibleTask(nextTask: TaskInfo | null) {
    visibleTaskIdRef.current = nextTask?.id ?? null;
    setResponseFeedbackDialog(null);
    if (nextTask) setWorkspaceReview(null);
    setTask(nextTask);
  }

  function prepareVisibleTaskLoad(taskId: string | null) {
    visibleTaskIdRef.current = taskId;
    setResponseFeedbackDialog(null);
    setWorkspaceReview(null);
    setTask(null);
  }

  useEffect(() => {
    if (task) return;
    setWorkspaceReview(null);
    setTasklessReviewScope("task");
  }, [repository?.rootPath]);

  useEffect(() => {
    writeAppearanceSettings(appearanceSettings);
    document.documentElement.dataset.theme = effectiveTheme;
    document.documentElement.style.colorScheme = effectiveTheme;
    document.documentElement.style.setProperty(
      "--app-font",
      cssFontValue(appearanceSettings.uiFont, "system-ui, sans-serif"),
    );
    document.documentElement.style.setProperty(
      "--mono-font",
      cssFontValue(appearanceSettings.monoFont, "ui-monospace, SFMono-Regular, Consolas, monospace"),
    );
    void api.setWindowChromeTheme(effectiveTheme);
  }, [appearanceSettings, effectiveTheme]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const sync = () => setSystemPrefersDark(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  const hasRunningActivity = composerItems.some((item) => item.type === "activity" && !item.finished);

  // The published registry is refetched whenever the connection changes, and
  // again when the menu opens, so a model an administrator just started stops
  // reading as unavailable without the user reconnecting.
  useEffect(() => {
    if (endpointSettings.mode !== "server" || backend?.endpoint !== "ready") {
      setServerModels([]);
      return;
    }
    void api.listServerModels().then(setServerModels).catch(() => setServerModels([]));
  }, [endpointSettings.mode, backend?.endpoint, backend?.model?.modelId]);

  useEffect(() => {
    if (!hasRunningActivity) return undefined;
    const timer = window.setInterval(() => setActivityClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasRunningActivity]);

  useEffect(() => {
    const activeActivityToolIds = new Set<string>();
    for (const item of composerItems) {
      if (item.type !== "activity") continue;
      for (const segment of item.segments) {
        if (segment.type === "command") {
          activeActivityToolIds.add(`${item.id}:${segment.id}`);
        }
      }
    }
    setExpandedActivityIds((current) => {
      const next = reconcileActivityDisclosureState(
        current,
        composerItems,
        task?.id,
        autoOpenedActivityIdsRef.current,
        keepFinishedOpen,
      );
      autoOpenedActivityIdsRef.current = next.autoOpenedKeys;
      for (const id of next.newlyOpenedIds) {
        activityFollowScrollRef.current.set(id, true);
      }
      return next.expandedIds;
    });
    setExpandedActivityToolIds((current) => {
      let changed = false;
      const next = new Set(current);
      for (const id of next) {
        if (activeActivityToolIds.has(id)) continue;
        next.delete(id);
        changed = true;
      }
      return changed ? next : current;
    });
  }, [composerItems, keepFinishedOpen, task?.id]);

  useEffect(() => {
    void refreshStatus();
    void loadAvailableIdes();
    void loadProjects();
    void loadChats();
    void loadSkills();
    const statusTimer = window.setInterval(() => void refreshStatus(), 30000);
    const pendingBackendEvents: BackendUiEvent[] = [];
    let backendEventFlushTimer: number | null = null;
    let backendEventFlushDisposed = false;
    const scheduleBackendEventFlush = () => {
      if (backendEventFlushDisposed) return;
      if (backendEventFlushTimer) return;
      backendEventFlushTimer = window.setTimeout(flushBackendEvents, streamingMarkdownRenderBatchIntervalMs);
    };
    const flushBackendEvents = () => {
      backendEventFlushTimer = null;
      const batch = takeBatchedBackendEvents(pendingBackendEvents);
      if (batch.length === 0) return;
      cacheTaskEvents(batch);
      const visibleTaskId = visibleTaskIdRef.current;
      const visibleTaskEvents = visibleTaskId ? batch.filter((event) => event.taskId === visibleTaskId) : [];
      if (visibleTaskEvents.length) {
        setEvents((current) => appendBackendEvents(current, visibleTaskEvents, 500));
      }
      for (const event of batch) {
        const isVisibleTaskEvent = event.taskId === visibleTaskIdRef.current;
        const effects = taskEventEffects(event);
        if (isVisibleTaskEvent) {
          setTask((current) => reduceVisibleTask(current, event));
          setPendingPermission((current) => reducePendingPermission(current, event));
          if (effects.errorMessage) setError(effects.errorMessage);
          if (effects.resetExpandedReview) setExpandedReviewPaths(new Set());
          if (effects.refreshReview) {
            window.setTimeout(() => {
              if (visibleTaskIdRef.current === event.taskId) {
                void refreshTaskReviewById(event.taskId);
              }
            }, 120);
          }
        }
        if (effects.reloadChats) void loadChats();
      }
      if (pendingBackendEvents.length) scheduleBackendEventFlush();
    };
    const unsubscribe = api.onBackendEvent((event) => {
      pendingBackendEvents.push(event);
      scheduleBackendEventFlush();
    });
    const unsubscribeIndex = api.onWorkspaceIndex((event) => {
      setIndexingWorkspace(event.phase === "started" ? event.workspacePath : null);
    });
    return () => {
      window.clearInterval(statusTimer);
      backendEventFlushDisposed = true;
      if (backendEventFlushTimer) {
        window.clearTimeout(backendEventFlushTimer);
        backendEventFlushTimer = null;
        flushBackendEvents();
      }
      unsubscribe();
      unsubscribeIndex();
    };
  }, []);

  useEffect(() => {
    const markBlurred = () => {
      appBlurredRef.current = true;
    };
    const refreshOnFocus = () => {
      if (!appBlurredRef.current) return;
      appBlurredRef.current = false;
      if (!reviewOpen || busy || task?.state !== "review_ready") return;
      if (focusRefreshTimerRef.current) {
        window.clearTimeout(focusRefreshTimerRef.current);
      }
      focusRefreshTimerRef.current = window.setTimeout(() => {
        focusRefreshTimerRef.current = null;
        window.requestAnimationFrame(() => {
          void refreshActiveReview();
        });
      }, 450);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        markBlurred();
      } else {
        refreshOnFocus();
      }
    };
    window.addEventListener("blur", markBlurred);
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      if (focusRefreshTimerRef.current) {
        window.clearTimeout(focusRefreshTimerRef.current);
        focusRefreshTimerRef.current = null;
      }
      window.removeEventListener("blur", markBlurred);
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [task?.id, task?.state, busy, reviewOpen]);

  useEffect(() => {
    if (availableIdes.length > 0 && !availableIdes.some((ide) => ide.id === selectedIdeId)) {
      setSelectedIdeId(availableIdes[0].id);
    }
  }, [availableIdes, selectedIdeId]);

  useEffect(() => {
    if (!canOpenIde && ideMenuOpen === "review") setIdeMenuOpen(null);
  }, [canOpenIde, ideMenuOpen]);

  useEffect(
    () => () => {
      if (reviewAnimationRef.current !== null) window.cancelAnimationFrame(reviewAnimationRef.current);
    },
    [],
  );

  useEffect(() => {
    const hidePointerWhileTyping = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.length === 1 || event.key === "Backspace" || event.key === "Delete" || event.key === "Enter") {
        document.body.classList.add("isKeyboardTyping");
      }
    };
    const restorePointer = () => document.body.classList.remove("isKeyboardTyping");
    document.addEventListener("keydown", hidePointerWhileTyping);
    document.addEventListener("pointermove", restorePointer);
    document.addEventListener("focusout", restorePointer);
    return () => {
      restorePointer();
      document.removeEventListener("keydown", hidePointerWhileTyping);
      document.removeEventListener("pointermove", restorePointer);
      document.removeEventListener("focusout", restorePointer);
    };
  }, []);

  // Whether something is layered over the app. Shared by the focus trap below
  // and by the global shortcuts, which must not reach past a dialog to a
  // composer the user cannot currently see.
  const modalOpen =
    settingsOpen
    || !!previewAttachment?.previewDataUrl
    || !!deleteCandidate
    || showElevatedPermissionsDialog
    || approvalPending
    || !!responseFeedbackDialog;

  /** Opens the microphone, or offers the way in when dictation is not set up. */
  function toggleDictation() {
    // Mid-flight is not a state to interrupt: the model is being fetched or
    // the audio is being transcribed, and both finish on their own.
    if (dictation.status.state === "starting" || dictation.status.state === "transcribing") return;
    // Pressed while dictation is off, the shortcut answers the way the
    // microphone button does — by offering the way in rather than by doing
    // nothing and reading as a broken key.
    if (!dictationAvailable) {
      setDictationSetupOffer(true);
      return;
    }
    dictation.toggle();
  }

  function openSettings(tab?: SettingsTab) {
    if (tab) setSettingsTab(tab);
    setSettingsOpen(true);
    connectionSettings.clearMessage();
    setFontScanMessage(null);
    void refreshStatus();
    void loadSkills();
  }

  /**
   * The app's own keyboard shortcuts.
   *
   * One document-level listener dispatching off the same table the Keyboard
   * settings page prints and the tooltips advertise, so a chord that fires and
   * a chord that is documented cannot drift apart. It runs on capture, because
   * the composer textarea holds focus almost all the time and a chord caught
   * there would never reach the window.
   */
  // Rewritten every render and read through a ref, so the one listener below
  // can subscribe once and still call today's closures. A dependency list here
  // would have to name everything these actions read — the draft, the
  // attachments, the run — and the day it missed one, a shortcut would quietly
  // act on a stale copy of the composer.
  shortcutActionsRef.current = {
    "dictation.toggle": toggleDictation,
    "chat.new": () => void newChat(),
    // Raises the same confirmation the sidebar's trash button does rather than
    // deleting outright: a chat is gone for good, and a chord is far easier to
    // press by accident than a button is to click by accident.
    "chat.delete": () => { if (activeChat) setDeleteCandidate({ kind: "chat", chat: activeChat }); },
    "app.settings": () => openSettings(),
    "app.shortcuts": () => openSettings("keyboard"),
    "review.toggle": () => (reviewClosing ? openReviewPanel() : toggleReviewPanel()),
    "composer.focus": () => textareaRef.current?.focus(),
    // Only while there is something to stop, and never twice: a second press
    // while the first stop is still landing would read as the key doing
    // nothing rather than as the run already ending.
    "run.stop": () => { if (isGenerating && !stopPending) void stopTask(); },
  };
  chatJumpTargetsRef.current = visibleChats.slice(0, chatJumpLimit);
  // Read the same way, so a chord cannot reach past a dialog to a window the
  // user cannot currently see.
  shortcutsBlockedRef.current = modalOpen;

  useEffect(() => {
    const runShortcut = (event: KeyboardEvent) => {
      // Never on the auto-repeat of a held key, and never mid-IME sequence.
      if (shortcutsBlockedRef.current || event.repeat || event.isComposing) return;
      // The number keys first: they are nine chords for one gesture, so they
      // are matched by position rather than looked up in the table. A number
      // with no chat under it is left alone rather than swallowed.
      const jumpPosition = chatJumpFromEvent(event);
      const jumpTarget = jumpPosition ? chatJumpTargetsRef.current[jumpPosition - 1] : undefined;
      if (jumpTarget) {
        event.preventDefault();
        // The badges stay up: the modifier is still down, and somebody who just
        // pressed 3 is as likely as not about to press 4.
        void selectChat(jumpTarget);
        return;
      }
      const shortcut = shortcutForEvent(event);
      const action = shortcut && shortcutActionsRef.current[shortcut.id];
      if (!action) return;
      event.preventDefault();
      action();
    };
    document.addEventListener("keydown", runShortcut, true);
    return () => document.removeEventListener("keydown", runShortcut, true);
  }, []);

  /**
   * The numbers on the sidebar rows, raised and dropped with the modifier.
   *
   * Both events carry the modifier state, so holding it and letting it go are
   * the same handler rather than a pair that can fall out of step — and a chord
   * that starts with the modifier and ends somewhere else takes the badges down
   * on its own way through.
   */
  useEffect(() => {
    const sync = (event: KeyboardEvent) => {
      setChatJumpKeysVisible(!shortcutsBlockedRef.current && chatJumpModifierHeld(event));
    };
    const clear = () => setChatJumpKeysVisible(false);
    document.addEventListener("keydown", sync, true);
    document.addEventListener("keyup", sync, true);
    // A modifier let go of while another window has focus never reaches this
    // one, and the badges would still be up when the user came back to it.
    window.addEventListener("blur", clear);
    return () => {
      document.removeEventListener("keydown", sync, true);
      document.removeEventListener("keyup", sync, true);
      window.removeEventListener("blur", clear);
    };
  }, []);

  useEffect(() => {
    const isOpen = modalOpen;
    // While a modal is up the page behind it holds still: see .modalScrim CSS.
    document.documentElement.classList.toggle("modalOpen", isOpen);
    if (!isOpen) {
      modalTriggerRef.current?.focus();
      modalTriggerRef.current = null;
      return;
    }
    if (!modalTriggerRef.current && document.activeElement instanceof HTMLElement) modalTriggerRef.current = document.activeElement;
    const focusModal = () => {
      const modal = modalRef.current;
      if (!modal) return;
      // A single querySelector answers in document order, not in the order the
      // selectors are written, so the deliberate choice is asked for on its own
      // first: a dialog that names its own default focus means it even when an
      // earlier button would also have matched.
      const target = modal.querySelector<HTMLElement>("[data-modal-autofocus], [autofocus]")
        ?? modal.querySelector<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])");
      (target ?? modal).focus();
    };
    const frame = window.requestAnimationFrame(focusModal);
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !modalRef.current) return;
      const focusable = Array.from(modalRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"));
      if (!focusable.length) { event.preventDefault(); modalRef.current.focus(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", trapFocus);
    return () => { window.cancelAnimationFrame(frame); document.removeEventListener("keydown", trapFocus); };
  }, [settingsOpen, previewAttachment, deleteCandidate, showElevatedPermissionsDialog, approvalPending, responseFeedbackDialog]);

  useEffect(() => {
    if (!responseFeedbackDialog) return undefined;
    const frame = window.requestAnimationFrame(() => responseFeedbackInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [responseFeedbackDialog?.messageId, responseFeedbackDialog?.rating]);

  // The offset lives on the DOM node rather than in the style prop, so it needs
  // its starting value written once. Everything after this comes from the
  // animation itself.
  useLayoutEffect(() => {
    applyReviewOffset(reviewOffsetRef.current);
  }, []);

  useEffect(() => {
    if (!reviewOpen) return undefined;
    const resizeReview = () => {
      setReviewWidth((current) => reviewHasSessionWidth
        ? clamp(current, reviewMinWidthForViewport(), reviewMaxWidth())
        : Math.min(reviewOpenWidth(), reviewMaxWidth()));
    };
    window.addEventListener("resize", resizeReview);
    return () => window.removeEventListener("resize", resizeReview);
  }, [reviewHasSessionWidth, reviewOpen]);

  useLayoutEffect(() => {
    const node = streamRef.current;
    if (!node) return;
    if (forceComposerBottomScrollRef.current) {
      if (composerItems.length === 0 && (activeChat?.taskId || task)) return;
      forceComposerBottomScrollRef.current = false;
      followComposerScrollRef.current = true;
      placeElementAtBottom(node);
      return;
    }
    if (followComposerScrollRef.current) followElementToBottom(node);
  }, [activeChat?.taskId, composerItems, task, prompt, reviewFiles.length, expandedReviewPaths, reviewOpen]);

  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node || node.selectionEnd !== prompt.length) return;
    node.scrollTop = node.scrollHeight;
    setPromptScrollTop(node.scrollTop);
  }, [prompt]);

  useLayoutEffect(() => {
    const activeActivityIds = new Set<string>();
    for (const item of composerItems) {
      if (item.type !== "activity") continue;
      activeActivityIds.add(item.id);
      const expanded = expandedActivityIds.has(item.id);
      const node = activityBodyRefs.current.get(item.id);
      if (!node || !expanded || item.finished) continue;
      if (activityFollowScrollRef.current.get(item.id) ?? true) {
        // Streaming updates arrive many times per second; following on the
        // frame avoids both smooth-scroll animations piling up beneath active
        // wheel input and a forced layout per update.
        followElementToBottom(node);
      }
    }
    for (const id of activityFollowScrollRef.current.keys()) {
      if (activeActivityIds.has(id)) continue;
      activityFollowScrollRef.current.delete(id);
      activityScrollInputRef.current.delete(id);
    }
  }, [composerItems, expandedActivityIds]);

  useEffect(() => {
    const closeMenus = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (!target.closest(".branchControl")) setBranchMenuOpen(false);
      if (!target.closest(".permissionControl")) setPermissionMenuOpen(false);
      if (!target.closest(".idePicker")) setIdeMenuOpen(null);
      if (!target.closest(".chatProjectActions")) setProjectActionMenuKey(null);
      if (!target.closest(".attachmentMenu")) setMention(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setBranchMenuOpen(false);
      setPermissionMenuOpen(false);
      setIdeMenuOpen(null);
      setProjectActionMenuKey(null);
      setMention(null);
    };
    document.addEventListener("pointerdown", closeMenus);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenus);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  useEffect(() => {
    if (suppressDraftSaveRef.current) return undefined;
    if (draftSaveRef.current) window.clearTimeout(draftSaveRef.current);
    const chatId = activeChatId;
    const scope = unsavedDraftScope;
    const draftPrompt = prompt;
    const files = attachedFiles;
    draftSaveRef.current = window.setTimeout(() => {
      // A chat that exists keeps its draft in its own row. One that does not
      // exist yet has no row to keep it in, so it goes to main-process memory
      // instead of being dropped on the next chat switch.
      if (chatId) void persistDraft(chatId, draftPrompt, files, { updateLocal: false });
      else void api.setUnsavedDraft({ scope, draftPrompt, attachedFiles: files }).catch(() => undefined);
    }, 250);
    return () => {
      if (draftSaveRef.current) window.clearTimeout(draftSaveRef.current);
    };
  }, [activeChatId, unsavedDraftScope, prompt, attachedFiles]);

  useEffect(() => {
    if (!fileSearchKind || !repository) {
      setFileMatches([]);
      setSelectedFileIndex(0);
      return undefined;
    }
    let canceled = false;
    const timer = window.setTimeout(async () => {
      try {
        const matches = await api.searchFiles({
          repositoryId: repository.id,
          query: attachmentSearchQuery,
          limit: 25,
          kind: fileSearchKind,
        });
        if (!canceled) {
          setFileMatches(matches);
          setSelectedFileIndex(0);
        }
      } catch (cause) {
        if (!canceled) {
          setFileMatches([]);
          setSelectedFileIndex(0);
          setError(String(cause instanceof Error ? cause.message : cause));
        }
      }
    }, 120);
    return () => {
      canceled = true;
      window.clearTimeout(timer);
    };
  }, [fileSearchKind, attachmentSearchQuery, repository?.id]);

  // A different mention (new trigger position or trigger character) starts the
  // picker over at the category step; refining the query keeps the scope.
  const mentionIdentityRef = useRef<string | null>(null);
  useEffect(() => {
    const identity = mention ? `${mention.kind}:${mention.start}` : null;
    if (mentionIdentityRef.current === identity) return;
    mentionIdentityRef.current = identity;
    setMentionScope(null);
    setSelectedCategoryIndex(0);
  }, [mention]);

  useEffect(() => {
    const menu = attachmentMenuRef.current;
    if (!menu || !categoryMenuOpen) return;
    menu.querySelector<HTMLButtonElement>(`[data-category-index="${selectedCategoryIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [categoryMenuOpen, selectedCategoryIndex]);

  useEffect(() => {
    const menu = attachmentMenuRef.current;
    if (!menu || !fileMatches.length) return;
    menu.querySelector<HTMLButtonElement>(`[data-file-index="${selectedFileIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [fileMatches.length, selectedFileIndex]);

  useEffect(() => {
    const menu = attachmentMenuRef.current;
    if (!menu || !skillMatches.length) return;
    menu.querySelector<HTMLButtonElement>(`[data-skill-index="${selectedSkillIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedSkillIndex, skillMatches.length]);

  useEffect(() => {
    setSelectedSkillIndex(0);
  }, [skillSearchQuery]);

  useEffect(() => {
    if (!selectedSkillId || skills.some((skill) => skill.id === selectedSkillId)) return;
    setSelectedSkillId(null);
    setSkillDocument(null);
  }, [selectedSkillId, skills]);

  async function persistDraft(
    chatId: string,
    draftPrompt: string,
    files: ChatAttachment[],
    options: { updateLocal?: boolean } = {},
  ) {
    const filesSignature = chatAttachmentsSignature(files);
    const lastPersisted = lastPersistedDraftRef.current.get(chatId);
    if (lastPersisted?.draftPrompt === draftPrompt && lastPersisted.filesSignature === filesSignature) {
      if (options.updateLocal !== false) {
        setChats((current) =>
          current.map((chat) =>
            chat.id === chatId && ((chat.draftPrompt ?? "") !== draftPrompt || !chatAttachmentsMatch(chat.attachedFiles ?? [], files))
              ? { ...chat, draftPrompt, attachedFiles: files }
              : chat,
          ),
        );
      }
      return;
    }
    const existing = chats.find((chat) => chat.id === chatId);
    if (
      existing &&
      (existing.draftPrompt ?? "") === draftPrompt &&
      chatAttachmentsMatch(existing.attachedFiles ?? [], files)
    ) {
      lastPersistedDraftRef.current.set(chatId, { draftPrompt, filesSignature });
      return;
    }
    try {
      const next = await api.updateChatDraft({ chatId, draftPrompt, attachedFiles: files });
      lastPersistedDraftRef.current.set(chatId, { draftPrompt, filesSignature });
      if (options.updateLocal !== false) {
        setChats((current) =>
          current.map((chat) =>
            chat.id === chatId
              ? { ...chat, draftPrompt: next.draftPrompt, attachedFiles: next.attachedFiles, updatedAt: next.updatedAt }
              : chat,
          ),
        );
      }
    } catch {
      /* Draft persistence should not interrupt typing. */
    }
  }

  function mergeChat(chat: ChatRecord) {
    setChats((current) => [chat, ...current.filter((row) => row.id !== chat.id)]);
  }

  function mergeProject(project: RepositoryInfo) {
    setProjects((current) => [project, ...current.filter((row) => row.id !== project.id)]);
  }

  async function ensurePersistedChatForMessage(title: string): Promise<string> {
    if (activeChatId && chats.some((chat) => chat.id === activeChatId)) {
      return activeChatId;
    }
    const chat = await api.createChat({
      ...chatInputForCurrentProject(title),
      id: activeChatId ?? undefined,
    });
    mergeChat(chat);
    suppressDraftSaveBriefly();
    setActiveChatId(chat.id);
    return chat.id;
  }

  function upsertChatFromTask(nextTask: TaskInfo) {
    if (!nextTask.chatId) return;
    const now = new Date().toISOString();
    const chat: ChatRecord = {
      id: nextTask.chatId,
      title: titleFromPrompt(nextTask.prompt),
      createdAt: now,
      updatedAt: now,
      taskId: nextTask.id,
      taskState: nextTask.state,
      repositoryName: repository?.id === nextTask.repositoryId ? repository.name : undefined,
      repositoryPath: repository?.id === nextTask.repositoryId ? repository.rootPath : undefined,
      changedFiles: nextTask.changedFiles.length,
      worktreeRootTaskId: nextTask.workspaceMode === "worktree" ? nextTask.worktreeRootTaskId ?? nextTask.id : undefined,
      worktreePath: nextTask.workspaceMode === "worktree" ? nextTask.worktreePath : undefined,
      worktreeBranch: nextTask.workspaceMode === "worktree" ? nextTask.agentBranch : undefined,
      worktreeBaseCommit: nextTask.workspaceMode === "worktree" ? nextTask.baseCommit : undefined,
      draftPrompt: "",
      attachedFiles: [],
    };
    setChats((current) => {
      const existing = current.find((row) => row.id === nextTask.chatId);
      const existingDraft = existing?.draftPrompt ?? "";
      const nextDraft = draftMatchesTaskPrompt(existingDraft, nextTask.prompt) ? "" : existingDraft;
      return [
        {
          ...chat,
          title: stableChatTitle(existing?.title, nextTask.prompt),
          createdAt: existing?.createdAt ?? chat.createdAt, updatedAt: chatActivityUtcIso(nextTask, existing?.updatedAt) ?? now,
          modelEndpointMode: existing?.modelEndpointMode ?? endpointSettings.mode,
          repositoryName: chat.repositoryName ?? existing?.repositoryName,
          repositoryPath: chat.repositoryPath ?? existing?.repositoryPath,
          worktreeRootTaskId: chat.worktreeRootTaskId ?? existing?.worktreeRootTaskId,
          worktreePath: chat.worktreePath ?? existing?.worktreePath,
          worktreeBranch: chat.worktreeBranch ?? existing?.worktreeBranch,
          worktreeBaseCommit: chat.worktreeBaseCommit ?? existing?.worktreeBaseCommit,
          draftPrompt: nextDraft,
          attachedFiles: nextDraft ? (existing?.attachedFiles ?? chat.attachedFiles) : [],
        },
        ...current.filter((row) => row.id !== nextTask.chatId),
      ];
    });
  }

  async function loadChats() {
    try {
      const nextChats = await api.listChats();
      setChats(nextChats);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function loadProjects() {
    try {
      setProjects(await api.listProjects());
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  function updateAppearanceSettings(patch: Partial<AppearanceSettings>) {
    setAppearanceSettings((current) => ({ ...current, ...patch }));
    setFontScanMessage(null);
  }

  async function scanSystemFonts() {
    setFontScanPending(true);
    setFontScanMessage(null);
    try {
      const families = await listLocalFontFamilies();
      if (!families) {
        setFontScanMessage("System font scanning is not available in this runtime. The curated font list will still work.");
        return;
      }
      if (!families.length) {
        setFontScanMessage("No system fonts were returned.");
        return;
      }
      setAvailableFontFamilies((current) => uniqueFonts([...current, ...families]));
      setFontScanMessage(`Found ${families.length} font famil${families.length === 1 ? "y" : "ies"}.`);
    } catch (cause) {
      setFontScanMessage(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setFontScanPending(false);
    }
  }

  async function showConnectionErrorInChat(userText: string, status: BackendStatus | null) {
    const chatId = await ensurePersistedChatForMessage(titleFromPrompt(userText));
    const detail = status?.providers[0]?.message || status?.message;
    const message = [
      "I can't reach the LLM endpoint yet, so I didn't start this run.",
      "",
      "Check **Settings > Account** for the model server connection status.",
      detail ? `\nConnection detail: ${detail}` : "",
    ].join("\n");
    const taskId = `local-connection-${Date.now().toString(36)}`;
    const at = new Date().toISOString();
    const nextEvents: BackendUiEvent[] = [
      { type: "user.message", taskId, text: userText, at },
      { type: "assistant.delta", taskId, text: message, at },
      { type: "assistant.done", taskId, at },
    ];
    setVisibleTask(null);
    closeReviewPanel();
    setPendingPermission(null);
    setEvents((current) => appendBackendEvents(current, nextEvents));
    await persistDraft(chatId, prompt, attachedFiles);
  }

  function chatInputForCurrentProject(title: string) {
    return {
      title,
      repositoryName: repository?.name,
      repositoryPath: repository?.rootPath,
    };
  }

  function chatInputForProject(title: string, project: { name?: string; path?: string }) {
    return {
      title,
      repositoryName: project.name,
      repositoryPath: project.path,
    };
  }

  function toggleProjectGroup(projectKey: string) {
    setCollapsedProjectKeys((current) => {
      const next = new Set(current);
      if (next.has(projectKey)) {
        next.delete(projectKey);
      } else {
        next.add(projectKey);
      }
      return next;
    });
  }

  function toggleWorktreeGroup(worktreeKey: string) {
    setCollapsedWorktreeKeys((current) => {
      const next = new Set(current);
      if (next.has(worktreeKey)) {
        next.delete(worktreeKey);
      } else {
        next.add(worktreeKey);
      }
      return next;
    });
  }

  /** `scope` of null clears the composer without restoring anything, for the
   * callers that go straight on to create a real chat. */
  function resetUnsavedChat(scope: string | null = unsavedDraftScope) {
    suppressDraftSaveBriefly();
    if (scope !== null) {
      void restoreUnsavedDraft(api, scope, { activeChatId: () => activeChatIdRef.current, setPrompt, setAttachedFiles });
    }
    setActiveChatId(null);
    setVisibleTask(null);
    setEvents([]);
    setExpandedActivityIds(new Set());
    setExpandedActivityToolIds(new Set());
    setPendingPermission(null);
    setExpandedReviewPaths(new Set());
    closeReviewPanel();
    setAttachedFiles([]);
    setMention(null);
    setFileMatches([]);
    setPrompt(initialPrompt);
  }

  async function refreshStatus(): Promise<BackendStatus | null> {
    try {
      const status = await api.getBackendStatus();
      setBackend(status);
      setPermissionModeState(status.permissionMode);
      return status;
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
      return null;
    }
  }

  function closeSettingsDialog() {
    connectionSettings.resetDraft();
    setHarnessDraftProfile(harnessProfile);
    setHarnessDraftContextLength(contextLength);
    setHarnessMessage(null);
    setSettingsOpen(false);
  }

  async function loadHarnessProfile() {
    try {
      const [profileId, configuredContextLength] = await Promise.all([
        api.getHarnessProfile(),
        api.getContextLength(),
      ]);
      const normalized = isHarnessProfileId(profileId) ? profileId : defaultHarnessProfileId;
      const normalizedContextLength = normalizeContextLength(configuredContextLength);
      setHarnessProfile(normalized);
      setHarnessDraftProfile(normalized);
      setContextLength(normalizedContextLength);
      setHarnessDraftContextLength(normalizedContextLength);
      setHarnessMessage(null);
    } catch (cause) {
      setHarnessMessage(String(cause instanceof Error ? cause.message : cause));
    }
  }

  function selectHarnessProfile(profileId: HarnessProfileId) {
    setHarnessDraftProfile(profileId);
    setHarnessMessage(null);
  }

  async function saveHarnessProfile() {
    if (!harnessDirty || harnessSaving) return;
    const profileChanged = harnessDraftProfile !== harnessProfile;
    const contextLengthChanged = harnessDraftContextLength !== contextLength;
    const optimisticProfile = harnessDraftProfile;
    const optimisticContextLength = harnessDraftContextLength;
    const feedbackStartedAt = Date.now();
    setHarnessMessage(null);
    setHarnessSaving(true);
    setHarnessSaveFeedback("saved");
    if (profileChanged) setHarnessProfile(optimisticProfile);
    if (contextLengthChanged) setContextLength(optimisticContextLength);
    try {
      let nextProfile = optimisticProfile;
      let nextContextLength = optimisticContextLength;
      let status: BackendStatus | null = null;
      if (profileChanged) {
        const result = await api.saveHarnessProfile(harnessDraftProfile);
        nextProfile = isHarnessProfileId(result.settings) ? result.settings : defaultHarnessProfileId;
        status = result.status;
      }
      if (contextLengthChanged) {
        const result = await api.saveContextLength(harnessDraftContextLength);
        nextContextLength = normalizeContextLength(result.contextLength);
        status = result.status;
      }
      setHarnessProfile(nextProfile);
      setHarnessDraftProfile(nextProfile);
      setContextLength(nextContextLength);
      setHarnessDraftContextLength(nextContextLength);
      if (profileChanged) await loadSkills();
      if (status) {
        setBackend(status);
        setPermissionModeState(status.permissionMode);
      }
    } catch (cause) {
      setHarnessSaveFeedback("idle");
      await loadHarnessProfile();
      setHarnessMessage(String(cause instanceof Error ? cause.message : cause));
    } finally {
      const remainingFeedbackMs = Math.max(0, 500 - (Date.now() - feedbackStartedAt));
      if (remainingFeedbackMs > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, remainingFeedbackMs));
      }
      setHarnessSaving(false);
      setHarnessSaveFeedback("idle");
    }
  }

  async function loadSkills() {
    setSkillsLoading(true);
    try {
      const result = await api.listSkills();
      setSkills(result.skills);
      setSkillsEnabled(Object.fromEntries(result.skills.map((skill) => [skill.id, skill.enabled])));
      setSelectedSkillId((current) => (current && result.skills.some((skill) => skill.id === current) ? current : null));
      skillsLoadedRef.current = true;
      setSkillsLoaded(true);
    } catch (cause) {
      if (!skillsLoadedRef.current) setSkills([]);
      console.warn("Failed to list skills", cause);
    } finally {
      setSkillsLoading(false);
    }
  }

  async function toggleSkillSetting(skillId: string) {
    let previous = skillsEnabled;
    let next = skillsEnabled;
    setSkillsEnabled((current) => {
      previous = current;
      next = { ...current, [skillId]: !current[skillId] };
      return next;
    });
    setSkillsMessage(null);
    const requestId = skillsSaveSequenceRef.current + 1;
    skillsSaveSequenceRef.current = requestId;
    try {
      const result = await api.saveSkillSettings(next);
      if (requestId !== skillsSaveSequenceRef.current) return;
      setSkills(result.skills);
      setSkillsEnabled(Object.fromEntries(result.skills.map((skill) => [skill.id, skill.enabled])));
      setSkillDocument((current) =>
        current && current.id === skillId ? { ...current, enabled: result.skills.find((skill) => skill.id === skillId)?.enabled ?? current.enabled } : current,
      );
    } catch (cause) {
      if (requestId !== skillsSaveSequenceRef.current) return;
      setSkillsEnabled(previous);
      setSkillsMessage(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function openSkillsFolder() {
    setSkillsMessage(null);
    try {
      const result = await api.openSkillsFolder();
      if (!result.ok) {
        setSkillsMessage(result.message);
      }
    } catch (cause) {
      setSkillsMessage(String(cause instanceof Error ? cause.message : cause));
    }
  }

  function selectSkillSourceFilter(filter: SkillSourceFilter) {
    setSkillSourceFilter(filter);
    setSelectedSkillId(null);
    setSkillDocument(null);
    setSkillsMessage(null);
  }

  async function toggleSkillPreview(skillId: string) {
    if (skillPreviewLoading) return;
    if (selectedSkillId === skillId) {
      setSelectedSkillId(null);
      setSkillDocument(null);
      setSkillsMessage(null);
      return;
    }
    setSelectedSkillId(skillId);
    setSkillsMessage(null);
    setSkillPreviewLoading(true);
    try {
      const result = await api.getSkillDocument({ id: skillId });
      if (!result.ok) {
        setSkillsMessage(result.message);
        setSkillDocument(null);
        return;
      }
      setSkillDocument(result.skill);
    } catch (cause) {
      setSkillsMessage(String(cause instanceof Error ? cause.message : cause));
      setSkillDocument(null);
    } finally {
      setSkillPreviewLoading(false);
    }
  }

  async function openSelectedSkillInEditor() {
    if (!skillDocument) return;
    setSkillsMessage(null);
    try {
      const result = await api.openSkillInEditor({ id: skillDocument.id });
      if (!result.ok) {
        setSkillsMessage(result.message);
        return;
      }
      setSkillsMessage("Opened skill file.");
    } catch (cause) {
      setSkillsMessage(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function resetSelectedSystemSkill() {
    if (!skillDocument || skillDocument.source !== "system") return;
    setSkillsMessage(null);
    setSkillPreviewLoading(true);
    try {
      const result = await api.resetSystemSkill({ id: skillDocument.id });
      if (!result.ok) {
        setSkillsMessage(result.message);
        return;
      }
      setSkills(result.skills);
      setSkillsEnabled(Object.fromEntries(result.skills.map((skill) => [skill.id, skill.enabled])));
      setSkillDocument(result.skill);
      setSkillsMessage(`Reset ${result.skill.name}.`);
    } catch (cause) {
      setSkillsMessage(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setSkillPreviewLoading(false);
    }
  }

  async function submitCreateSkill() {
    if (creatingSkill) return;
    setSkillsMessage(null);
    setCreatingSkill(true);
    try {
      const result = await api.createSkill({ name: newSkillName });
      if (!result.ok) {
        setSkillsMessage(result.message);
        return;
      }
      setNewSkillName("");
      setNewSkillFormOpen(false);
      await loadSkills();
      await toggleSkillPreview(result.skill.id);
    } catch (cause) {
      setSkillsMessage(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setCreatingSkill(false);
    }
  }

  async function importSkill() {
    if (skillsLoading) return;
    setSkillsMessage(null);
    setSkillsLoading(true);
    try {
      const result = await api.importSkill();
      if (!result.ok) {
        setSkillsMessage(result.message);
        return;
      }
      setSkills(result.skills);
      setSkillsEnabled(Object.fromEntries(result.skills.map((skill) => [skill.id, skill.enabled])));
      skillsLoadedRef.current = true;
      setSkillsLoaded(true);
      await toggleSkillPreview(result.skill.id);
      setSkillsMessage(`Imported ${result.skill.name}.`);
    } catch (cause) {
      setSkillsMessage(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setSkillsLoading(false);
    }
  }

  async function loadAvailableIdes() {
    try {
      const ides = (await api.listAvailableIdes()).filter((ide) => ide.id !== "cursor");
      if (ides.length > 0) {
        setAvailableIdes(ides);
        setSelectedIdeId((current) => (ides.some((ide) => ide.id === current) ? current : ides[0].id));
      }
    } catch {
      setAvailableIdes(defaultIdeChoices);
    }
  }

  async function refreshTaskReviewById(
    taskId: string,
    openWhenReady = false,
    scope?: "task" | "worktree",
    repositoryPath?: string,
  ) {
    if (reviewRefreshRef.current) return;
    reviewRefreshRef.current = true;
    try {
      const nextTask = await api.refreshTaskReview({ taskId, scope, repositoryPath });
      if (!nextTask) return;
      if (visibleTaskIdRef.current === nextTask.id) {
        setVisibleTask(nextTask);
        const nextEvents = visibleEventsForTask(nextTask);
        cacheTaskEvents(nextEvents);
        setEvents(nextEvents);
        setPendingPermission(pendingPermissionFromEvents(nextEvents));
        setExpandedReviewPaths((current) => {
          const availablePaths = new Set(nextTask.reviewFiles.map((file) => file.path));
          return new Set(Array.from(current).filter((filePath) => availablePaths.has(filePath)));
        });
        if (openWhenReady && nextTask.state === "review_ready") {
          openReviewPanel();
        }
      }
      upsertChatFromTask(nextTask);
      void loadChats();
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      reviewRefreshRef.current = false;
    }
  }

  async function refreshActiveReview() {
    if (!reviewOpen || !task || busy || task.state !== "review_ready") return;
    const scope = task.reviewScope ?? "task";
    await refreshTaskReviewById(
      task.id,
      false,
      scope,
      scope === "worktree" ? repository?.rootPath : undefined,
    );
  }

  async function pickRepository() {
    setError(null);
    setBusy(true);
    try {
      const result = await api.pickRepository();
      if (!result.canceled) {
        const nextRepository = result.repository;
        mergeProject(nextRepository);
        setRepository(nextRepository);
        const chatWithoutProject = activeChatId ? chats.find((chat) => chat.id === activeChatId && !chat.repositoryPath) : undefined;
        if (chatWithoutProject) {
          const nextChat = await api.updateChatProject({
            chatId: chatWithoutProject.id,
            repositoryName: nextRepository.name,
            repositoryPath: nextRepository.rootPath,
          });
          setChats((current) =>
            current.map((chat) =>
              chat.id === nextChat.id
                ? { ...chat, repositoryName: nextChat.repositoryName, repositoryPath: nextChat.repositoryPath }
                : chat,
            ),
          );
        }
        setBranches([]);
        setBranchError(null);
      }
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setBusy(false);
    }
  }

  async function refreshBranches() {
    if (!repository || repository.kind !== "git") return;
    setBranchesLoading(true);
    setBranchError(null);
    try {
      const result = await api.listRepositoryBranches({ repositoryId: repository.id, repositoryPath: repository.rootPath });
      if (result.ok) {
        setBranches(result.branches);
      } else {
        setBranchError(result.message);
        setBranches([]);
      }
    } catch (cause) {
      setBranchError(String(cause instanceof Error ? cause.message : cause));
      setBranches([]);
    } finally {
      setBranchesLoading(false);
    }
  }

  async function toggleBranchMenu() {
    if (!repository || repository.kind !== "git") return;
    const next = !branchMenuOpen;
    if (next) setPermissionMenuOpen(false);
    setBranchMenuOpen(next);
    if (next) await refreshBranches();
  }

  async function selectBranch(branch: string) {
    if (!repository || repository.kind !== "git") return;
    if (branch === repository.originalBranch) {
      setBranchMenuOpen(false);
      return;
    }
    setCheckoutPending(true);
    setBranchError(null);
    try {
      const result = await api.checkoutRepositoryBranch({
        repositoryId: repository.id,
        repositoryPath: repository.rootPath,
        branch,
      });
      if (result.ok) {
        mergeProject(result.repository);
        setRepository(result.repository);
        setBranchMenuOpen(false);
      } else {
        setBranchError(result.message);
      }
    } catch (cause) {
      setBranchError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setCheckoutPending(false);
    }
  }

  async function restoreChatRepository(chat: ChatRecord, selectionSequence: number) {
    // A chat's saved project is its only workspace authority. In particular, an
    // unassigned chat must never inherit the project that was selected previously.
    setRepository(null);
    if (!chat.repositoryPath) return;
    try {
      const nextRepository = await api.getRepository({ repositoryPath: chat.repositoryPath });
      if (chatSelectionSequenceRef.current !== selectionSequence) return;
      if (nextRepository) {
        mergeProject(nextRepository);
        setRepository(nextRepository);
      }
    } catch (cause) {
      if (chatSelectionSequenceRef.current !== selectionSequence) return;
      setRepository(null);
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function updatePermissionMode(mode: PermissionMode) {
    setPermissionMenuOpen(false);
    if (mode === "auto_safe" && permissionMode !== "auto_safe") {
      setShowElevatedPermissionsDialog(true);
      return;
    }
    setError(null);
    setPermissionModeState(mode);
    try {
      setPermissionModeState(await api.setPermissionMode(mode));
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function confirmElevatedPermissionsMode() {
    setShowElevatedPermissionsDialog(false);
    setError(null);
    setPermissionModeState("auto_safe");
    try {
      setPermissionModeState(await api.setPermissionMode("auto_safe"));
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  /**
   * The composer's picker and the Connection panel's picker choose the same
   * thing, so they go through the same code.
   *
   * Writing the endpoint settings directly from here saved the right model but
   * left the settings controller holding the model it was mounted with, which
   * is what made Connection show "Choose or download a model" beside a
   * "Loaded" badge for a model that was in fact loaded and answering.
   */
  async function selectComposerModel(modelId: string) {
    setError(null);
    try {
      const failure = endpointSettings.mode === "server"
        ? await connectionSettings.selectServerModel(modelId)
        : await connectionSettings.selectLocalModel(modelId);
      // The panel shows this too, but it is usually closed when the pick came
      // from the composer, so the composer says it as well.
      if (failure) {
        setError(failure);
        return;
      }
      await refreshStatus();
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  /**
   * The chat models on this computer, for the composer's picker. Chat kind
   * only, so dictation weights never appear as something that could answer a
   * prompt, and downloaded only, because choosing one loads it.
   */
  async function refreshDownloadedChatModels() {
    const rows = await api.listLocalModels({ kind: "chat" }).catch(() => [] as LocalCatalogModel[]);
    setDownloadedChatModels(rows.filter((row) => row.downloaded));
  }

  async function updateReasoningEffort(next: ReasoningEffort) {
    const previous = reasoningEffort;
    setReasoningEffort(next);
    setError(null);
    try {
      const saved = await api.saveReasoningEffort(next);
      setReasoningEffort(saved.reasoningEffort);
      setBackend(saved.status);
    } catch (cause) {
      setReasoningEffort(previous);
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function updateShowThinking(next: boolean) {
    const previous = showThinking;
    setShowThinking(next);
    try {
      setShowThinking(await api.saveShowThinking(next));
    } catch (cause) {
      setShowThinking(previous);
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  function selectWorkspaceMode(mode: WorkspaceMode) {
    setWorkspaceMode(mode);
    writeWorkspaceMode(mode);
  }

  function noteComposerScrollInput(node: HTMLElement, forcePause = false) {
    composerScrollInputRef.current = true;
    if (forcePause || !isElementNearBottom(node, 8)) {
      followComposerScrollRef.current = false;
    }
  }

  function handleComposerScroll(event: React.UIEvent<HTMLDivElement>) {
    const node = event.currentTarget;
    if (isElementAtBottom(node)) {
      followComposerScrollRef.current = true;
      composerScrollInputRef.current = false;
      return;
    }
    if (isElementNearBottom(node) && !composerScrollInputRef.current) {
      followComposerScrollRef.current = true;
      return;
    }
    if (composerScrollInputRef.current) {
      followComposerScrollRef.current = false;
    }
  }

  function handleComposerWheel(event: React.WheelEvent<HTMLDivElement>) {
    const shouldPause = event.deltaY < 0 || !isElementNearBottom(event.currentTarget);
    if (shouldPause) {
      noteComposerScrollInput(event.currentTarget, shouldPause);
    }
  }

  function handleComposerScrollPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    noteComposerScrollInput(event.currentTarget);
  }

  function handleComposerTouchMove(event: React.TouchEvent<HTMLDivElement>) {
    noteComposerScrollInput(event.currentTarget, true);
  }

  function setActivityBodyRef(id: string, node: HTMLDivElement | null) {
    if (!node) {
      activityBodyRefs.current.delete(id);
      return;
    }
    activityBodyRefs.current.set(id, node);
    if (!activityFollowScrollRef.current.has(id)) {
      activityFollowScrollRef.current.set(id, true);
    }
  }

  function noteActivityScrollInput(id: string, node: HTMLElement, forcePause = false) {
    activityScrollInputRef.current.add(id);
    if (forcePause || !isElementNearBottom(node, 8)) {
      activityFollowScrollRef.current.set(id, false);
    }
  }

  function handleActivityScroll(id: string, event: React.UIEvent<HTMLDivElement>) {
    const node = event.currentTarget;
    if (isElementAtBottom(node)) {
      activityFollowScrollRef.current.set(id, true);
      activityScrollInputRef.current.delete(id);
      return;
    }
    if (isElementNearBottom(node, 18) && !activityScrollInputRef.current.has(id)) {
      activityFollowScrollRef.current.set(id, true);
      return;
    }
    if (activityScrollInputRef.current.has(id)) {
      activityFollowScrollRef.current.set(id, false);
    }
  }

  function handleActivityWheel(id: string, event: React.WheelEvent<HTMLDivElement>) {
    // Keep wheel and trackpad input on Chromium's native scrolling path. The inner
    // scroller already allows scroll chaining through `overscroll-behavior: auto`,
    // so manually moving the composer here would apply the boundary delta twice.
    const shouldPause = event.deltaY < 0 || !isElementNearBottom(event.currentTarget, 8);
    if (shouldPause) {
      noteActivityScrollInput(id, event.currentTarget, shouldPause);
    }
  }

  function handleActivityPointerDown(id: string, event: React.PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.right - event.clientX <= 14) {
      noteActivityScrollInput(id, event.currentTarget, true);
    }
  }

  function handleActivityTouchMove(id: string, event: React.TouchEvent<HTMLDivElement>) {
    noteActivityScrollInput(id, event.currentTarget, true);
  }

  async function startTask(submission?: ComposerSubmission): Promise<boolean> {
    if (closedChatNotice) {
      setError(closedChatNotice);
      return false;
    }
    const sourcePrompt = submission?.prompt ?? prompt;
    const sourceFeedback = submission?.reviewFeedback ?? reviewPromptFeedback;
    const sourceAttachments = submission?.attachedFiles ?? attachedFiles;
    const trimmedPrompt = appendReviewFeedback(composerPromptForSend(sourcePrompt), sourceFeedback).trim();
    if (!trimmedPrompt) return false;
    if (startTaskInFlightRef.current) return false;
    startTaskInFlightRef.current = true;
    let status: BackendStatus | null = null;
    try {
      status = selectedModel && backend?.endpoint === "ready" ? backend : await refreshStatus();
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
      startTaskInFlightRef.current = false;
      return false;
    }
    if (!status?.model || status.endpoint !== "ready") {
      try {
        await showConnectionErrorInChat(trimmedPrompt, status);
      } catch (cause) {
        setError(String(cause instanceof Error ? cause.message : cause));
      } finally {
        startTaskInFlightRef.current = false;
      }
      return false;
    }
    const isContinuingChat = !!task && task.chatId === activeChatId;
    setError(null);
    setBusy(true);
    followComposerScrollRef.current = true;
    composerScrollInputRef.current = false;
    if (!isContinuingChat) {
      setVisibleTask(null);
      setEvents([]);
      setExpandedActivityIds(new Set());
      setExpandedActivityToolIds(new Set());
      setExpandedReviewPaths(new Set());
      closeReviewPanel();
    }
    setPendingPermission(null);
    try {
      let chatId = activeChatId;
      if (!chatId) {
        const chat = await api.createChat(chatInputForCurrentProject(titleFromPrompt(trimmedPrompt)));
        mergeChat(chat);
        chatId = chat.id;
        setActiveChatId(chat.id);
        // The chat exists now and keeps its own draft, so the memory copy would
        // only reappear the next time this workspace opened a new chat.
        void api.clearUnsavedDraft({ scope: unsavedDraftScope }).catch(() => undefined);
      }
      const nextTask = await api.startTask({
        repositoryId: repository?.id,
        remoteConnectionId: remoteConnectionId || undefined,
        remoteDirectory: remoteConnectionId ? remoteDirectory : undefined,
        prompt: trimmedPrompt,
        chatId,
        attachedFiles: sourceAttachments.map(normalizeAttachment),
        useWorktree: useWorktreeForNextRun,
        worktreeTaskId: activeChatWorktreeTaskId,
      });
      setVisibleTask(nextTask);
      const nextVisibleEvents = visibleEventsForTask(nextTask);
      cacheTaskEvents(nextVisibleEvents);
      setEvents(nextVisibleEvents);
      setPendingPermission(pendingPermissionFromEvents(nextVisibleEvents));
      if (nextTask.chatId) setActiveChatId(nextTask.chatId);
      upsertChatFromTask(nextTask);
      if (!submission) {
        suppressDraftSaveBriefly();
        setPrompt("");
        setReviewPromptFeedback([]);
        setAttachedFiles([]);
        setMention(null);
        setFileMatches([]);
        await persistDraft(nextTask.chatId ?? chatId, "", []);
      }
      if (!isContinuingChat) {
        setExpandedReviewPaths(new Set());
      }
      return true;
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
      return false;
    } finally {
      startTaskInFlightRef.current = false;
      setBusy(false);
    }
  }

  function currentComposerSubmission(): ComposerSubmission | null {
    const text = composerPromptForSend(prompt);
    if (!text && reviewPromptFeedback.length === 0) return null;
    return {
      prompt: text,
      attachedFiles: attachedFiles.map(normalizeAttachment),
      reviewFeedback: reviewPromptFeedback,
    };
  }

  function clearComposerInput() {
    suppressDraftSaveBriefly();
    setPrompt("");
    setReviewPromptFeedback([]);
    setAttachedFiles([]);
    setMention(null);
    setFileMatches([]);
    if (activeChatId) void persistDraft(activeChatId, "", []);
  }

  // Re-sync when a queued follow-up is dequeued into a user.message (task.state stays "running").
  const userMessageCount = events.reduce((count, event) => count + (event.type === "user.message" ? 1 : 0), 0);
  useEffect(() => { void syncQueuedPrompts(task?.id); }, [task?.id, task?.state, userMessageCount]);

  async function syncQueuedPrompts(taskId: string | undefined) {
    setQueuedPrompts(taskId ? await readQueuedPrompts(api, taskId).catch(() => []) : []);
  }

  async function queueCurrentPrompt() {
    if (!task || !canQueue) return;
    const submission = currentComposerSubmission();
    if (!submission) return;
    const taskId = task.id;
    // The runner owns the ordering and the release, so a rejection here (queue
    // full, or the turn already ended) must not leave a phantom row behind.
    try {
      const { prompt, attachedFiles, reviewFeedback } = submission;
      // The queue stores plain prompt text, so pending review comments travel
      // inside it the same way startTask and steerTask send them. The queued
      // row re-parses the block to display the clean text plus a feedback chip.
      await api.queueFollowUpTask({ taskId, prompt: appendReviewFeedback(prompt, reviewFeedback).trim(), attachedFiles });
      clearComposerInput();
      await syncQueuedPrompts(taskId);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function steerSubmission(submission: ComposerSubmission, queuedId?: string) {
    if (!task || task.state !== "running" || steerPending) return;
    const steeredPrompt = appendReviewFeedback(submission.prompt, submission.reviewFeedback).trim();
    if (!steeredPrompt) return;
    setSteerPending(true);
    setError(null);
    try {
      await api.steerTask({
        taskId: task.id,
        prompt: steeredPrompt,
        attachedFiles: submission.attachedFiles,
      });
      // Sending a queued message now must also retract it from the runner's
      // queue, or it would run a second time once the turn answers.
      if (queuedId) removeQueuedPrompt(queuedId);
      else clearComposerInput();
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setSteerPending(false);
    }
  }

  function removeQueuedPrompt(id: string) {
    const item = queuedPrompts.find((queued) => queued.id === id);
    setQueuedPrompts((current) => current.filter((queued) => queued.id !== id));
    if (!item) return;
    void api.dropQueuedTaskPrompt({ taskId: item.taskId, actionId: item.actionId })
      .then(() => syncQueuedPrompts(item.taskId));
  }

  function editQueuedPrompt(item: QueuedComposerPrompt) {
    setPrompt(item.prompt);
    setAttachedFiles(item.attachedFiles);
    setReviewPromptFeedback(item.reviewFeedback);
    setMention(null);
    setFileMatches([]);
    setSelectedFileIndex(0);
    setSelectedSkillIndex(0);
    removeQueuedPrompt(item.id);
    window.requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(item.prompt.length, item.prompt.length);
    });
  }

  async function stopTask() {
    if (!task || task.state !== "running" || stopPending) return;
    const taskId = task.id;
    setStopPending(true);
    setError(null);
    try {
      await api.cancelTask({ taskId });
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setStopPending(false);
    }
  }

  async function approveWorktree(approved: boolean) {
    if (!task) return;
    try {
      await api.approveWorktreeCreation({ taskId: task.id, approved });
      setTask((current) =>
        current && current.id === task.id ? { ...current, state: approved ? "running" : "rejected" } : current,
      );
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function resolvePermission(decision: "allow" | "deny") {
    if (!pendingPermission || !latestTaskId) return;
    try {
      await api.respondToToolPermission({ taskId: latestTaskId, id: pendingPermission.id, decision });
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function copyText(value: string) {
    await copyPlainText(value);
  }

  function openResponseFeedbackDialog(
    messageId: string,
    rating: ResponseRating,
    trigger: HTMLButtonElement,
  ) {
    modalTriggerRef.current = trigger;
    const previousFeedback = [...visibleEvents].reverse().find(
      (event): event is Extract<BackendUiEvent, { type: "response.feedback" }> =>
        event.type === "response.feedback" && event.messageId === messageId,
    );
    setResponseFeedbackDialog({
      messageId,
      rating,
      ...(previousFeedback?.rating === rating && previousFeedback.reason
        ? { reason: previousFeedback.reason }
        : {}),
      comment: previousFeedback?.rating === rating ? previousFeedback.comment ?? "" : "",
    });
  }

  async function rateResponse(
    messageId: string,
    rating: ResponseRating,
    reason?: ResponseFeedbackReason,
    comment?: string,
  ): Promise<boolean> {
    if (!latestTaskId) return false;
    setError(null);
    const taskId = latestTaskId;
    const previousFeedback = [...visibleEvents].reverse().find(
      (event): event is Extract<BackendUiEvent, { type: "response.feedback" }> =>
        event.type === "response.feedback" && event.taskId === taskId && event.messageId === messageId,
    );
    const nextComment = (comment ?? "").trim().slice(0, 1000);
    setEvents((current) => appendBackendEvent(current, {
      type: "response.feedback",
      taskId,
      messageId,
      rating,
      ...(reason ? { reason } : {}),
      ...(nextComment ? { comment: nextComment } : {}),
      at: new Date().toISOString(),
    }, 500));
    try {
      await api.setResponseFeedback({
        taskId,
        messageId,
        rating,
        ...(reason ? { reason } : {}),
        ...(nextComment ? { comment: nextComment } : {}),
      });
      return true;
    } catch (cause) {
      setEvents((current) => {
        const withoutFailedRating = removeResponseFeedback(current, taskId, messageId) as BackendUiEvent[];
        return previousFeedback
          ? appendBackendEvent(withoutFailedRating, { ...previousFeedback, at: new Date().toISOString() }, 500)
          : withoutFailedRating;
      });
      setError(String(cause instanceof Error ? cause.message : cause));
      return false;
    }
  }

  async function submitResponseFeedback() {
    if (!responseFeedbackDialog || responseFeedbackSubmitting) return;
    setResponseFeedbackSubmitting(true);
    try {
      const submitted = await rateResponse(
        responseFeedbackDialog.messageId,
        responseFeedbackDialog.rating,
        responseFeedbackDialog.reason,
        responseFeedbackDialog.comment,
      );
      if (submitted) setResponseFeedbackDialog(null);
    } finally {
      setResponseFeedbackSubmitting(false);
    }
  }

  async function exportLocalLogs() {
    setLocalLogsBusy(true);
    try {
      await api.exportLocalDiagnostics();
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setLocalLogsBusy(false);
    }
  }

  async function clearLocalLogs() {
    setLocalLogsBusy(true);
    try {
      const info = await api.clearLocalDiagnostics();
      setBackend((current) => current ? {
        ...current,
        diagnostics: { ...current.diagnostics, localLogs: info },
      } : current);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setLocalLogsBusy(false);
    }
  }

  async function openIde(ideId: string) {
    if (!repository) return;
    setIdeMenuOpen(null);
    const result = await api.openRepositoryInIde({ repositoryId: repository.id, ideId });
    if (!result.ok) setError(result.message);
  }

  function toggleIdeMenu(owner: "composer" | "review") {
    setIdeMenuOpen((open) => {
      const next = open === owner ? null : owner;
      if (next) {
        setBranchMenuOpen(false);
        setPermissionMenuOpen(false);
      }
      return next;
    });
  }

  function renderIdePicker(owner: "composer" | "review") {
    const canOpen = owner === "composer" ? !!repository : canOpenIde;
    const expanded = ideMenuOpen === owner && canOpen;
    const disabledTitle = owner === "composer" ? "Select a folder first" : "No review folder yet";
    const openTitle =
      owner === "composer"
        ? `Open ${repository?.name ?? "folder"} in ${selectedIde.label}`
        : `Use ${selectedIde.label} for changed files`;
    return (
      <div className={`idePicker ${canOpen ? "" : "isDisabled"}`}>
        <button
          className="idePickerOpen"
          type="button"
          onClick={() => openIde(selectedIde.id)}
          disabled={!canOpen}
          title={canOpen ? openTitle : disabledTitle}
        >
          <IdeIcon icon={selectedIde.icon} />
        </button>
        <button
          className="idePickerToggle"
          type="button"
          onClick={() => toggleIdeMenu(owner)}
          disabled={!canOpen}
          aria-expanded={expanded}
          aria-haspopup="menu"
          title={canOpen ? "Choose editor" : disabledTitle}
        >
          <ChevronDown size={13} />
        </button>
        {expanded ? (
          <div className="ideMenu" role="menu" onKeyDown={(event) => {
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']"));
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
            } else if (event.key === "Home") { event.preventDefault(); items[0]?.focus(); }
            else if (event.key === "End") { event.preventDefault(); items.at(-1)?.focus(); }
          }}>
            {availableIdes.map((ide) => (
              <button
                className={ide.id === selectedIde.id ? "active" : ""}
                key={ide.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  void api.recordProductEvent({
                    type: "ide.selected",
                    taskId: task?.id,
                    repositoryId: repository?.id,
                    ideId: ide.id,
                    surface: owner,
                  }).catch(() => undefined);
                  setSelectedIdeId(ide.id);
                  setIdeMenuOpen(null);
                }}
              >
                <IdeIcon icon={ide.icon} />
                <span>{ide.label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  function sidebarMaxAvailableWidth() {
    return clamp(Math.round(window.innerWidth * sidebarMaxRatio), sidebarMinWidth, sidebarMaxWidth);
  }

  function reviewMaxWidth() {
    return Math.max(0, Math.floor(window.innerWidth * reviewMaxWidthRatio));
  }

  function reviewOpenWidth() {
    return Math.max(reviewDefaultWidth, Math.floor(window.innerWidth * reviewOpenWidthRatio));
  }

  function reviewMinWidthForViewport() {
    return Math.min(reviewMinWidth, reviewMaxWidth());
  }

  function cancelReviewClose() {
    if (reviewAnimationRef.current !== null) window.cancelAnimationFrame(reviewAnimationRef.current);
    shellRef.current?.classList.remove("reviewClosing");
    setReviewClosing(false);
  }

  // The panel's position is written straight to the shell. Carrying it in state
  // re-rendered the whole app on every frame of the slide — the timeline, the
  // composer, and the review panel itself, which is always mounted and holds
  // the entire diff. That reconciliation was the frame cost, and long frames
  // are the one thing an animation cannot absorb: the close dragged because
  // each of its frames was paying to redraw everything it was sliding away.
  function applyReviewOffset(value: number) {
    shellRef.current?.style.setProperty("--review-offset", `${value}px`);
  }

  function animateReviewTo(
    target: number,
    initialVelocity = 0,
    { onRest, doneEarly, spring = reviewOpenSpring }: {
      onRest?: () => void;
      doneEarly?: (value: number) => boolean;
      spring?: ReviewSpring;
    } = {},
  ) {
    if (reviewAnimationRef.current !== null) window.cancelAnimationFrame(reviewAnimationRef.current);
    let value = reviewOffsetRef.current;
    let velocity = initialVelocity;
    let previous = performance.now();
    const tick = (now: number) => {
      // It starts from the presented position and can be retargeted at any time.
      const advanced = reviewSpringStep(value, velocity, target, (now - previous) / 1000, spring);
      previous = now;
      value = advanced.value;
      velocity = advanced.velocity;
      reviewOffsetRef.current = value;
      reviewVelocityRef.current = velocity;
      applyReviewOffset(value);
      if ((Math.abs(target - value) < 0.5 && Math.abs(velocity) < 3) || doneEarly?.(value)) {
        reviewOffsetRef.current = target;
        reviewVelocityRef.current = 0;
        applyReviewOffset(target);
        reviewAnimationRef.current = null;
        onRest?.();
        return;
      }
      reviewAnimationRef.current = window.requestAnimationFrame(tick);
    };
    reviewAnimationRef.current = window.requestAnimationFrame(tick);
  }

  function closeReviewPanel() {
    if (!reviewOpen && !reviewClosing) return;
    // The class lands on the node before React is told anything. The state
    // change re-renders the whole app, and that render sat between the click
    // and the first frame of motion; this way the panel is already shedding its
    // blur layers while React catches up to the same class name.
    shellRef.current?.classList.add("reviewClosing");
    setReviewClosing(true);
    // Past the edge the panel is invisible, and the spring's tail is another
    // third of a second of holding a mounted diff on screen for nobody.
    animateReviewTo(reviewWidth + 18, reviewVelocityRef.current, {
      onRest: () => {
        setReviewOpen(false);
        setReviewClosing(false);
      },
      doneEarly: (value) => value >= reviewWidth,
      spring: reviewCloseSpring,
    });
  }

  function openReviewPanel(filePath?: string) {
    if (!reviewOpen || reviewClosing) {
      void api.recordProductEvent({
        type: "review.opened",
        taskId: task?.id,
        repositoryId: repository?.id,
        scope: task?.reviewScope ?? tasklessReviewScope,
        target: task ? "task" : "project",
      }).catch(() => undefined);
    }
    cancelReviewClose();
    if (!reviewHasSessionWidth) setReviewWidth(Math.min(reviewOpenWidth(), reviewMaxWidth()));
    setReviewOpen(true);
    animateReviewTo(0, reviewVelocityRef.current);
    if (filePath) {
      setReviewTargetPath(filePath);
      setExpandedReviewPaths(new Set([filePath]));
    }
    if (task) {
      const taskId = task.id;
      const scope = task.reviewScope ?? "task";
      const request = ++reviewScopeRequestRef.current;
      void api.refreshTaskReview({ taskId, scope, repositoryPath: scope === "worktree" ? repository?.rootPath : undefined }).then((refreshed) => {
        if (refreshed && visibleTaskIdRef.current === taskId && reviewScopeRequestRef.current === request) setTask(refreshed);
      }).catch((cause) => {
        if (reviewScopeRequestRef.current === request) setError(String(cause instanceof Error ? cause.message : cause));
      });
    } else if (repository?.kind === "git") {
      const request = ++reviewScopeRequestRef.current;
      setTasklessReviewScope("worktree");
      void api.refreshWorkspaceReview({ repositoryPath: repository.rootPath }).then((refreshed) => {
        if (reviewScopeRequestRef.current === request) setWorkspaceReview(refreshed);
      }).catch((cause) => {
        if (reviewScopeRequestRef.current === request) setError(String(cause instanceof Error ? cause.message : cause));
      });
    }
  }

  function toggleReviewPanel() {
    if (reviewOpen) {
      closeReviewPanel();
      return;
    }
    openReviewPanel();
  }

  async function openReviewFile(filePath: string) {
    if (!canOpenIde || !task) return;
    setError(null);
    const result = await api.openTaskInIde({ taskId: task.id, ideId: selectedIde.id, filePath });
    if (!result.ok) setError(result.message);
  }

  function toggleReviewFile(filePath: string) {
    setExpandedReviewPaths((current) => {
      const next = new Set(current);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  }

  function openReviewReference(filePath: string) {
    openReviewPanel(filePath);
  }

  // Handed to every rendered message, so it has to keep its identity across
  // renders: a fresh function each time defeats the per-block memo in the
  // markdown renderer and puts the whole transcript back through
  // reconciliation on every streamed token.
  const openReviewReferenceRef = useRef(openReviewReference);
  openReviewReferenceRef.current = openReviewReference;
  const handleReviewReference = useCallback((filePath: string) => {
    openReviewReferenceRef.current(filePath);
  }, []);

  async function changeReviewScope(scope: "task" | "worktree") {
    if (!task) {
      if (tasklessReviewScope === scope && scope !== "worktree") return;
      setTasklessReviewScope(scope);
      if (scope === "task") {
        setWorkspaceReview(null);
        return;
      }
      if (!repository || repository.kind !== "git") return;
      const request = ++reviewScopeRequestRef.current;
      setError(null);
      try {
        const refreshed = await api.refreshWorkspaceReview({ repositoryPath: repository.rootPath });
        if (reviewScopeRequestRef.current === request) setWorkspaceReview(refreshed);
      } catch (cause) {
        if (reviewScopeRequestRef.current === request) {
          setTasklessReviewScope("task");
          setError(String(cause instanceof Error ? cause.message : cause));
        }
      }
      return;
    }
    if (task.reviewScope === scope && scope !== "worktree") return;
    const previousTask = task;
    const request = ++reviewScopeRequestRef.current;
    setError(null);
    setTask((current) => current && current.id === task.id ? {
      ...current,
      reviewScope: scope,
      reviewBaselineLabel: scope === "worktree" ? "Whole diff" : "Turn changes",
      reviewBaselineOid: scope === "worktree" ? "HEAD" : "task start",
    } : current);
    try {
      const refreshed = await api.refreshTaskReview({
        taskId: task.id,
        scope,
        repositoryPath: scope === "worktree" ? repository?.rootPath : undefined,
      });
      if (refreshed && reviewScopeRequestRef.current === request) setTask(refreshed);
    } catch (cause) {
      if (reviewScopeRequestRef.current === request) {
        setTask(previousTask);
        setError(String(cause instanceof Error ? cause.message : cause));
      }
    }
  }

  function addReviewFeedbackToPrompt(comments: ReviewCommentDraft[]) {
    const active = comments.filter((comment) => !comment.stale && comment.body.trim());
    if (!active.length) return;
    setReviewPromptFeedback((current) => {
      const merged = new Map(current.map((comment) => [comment.id, comment]));
      for (const comment of active) merged.set(comment.id, comment);
      return [...merged.values()];
    });
  }

  async function undoReviewFile(filePath: string) {
    if (!task || !canUndoFile) return;
    setBusy(true);
    setIdeMenuOpen(null);
    try {
      const next = await api.revertReviewFile({ taskId: task.id, path: filePath });
      if (!next) return;
      setExpandedReviewPaths((current) => {
        const remaining = new Set(current);
        remaining.delete(filePath);
        return remaining;
      });
      setTask(next);
      upsertChatFromTask(next);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setBusy(false);
    }
  }

  function suppressDraftSaveBriefly() {
    suppressDraftSaveRef.current = true;
    window.setTimeout(() => {
      suppressDraftSaveRef.current = false;
    }, 80);
  }

  function updateMention(value: string, cursor: number | null) {
    // Every composer interaction routes through here, which makes it the one
    // place that knows where the caret is. Dictation reads it later.
    if (cursor !== null) promptCaretRef.current = cursor;
    const nextMention = cursor === null ? null : mentionAtCursor(value, cursor);
    setMention(nextMention);
    if (!nextMention) setFileMatches([]);
    if (!nextMention || nextMention.kind !== "skill") setSelectedSkillIndex(0);
  }

  function handlePromptChange(event: React.ChangeEvent<HTMLTextAreaElement>) {
    const nextPrompt = event.target.value;
    followComposerScrollRef.current = true;
    setPrompt(nextPrompt);
    updateMention(nextPrompt, event.target.selectionStart);
  }

  function mergeAttachments(current: ChatAttachment[], files: ChatAttachment[]): ChatAttachment[] {
    const next = [...current];
    for (const file of files.map(normalizeAttachment)) {
      const key = file.storedPath || file.path;
      if (!next.some((attached) => (attached.storedPath || attached.path) === key)) {
        next.push(file);
      }
      if (next.length >= 16) break;
    }
    return next;
  }

  function removeAttachment(file: ChatAttachment) {
    const key = file.storedPath || file.path;
    setAttachedFiles((current) => current.filter((attached) => (attached.storedPath || attached.path) !== key));
  }

  async function openMessageAttachment(file: ChatAttachment) {
    if (isImageAttachment(file) && file.previewDataUrl) {
      setPreviewAttachment(file);
      return;
    }
    const result = await api.openChatAttachment({ attachment: file, repositoryId: repository?.id });
    if (!result.ok) {
      setError(result.message);
    }
  }

  function insertAttachmentMentions(files: ChatAttachment[]) {
    const normalized = files.map(normalizeAttachment);
    if (!normalized.length) return;
    const node = textareaRef.current;
    const cursor = node?.selectionStart ?? prompt.length;
    const before = prompt.slice(0, cursor);
    const after = prompt.slice(cursor);
    const leading = before && !/\s$/.test(before) ? " " : "";
    const trailing = after && !/^\s/.test(after) ? " " : "";
    const mentionText = normalized.map(attachmentMention).join(" ");
    const insertion = `${leading}${mentionText} ${trailing}`;
    const nextPrompt = `${before}${insertion}${after}`;
    const caret = cursor + insertion.length;
    setPrompt(nextPrompt);
    setMention(null);
    setFileMatches([]);
    setSelectedFileIndex(0);
    window.setTimeout(() => {
      const current = textareaRef.current;
      if (!current) return;
      current.focus();
      current.setSelectionRange(caret, caret);
    }, 0);
  }

  function addAttachment(file: ChatAttachment) {
    const normalized = normalizeAttachment(file);
    setAttachedFiles((current) => mergeAttachments(current, [normalized]));
    if (mention?.kind === "file") {
      const mentionText = `${attachmentMention(normalized)} `;
      const nextPrompt = `${prompt.slice(0, mention.start)}${mentionText}${prompt.slice(mention.end)}`;
      setPrompt(nextPrompt);
      setMention(null);
      setFileMatches([]);
      setSelectedFileIndex(0);
      window.setTimeout(() => {
        const node = textareaRef.current;
        if (!node) return;
        const caret = mention.start + mentionText.length;
        node.focus();
        node.setSelectionRange(caret, caret);
      }, 0);
      return;
    }

    insertAttachmentMentions([normalized]);
  }

  function selectMentionCategory(category: MentionCategoryId) {
    setMentionScope(category);
    setSelectedFileIndex(0);
    setSelectedSkillIndex(0);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function backToMentionCategories() {
    const index = mentionCategories.findIndex((category) => category.id === mentionScope);
    setMentionScope(null);
    setSelectedCategoryIndex(index >= 0 ? index : 0);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function insertSkillMention(skill: SkillInfo) {
    const node = textareaRef.current;
    // Skills commit from the $ trigger and from the @ menu's Skills scope;
    // either way the typed trigger text is replaced by the skill token.
    const activeMention = mention;
    const cursor = activeMention?.start ?? node?.selectionStart ?? prompt.length;
    const end = activeMention?.end ?? cursor;
    const before = prompt.slice(0, activeMention ? activeMention.start : cursor);
    const after = prompt.slice(end);
    const leading = before && !/\s$/.test(before) ? " " : "";
    const trailing = after && !/^\s/.test(after) ? " " : "";
    const mentionText = `${skillMention(skill)} `;
    const insertion = `${leading}${mentionText}${trailing}`;
    const nextPrompt = `${before}${insertion}${after}`;
    const caret = before.length + insertion.length;
    setPrompt(nextPrompt);
    setMention(null);
    setSelectedSkillIndex(0);
    window.setTimeout(() => {
      const current = textareaRef.current;
      if (!current) return;
      current.focus();
      current.setSelectionRange(caret, caret);
    }, 0);
  }

  async function pickAttachment() {
    if (busy || closedChatNotice) return;
    setError(null);
    try {
      const chatId = await ensureChatForAttachments();
      const result = await api.pickAttachmentFiles({ chatId, repositoryId: repository?.id });
      if (result.canceled) return;
      const files = result.files.map(normalizeAttachment);
      setAttachedFiles((current) => mergeAttachments(current, files));
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function ensureChatForAttachments(): Promise<string> {
    if (activeChatId) return activeChatId;
    const chat = await api.createChat({
      ...chatInputForCurrentProject(prompt.trim() ? titleFromPrompt(prompt) : "New chat"),
    });
    mergeChat(chat);
    suppressDraftSaveBriefly();
    setActiveChatId(chat.id);
    return chat.id;
  }

  function fileToPastedAttachment(file: File): Promise<PastedAttachmentInput> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== "string") {
          reject(new Error("Could not read pasted file."));
          return;
        }
        resolve({
          name: file.name || (file.type.startsWith("image/") ? "pasted-image.png" : "pasted-file"),
          mimeType: file.type || undefined,
          dataUrl: reader.result,
        });
      };
      reader.onerror = () => reject(reader.error ?? new Error("Could not read pasted file."));
      reader.readAsDataURL(file);
    });
  }

  async function attachPastedFiles(files: File[]) {
    if (!files.length || !canAttachFiles) return;
    setError(null);
    try {
      const chatId = await ensureChatForAttachments();
      const payload = await Promise.all(files.slice(0, 16).map(fileToPastedAttachment));
      const result = await api.savePastedAttachments({ chatId, files: payload });
      setAttachedFiles((current) => mergeAttachments(current, result.files.map(normalizeAttachment)));
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  function handleComposerPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files).filter((file) => file.size > 0);
    if (files.length) {
      event.preventDefault();
      void attachPastedFiles(files);
      return;
    }
    const pastedText = event.clipboardData.getData("text/plain");
    const insertion = insertPastedComposerText(
      prompt,
      pastedText,
      event.currentTarget.selectionStart,
      event.currentTarget.selectionEnd,
    );
    event.preventDefault();
    setPrompt(insertion.value);
    updateMention(insertion.value, insertion.caret);
    window.requestAnimationFrame(() => textareaRef.current?.setSelectionRange(insertion.caret, insertion.caret));
  }

  function handleComposerDrop(event: React.DragEvent<HTMLDivElement>) {
    const files = Array.from(event.dataTransfer.files).filter((file) => file.size > 0);
    if (!files.length) return;
    event.preventDefault();
    void attachPastedFiles(files);
  }

  function handleComposerDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (event.dataTransfer.types.includes("Files")) {
      event.preventDefault();
    }
  }

  function handlePromptKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (promptReferenceMenuOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        setMentionScope(null);
        setFileMatches([]);
        setSelectedCategoryIndex(0);
        setSelectedFileIndex(0);
        setSelectedSkillIndex(0);
        return;
      }
      if (categoryMenuOpen) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setSelectedCategoryIndex((current) => {
            const direction = event.key === "ArrowDown" ? 1 : -1;
            return Math.max(0, Math.min(mentionCategories.length - 1, current + direction));
          });
          return;
        }
        if ((!event.shiftKey && event.key === "Enter") || event.key === "Tab") {
          event.preventDefault();
          selectMentionCategory(mentionCategories[selectedCategoryIndex].id);
          return;
        }
      }
      if (mentionScope && mention?.kind === "file" && !mentionQuery && event.key === "Backspace") {
        event.preventDefault();
        backToMentionCategories();
        return;
      }
      if (fileSearchKind && (event.key === "ArrowDown" || event.key === "ArrowUp") && fileMatches.length) {
        event.preventDefault();
        setSelectedFileIndex((current) => {
          const direction = event.key === "ArrowDown" ? 1 : -1;
          return Math.max(0, Math.min(fileMatches.length - 1, current + direction));
        });
        return;
      }
      if (skillMenuOpen && (event.key === "ArrowDown" || event.key === "ArrowUp") && skillMatches.length) {
        event.preventDefault();
        setSelectedSkillIndex((current) => {
          const direction = event.key === "ArrowDown" ? 1 : -1;
          return Math.max(0, Math.min(skillMatches.length - 1, current + direction));
        });
        return;
      }
      if (fileSearchKind && ((!event.shiftKey && event.key === "Enter") || event.key === "Tab") && fileMatches.length) {
        event.preventDefault();
        addAttachment(fileMatches[Math.min(selectedFileIndex, fileMatches.length - 1)]);
        return;
      }
      if (skillMenuOpen && ((!event.shiftKey && event.key === "Enter") || event.key === "Tab") && skillMatches.length) {
        event.preventDefault();
        insertSkillMention(skillMatches[Math.min(selectedSkillIndex, skillMatches.length - 1)]);
        return;
      }
    }
    if (event.key !== "Enter") {
      return;
    }
    if (event.shiftKey) {
      const target = event.currentTarget;
      const continuation = continueNumberedList(target.value, target.selectionStart, target.selectionEnd);
      if (!continuation) return;
      event.preventDefault();
      followComposerScrollRef.current = true;
      setPrompt(continuation.value);
      setMention(null);
      setFileMatches([]);
      setSelectedFileIndex(0);
      setSelectedSkillIndex(0);
      window.requestAnimationFrame(() => {
        textareaRef.current?.setSelectionRange(continuation.caret, continuation.caret);
      });
      return;
    }
    event.preventDefault();
    if (isGenerating) {
      queueCurrentPrompt();
    } else {
      void startTask();
    }
  }

  async function newChat() {
    setError(null);
    try {
      if (activeChatId) await persistDraft(activeChatId, prompt, attachedFiles);
      setRepository(null);
      resetUnsavedChat("");
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function newProject() {
    setError(null);
    setBusy(true);
    try {
      if (activeChatId) await persistDraft(activeChatId, prompt, attachedFiles);
      const result = await api.pickRepository();
      if (!result.canceled) {
        resetUnsavedChat(result.repository.rootPath);
        mergeProject(result.repository);
        setRepository(result.repository);
      }
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setBusy(false);
    }
  }

  async function newChatForProject(project: { name: string; path?: string }) {
    if (!project.path) return;
    setError(null);
    try {
      if (activeChatId) await persistDraft(activeChatId, prompt, attachedFiles);
      // Scoped to the folder being opened, not the one being left: the draft to
      // restore belongs to the new chat's workspace.
      resetUnsavedChat(project.path);
      const nextRepository = await api.getRepository({ repositoryPath: project.path });
      if (nextRepository) {
        mergeProject(nextRepository);
        setRepository(nextRepository);
      }
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function newChatForWorktree(project: { name: string; path?: string }, worktree: WorktreeChatGroup) {
    if (!project.path || !worktree.rootTaskId) return;
    setError(null);
    try {
      if (activeChatId) await persistDraft(activeChatId, prompt, attachedFiles);
      // This path creates a real chat immediately, so there is no unsaved draft
      // to restore into.
      resetUnsavedChat(null);
      const nextRepository = await api.getRepository({ repositoryPath: project.path });
      if (nextRepository) {
        mergeProject(nextRepository);
        setRepository(nextRepository);
      }
      const chat = await api.createChat({
        title: "New chat",
        repositoryName: project.name,
        repositoryPath: project.path,
        worktreeTaskId: worktree.rootTaskId,
      });
      mergeChat(chat);
      suppressDraftSaveBriefly();
      setActiveChatId(chat.id);
      setPrompt("");
      setCollapsedProjectKeys((current) => {
        if (!current.has(project.path ?? "")) return current;
        const next = new Set(current);
        next.delete(project.path ?? "");
        return next;
      });
      setCollapsedWorktreeKeys((current) => {
        if (!current.has(worktree.key)) return current;
        const next = new Set(current);
        next.delete(worktree.key);
        return next;
      });
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function selectChat(chat: ChatRecord, options: { persistCurrentDraft?: boolean } = {}) {
    const selectionSequence = chatSelectionSequenceRef.current + 1;
    chatSelectionSequenceRef.current = selectionSequence;
    if (activeChatId === chat.id) {
      const node = streamRef.current;
      if (node) {
        followComposerScrollRef.current = true;
        forceComposerBottomScrollRef.current = false;
        placeElementAtBottom(node);
      }
      void restoreChatRepository(chat, selectionSequence);
      return;
    }
    void restoreChatRepository(chat, selectionSequence);
    // The chat being left keeps what was typed into it — unless it is being
    // left because it was just deleted, and writing a draft back to it would
    // ask the store to hold a draft for a chat that no longer exists.
    if (activeChatId && options.persistCurrentDraft !== false) void persistDraft(activeChatId, prompt, attachedFiles);
    suppressDraftSaveBriefly();
    const cachedEvents = chat.taskId ? compactBackendEvents(cachedEventsForTask(chat.taskId), 500) : [];
    const canOpenImmediately = !chat.taskId || cachedEvents.length > 0;
    if (canOpenImmediately) {
      flushSync(() => {
        forceComposerBottomScrollRef.current = true;
        prepareVisibleTaskLoad(chat.taskId ?? null);
        setActiveChatId(chat.id);
        setEvents(cachedEvents);
        setExpandedActivityIds(new Set());
        setExpandedActivityToolIds(new Set());
        setPendingPermission(null);
        setError(null);
        setExpandedReviewPaths(new Set());
        setAttachedFiles(chat.attachedFiles ?? []);
        setMention(null);
        setFileMatches([]);
      });
      const openedNode = streamRef.current;
      if (openedNode) placeElementAtBottom(openedNode);
    } else {
      setError(null);
      setMention(null);
      setFileMatches([]);
    }
    try {
      let nextTask = chat.taskId ? await api.getTask({ taskId: chat.taskId }) : null;
      if (reviewOpen && nextTask?.state === "review_ready") {
        nextTask = (await api.refreshTaskReview({ taskId: nextTask.id })) ?? nextTask;
      }
      if (chatSelectionSequenceRef.current !== selectionSequence) return;
      if (!chat.taskId) {
        flushSync(() => {
          setVisibleTask(null);
          closeReviewPanel();
          setPrompt(chat.draftPrompt ?? "");
        });
        const node = streamRef.current;
        if (node) placeElementAtBottom(node);
        return;
      }
      const nextEvents = nextTask ? visibleEventsForTask(nextTask) : [];
      const draftPrompt = chat.draftPrompt ?? "";
      const sentDraft = nextTask ? draftMatchesTaskPrompt(draftPrompt, nextTask.prompt) : false;
      flushSync(() => {
        forceComposerBottomScrollRef.current = true;
        setActiveChatId(chat.id);
        setVisibleTask(nextTask);
        setEvents(compactBackendEvents(nextEvents, 500));
        setExpandedActivityIds(new Set());
        setExpandedActivityToolIds(new Set());
        setPendingPermission(pendingPermissionFromEvents(nextEvents));
        setError(null);
        setPrompt(sentDraft ? "" : draftPrompt);
        setAttachedFiles(!draftPrompt || sentDraft ? [] : (chat.attachedFiles ?? []));
        setMention(null);
        setFileMatches([]);
        setExpandedReviewPaths(new Set());
      });
      const node = streamRef.current;
      if (node) placeElementAtBottom(node);
      if (sentDraft) void persistDraft(chat.id, "", []);
    } catch (cause) {
      if (chatSelectionSequenceRef.current !== selectionSequence) return;
      if (canOpenImmediately) setVisibleTask(null);
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  function clearDeletedActiveChat() {
    suppressDraftSaveBriefly();
    setActiveChatId(null);
    setVisibleTask(null);
    setEvents([]);
    setExpandedActivityIds(new Set());
    setExpandedActivityToolIds(new Set());
    setPendingPermission(null);
    setExpandedReviewPaths(new Set());
    closeReviewPanel();
    setAttachedFiles([]);
    setMention(null);
    setFileMatches([]);
    setPrompt("");
  }

  function chatProjectTarget(group: ChatProjectGroup): ProjectDeleteTarget | null {
    if (!group.path) return null;
    const project = projects.find((row) => row.rootPath === group.path);
    if (!project) return null;
    const worktreeChatCount = group.worktrees.reduce((count, worktree) => count + worktree.chats.length, 0);
    return {
      id: project.id,
      key: group.key,
      name: group.name,
      path: group.path,
      chatCount: group.chats.length + worktreeChatCount,
    };
  }

  function removeDeletedChats(deletedChatIds: string[]) {
    if (!deletedChatIds.length) return;
    const deleted = new Set(deletedChatIds);
    setChats((current) => current.filter((chat) => !deleted.has(chat.id)));
    if (activeChatId && deleted.has(activeChatId)) {
      // An empty composer is what is left when nothing survived the delete, not
      // what deleting one chat out of several should mean.
      const successor = chatAfterDeletion(visibleChats, activeChatId, deleted);
      if (successor) void selectChat(successor, { persistCurrentDraft: false });
      else clearDeletedActiveChat();
    }
  }

  function projectMatchesRepository(project: ProjectDeleteTarget, selectedRepository: RepositoryInfo | null): boolean {
    return !!selectedRepository && selectedRepository.rootPath === project.path;
  }

  async function confirmDeleteCandidate() {
    if (!deleteCandidate) return;
    const target = deleteCandidate;
    setDeleteCandidate(null);
    try {
      if (target.kind === "chat") {
        await api.deleteChat({ chatId: target.chat.id });
        removeDeletedChats([target.chat.id]);
      } else if (target.kind === "projectChats") {
        const result = await api.deleteProjectChats({ projectId: target.project.id });
        const localDeletedChatIds = chats.filter((chat) => chat.repositoryPath === target.project.path).map((chat) => chat.id);
        removeDeletedChats(Array.from(new Set([...result.deletedChatIds, ...localDeletedChatIds])));
      } else {
        const result = await api.deleteProject({ projectId: target.project.id });
        const localDeletedChatIds = chats.filter((chat) => chat.repositoryPath === target.project.path).map((chat) => chat.id);
        removeDeletedChats(Array.from(new Set([...result.deletedChatIds, ...localDeletedChatIds])));
        setProjects((current) => current.filter((project) => project.id !== target.project.id));
        if (projectMatchesRepository(target.project, repository)) {
          setRepository(null);
        }
      }
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  function beginSidebarResize(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    document.body.classList.add("isResizing");
    const move = (moveEvent: PointerEvent) => {
      const nextWidth = startWidth + moveEvent.clientX - startX;
      setSidebarWidth(clamp(nextWidth, sidebarMinWidth, sidebarMaxAvailableWidth()));
    };
    const stop = () => {
      setSidebarWidth((current) => clamp(current, sidebarMinWidth, sidebarMaxAvailableWidth()));
      document.body.classList.remove("isResizing");
      event.currentTarget.removeEventListener("pointermove", move);
      event.currentTarget.removeEventListener("pointerup", stop);
    };
    event.currentTarget.addEventListener("pointermove", move);
    event.currentTarget.addEventListener("pointerup", stop, { once: true });
  }

  function beginReviewResize(event: React.PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    cancelReviewClose();
    setReviewHasSessionWidth(true);
    const startX = event.clientX;
    const startWidth = reviewWidth;
    document.body.classList.add("isResizing");
    const move = (moveEvent: PointerEvent) => {
      if (!moveEvent.isPrimary || (moveEvent.buttons & 1) !== 1) {
        stop();
        return;
      }
      const nextWidth = startWidth - (moveEvent.clientX - startX);
      setReviewWidth(clamp(nextWidth, reviewMinWidthForViewport(), reviewMaxWidth()));
    };
    const stop = () => {
      setReviewWidth((current) => clamp(current, reviewMinWidthForViewport(), reviewMaxWidth()));
      document.body.classList.remove("isResizing");
      event.currentTarget.removeEventListener("pointermove", move);
      event.currentTarget.removeEventListener("pointerup", stop);
      event.currentTarget.removeEventListener("pointercancel", stop);
    };
    event.currentTarget.addEventListener("pointermove", move);
    event.currentTarget.addEventListener("pointerup", stop, { once: true });
    event.currentTarget.addEventListener("pointercancel", stop, { once: true });
  }

  function handleReviewResizeKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 24 : 8;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setReviewHasSessionWidth(true);
    setReviewWidth((width) => clamp(width + (event.key === "ArrowLeft" ? step : -step), reviewMinWidthForViewport(), reviewMaxWidth()));
  }

  function renderChatRow(chat: ChatRecord) {
    const connectionLabel = chat.modelEndpointMode === "server"
      ? "Company server"
      : chat.modelEndpointMode === "local"
        ? "Local model"
        : "";
    // The number takes the connection icon's place rather than sitting beside
    // it: the slot is already the right size, so holding the modifier changes
    // what the row starts with without moving a single word of it.
    const jumpNumber = chatJumpKeysVisible ? chatJumpNumbersById.get(chat.id) : undefined;
    return (
      <div
        className={`chatRow ${activeChatId === chat.id ? "active" : ""} ${
          closedChatMessage(chat.taskState) ? "closed" : ""
        }`}
        key={chat.id}
      >
        <button className="chatRowMain" type="button" onClick={() => selectChat(chat)}>
          <span className={`chatRowContent ${connectionLabel || jumpNumber ? "hasConnection" : ""}`}>
            {jumpNumber ? (
              <span className="chatJumpKey" aria-hidden="true">{jumpNumber}</span>
            ) : connectionLabel ? (
              <span className="chatConnectionIcon" role="img" aria-label={connectionLabel} title={connectionLabel}>
                {chat.modelEndpointMode === "server" ? <Cloud size={12} aria-hidden="true" /> : <Monitor size={12} aria-hidden="true" />}
              </span>
            ) : null}
            <strong>{chatDisplayTitle(chat)}</strong>
            <em title={chat.updatedAt}>{chatSubline(chat)}</em>
          </span>
        </button>
        <button
          className="chatDeleteButton"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setDeleteCandidate({ kind: "chat", chat });
          }}
          title="Delete chat"
        >
          <Trash2 size={14} />
        </button>
      </div>
    );
  }

  return (
    <div
      className={`appShell ${isMacLike ? "macChrome" : ""} sidebarOpen ${
        reviewLayoutOpen ? "" : "reviewClosed"
      } ${reviewLayoutOpen ? "reviewOpen" : ""} ${reviewClosing ? "reviewClosing" : ""}`}
      ref={shellRef}
      style={layoutStyle}
    >
      <header className="topbar">
        <div className="topbarTitle" aria-hidden="true">
          <span className="topbarLogo" />
          <span>Umbratic</span>
        </div>
        <div className="topbarSpacer" />
      </header>

      <aside className="sidebar">
        <div className="sidebarResizeHandle" role="separator" tabIndex={0} aria-orientation="vertical" aria-valuemin={sidebarMinWidth} aria-valuemax={sidebarMaxAvailableWidth()} aria-valuenow={Math.round(sidebarWidth)} aria-label="Sidebar width" onPointerDown={beginSidebarResize} onKeyDown={(event) => { const step = event.shiftKey ? 24 : 8; if (event.key === "ArrowLeft") { event.preventDefault(); setSidebarWidth((width) => clamp(width - step, sidebarMinWidth, sidebarMaxAvailableWidth())); } if (event.key === "ArrowRight") { event.preventDefault(); setSidebarWidth((width) => clamp(width + step, sidebarMinWidth, sidebarMaxAvailableWidth())); } }} />
        <div className="sidebarStack">
          <section className="chatArchive">
            <div className="sideHeader">
              <h2>Chats</h2>
              <div className="newActionSplit" role="toolbar" aria-label="Create">
                <ShortcutTooltip id="chat.new" placement="bottom">
                  <button className="newActionButton" type="button" onClick={newChat} aria-label="New chat">
                    <SquarePen size={13} />
                  </button>
                </ShortcutTooltip>
                <button
                  className="newActionButton"
                  type="button"
                  onClick={() => void newProject()}
                  disabled={busy}
                  aria-label="New project"
                  title="New project"
                >
                  <FolderPlus size={13} />
                </button>
              </div>
            </div>
            <div className="chatList">
              {chatProjectGroups.length ? (
                chatProjectGroups.map((group) => {
                  const collapsed = collapsedProjectKeys.has(group.key);
                  const projectTarget = chatProjectTarget(group);
                  return (
                    <section className="chatProject" key={group.key}>
                      <div className="chatProjectHeader">
                        <button
                          className="chatProjectToggle"
                          type="button"
                          onClick={() => toggleProjectGroup(group.key)}
                          aria-expanded={!collapsed}
                          title={group.path ?? group.name}
                        >
                          <ChevronDown className={collapsed ? "collapsed" : ""} size={14} />
                          <span>
                            <strong>{group.name}</strong>
                          </span>
                        </button>
                        {group.path ? (
                          <button
                            className="chatProjectNewButton"
                            type="button"
                            onClick={() => void newChatForProject({ name: group.name, path: group.path })}
                            title={`Start a new chat in "${group.name}"`}
                          >
                            <SquarePen size={14} />
                          </button>
                        ) : null}
                        {projectTarget ? (
                          <div className="chatProjectActions">
                            <button
                              className="chatProjectActionButton"
                              type="button"
                              onClick={() => {
                                setProjectActionMenuKey((current) => (current === group.key ? null : group.key));
                              }}
                              aria-expanded={projectActionMenuKey === group.key}
                              aria-haspopup="menu"
                              title={`Project actions for "${group.name}"`}
                            >
                              <Ellipsis size={14} />
                            </button>
                            {projectActionMenuKey === group.key ? (
                              <div className="chatProjectMenu" role="menu">
                                {projectTarget.chatCount > 0 ? (
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      setProjectActionMenuKey(null);
                                      setDeleteCandidate({ kind: "projectChats", project: projectTarget });
                                    }}
                                  >
                                    <MessageSquareX size={14} />
                                    <span>Delete all chats</span>
                                  </button>
                                ) : null}
                                <button
                                  className="danger"
                                  type="button"
                                  role="menuitem"
                                  onClick={() => {
                                    setProjectActionMenuKey(null);
                                    setDeleteCandidate({ kind: "project", project: projectTarget });
                                  }}
                                >
                                  <FolderX size={14} />
                                  <span>Delete project</span>
                                </button>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      {!collapsed ? (
                        <div className={`chatProjectChats ${group.worktrees.length ? "hasWorktrees" : ""}`}>
                          {group.chats.map((chat) => renderChatRow(chat))}
                          {group.worktrees.map((worktree) => {
                            const worktreeCollapsed = collapsedWorktreeKeys.has(worktree.key);
                            const canCreateWorktreeChat = /^task-[A-Za-z0-9_-]+$/.test(worktree.rootTaskId);
                            return (
                              <section className="chatWorktree" key={worktree.key}>
                                <div className="chatWorktreeHeader">
                                  <button
                                    className="chatWorktreeToggle"
                                    type="button"
                                    onClick={() => toggleWorktreeGroup(worktree.key)}
                                    aria-expanded={!worktreeCollapsed}
                                    title={worktree.path}
                                  >
                                    <ChevronDown className={worktreeCollapsed ? "collapsed" : ""} size={13} />
                                    <GitBranch size={13} />
                                    <span>
                                      <strong>{worktreeTitle(worktree)}</strong>
                                      <em>{worktreeSubline(worktree)}</em>
                                    </span>
                                  </button>
                                  <button
                                    className="chatWorktreeNewButton"
                                    type="button"
                                    onClick={() => void newChatForWorktree(group, worktree)}
                                    disabled={!canCreateWorktreeChat}
                                    title={`Start a new chat in "${worktreeTitle(worktree)}"`}
                                  >
                                    <SquarePen size={13} />
                                  </button>
                                </div>
                                {!worktreeCollapsed ? (
                                  <div className="chatWorktreeChats">
                                    {worktree.chats.map((chat) => renderChatRow(chat))}
                                  </div>
                                ) : null}
                              </section>
                            );
                          })}
                          {!group.chats.length && !group.worktrees.length ? <div className="chatProjectEmpty">No chats yet.</div> : null}
                        </div>
                      ) : null}
                    </section>
                  );
                })
              ) : (
                <div className="archiveEmpty">
                  <CircleDashed size={17} />
                  <span>No chats yet.</span>
                </div>
              )}
            </div>
          </section>
        </div>

        <div className="sidebarFooter">
          <div className="sidebarBrand" aria-hidden="true"><span className="sidebarBrandRow"><span className="sidebarBrandMark" /><span className="sidebarBrandName">Umbratic</span></span><span className="confidentialMark">Private and Confidential</span></div>
          <ShortcutTooltip id="app.settings">
            <button
              className="settingsPlaceholder"
              type="button"
              onClick={() => openSettings()}
            >
              <Settings size={16} />
              <span>Settings</span>
            </button>
          </ShortcutTooltip>
        </div>
      </aside>

      <main className={`workspace ${approvalPending ? "approvalPending" : ""}`}>
        <section className="workArea">
          <section className="composerPanel">
            <div className="composerHeader">
              <div className="composerHeaderTitle">
                <strong>{composerHeaderTitle}</strong>
                <div className="composerHeaderMetaRow">
                  <span>{composerHeaderMeta}</span>
                  {remoteBadge ? <RemoteChatBadge name={remoteBadge.name} directory={remoteBadge.directory} /> : null}
                </div>
                {indexingThisWorkspace ? (
                  <span className="workspaceIndexing" role="status">
                    <span className="workspaceIndexingSpinner" aria-hidden="true" />
                    Indexing this folder…
                  </span>
                ) : null}
              </div>
              <div className="composerHeaderActions">
                {renderIdePicker("composer")}
                <ShortcutTooltip
                  id="review.toggle"
                  label={reviewOpen && !reviewClosing ? "Hide review" : reviewClosing ? "Keep review open" : "Open review"}
                  placement="bottom"
                >
                  <button
                    className="chromeButton composerReviewToggle"
                    type="button"
                    onClick={reviewClosing ? () => openReviewPanel() : toggleReviewPanel}
                    aria-pressed={reviewOpen && !reviewClosing}
                    aria-label={reviewOpen && !reviewClosing ? "Hide review" : reviewClosing ? "Keep review open" : "Open review"}
                  >
                    <PanelRight size={15} />
                  </button>
                </ShortcutTooltip>
              </div>
            </div>
            <div
              className="composerBody"
              ref={streamRef}
              onPointerDown={handleComposerScrollPointerDown}
              onScroll={handleComposerScroll}
              onTouchMove={handleComposerTouchMove}
              onWheel={handleComposerWheel}
            >
              {composerItems.length ? (
                <div className="timeline">
                  {composerItems.map((item) =>
                    item.type === "user" ? (
                      <article className="timelineMessage userMessage" key={item.id}>
                        <AttachmentPreviewList files={item.attachedFiles} mode="message" onOpen={openMessageAttachment} />
                        <div className="userMessageBubble">
                          {item.text ? <MarkdownContent content={item.text} /> : null}
                          {item.reviewFeedback.length ? (
                            <button
                              className="messageReviewFeedback"
                              type="button"
                              onClick={() => {
                                setReviewFeedbackPreview(item.reviewFeedback);
                                setReviewFeedbackDialogOpen(true);
                              }}
                              aria-haspopup="dialog"
                            >
                              <span className="messageReviewFeedbackIcon"><MessageSquareText size={13} /></span>
                              <span><strong>Review feedback</strong><small>{item.reviewFeedback.length} {item.reviewFeedback.length === 1 ? "comment" : "comments"}</small></span>
                              <ChevronRight size={13} aria-hidden="true" />
                            </button>
                          ) : null}
                        </div>
                        <div className="messageActions">
                          <button className="messageAction" type="button" onClick={() => void copyText(item.rawText)} title="Copy prompt">
                            <Copy size={14} />
                          </button>
                        </div>
                      </article>
                    ) : item.type === "compaction" ? (
                      <CompactionRow item={item} key={item.id} clock={activityClock} />
                    ) : item.type === "assistant" ? (
                      <AssistantMessage
                        key={item.id}
                        item={item}
                        settled={!isGenerating || item.id !== lastAssistantItemId}
                        rating={responseFeedback.get(item.id)}
                        copyText={item.text}
                        onCopy={(text) => void copyText(text)}
                        onRate={openResponseFeedbackDialog}
                        documents={
                          // Every turn has an answer, but the documents a run
                          // produced belong to the newest one — the review state
                          // they link into is the task's current state, not a
                          // snapshot of what scrollback said at the time.
                          item.id === lastAssistantItemId && reviewReadyForDisplay && documentReviewFiles.length ? (
                            <div className="documentResponseLinks" aria-label="Generated documents">
                              {documentReviewFiles.map((file) => (
                                <DocumentReviewResponseLink
                                  file={file}
                                  key={file.path}
                                  onOpenReview={openReviewPanel}
                                />
                              ))}
                            </div>
                          ) : null
                        }
                      >
                        <AssistantAnswerContent
                          content={item.text}
                          onReviewFileClick={handleReviewReference}
                          reviewFiles={reviewFiles}
                          streaming={Boolean(item.streaming)}
                        />
                      </AssistantMessage>
                    ) : (
                      <WorkingBlock
                        key={item.id}
                        item={item}
                        clock={activityClock}
                        expanded={expandedActivityIds.has(item.id)}
                        expandedToolIds={expandedActivityToolIds}
                        skills={skills}
                        followScrollRef={activityFollowScrollRef}
                        setExpanded={setExpandedActivityIds}
                        setExpandedTools={setExpandedActivityToolIds}
                        setBodyRef={setActivityBodyRef}
                        onPointerDown={handleActivityPointerDown}
                        onScroll={handleActivityScroll}
                        onTouchMove={handleActivityTouchMove}
                        onWheel={handleActivityWheel}
                      />
                    ),
                  )}
                  {codeReviewFiles.length && reviewReadyForDisplay ? (
                    <ReviewSummaryCard
                      fileCount={codeReviewFiles.length}
                      onOpenReview={() => openReviewPanel()}
                      totals={codeReviewTotals}
                    />
                  ) : null}
                </div>
              ) : (
                <ComposerGreeting label={todayPromptLabel} />
              )}
            </div>
          </section>
        </section>

        {task?.state === "awaiting_worktree_approval" ? (
          <section ref={modalRef} tabIndex={-1} className="floatingApproval" role="alertdialog" aria-modal="true" aria-label="Create isolated worktree" onKeyDown={(event) => { if (event.key === "Escape") void approveWorktree(false); }}>
            <div>
              <strong>Create isolated worktree?</strong>
              <span>{task.agentBranch} at {task.worktreePath}</span>
            </div>
            <button className="secondaryAction" type="button" onClick={() => approveWorktree(false)}>
              <X size={15} />
              Decline
            </button>
            <button className="primaryAction" type="button" onClick={() => approveWorktree(true)}>
              <Play size={15} />
              Create
            </button>
          </section>
        ) : pendingPermission ? (
          <section ref={modalRef} tabIndex={-1} className="floatingApproval" role="alertdialog" aria-modal="true" aria-label="Command permission request" onKeyDown={(event) => { if (event.key === "Escape") void resolvePermission("deny"); }}>
            <div>
              <strong>{pendingPermission.consequence ?? `${pendingPermission.kind} permission`}</strong>
              <span>{pendingPermission.command}</span>
              {pendingPermission.riskyFragment ? <span>Risky fragment: {pendingPermission.riskyFragment}</span> : null}
              {pendingPermission.suggestion ? <span>{pendingPermission.suggestion}</span> : null}
            </div>
            <button className="secondaryAction" type="button" onClick={() => resolvePermission("deny")}>
              <X size={15} />
              Deny
            </button>
            <button className="primaryAction" type="button" onClick={() => resolvePermission("allow")}>
              <ShieldCheck size={15} />
              Run once
            </button>
          </section>
        ) : null}

        <section className="promptDock">
          {/* Everything already committed but not yet answered, in one stack above
              the controls: messages waiting their turn, and the review comments
              riding along with the message being written. They were two trays in
              two places, which read as two unrelated things when they are both
              just "what is going out next". */}
          <div className={`composerPendingTray ${
            activeQueuedPrompts.length || reviewPromptFeedback.length || dictation.status.error
              ? "hasPending"
              : ""
          }`}>
            <QueuedPromptList
              items={activeQueuedPrompts}
              isGenerating={isGenerating}
              steerPending={steerPending}
              onEdit={editQueuedPrompt}
              onSteer={(item) => void steerSubmission(item, item.id)}
              onDelete={removeQueuedPrompt}
              onPreviewFeedback={(feedback) => {
                setReviewFeedbackPreview(feedback);
                setReviewFeedbackDialogOpen(true);
              }}
            />
            {dictation.status.error ? (
              // Sized to its sentence rather than to the composer: a line about
              // one microphone press that ruled a bar across the full width read
              // as a state the whole composer was in.
              <div className="dictationNotice" role="status" aria-live="polite">
                <Mic size={13} aria-hidden="true" />
                <span>{dictation.status.error}</span>
                <button
                  className="dictationNoticeDismiss"
                  type="button"
                  aria-label="Dismiss"
                  onClick={dictation.dismissError}
                >
                  <X size={11} aria-hidden="true" />
                </button>
              </div>
            ) : null}
            {reviewPromptFeedback.length ? <button className="composerReviewFeedback" type="button" onClick={() => { setReviewFeedbackPreview(null); setReviewFeedbackDialogOpen(true); }} aria-haspopup="dialog"><span className="composerReviewFeedbackIcon"><MessageSquareText size={12} /></span><span>Review feedback</span><ChevronRight className="composerReviewFeedbackChevron" size={12} aria-hidden="true" /></button> : null}
          </div>
          <div className="promptControls">
            <div className={`workspaceCluster ${repository?.kind === "git" ? "hasBranch" : ""}`}>
              <button className="workspaceControl" type="button" onClick={pickRepository} disabled={busy}>
                <span className="controlIcon"><FolderOpen size={14} /></span>
                <span>
                  <strong>{repository ? repository.name : "Select folder"}</strong>
                </span>
              </button>
              {repository?.kind === "git" ? (
                <BranchPicker
                  branch={repository.originalBranch}
                  branches={branches}
                  open={branchMenuOpen}
                  loading={branchesLoading}
                  error={branchError}
                  disabled={busy || checkoutPending}
                  checkoutPending={checkoutPending}
                  onToggleMenu={() => void toggleBranchMenu()}
                  onRefresh={() => void refreshBranches()}
                  onSelect={(branch) => void selectBranch(branch)}
                />
              ) : null}
            </div>

            <RemoteHostPicker
              connections={remoteSettings.connections}
              selectedId={remoteConnectionId}
              directory={remoteDirectory}
              disabled={busy}
              locked={task !== null}
              onSelect={(connectionId, directory) => {
                setRemoteConnectionId(connectionId);
                setRemoteDirectory(directory);
              }}
              onBrowse={(connectionId, path) => api.browseRemoteDirectory({ connectionId, path })}
              onManage={() => {
                setSettingsOpen(true);
                setSettingsTab("remote");
              }}
            />

            {canUseWorktreeMode && !remoteConnectionId ? (
              <WorktreeToggle
                useWorktree={useWorktreeForNextRun}
                locked={workspaceModeLocked}
                disabled={busy}
                onToggle={(next) => selectWorkspaceMode(next ? "worktree" : "local")}
              />
            ) : null}{endpointSettings.mode === "local" || backend?.veilFeatures.includes("web.search") === true ? (<WebToolsControl initial={startupSettings.webTools === true} disabled={busy} setWebTools={api.setWebTools} onError={setError} />) : null}

            <div className="attachmentControl">
              <button
                className="attachmentTrigger"
                type="button"
                onClick={() => void pickAttachment()}
                disabled={!canAttachFiles}
                title="Attach file"
              >
                <Paperclip size={14} />
                {attachedFiles.length ? <span className="attachmentCount">{attachedFiles.length}</span> : null}
              </button>
            </div>
          </div>
          {closedChatNotice ? (
            <div className="closedChatNotice">
              <CheckCircle2 size={15} />
              <span>{closedChatNotice}</span>
            </div>
          ) : null}
          <div className="composer" onDrop={handleComposerDrop} onDragOver={handleComposerDragOver}>
            {providerReconnect ? <ConnectionNotice state={providerReconnect} /> : null}
            {promptReferenceMenuOpen && !closedChatNotice ? (
              <div className="attachmentMenu" ref={attachmentMenuRef}>
                <div className="attachmentMenuHeader">
                  {mentionScope && mention?.kind === "file" ? (
                    <button
                      className="attachmentMenuBack"
                      type="button"
                      aria-label="Back to categories"
                      title="Back (⌫)"
                      onMouseDown={(pointer) => pointer.preventDefault()}
                      onClick={backToMentionCategories}
                    >
                      <ChevronLeft size={13} />
                    </button>
                  ) : skillMenuOpen ? (
                    <Sparkles size={14} />
                  ) : (
                    <AtSign size={14} />
                  )}
                  <span>
                    {skillMenuOpen
                      ? "Use a skill for this turn"
                      : !repository
                        ? "Search files after selecting a folder"
                        : categoryMenuOpen
                          ? `Add context from ${repository.name}`
                          : mentionMode === "file"
                            ? `Files in ${repository.name}`
                            : mentionMode === "folder"
                              ? `Folders in ${repository.name}`
                              : `Files & folders in ${repository.name}`}
                  </span>
                </div>
                <div className="attachmentMenuList">
                {categoryMenuOpen ? (
                  mentionCategories.map((category, index) => (
                    <button
                      className={`attachmentMenuCategory${index === selectedCategoryIndex ? " active" : ""}`}
                      data-category-index={index}
                      key={category.id}
                      type="button"
                      onMouseDown={(pointer) => pointer.preventDefault()}
                      onClick={() => selectMentionCategory(category.id)}
                      onMouseEnter={() => setSelectedCategoryIndex(index)}
                    >
                      {mentionCategoryIcon(category.id)}
                      <span>
                        <strong>{category.label}</strong>
                        <em>{category.hint}</em>
                      </span>
                      <ChevronRight className="attachmentMenuCategoryChevron" size={13} />
                    </button>
                  ))
                ) : skillMenuOpen ? (
                  skillMatches.length ? (
                    skillMatches.map((skill, index) => (
                      <button
                        className={index === selectedSkillIndex ? "active" : ""}
                        data-skill-index={index}
                        key={skill.id}
                        type="button"
                        onClick={() => insertSkillMention(skill)}
                        onMouseEnter={() => setSelectedSkillIndex(index)}
                      >
                        <Sparkles size={14} />
                        <span>
                          <strong>
                            <MentionMatchText text={skill.name} query={skillSearchQuery} />
                          </strong>
                          <em>{skill.description || skill.id}</em>
                        </span>
                        <small>{skillsEnabled[skill.id] === false ? "Off" : skillMention(skill)}</small>
                      </button>
                    ))
                  ) : (
                    <div className="attachmentMenuEmpty">No matching skills</div>
                  )
                ) : repository ? (
                  fileMatches.length ? (
                    fileMatches.map((file, index) => (
                      <button
                        className={index === selectedFileIndex ? "active" : ""}
                        data-file-index={index}
                        key={file.path}
                        type="button"
                        onClick={() => addAttachment(file)}
                        onMouseEnter={() => setSelectedFileIndex(index)}
                      >
                        {file.kind === "folder" ? <Folder size={14} /> : <File size={14} />}
                        <span>
                          <strong>
                            <MentionMatchText text={file.name} query={attachmentSearchQuery} />
                          </strong>
                          <em>
                            <MentionMatchText text={file.path} query={attachmentSearchQuery} />
                          </em>
                        </span>
                      </button>
                    ))
                  ) : (
                    <div className="attachmentMenuEmpty">
                      {mentionMode === "file"
                        ? "No matching files"
                        : mentionMode === "folder"
                          ? "No matching folders"
                          : "No matching files or folders"}
                    </div>
                  )
                ) : null}
                </div>
                <div className="attachmentMenuHints">
                  <span>
                    <kbd>↑</kbd>
                    <kbd>↓</kbd> Navigate
                  </span>
                  <span>
                    <kbd>↵</kbd> Select
                  </span>
                  {mentionScope && mention?.kind === "file" ? (
                    <span>
                      <kbd>⌫</kbd> Back
                    </span>
                  ) : null}
                  <span>
                    <kbd>esc</kbd> Dismiss
                  </span>
                  {categoryMenuOpen ? <span className="attachmentMenuHintNote">or just type to search</span> : null}
                </div>
              </div>
            ) : null}
            {/* Pressing the microphone before dictation is set up is the one
                moment someone is definitely interested in it. The offer floats
                over the prompt text rather than displacing anything, so it
                costs no height and nothing in the composer moves. The text
                behind it is blurred back: the question is the only thing worth
                reading while it is up, and the rail stays clear so the
                microphone that raised it is still there to press. */}
            <div className="promptInputShell">
              {dictationSetupOffer && !dictationAvailable ? (
                <div
                  className="dictationSetupOverlay"
                  role="status"
                  onMouseDown={(event) => { if (event.target === event.currentTarget) setDictationSetupOffer(false); }}
                >
                  <div className="dictationSetupCard">
                    <span className="dictationSetupIcon"><MicOff size={13} aria-hidden="true" /></span>
                    <span className="dictationSetupText">Dictation is off</span>
                    <button
                      type="button"
                      className="primaryAction dictationSetupAction"
                      onClick={() => {
                        setDictationSetupOffer(false);
                        setSettingsOpen(true);
                        setSettingsTab("voice");
                      }}
                    >
                      Voice settings
                    </button>
                    <button className="dictationSetupDismiss" type="button" aria-label="Dismiss" onClick={() => setDictationSetupOffer(false)}>
                      <X size={12} />
                    </button>
                  </div>
                </div>
              ) : null}
              {/* Always in the flow, so the shell's three rows line up whether or
                  not anything is attached; it collapses to nothing when empty. */}
              <div className="promptAttachmentStrip">
                <AttachmentPreviewList files={pickedAttachments} mode="composer" onRemove={removeAttachment} />
              </div>
              <div className="promptEditor">
                <div className="promptHighlight" aria-hidden="true">
                  <div style={{ transform: `translateY(-${promptScrollTop}px)` }}>
                    {renderPromptHighlights(prompt, attachedFiles, skills)}
                    {/* The words being spoken, muted, in the box they are going
                        into. They are drawn behind the textarea rather than
                        written into it: a partial is replaced whole on every
                        update, and rewriting the value would move a caret the
                        user may have placed. Only the final text is inserted. */}
                    {dictation.status.preview ? (
                      <span className="promptDictationGhost">
                        {prompt && !prompt.endsWith(" ") ? " " : ""}
                        {dictation.status.preview}
                      </span>
                    ) : null}
                  </div>
                </div>
                <textarea
                  ref={textareaRef}
                  value={prompt}
                  onChange={handlePromptChange}
                  onKeyDown={handlePromptKeyDown}
                  onPaste={handleComposerPaste}
                  onKeyUp={(event) => updateMention(event.currentTarget.value, event.currentTarget.selectionStart)}
                  onClick={(event) => updateMention(event.currentTarget.value, event.currentTarget.selectionStart)}
                  onSelect={(event) => updateMention(event.currentTarget.value, event.currentTarget.selectionStart)}
                  onScroll={(event) => setPromptScrollTop(event.currentTarget.scrollTop)}
                  disabled={busy || !!closedChatNotice}
                  placeholder={
                    // The ghost transcript occupies the same line, so the
                    // placeholder stands down rather than printing under it.
                    dictation.status.preview
                      ? ""
                      : closedChatNotice ? "This chat is closed. Start a new chat for more changes." : todayPromptLabel
                  }
                />
              </div>
              <div className="promptActionRail">
                {/* What this turn will do, on the left: speak it instead of
                    typing it, and whether it may act without asking. What will
                    answer it, on the right. The two halves are separate
                    questions and the gap between them is what says so. */}
                <div className="promptRailGroup promptRailLeft">
                  <DictationControl status={dictation.status} enabled={dictationAvailable} onToggle={dictation.toggle}
                    devices={dictation.devices} deviceId={dictation.deviceId} onSelectDevice={dictation.selectDevice}
                    onRequestSetup={() => setDictationSetupOffer(true)} />
                  <PermissionModePicker
                    mode={permissionMode}
                    open={permissionMenuOpen}
                    onToggleMenu={() => {
                      setPermissionMenuOpen((open) => {
                        const next = !open;
                        if (next) setBranchMenuOpen(false);
                        return next;
                      });
                    }}
                    onSelect={(mode) => {
                      setPermissionMenuOpen(false);
                      void updatePermissionMode(mode);
                    }}
                  />
                </div>
                <div className="promptRailGroup promptRailRight">
                  {composerModels.length > 1 || modelReasoningEfforts.length > 0 || endpointSettings.mode === "local" ? (
                    <ComposerModelPicker
                      models={composerModels}
                      selectedId={selectedModel?.modelId ?? ""}
                      disabled={busy}
                      disabledReason="Wait for the current run to finish"
                      onOpen={() => {
                        if (endpointSettings.mode !== "server") {
                          void refreshDownloadedChatModels();
                          return;
                        }
                        void api.listServerModels().then(setServerModels).catch(() => undefined);
                      }}
                      efforts={modelReasoningEfforts}
                      effort={reasoningEffort}
                      effortDisabled={busy || isGenerating}
                      showThinking={showThinking}
                      showThinkingAvailable={backend?.veilFeatures.includes("chat.reasoning_visible") === true}
                      onSelect={(modelId) => void selectComposerModel(modelId)}
                      onSelectEffort={(next) => void updateReasoningEffort(next)}
                      onToggleShowThinking={(next) => void updateShowThinking(next)}
                      onManage={endpointSettings.mode === "local" ? () => {
                        setSettingsOpen(true);
                        setSettingsTab("account");
                      } : undefined}
                    />
                  ) : selectedModel ? (
                    // One model is still worth naming: the answer to "what am I
                    // talking to" should not depend on there being a choice.
                    <span className="promptRailModelName" title={`Model: ${selectedModel.displayName}`}>
                      {selectedModel.displayName}
                    </span>
                  ) : null}
                  {showContextMeter ? (
                    <ContextMeter
                      estimate={contextEstimate}
                      state={contextMeterLabel}
                      breakdown={runnerContextUsage?.breakdown}
                      compactionBlocked={runnerContextUsage?.compactionBlocked}
                      compactionBlockedReason={runnerContextUsage?.compactionBlockedReason}
                      compacting={contextCompacting}
                      draftTokens={composerDraftTokens}
                    />
                  ) : null}
                {isGenerating && !hasComposerMessage ? (
                  // A chord is only named while it would do something: offering
                  // one beside "Stopping generation" advertises a key for a
                  // state that ignores it.
                  <ShortcutTooltip id="run.stop" label="Stop generation" disabled={stopPending}>
                    <button
                      className="sendButton stopButton"
                      type="button"
                      onClick={() => void stopTask()}
                      disabled={stopPending}
                      aria-label={stopPending ? "Stopping generation" : "Stop generation"}
                    >
                      {stopPending ? <Loader2 className="spin" size={17} /> : <Square aria-hidden="true" fill="currentColor" size={12} />}
                    </button>
                  </ShortcutTooltip>
                ) : isGenerating ? (
                  <ShortcutTooltip id="composer.send" label="Queue prompt">
                    <button
                      className="sendButton queueButton"
                      type="button"
                      onClick={queueCurrentPrompt}
                      disabled={!canQueue}
                      aria-label="Queue prompt"
                    >
                      <Send aria-hidden="true" size={16} />
                    </button>
                  </ShortcutTooltip>
                ) : (
                  <ShortcutTooltip id="composer.send" label="Send prompt">
                    <button className="sendButton" type="button" onClick={() => void startTask()} disabled={!canStart} aria-label="Send prompt">
                      {busy ? <Loader2 className="spin" size={17} /> : <Send aria-hidden="true" size={17} />}
                    </button>
                  </ShortcutTooltip>
                )}
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <aside className="reviewSidebar">
        <ReviewPanel
          files={reviewFiles}
          initialSelectedPath={reviewTargetPath}
          taskId={task?.id ?? `workspace:${repository?.rootPath ?? "none"}`}
          patchHash={task?.reviewPatchHash}
          scope={task?.reviewScope ?? tasklessReviewScope}
          canUseWorktreeScope={repository?.kind === "git" || task?.workspaceKind === "git"}
          canOpenIde={canOpenIde}
          canUndoFile={canUndoFile}
          selectedIdeLabel={selectedIde.label}
          onClose={closeReviewPanel}
          onUndoFile={(filePath) => void undoReviewFile(filePath)}
          onOpenFile={openReviewFile}
          onScopeChange={changeReviewScope}
          onResizePointerDown={beginReviewResize}
          onResizeKeyDown={handleReviewResizeKeyDown}
          onAddFeedback={addReviewFeedbackToPrompt}
          onLoadDocumentReview={(documentPath) => task
            ? api.readArtifactPreview({ taskId: task.id, documentPath })
            : Promise.resolve({ ok: false, code: "not_available", message: "Document previews are available for task reviews." })}
        />
      </aside>

      {responseFeedbackDialog ? (
        <div
          className="modalScrim responseFeedbackScrim"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !responseFeedbackSubmitting) {
              setResponseFeedbackDialog(null);
            }
          }}
        >
          <form
            ref={modalRef as React.RefObject<HTMLFormElement>}
            tabIndex={-1}
            className="responseFeedbackDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="response-feedback-title"
            onSubmit={(event) => {
              event.preventDefault();
              void submitResponseFeedback();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !responseFeedbackSubmitting) {
                setResponseFeedbackDialog(null);
              }
            }}
          >
            <header>
              <span className={`responseFeedbackDialogIcon is${responseFeedbackDialog.rating === "good" ? "Good" : "Bad"}`}>
                {responseFeedbackDialog.rating === "good" ? <ThumbsUp size={16} /> : <ThumbsDown size={16} />}
              </span>
              <h3 id="response-feedback-title">
                {responseFeedbackDialog.rating === "good"
                  ? "What made this a good answer?"
                  : "What could be better?"}
              </h3>
              <button
                className="responseFeedbackClose"
                type="button"
                aria-label="Close response feedback"
                disabled={responseFeedbackSubmitting}
                onClick={() => setResponseFeedbackDialog(null)}
              >
                <X size={15} />
              </button>
            </header>
            <fieldset>
              <legend>Choose one (optional)</legend>
              <div className="responseFeedbackOptions">
                {responseFeedbackReasons[responseFeedbackDialog.rating].map((reason) => (
                  <button
                    type="button"
                    key={reason}
                    aria-pressed={responseFeedbackDialog.reason === reason}
                    onClick={() => setResponseFeedbackDialog((current) => current ? {
                      ...current,
                      reason: current.reason === reason ? undefined : reason,
                    } : current)}
                  >
                    {reason}
                  </button>
                ))}
              </div>
            </fieldset>
            <label>
              <span>Additional details (optional)</span>
              <textarea
                ref={responseFeedbackInputRef}
                autoFocus
                data-modal-autofocus
                value={responseFeedbackDialog.comment}
                maxLength={1000}
                placeholder="Add a note"
                onChange={(event) => {
                  const comment = event.target.value;
                  setResponseFeedbackDialog((current) => current ? { ...current, comment } : current);
                }}
              />
            </label>
            <footer>
              <button
                className="secondaryAction"
                type="button"
                disabled={responseFeedbackSubmitting}
                onClick={() => setResponseFeedbackDialog(null)}
              >
                Cancel
              </button>
              <button className="primaryAction" type="submit" disabled={responseFeedbackSubmitting}>
                {responseFeedbackSubmitting ? "Submitting…" : "Submit"}
              </button>
            </footer>
          </form>
        </div>
      ) : null}
      {reviewFeedbackDialogOpen ? (() => {
        const readOnly = reviewFeedbackPreview !== null;
        const dialogFeedback = readOnly
          ? reviewFeedbackPreview.map((comment, index) => ({ ...comment, id: `sent-${index}` }))
          : reviewPromptFeedback.map((comment) => ({ ...comment, lineLabel: reviewCommentLineLabel(comment) }));
        const closeDialog = () => {
          setReviewFeedbackDialogOpen(false);
          setReviewFeedbackPreview(null);
        };
        return (
          <div className="modalScrim reviewFeedbackScrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }}>
            <section className="reviewFeedbackDialog" role="dialog" aria-modal="true" aria-labelledby="review-feedback-title" onKeyDown={(event) => { if (event.key === "Escape") closeDialog(); }}>
              <header><span><MessageSquareText size={16} /><strong id="review-feedback-title">Review feedback</strong><small>{dialogFeedback.length}</small></span><button type="button" onClick={closeDialog} aria-label="Close review feedback"><X size={15} /></button></header>
              <div>{dialogFeedback.map((comment) => <article key={comment.id}><div><button className="reviewFeedbackFileLink" type="button" onClick={() => { closeDialog(); openReviewReference(comment.filePath); }} title={`Open ${comment.filePath} in review`}><strong>{comment.filePath}</strong></button><small>{comment.lineLabel}</small></div><p>{comment.body}</p>{!readOnly ? <button type="button" onClick={() => setReviewPromptFeedback((current) => current.filter((candidate) => candidate.id !== comment.id))} aria-label={`Remove feedback for ${comment.filePath}`}><X size={13} /></button> : null}</article>)}</div>
              <footer>{!readOnly ? <button type="button" onClick={() => { setReviewPromptFeedback([]); closeDialog(); }}>Remove all</button> : null}<button className="primaryAction" type="button" onClick={closeDialog}>Done</button></footer>
            </section>
          </div>
        );
      })() : null}

      {settingsOpen ? (
        <div className="modalScrim" role="presentation">
          <section ref={modalRef} tabIndex={-1} className="settingsDialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onKeyDown={(event) => { if (event.key === "Escape") closeSettingsDialog(); }}>
            <header className="settingsDialogHeader">
              <span>
                <Settings size={17} />
                <strong id="settings-title">Settings</strong>
              </span>
              <button className="chromeButton" type="button" onClick={closeSettingsDialog} title="Close settings">
                <X size={15} />
              </button>
            </header>

            <div className="settingsLayout">
              <SettingsNav active={settingsTab} onSelect={setSettingsTab} />

              <div className="settingsContent">
                {settingsTab === "account" ? <ConnectionSettingsPanel controller={connectionSettings} /> : null}

                {settingsTab === "remote" ? <RemoteSettingsPanel controller={remoteSettings} /> : null}

                {settingsTab === "harness" ? (
                  <HarnessSettingsPanel
                    draftProfile={harnessDraftProfile}
                    draftContextLength={harnessDraftContextLength}
                    draftContextIndex={harnessDraftContextIndex}
                    endpointMode={endpointDraftSettings.mode}
                    saving={harnessSaving}
                    saveFeedback={harnessSaveFeedback}
                    dirty={harnessDirty}
                    message={harnessMessage}
                    onSelectProfile={selectHarnessProfile}
                    onDraftContextLength={(option) => {
                      setHarnessDraftContextLength(option);
                      setHarnessMessage(null);
                    }}
                    onSave={() => void saveHarnessProfile()}
                  />
                ) : null}

                {settingsTab === "appearance" ? (
                  <AppearanceSettingsPanel
                    settings={appearanceSettings}
                    uiFontOptions={uiFontOptions}
                    monoFontOptions={monoFontOptions}
                    fontScanPending={fontScanPending}
                    fontScanMessage={fontScanMessage}
                    fontScanAvailable={localFontAccessAvailable()}
                    onChange={(next) => updateAppearanceSettings(next)}
                    onScanFonts={() => void scanSystemFonts()}
                  />
                ) : null}

                {settingsTab === "voice" ? (
                  <VoiceSettings api={api} backend={backend} active onBackendStatus={setBackend}
                    serverMode={connectionSettings.settings.mode === "server"} speechAdvertised={dictationAvailable} />
                ) : null}
                {settingsTab === "keyboard" ? <KeyboardSettingsPanel api={api} /> : null}
                {settingsTab === "skills" ? (
                  <SkillsSettingsPanel
                    skills={skills}
                    visibleSkills={visibleSkills}
                    skillsEnabled={skillsEnabled}
                    skillsLoading={skillsLoading}
                    skillsLoaded={skillsLoaded}
                    skillSourceFilter={skillSourceFilter}
                    selectedSkillId={selectedSkillId}
                    selectedSkillPreview={selectedSkillPreview}
                    skillPreviewLoading={skillPreviewLoading}
                    skillDocument={skillDocument}
                    newSkillFormOpen={newSkillFormOpen}
                    newSkillName={newSkillName}
                    creatingSkill={creatingSkill}
                    skillsMessage={skillsMessage}
                    onRefresh={() => {
                      setSkillsMessage(null);
                      void loadSkills();
                    }}
                    onOpenFolder={() => void openSkillsFolder()}
                    onImport={() => void importSkill()}
                    onToggleNewSkillForm={() => {
                      setNewSkillFormOpen((open) => !open);
                      setSkillsMessage(null);
                    }}
                    onSelectSourceFilter={selectSkillSourceFilter}
                    onNewSkillName={setNewSkillName}
                    onCreateSkill={() => void submitCreateSkill()}
                    onCancelNewSkill={() => {
                      setNewSkillFormOpen(false);
                      setNewSkillName("");
                    }}
                    onTogglePreview={(skillId) => void toggleSkillPreview(skillId)}
                    onToggleEnabled={(skillId) => void toggleSkillSetting(skillId)}
                    onResetSystemSkill={() => void resetSelectedSystemSkill()}
                    onOpenInEditor={() => void openSelectedSkillInEditor()}
                  />
                ) : null}

                {settingsTab === "telemetry" ? (
                  <TelemetrySettingsPanel
                    syncEnabled={telemetrySyncEnabled}
                    localLogSize={formatFileSize(localLogInfo.bytes)}
                    busy={localLogsBusy}
                    logEntryCount={localLogInfo.entries}
                    onExport={() => void exportLocalLogs()}
                    onClear={() => void clearLocalLogs()}
                  />
                ) : null}
                {settingsTab === "about" ? <AboutSettingsPanel api={api} /> : null}
                <div className="settingsFooter" aria-hidden="true"><span className="sidebarBrandMark" /><span>Umbratic · Private and confidential</span></div>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {previewAttachment?.previewDataUrl ? (
        <div className="modalScrim imagePreviewScrim" role="presentation" onClick={() => setPreviewAttachment(null)}>
          <section
            ref={modalRef}
            tabIndex={-1}
            className="imagePreviewDialog"
            role="dialog"
            aria-modal="true"
            aria-label={attachmentLabel(previewAttachment)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => { if (event.key === "Escape") setPreviewAttachment(null); }}
          >
            <div className="imagePreviewHeader">
              <strong>{attachmentLabel(previewAttachment)}</strong>
              <button className="messageAction" type="button" onClick={() => setPreviewAttachment(null)} title="Close preview">
                <X size={15} />
              </button>
            </div>
            <div className="imagePreviewCanvas">
              <img alt={attachmentLabel(previewAttachment)} src={previewAttachment.previewDataUrl} />
            </div>
          </section>
        </div>
      ) : null}

      {deleteCandidate ? (
        <div className="modalScrim" role="presentation">
          <section ref={modalRef} tabIndex={-1} className="riskDialog deleteDialog" role="dialog" aria-modal="true" aria-labelledby="delete-title" onKeyDown={(event) => { if (event.key === "Escape") setDeleteCandidate(null); }}>
            <div className="dialogIcon deleteIcon">
              {deleteCandidate.kind === "project" ? (
                <FolderX size={18} />
              ) : deleteCandidate.kind === "projectChats" ? (
                <MessageSquareX size={18} />
              ) : (
                <Trash2 size={18} />
              )}
            </div>
            <div>
              <h3 id="delete-title">{deleteCandidateTitle(deleteCandidate)}</h3>
              <p>{deleteCandidateDescription(deleteCandidate)}</p>
            </div>
            <div className="dialogActions">
              <button className="secondaryAction" type="button" onClick={() => setDeleteCandidate(null)}>
                Cancel
              </button>
              {/* The dialog was raised by asking to delete, so Enter answers the
                  question that was asked. Cancel is still one Tab away and
                  Escape still leaves without doing anything. */}
              <button className="dangerAction" type="button" data-modal-autofocus onClick={confirmDeleteCandidate}>
                {deleteCandidate.kind === "project" ? (
                  <FolderX size={14} />
                ) : deleteCandidate.kind === "projectChats" ? (
                  <MessageSquareX size={14} />
                ) : (
                  <Trash2 size={14} />
                )}
                {deleteCandidateActionLabel(deleteCandidate)}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {showElevatedPermissionsDialog ? (
        <div className="modalScrim" role="presentation">
          <section ref={modalRef} tabIndex={-1} className="riskDialog safePermissionDialog" role="dialog" aria-modal="true" aria-labelledby="elevated-permissions-title" onKeyDown={(event) => { if (event.key === "Escape") setShowElevatedPermissionsDialog(false); }}>
            <div className="safePermissionIcon" aria-hidden="true">
              <ShieldCheck size={18} />
            </div>
            <div>
              <h3 id="elevated-permissions-title">Auto-run low-risk actions?</h3>
              <p>
                Verified non-destructive commands and routine workspace edits can continue without pausing.
                Umbratic will still ask before higher-risk or unrecognized actions.
              </p>
            </div>
            <div className="dialogActions">
              <button className="secondaryAction" type="button" onClick={() => setShowElevatedPermissionsDialog(false)}>
                Cancel
              </button>
              <button className="primaryAction" type="button" onClick={confirmElevatedPermissionsMode}>
                <ShieldCheck size={14} />
                Turn on auto-run
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {localModelStarting && !modelStartupDismissed ? (
        <ModelStartupNotice
          title="Starting model…"
          detail={`Loading ${startingModelName} into memory.`}
          onCancel={() => void connectionSettings.unloadLocalModel()}
          onDismiss={() => setModelStartupDismissed(true)}
        />
      ) : dictationStarting && !modelStartupDismissed ? (
        // The speech model loads on the press rather than at startup, so a
        // cold dictation waits on gigabytes with nothing but a 16px spinner to
        // show for it. This is the same card, saying so — and only shown on
        // that press: `dictationStarting` is already gated on the main
        // process reporting a real load.
        <ModelStartupNotice
          title="Starting dictation…"
          detail="Loading the speech model into memory."
          onCancel={dictation.cancel}
          onDismiss={() => setModelStartupDismissed(true)}
        />
      ) : null}

      <ErrorToast message={error} onDismiss={() => setError(null)} />

    </div>
  );
}

type RootElement = HTMLElement & {
  umbraticRoot?: ReturnType<typeof createRoot>;
};

const rootElement = typeof document === "undefined" ? null : document.getElementById("root") as RootElement | null;
if (rootElement) {
  api = window.umbratic
    ?? previewEnvironment?.api
    ?? (() => {
      throw new Error("The Umbratic preload API is not available. The desktop app cannot start.");
    })();
  const renderApp = (startupSettings: DesktopStartupSettings) => {
    rootElement.umbraticRoot ??= createRoot(rootElement);
    rootElement.umbraticRoot.render(<App startupSettings={startupSettings} />);
  };
  // The stored chords are put in force before the first paint, not after it: a
  // window that draws its tooltips with the shipped keys and then corrects
  // itself has spent its one first impression advertising the wrong ones.
  void (async () => {
    setShortcutOverrides(await api.getKeyBindings().catch(() => ({})) as ShortcutOverrides);
    renderApp(await api.getStartupSettings().catch(() => defaultStartupSettings));
  })();
}
