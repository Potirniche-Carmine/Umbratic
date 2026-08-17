import { chatAttachmentRoot, isHiddenChatTask } from "./chatStore";
import { RunnerPrompt, RunnerPromptPart, pdfAttachmentByteLimit, pdfImagePageLimit, promptImageCharacterLimit } from "./mainRuntime";
import { inspectPdf } from "./pdfInspector";
import { pdfAttachmentPromptSection } from "./pdfPrompt";
import { imageDataUrlIfSafe, isBinarySnapshotValue, isPdfFile, ocrAttachmentArtifact, ocrInputKindForPath, ocrInputKindsForAttachments, ocrPromptDigest, pdfAttachmentImageParts, readTextFileIfSafe, relativeArtifactPath } from "./workspaceSnapshot";
import { directoryIsEmpty } from "./worktreeOps";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  attachmentPromptTokenBudget,
  attachmentTextExcerpt,
  estimateTextTokens,
} from "../shared/contextWindow";

import {
  capabilityPromptGuidance,
  probeLocalCapabilities,
  type CapabilityPromptNeeds,
} from "./capabilities";
import { remoteCapabilityReport } from "./remoteHost";
import { promptLooksLikeArtifactTask, promptLooksLikeOcrTask } from "./artifactRuntime";
import { priorChatAttachments, readAttachmentTextIfSafe } from "./attachmentContext";
import {
  runnerBinaryPath,
} from "./runnerAdapter";
import {
  promptLooksLikeCmakeTask,
  promptLooksLikePythonTask,
} from "./policy";
import {
  readChat,
} from "./storage";
import type { BackendUiEvent, CapabilityProbeReport, ChatAttachment, ReviewFile, TaskRecord } from "./types";
import { pathInside } from "./utils";
import { normalizeReviewFile, buildTextDiff } from "../shared/reviewDiff";
import { boundedRecentLines } from "./historyContext";
import { limitPromptImages, shouldIncludeWorkspaceContext } from "./promptContext";
import { rootAgentInstructions } from "./repositoryInstructions";
import {
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
    case "context.compaction":
    case "context.compressed":
    case "context.retrieved":
      return null;
    // Losing and regaining the model server is a fact about the transport, not
    // about the conversation, so it stays out of the history the model reads.
    case "provider.reconnecting":
    case "provider.reconnected":
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

function pushConversationHistory(lines: string[], history: string) {
  if (!history) return;
  if (lines.length) lines.push("");
  lines.push("Conversation so far:", history);
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
  const remote = task.remote;
  const rootPath = remote
    ? remote.directory
    : fs.existsSync(task.worktreePath) ? task.worktreePath : task.originalRepoPath;
  const hiddenChat = !remote && isHiddenChatTask(task);
  const historicalAttachments = priorChatAttachments(task.events ?? [], userPrompt);
  const hasDurableContext = options.useDurableContext
    ?? Boolean(task.chatId && readChat(task.chatId)?.conversationState);
  const history = hasDurableContext ? "" : priorChatContext(task.events ?? [], userPrompt);
  if (!shouldIncludeWorkspaceContext({
    hasProject: !hiddenChat,
    // A remote workspace cannot be inspected from here, and a run was asked for
    // against it, so it counts as a workspace with something in it.
    workspaceHasFiles: remote ? true : !directoryIsEmpty(rootPath),
    attachmentCount: attachments.length,
    historicalAttachmentCount: historicalAttachments.length,
  })) {
    const lines: string[] = [];
    pushConversationHistory(lines, history);
    if (!history) return [{ type: "text", text: userPrompt }];
    return [
      { type: "text", text: lines.join("\n") },
      { type: "text", text: userPrompt },
    ];
  }
  // What the model is told is available has to describe the machine the tools
  // will actually run on, which for a remote task is not this one.
  const capabilityReport = remote
    ? await remoteCapabilityReport(remote.connectionId)
    : await probeLocalCapabilities({ runnerPath: runnerBinaryPath() });
  const capabilityNeeds = capabilityNeedsForPrompt(userPrompt, attachments);
  const lines = remote
    ? [
        "Umbratic workspace context:",
        `- the workspace is on a remote host reached over SSH: ${remote.name}`,
        `- opened folder on that host: ${remote.directory}`,
        "- workspace tools run on the remote host, so paths and commands are that host's, not this computer's",
      ]
    : hiddenChat
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
  if (!remote) pushAgentInstructionContext(lines, rootPath);
  pushConversationHistory(lines, history);
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
