import { chatAttachmentRoot, isHiddenChatTask } from "./chatStore";
import { RunnerPrompt, RunnerPromptPart, pdfAttachmentByteLimit, pdfImagePageLimit, promptImageCharacterLimit } from "./mainRuntime";
import { inspectPdf } from "./pdfInspector";
import { pdfAttachmentPromptSection } from "./pdfPrompt";
import { ignoredSnapshotDirectories, imageDataUrlIfSafe, isBinarySnapshotValue, isPdfFile, ocrAttachmentArtifact, ocrInputKindForPath, ocrInputKindsForAttachments, ocrPromptDigest, pdfAttachmentImageParts, readTextFileIfSafe, relativeArtifactPath } from "./workspaceSnapshot";
import { directoryIsEmpty } from "./worktreeOps";
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
import { rootAgentInstructions } from "./repositoryInstructions";
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

export function pushAgentInstructionContext(lines: string[], rootPath: string) {
  const root = rootAgentInstructions(rootPath, { readTextFile: readTextFileIfSafe });
  if (!root) return;
  lines.push(
    "",
    // Only the file is supplied here. How a nested AGENTS.md is found and
    // applied is a protected system-prompt rule, stated there once so the two
    // cannot drift apart.
    "Repository instructions for this workspace root:",
    `\n### ${root.path}`,
    "```",
    root.text,
    "```",
  );
}

export function compactHistoryText(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 16)).trimEnd()} ...(truncated)`;
}

export function historyLineForEvent(event: BackendUiEvent): string | null {
  switch (event.type) {
    case "user.message":
      return `User: ${compactHistoryText(event.text, 1800)}`;
    case "assistant.delta":
      return `Assistant: ${compactHistoryText(event.text, 2400)}`;
    case "command.started":
      return `Tool started: ${compactHistoryText(event.command, 500)}`;
    case "command.output":
      return `Tool ${event.stream}: ${compactHistoryText(event.text, 900)}`;
    case "command.finished":
      return `Tool finished: exit code ${event.exitCode === null ? "unknown" : event.exitCode}`;
    case "permission.requested":
      return `Permission requested: ${compactHistoryText(event.request.summary, 500)}`;
    case "permission.resolved":
      return `Permission ${event.decision}.`;
    case "review.ready":
      return `Review ready: ${event.changedFiles.length} changed file${event.changedFiles.length === 1 ? "" : "s"}.`;
    case "review.changed_since_ready":
      return `Review changed since ready: ${event.changedFileCount} changed file${event.changedFileCount === 1 ? "" : "s"}.`;
    case "approval.check":
      return `Approval check ${event.status}: ${event.name}${event.detail ? ` (${compactHistoryText(event.detail, 300)})` : ""}`;
    case "merge.approval":
      return `Changes ${event.decision === "approved" ? "accepted" : "rejected"}.`;
    case "approval.completed":
      return `Approval completed for ${event.target}.`;
    case "merge.completed":
      return `Merge completed into ${event.targetBranch}.`;
    case "ide.opened":
      return `IDE open ${event.result}: ${event.filePath ?? event.target}.`;
    case "skill.requested":
      return `Skill requested: ${event.skillId} (${event.origin})`;
    case "skill.loaded":
      return `Skill loaded: ${event.skillId} (${event.bytes} bytes)`;
    case "skill.failed":
      return `Skill failed: ${event.skillId} (${event.code}: ${compactHistoryText(event.message, 300)})`;
    case "required_tool.failed":
      return `Required tool failed: ${event.requirement} (${event.reason}${event.detail ? `: ${compactHistoryText(event.detail, 300)}` : ""})`;
    case "task.error":
      return `Task error: ${compactHistoryText(event.message, 900)}`;
    case "context.usage":
    case "context.threshold":
    case "context.compressed":
    case "context.retrieved":
      return null;
    case "assistant.done":
    case "assistant.progress.delta":
    case "response.feedback":
    case "tool.failed":
    case "tool.policy.stage":
    case "turn.outcome":
    case "worktree.requested":
    case "worktree.created":
      return null;
  }
}

export function priorChatContext(events: BackendUiEvent[], currentUserPrompt = ""): string {
  const historyEvents = visibleTaskEvents(events);
  const currentPrompt = currentUserPrompt.trim();
  if (currentPrompt) {
    const last = historyEvents.at(-1);
    if (last?.type === "user.message" && last.text.trim() === currentPrompt) {
      historyEvents.pop();
    }
  }
  const lines = historyEvents
    .map(historyLineForEvent)
    .filter((line): line is string => !!line);
  if (lines.length === 0) return "";
  return boundedRecentLines(lines);
}

export function capabilityNeedsForPrompt(prompt: string, attachments: ChatAttachment[] = []): CapabilityPromptNeeds {
  return {
    python: promptLooksLikePythonTask(prompt) || promptLooksLikeArtifactTask(prompt),
    cmake: promptLooksLikeCmakeTask(prompt),
    artifacts: promptLooksLikeArtifactTask(prompt),
    ocr: promptLooksLikeOcrTask(prompt) || ocrInputKindsForAttachments(attachments).length > 0,
  };
}

export function pushPromptText(parts: RunnerPromptPart[], lines: string[], emptyHeader = "Attached file contents:") {
  const text = lines.join("\n").trim();
  if (text && text !== emptyHeader) {
    parts.push({ type: "text", text });
  }
  lines.length = 0;
}

const folderListingEntryLimit = 40;

function folderListingPreview(absolute: string): string[] {
  try {
    const entries = fs
      .readdirSync(absolute, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
      .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name));
    const shown = entries.slice(0, folderListingEntryLimit);
    const lines = shown.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    if (entries.length > shown.length) lines.push(`… ${entries.length - shown.length} more entries`);
    return lines;
  } catch {
    return [];
  }
}

export async function attachmentPromptParts(
  rootPath: string,
  attachments: ChatAttachment[],
  options: {
    userPrompt: string;
    capabilityReport: CapabilityProbeReport;
    textBudget: { remainingTokens: number };
    heading?: string;
  },
): Promise<RunnerPromptPart[]> {
  if (!attachments.length) return [];
  const parts: RunnerPromptPart[] = [];
  const heading = options.heading ?? "Attached file contents:";
  const lines = [heading];
  const shouldGenerateOcr = promptLooksLikeOcrTask(options.userPrompt);
  for (const file of attachments) {
    const isChatAttachment = file.source === "chat" && typeof file.storedPath === "string";
    const absolute = isChatAttachment ? path.resolve(file.storedPath as string) : path.resolve(rootPath, file.path);
    const label = isChatAttachment ? `${file.name} (chat attachment)` : file.path;
    lines.push(`\n### ${label}`);
    if (isChatAttachment && file.originalPath) {
      lines.push(`Original path: ${file.originalPath}`);
    }
    if (isChatAttachment) {
      const workspaceCopy = path.resolve(rootPath, file.path);
      if (pathInside(rootPath, workspaceCopy) && fs.existsSync(workspaceCopy)) {
        lines.push(`Workspace path: ${file.path}`);
      }
    }
    const allowed = isChatAttachment ? pathInside(chatAttachmentRoot(), absolute) : pathInside(rootPath, absolute);
    if (!allowed || !fs.existsSync(absolute)) {
      lines.push("(file is no longer available)");
      continue;
    }
    if (fs.statSync(absolute).isDirectory()) {
      lines.push(`Attached folder: explore it with the list/glob/read tools under ${JSON.stringify(file.path)}.`);
      const listing = folderListingPreview(absolute);
      if (listing.length) {
        lines.push("Top-level contents:", "```", ...listing, "```");
      }
      continue;
    }
    const ocrKind = ocrInputKindForPath(absolute);
    if (shouldGenerateOcr && ocrKind) {
      const ocr = await ocrAttachmentArtifact(rootPath, label, absolute, ocrKind, options.capabilityReport);
      if (ocr.status === "created") {
        lines.push(
          `Local OCR artifact generated: ${relativeArtifactPath(rootPath, ocr.markdownPath)} and ${relativeArtifactPath(rootPath, ocr.jsonPath)}.`,
          `OCR recognized ${ocr.document.metrics.recognizedLines} line${ocr.document.metrics.recognizedLines === 1 ? "" : "s"} with ${ocr.document.warnings.length} warning${ocr.document.warnings.length === 1 ? "" : "s"}.`,
          "```markdown",
          ocrPromptDigest(ocr.markdown),
          "```",
        );
      } else {
        lines.push(`Local OCR artifact was not generated: ${ocr.message}`);
      }
    }
    if (isPdfFile(absolute)) {
      const section = await pdfAttachmentPromptSection<RunnerPromptPart>({
        inspect: () =>
          inspectPdf(absolute, {
            full: true,
            tokenBudget: options.textBudget.remainingTokens,
            maxBytes: pdfAttachmentByteLimit,
          }),
        renderImages: (pageNumbers) => pdfAttachmentImageParts(absolute, pageNumbers),
        fullAccessHint: isChatAttachment
          ? `Complete extracted text: use read_attachment with attachmentId ${JSON.stringify(path.basename(absolute))} and the reported byte offsets.`
          : `Complete extracted text: use read with path ${JSON.stringify(file.path)} and successive line offsets.`,
        pageLimit: pdfImagePageLimit,
        textBudget: options.textBudget,
      });
      lines.push(...section.lines);
      if (section.imageParts?.length) {
        pushPromptText(parts, lines, heading);
        parts.push(...section.imageParts);
        lines.push(heading);
      }
      continue;
    }
    const imageDataUrl = imageDataUrlIfSafe(absolute);
    if (imageDataUrl) {
      lines.push("Image included below for the vision model.");
      pushPromptText(parts, lines, heading);
      parts.push({ type: "image", data_url: imageDataUrl });
      lines.push(heading);
      continue;
    }
    const text = readAttachmentTextIfSafe(absolute);
    if (text === null) {
      lines.push("(binary, too large, or unreadable text file)");
      continue;
    }
    const fullAccess = isChatAttachment
      ? `Complete attachment: use read_attachment with attachmentId ${JSON.stringify(path.basename(absolute))} and the reported byte offsets.`
      : `Complete workspace file: use read with path ${JSON.stringify(file.path)} and successive line offsets.`;
    lines.push(fullAccess);
    const excerpt = attachmentTextExcerpt(text, options.textBudget.remainingTokens);
    options.textBudget.remainingTokens = Math.max(
      0,
      options.textBudget.remainingTokens - estimateTextTokens(excerpt.text),
    );
    if (!excerpt.text) {
      lines.push("(initial excerpt omitted to preserve the active context window; the complete text remains available through the tool above)");
      continue;
    }
    lines.push("```");
    lines.push(excerpt.text);
    lines.push("```");
    if (excerpt.truncated) {
      lines.push("Initial context contains a head-and-tail excerpt; the middle remains available through the tool above.");
    }
  }
  pushPromptText(parts, lines, heading);
  return parts;
}

export async function runnerPromptForTask(
  task: TaskRecord,
  userPrompt: string,
  attachments: ChatAttachment[],
  contextLength: number,
  options: { useDurableContext?: boolean } = {},
): Promise<RunnerPromptPart[]> {
  const rootPath = fs.existsSync(task.worktreePath) ? task.worktreePath : task.originalRepoPath;
  const hiddenChat = isHiddenChatTask(task), historicalAttachments = priorChatAttachments(task.events ?? [], userPrompt);
  if (!shouldIncludeWorkspaceContext({
    hasProject: !hiddenChat,
    workspaceHasFiles: !directoryIsEmpty(rootPath),
    attachmentCount: attachments.length,
    historicalAttachmentCount: historicalAttachments.length,
  })) return [{ type: "text", text: userPrompt }];
  const capabilityReport = await probeLocalCapabilities({ runnerPath: runnerBinaryPath() });
  const capabilityNeeds = capabilityNeedsForPrompt(userPrompt, attachments);
  const lines = hiddenChat
    ? [
        "Umbratic chat context:",
        "- no project folder is selected for this chat",
        "- Umbratic created a private scratch workspace for attachments and any files produced during the conversation",
        `- scratch workspace: ${rootPath}`,
      ]
    : [
        "Umbratic workspace context:",
        `- opened folder: ${rootPath}`,
        `- workspace kind: ${task.workspaceKind}`,
      ];
  pushAgentInstructionContext(lines, rootPath);
  const hasDurableContext = options.useDurableContext
    ?? Boolean(task.chatId && readChat(task.chatId)?.conversationState);
  const history = hasDurableContext ? "" : priorChatContext(task.events ?? [], userPrompt);
  if (history) {
    lines.push(
      "",
      "Conversation so far, for reference only:",
      history,
    );
  }
  const capabilityGuidance = capabilityPromptGuidance(capabilityReport, capabilityNeeds);
  if (capabilityGuidance) lines.push("", capabilityGuidance);
  const parts: RunnerPromptPart[] = [{ type: "text", text: lines.join("\n") }];
  const textBudget = { remainingTokens: attachmentPromptTokenBudget(contextLength) };
  parts.push(
    ...(await attachmentPromptParts(rootPath, historicalAttachments, {
      userPrompt,
      capabilityReport,
      textBudget,
      heading: "Previously attached file contents:",
    })),
  );
  parts.push(...(await attachmentPromptParts(rootPath, attachments, { userPrompt, capabilityReport, textBudget })));
  parts.push({
    type: "text",
    text: userPrompt,
  });
  return limitPromptImages(parts, pdfImagePageLimit, promptImageCharacterLimit);
}

export function runnerPromptParts(prompt: RunnerPrompt): RunnerPromptPart[] {
  return typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt;
}

export function runnerPromptText(prompt: RunnerPrompt): string {
  return typeof prompt === "string"
    ? prompt
    : prompt
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n\n");
}

export function buildBinaryDiff(filePath: string, before: string | null, after: string | null): ReviewFile | null {
  if (before === after) {
    return null;
  }
  const status: ReviewFile["status"] = before === null ? "added" : after === null ? "deleted" : "modified";
  const escaped = filePath.replace(/\\/g, "/");
  const header =
    status === "added"
      ? [`diff --git a/${escaped} b/${escaped}`, "new file mode 100644", "--- /dev/null", `+++ b/${escaped}`]
      : status === "deleted"
        ? [`diff --git a/${escaped} b/${escaped}`, "deleted file mode 100644", `--- a/${escaped}`, "+++ /dev/null"]
        : [`diff --git a/${escaped} b/${escaped}`, `--- a/${escaped}`, `+++ b/${escaped}`];
  return normalizeReviewFile({
    path: filePath,
    status,
    patch: [...header, `Binary file ${status}: ${filePath}`].join("\n"),
  });
}

export function buildSnapshotDiff(filePath: string, before: string | null, after: string | null): ReviewFile | null {
  if (isBinarySnapshotValue(before) || isBinarySnapshotValue(after)) {
    return buildBinaryDiff(filePath, before, after);
  }
  return buildTextDiff(filePath, before, after);
}
