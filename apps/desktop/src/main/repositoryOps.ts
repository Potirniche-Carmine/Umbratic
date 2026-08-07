import { getMainWindow } from "./mainRuntime";
import { chatAttachmentDirectory, chatAttachmentRoot, extensionForMimeType, parseAttachmentDataUrl, safeAttachmentFileName, stableRepositoryId } from "./chatStore";
import { chatAttachmentByteLimit } from "./mainRuntime";
import { imagePreviewDataUrl } from "./workspaceSnapshot";
import {
  app,
  dialog,
  OpenDialogOptions,
  shell,
} from "electron";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";


import { attachmentContextTokens } from "./attachmentContext";
import {
  readProjects,
  writeProjects,
} from "./storage";
import { gitOutput, gitResult } from "./processCommands";
import type { ChatAttachment, PastedAttachmentInput, RepositoryInfo, WorkspaceKind } from "./types";
import { isRecord, normalizeRelativePath, pathInside, requiredString } from "./utils";

export async function inspectRepository(selectedPath: string): Promise<RepositoryInfo> {
  const selected = path.resolve(selectedPath);
  if (!fs.existsSync(selected) || !fs.statSync(selected).isDirectory()) {
    throw new Error("Selected path is not a folder.");
  }
  let root = selected;
  let kind: WorkspaceKind = "folder";
  let branch = "folder";
  let baseCommit = crypto.createHash("sha256").update(`${selected}:${Date.now()}`).digest("hex");
  let statusSummary = "regular folder";
  let dirty = false;
  try {
    root = path.resolve(await gitOutput(selected, ["rev-parse", "--show-toplevel"]));
    kind = "git";
    branch = (await gitOutput(root, ["branch", "--show-current"]).catch(() => "")) || "HEAD";
    baseCommit = await gitOutput(root, ["rev-parse", "HEAD"]);
    const status = await gitOutput(root, ["status", "--porcelain"]).catch(() => "");
    const dirtyRows = status.split(/\r?\n/).filter(Boolean);
    dirty = dirtyRows.length > 0;
    statusSummary = dirtyRows.length === 0 ? "clean" : `${dirtyRows.length} pending change${dirtyRows.length === 1 ? "" : "s"}`;
  } catch {
    kind = "folder";
  }
  const repository: RepositoryInfo = {
    id: stableRepositoryId(root),
    name: path.basename(root) || root,
    rootPath: root,
    kind,
    originalBranch: branch,
    baseCommit,
    dirty,
    statusSummary,
  };
  writeProjects([repository, ...readProjects().filter((project) => project.id !== repository.id)]);
  return repository;
}

export async function pickRepository(): Promise<{ canceled: true } | { canceled: false; repository: RepositoryInfo }> {
  const options: OpenDialogOptions = {
    title: "Select Repository",
    properties: ["openDirectory"],
  };
  const dialogWindow = getMainWindow();
  const result = dialogWindow
    ? await dialog.showOpenDialog(dialogWindow, options) : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }
  return { canceled: false, repository: await inspectRepository(result.filePaths[0]) };
}

export async function pickAttachmentFiles(input: unknown): Promise<{ canceled: true } | { canceled: false; files: ChatAttachment[] }> {
  if (!isRecord(input)) {
    throw new Error("Invalid attachment input.");
  }
  const chatIdValue = requiredString(input.chatId, "chatId");
  const repositoryId = typeof input.repositoryId === "string" && input.repositoryId.trim() ? input.repositoryId.trim() : "";
  const repository = repositoryId ? readProjects().find((project) => project.id === repositoryId) : undefined;
  const defaultPath = repository?.rootPath && fs.existsSync(repository.rootPath)
    ? path.resolve(repository.rootPath)
    : app.getPath("documents") || os.homedir();
  const options: OpenDialogOptions = {
    title: "Attach Files",
    defaultPath,
    properties: ["openFile", "multiSelections"],
  };
  const dialogWindow = getMainWindow();
  const result = dialogWindow
    ? await dialog.showOpenDialog(dialogWindow, options) : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  const files: ChatAttachment[] = [];
  const seen = new Set<string>();
  const targetDirectory = chatAttachmentDirectory(chatIdValue);
  fs.mkdirSync(targetDirectory, { recursive: true });
  for (const filePath of result.filePaths) {
    const absolute = path.resolve(filePath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > chatAttachmentByteLimit || seen.has(absolute.toLowerCase())) continue;
    seen.add(absolute.toLowerCase());
    const originalName = path.basename(absolute);
    const storedName = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}-${safeAttachmentFileName(originalName)}`;
    const storedPath = path.join(targetDirectory, storedName);
    fs.copyFileSync(absolute, storedPath);
    files.push({
      path: `attachments/${storedName}`,
      name: originalName.slice(0, 120),
      source: "chat",
      storedPath,
      originalPath: absolute,
      previewDataUrl: imagePreviewDataUrl(storedPath),
      contextTokens: attachmentContextTokens(storedPath),
    });
    if (files.length >= 16) break;
  }
  if (!files.length) {
    throw new Error("No attachable files were selected.");
  }
  return { canceled: false, files };
}

export function savePastedAttachments(input: unknown): { files: ChatAttachment[] } {
  if (!isRecord(input)) {
    throw new Error("Invalid pasted attachment input.");
  }
  const chatIdValue = requiredString(input.chatId, "chatId");
  const rawFiles = Array.isArray(input.files) ? input.files : [];
  const targetDirectory = chatAttachmentDirectory(chatIdValue);
  fs.mkdirSync(targetDirectory, { recursive: true });

  const files: ChatAttachment[] = [];
  for (const item of rawFiles) {
    if (!isRecord(item)) continue;
    const dataUrl = typeof item.dataUrl === "string" ? item.dataUrl : "";
    const parsed = parseAttachmentDataUrl(dataUrl);
    if (!parsed || parsed.buffer.length === 0 || parsed.buffer.length > chatAttachmentByteLimit) continue;
    const typed = item as PastedAttachmentInput;
    const rawName =
      typeof typed.name === "string" && typed.name.trim()
        ? typed.name.trim()
        : `pasted-${new Date().toISOString().replace(/[:.]/g, "-")}${extensionForMimeType(typed.mimeType || parsed.mimeType)}`;
    const ext = path.extname(rawName) ? "" : extensionForMimeType(typed.mimeType || parsed.mimeType);
    const originalName = `${rawName}${ext}`.slice(0, 160);
    const storedName = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}-${safeAttachmentFileName(originalName)}`;
    const storedPath = path.join(targetDirectory, storedName);
    fs.writeFileSync(storedPath, parsed.buffer);
    files.push({
      path: `attachments/${storedName}`,
      name: originalName.slice(0, 120),
      source: "chat",
      storedPath,
      originalPath: "clipboard",
      previewDataUrl: imagePreviewDataUrl(storedPath),
      contextTokens: attachmentContextTokens(storedPath),
    });
    if (files.length >= 16) break;
  }
  if (!files.length) {
    throw new Error("No pasteable files were found.");
  }
  return { files };
}

export async function openChatAttachment(input: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!isRecord(input) || !isRecord(input.attachment)) {
    return { ok: false, message: "Invalid attachment." };
  }
  const attachment = input.attachment as Partial<ChatAttachment>;
  const repositoryId = typeof input.repositoryId === "string" && input.repositoryId.trim() ? input.repositoryId.trim() : "";
  let targetPath = "";

  if (attachment.source === "chat" && typeof attachment.storedPath === "string" && attachment.storedPath.trim()) {
    const storedPath = path.resolve(attachment.storedPath);
    if (!pathInside(chatAttachmentRoot(), storedPath)) {
      return { ok: false, message: "Attachment is outside Umbratic storage." };
    }
    targetPath = storedPath;
  } else if (attachment.source === "workspace" && typeof attachment.path === "string" && attachment.path.trim() && repositoryId) {
    const repository = readProjects().find((project) => project.id === repositoryId);
    if (!repository) {
      return { ok: false, message: "Repository was not found." };
    }
    const workspacePath = path.resolve(repository.rootPath, normalizeRelativePath(attachment.path));
    if (!pathInside(repository.rootPath, workspacePath)) {
      return { ok: false, message: "Attachment is outside the repository." };
    }
    targetPath = workspacePath;
  }

  if (!targetPath) {
    return { ok: false, message: "Attachment cannot be opened." };
  }
  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
    return { ok: false, message: "Attachment file no longer exists." };
  }

  const error = await shell.openPath(targetPath);
  return error ? { ok: false, message: error } : { ok: true };
}

export async function getRepository(input: unknown): Promise<RepositoryInfo | null> {
  if (!isRecord(input)) {
    throw new Error("Invalid repository lookup input.");
  }
  const repositoryId = typeof input.repositoryId === "string" && input.repositoryId.trim() ? input.repositoryId.trim() : "";
  const repositoryPath =
    typeof input.repositoryPath === "string" && input.repositoryPath.trim() ? path.resolve(input.repositoryPath.trim()) : "";
  const existing =
    (repositoryId ? readProjects().find((project) => project.id === repositoryId) : undefined) ??
    (repositoryPath ? readProjects().find((project) => path.resolve(project.rootPath) === repositoryPath) : undefined);
  const targetPath = existing?.rootPath ?? repositoryPath;
  if (!targetPath) {
    return null;
  }
  if (!fs.existsSync(targetPath)) {
    return existing ?? null;
  }
  return inspectRepository(targetPath);
}

export async function resolveRepositoryPath(input: unknown): Promise<string | null> {
  if (!isRecord(input)) {
    throw new Error("Invalid repository lookup input.");
  }
  const repositoryId = typeof input.repositoryId === "string" && input.repositoryId.trim() ? input.repositoryId.trim() : "";
  const repositoryPath =
    typeof input.repositoryPath === "string" && input.repositoryPath.trim() ? path.resolve(input.repositoryPath.trim()) : "";
  const existing =
    (repositoryId ? readProjects().find((project) => project.id === repositoryId) : undefined) ??
    (repositoryPath ? readProjects().find((project) => path.resolve(project.rootPath) === repositoryPath) : undefined);
  const targetPath = existing?.rootPath ?? repositoryPath;
  if (!targetPath || !fs.existsSync(targetPath)) {
    return null;
  }
  return targetPath;
}

export async function listRepositoryBranches(
  input: unknown,
): Promise<{ ok: true; current: string; branches: string[] } | { ok: false; message: string }> {
  const targetPath = await resolveRepositoryPath(input);
  if (!targetPath) return { ok: false, message: "Repository not found." };
  try {
    const root = path.resolve(await gitOutput(targetPath, ["rev-parse", "--show-toplevel"]));
    const current = (await gitOutput(root, ["branch", "--show-current"]).catch(() => "")) || "HEAD";
    const raw = await gitOutput(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
    const branches = Array.from(
      new Set(
        raw
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
      ),
    ).sort((a, b) => a.localeCompare(b));
    return { ok: true, current, branches };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Failed to list branches." };
  }
}

export async function checkoutRepositoryBranch(
  input: unknown,
): Promise<{ ok: true; repository: RepositoryInfo } | { ok: false; message: string }> {
  if (!isRecord(input)) {
    return { ok: false, message: "Invalid checkout input." };
  }
  const branch = typeof input.branch === "string" ? input.branch.trim() : "";
  if (!branch) {
    return { ok: false, message: "Branch name is required." };
  }
  const targetPath = await resolveRepositoryPath(input);
  if (!targetPath) return { ok: false, message: "Repository not found." };
  try {
    const root = path.resolve(await gitOutput(targetPath, ["rev-parse", "--show-toplevel"]));
    const result = await gitResult(root, ["checkout", branch]);
    if (!result.success) {
      const detail = (result.stderr || result.stdout || "").trim();
      return { ok: false, message: detail || `Failed to checkout ${branch}.` };
    }
    return { ok: true, repository: await inspectRepository(root) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Failed to checkout branch." };
  }
}
