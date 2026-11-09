import { commandRule, allowedCloudCommand, rememberCloudCommand } from "./cloudCommandRules";
import { cloudChatRecord, cloudWorkspaceKey, storedCloudWorkspaces } from "./cloudChatStore";
import { cloudTurnPrompt, rememberCloudSession } from "../shared/cloudHandoff";
import { resolveCloudImages } from "./cloudImages";
import { deleteCloudHistory, forgetCloudProviderSession, forgetStoredCloudProvider } from "./cloudHistory";
import { latestCloudUsage } from "../shared/cloudUsage";
import { app } from "electron";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { contextResetReason, defaultCloudSettings, isCloudProvider, validateCloudSettings,
  type CloudConnection, type CloudSettings, type CloudWorkspace, type CloudWorkspaceInput, type CloudFollowUpInput } from "../shared/cloud";
import { withAppDatabase } from "./storageDatabase";
import { readProjects } from "./storage";
import { getMainWindow } from "./mainRuntime";
import { codexCloudRuntime, codexExecutable, stopCodexLogin } from "./cloudCodex";
import { claudeCloudRuntime, claudeExecutable, stopClaudeLogin } from "./cloudClaude";
import { CloudRuntimeMissing, cloudInstallInProgress, installOfficialCloudRuntime, stopCloudInstall } from "./cloudInstall";
import type { ApprovalAnswer, CloudRun, CloudRuntimeSink } from "./cloudRuntimeTypes";

const workspaces = new Map<string, CloudWorkspace>();
const runs = new Map<string, CloudRun>();
const steering = new Map<string, Promise<void>>();
const stopping = new Set<string>();
const approvals = new Map<string, { key: string; resolve(value: ApprovalAnswer): void }>();
const timers = new Map<string, NodeJS.Timeout>();
const disconnecting = new Set<string>();
const accountGeneration = new Map<string, number>();
let closing = false;

function readStored(key: string): unknown {
  return withAppDatabase(db => {
    const row = db.prepare("SELECT payload FROM settings WHERE key = ?").get(key) as { payload: string } | undefined;
    try { return row ? JSON.parse(row.payload) : undefined; } catch { return undefined; }
  });
}
function writeStored(key: string, value: unknown): void {
  withAppDatabase(db => db.prepare("INSERT OR REPLACE INTO settings (key, payload) VALUES (?, ?)").run(key, JSON.stringify(value)));
}
export function getCloudSettings(): CloudSettings {
  const stored = readStored("cloud:settings");
  if (stored) { try { return validateCloudSettings(stored as CloudSettings); } catch { /* Recover invalid old settings. */ } }
  return defaultCloudSettings();
}
export function saveCloudSettings(input: CloudSettings): CloudSettings {
  if (cloudInstallInProgress() || disconnecting.size) throw new Error("Wait for the installation or disconnection to finish before changing settings.");
  const settings = validateCloudSettings(input);
  writeStored("cloud:settings", settings);
  return settings;
}
function scratchDirectory(): string {
  const directory = path.join(app.getPath("userData"), "cloud", "scratch");
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}
export async function inspectCloudProvider(input: { provider: string }): Promise<CloudConnection> {
  if (!isCloudProvider(input?.provider)) throw new Error("Choose a Cloud provider.");
  const generation = accountGeneration.get(input.provider);
  const disconnected = (): CloudConnection => ({ provider: input.provider as CloudConnection["provider"], state: "sign_in", models: [], message: "Connect your account." });
  if (disconnecting.has(input.provider)) return disconnected();
  try {
    const connection = await runtime(input.provider).inspect(getCloudSettings(), scratchDirectory());
    if (generation !== accountGeneration.get(input.provider)) return disconnected();
    if (connection.state === "ready" && connection.account) connection.usage = rememberUsage(input.provider, connection.account, connection.usage);
    return connection;
  }
  catch (error) { return { provider: input.provider, state: error instanceof CloudRuntimeMissing ? "missing" : "unavailable", models: [], message: error instanceof Error ? error.message : "Could not connect." }; }
}
function rememberUsage(provider: string, account: string, usage?: CloudWorkspace["usage"]) {
  const key = `cloud:usage:${provider}:${crypto.createHash("sha256").update(account).digest("hex")}`;
  const latest = latestCloudUsage([usage, readStored(key) as CloudWorkspace["usage"]]);
  if (latest) writeStored(key, latest);
  return latest;
}
export async function installCloudProvider(input: { provider: string }): Promise<CloudConnection> {
  if (!isCloudProvider(input?.provider)) throw new Error("Choose Codex or Claude Code.");
  if (runs.size || closing || disconnecting.size) throw new Error("Stop the current work before installing.");
  const settings = getCloudSettings();
  try { (input.provider === "codex" ? codexExecutable : claudeExecutable)(settings.providers[input.provider].executable); }
  catch (error) {
    if (!(error instanceof CloudRuntimeMissing)) throw error;
    await installOfficialCloudRuntime(input.provider);
  }
  return inspectCloudProvider(input);
}
export async function signInCloudProvider(input: { provider: string }): Promise<{ message: string }> {
  if (!isCloudProvider(input?.provider)) throw new Error("Choose a Cloud provider.");
  if (runs.size || cloudInstallInProgress() || disconnecting.size) throw new Error("Wait for the current work or installation to finish before connecting.");
  return runtime(input.provider).signIn(getCloudSettings(), scratchDirectory());
}
export function cancelCloudSignIn(input: { provider: string }): void {
  if (!isCloudProvider(input?.provider)) throw new Error("Choose a Cloud provider.");
  if (input.provider === "codex") stopCodexLogin(); else stopClaudeLogin();
}
function runtime(provider: string) { return provider === "codex" ? codexCloudRuntime : claudeCloudRuntime; }

export async function disconnectCloudProvider(input: { provider: string }): Promise<CloudConnection> {
  if (!isCloudProvider(input?.provider)) throw new Error("Choose a Cloud provider.");
  if (runs.size || cloudInstallInProgress() || disconnecting.size || closing) throw new Error("Wait for the current work to finish before disconnecting.");
  const provider = input.provider;
  disconnecting.add(provider);
  accountGeneration.set(provider, (accountGeneration.get(provider) || 0) + 1);
  try {
    await runtime(provider).signOut(getCloudSettings(), scratchDirectory());
    forgetStoredCloudProvider(provider);
    for (const workspace of workspaces.values()) { forgetCloudProviderSession(workspace, provider); flush(workspace); }
    return { provider, state: "sign_in", models: [], message: "Connect your account." };
  } finally { disconnecting.delete(provider); }
}

export function getCloudWorkspace(input: CloudWorkspaceInput): CloudWorkspace {
  if (!isCloudProvider(input?.provider)) throw new Error("Choose a Cloud provider.");
  if (input.key !== undefined) {
    if (typeof input.key !== "string" || !/^[a-f0-9]{64}$/.test(input.key)) throw new Error("Open this chat again.");
    const saved = workspaces.get(input.key) || readStored(`cloud:workspace:${input.key}`) as CloudWorkspace | undefined;
    if (!saved || saved.key !== input.key || saved.provider !== input.provider || !Array.isArray(saved.entries)) throw new Error("This chat belongs to a different provider or is no longer available.");
    const projects = readProjects();
    const scratch = fs.realpathSync(scratchDirectory());
    const roots = saved.paths || [saved.path];
    if (saved.repositoryIds?.length === 0 && saved.scratchPath) {
      const restored = workspaces.get(saved.key) || { ...saved, state: "idle" as const, approvals: [] };
      fs.mkdirSync(saved.scratchPath, { recursive: true });
      workspaces.set(saved.key, restored);
      return structuredClone(restored);
    }
    const ids = roots.filter(root => root !== scratch).map(root => {
      const project = projects.find(project => {
        try { return fs.realpathSync(project.rootPath) === root; } catch { return false; }
      });
      if (!project) throw new Error("Open the workspace folder again.");
      return project.id;
    });
    return getCloudWorkspace({ provider: input.provider, repositoryIds: ids, chatId: saved.chatId });
  }
  if (input.chatId !== undefined && (typeof input.chatId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.chatId))) throw new Error("Invalid chat identity.");
  const ids = input.repositoryIds ?? (input.repositoryId ? [input.repositoryId] : []);
  if (!Array.isArray(ids) || ids.length > 16 || ids.some(id => typeof id !== "string")) throw new Error("Choose up to 16 workspace folders.");
  const projects = readProjects();
  const paths = [...new Set(ids.map(id => {
    const project = projects.find(project => project.id === id);
    if (!project) throw new Error("Open the workspace folder again.");
    const root = fs.realpathSync(project.rootPath);
    if (!fs.statSync(root).isDirectory()) throw new Error("The workspace folder is no longer available.");
    return root;
  }))].sort();
  if (!paths.length) paths.push(fs.realpathSync(scratchDirectory()));
  const key = cloudWorkspaceKey(input.provider, paths, input.chatId);
  let scratchPath = path.join(app.getPath("userData"), "cloud", "workspaces", key);
  fs.mkdirSync(scratchPath, { recursive: true });
  scratchPath = fs.realpathSync(scratchPath);
  if (!ids.length) paths.splice(0, paths.length, fs.realpathSync(scratchPath));
  const directory = paths[0];
  let workspace = workspaces.get(key);
  if (!workspace) {
    const record = readStored(`cloud:workspace:${key}`) as CloudWorkspace | undefined;
    const stored = record?.key === key && record.provider === input.provider && (record.path === directory || !ids.length && record.path === fs.realpathSync(scratchDirectory())) && Array.isArray(record.entries) ? record : undefined;
    workspace = stored
      ? { ...stored, path: directory, paths, repositoryIds: [...new Set(ids)], state: "idle", approvals: [] }
      : { key, chatId: input.chatId, repositoryIds: [...new Set(ids)], provider: input.provider, path: directory, paths, compactions: 0, state: "idle", entries: [], approvals: [] };
    workspace.scratchPath = scratchPath;
    if (stored && stored.state !== "idle") append(workspace, "context", "The previous run was interrupted when Umbratic closed. You can continue from its saved context.");
    if (workspace.sessionId && !workspace.sessions?.[workspace.provider]) rememberCloudSession(workspace);
    workspaces.set(key, workspace);
  }
  return structuredClone(workspace);
}

export function listCloudChats(input: { provider: import("../shared/cloud").CloudProvider }) {
  if (!isCloudProvider(input?.provider)) throw new Error("Choose a provider.");
  const all = new Map<string, CloudWorkspace>(storedCloudWorkspaces().map(workspace => [workspace.key, { ...workspace, state: "idle" as const }]));
  for (const [key, workspace] of workspaces) all.set(key, workspace);
  return [...all.values()].filter(workspace => workspace.provider === input.provider)
    .filter(workspace => workspace.entries.length)
    .map(cloudChatRecord).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createCloudChat(input: CloudWorkspaceInput): CloudWorkspace {
  return getCloudWorkspace({ provider: input.provider, repositoryIds: input.repositoryIds, repositoryId: input.repositoryId, chatId: crypto.randomUUID() });
}

export function cloudProjectChats(projectId: string): CloudWorkspace[] {
  const project = readProjects().find(project => project.id === projectId);
  if (!project) throw new Error("Open the workspace folder again.");
  const all = new Map(storedCloudWorkspaces().map(workspace => [workspace.key, workspace]));
  for (const [key, workspace] of workspaces) all.set(key, workspace);
  const matches = [...all.values()].filter(workspace => workspace.repositoryIds?.includes(projectId) || (workspace.paths || [workspace.path]).includes(project.rootPath));
  if (matches.some(workspace => runs.has(workspace.key))) throw new Error("Stop the chats in this project before deleting it.");
  return matches;
}

export function deleteCloudChat(input: { key: string; provider: import("../shared/cloud").CloudProvider }): void {
  if (!isCloudProvider(input?.provider)) throw new Error("Choose a provider.");
  const workspace = workspaces.get(input.key) || storedCloudWorkspaces().find(value => value.key === input.key);
  if (!workspace || workspace.provider !== input.provider) throw new Error("This chat is no longer available.");
  if (runs.has(workspace.key)) throw new Error("Stop this chat before deleting it.");
  deleteCloudHistory(workspace, workspaces.values());
  clearTimeout(timers.get(workspace.key)); timers.delete(workspace.key);
  workspaces.delete(workspace.key);
  const scratch = path.join(app.getPath("userData"), "cloud", "workspaces", workspace.key);
  if (/^[a-f0-9]{64}$/.test(workspace.key)) fs.rmSync(scratch, { recursive: true, force: true });
}

function append(workspace: CloudWorkspace, kind: CloudWorkspace["entries"][number]["kind"], text: string): void {
  workspace.entries.push({ id: crypto.randomUUID(), kind, text, at: new Date().toISOString() });
  if (workspace.entries.length > 500) workspace.entries.splice(0, workspace.entries.length - 500);
}
function flush(workspace: CloudWorkspace): void {
  clearTimeout(timers.get(workspace.key)); timers.delete(workspace.key);
  if (closing) return;
  if (workspace.entries.length) writeStored(`cloud:workspace:${workspace.key}`, { ...workspace, approvals: [] });
  getMainWindow()?.webContents.send("umbratic:cloud-workspace", workspace);
}
function publish(workspace: CloudWorkspace): void {
  workspace.lastActiveAt = new Date().toISOString();
  if (closing || timers.has(workspace.key)) return;
  timers.set(workspace.key, setTimeout(() => flush(workspace), 80));
}
function requiredWorkspace(key: string): CloudWorkspace {
  const workspace = workspaces.get(key);
  if (!workspace) throw new Error("Open this Cloud workspace again.");
  return workspace;
}
export function readCloudFile(input: { key: string; path: string }): { path: string; text: string } {
  const workspace = requiredWorkspace(input?.key);
  if (typeof input.path !== "string" || !input.path || input.path.includes("\0")) throw new Error("Choose a workspace file.");
  const target = fs.realpathSync(path.resolve(workspace.path, input.path));
  if (![...(workspace.paths || [workspace.path]), ...(workspace.scratchPath ? [workspace.scratchPath] : [])].some(root => {
    const relative = path.relative(fs.realpathSync(root), target);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  })) throw new Error("This file is outside the selected workspace folders.");
  const fd = fs.openSync(target, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("Preview supports text files up to 256 KB.");
    const buffer = Buffer.alloc(256 * 1024 + 1);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > 256 * 1024 || buffer.subarray(0, bytes).includes(0)) throw new Error("This file cannot be previewed as text.");
    return { path: target, text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)) };
  } finally { fs.closeSync(fd); }
}
export function startCloudTurn(input: CloudWorkspaceInput & { prompt: string; imageIds?: string[] }): CloudWorkspace {
  if (closing) throw new Error("Umbratic is closing.");
  if (typeof input?.prompt !== "string" || (!input.prompt.trim() && !input.imageIds?.length) || input.prompt.length > 100_000) throw new Error("Enter an instruction of up to 100,000 characters.");
  const images = resolveCloudImages(input.imageIds ?? []);
  const snapshot = getCloudWorkspace(input);
  const workspace = requiredWorkspace(snapshot.key);
  if (runs.has(workspace.key) || cloudInstallInProgress() || disconnecting.has(input.provider)) throw new Error("Finish or stop this chat or its installation first.");
  const settings = getCloudSettings();
  const reason = contextResetReason(workspace, settings);
  if (reason) {
    forgetCloudProviderSession(workspace, workspace.provider);
    append(workspace, "context", reason);
    workspace.contextStartEntryId = workspace.entries.at(-1)!.id;
  }
  const runtimePrompt = cloudTurnPrompt(workspace, input.prompt.trim());
  const firstEntry = workspace.entries.length;
  workspace.lastActiveAt = new Date().toISOString();
  append(workspace, "instruction", input.prompt.trim());
  if (images.length) workspace.entries.at(-1)!.images = images.map(image => image.image);
  workspace.state = "running";
  function receiveText(id: string, text: string, additive: boolean, kind: "answer" | "thinking", phase?: import("../shared/cloud").CloudMessagePhase): void {
    if (closing) return;
    const entryId = `${workspace.sessionId}:${id}`;
    const existing = workspace.entries.find(entry => entry.id === entryId);
    if (existing) {
      existing.text = (additive ? existing.text + text : text).slice(0, 1_000_000);
      if (phase) existing.phase = phase;
      // Native providers may continue the same message after steering. Keep that
      // response below the instruction it is now answering without duplicating it.
      const index = workspace.entries.indexOf(existing);
      if (workspace.entries.slice(index + 1).some(entry => entry.kind === "instruction")) {
        workspace.entries.splice(index, 1); workspace.entries.push(existing);
      }
    } else if (text) workspace.entries.push({ id: entryId, kind, text: text.slice(0, 1_000_000), phase, at: new Date().toISOString() });
    publish(workspace);
  }
  const sink: CloudRuntimeSink = {
    session(id, account) {
      if (workspace.account !== account) workspace.usage = rememberUsage(workspace.provider, account);
      workspace.sessionId = id; workspace.account = account; publish(workspace);
    },
    text(id, text, additive, phase) { receiveText(id, text, additive, "answer", phase); },
    thinking(id, text, additive) { receiveText(`thinking:${id}`, text, additive, "thinking"); },
    complete() {
      for (const entry of workspace.entries.slice(firstEntry)) if (entry.kind === "instruction") entry.completedAt ??= new Date().toISOString();
      flush(workspace);
    },
    activity(text, tool) {
      const id = tool ? `${workspace.sessionId}:tool:${tool.id}` : undefined;
      const existing = id ? workspace.entries.find(entry => entry.id === id) : undefined;
      if (existing) { existing.text = text === "Tool finished" ? existing.text : text; existing.tool = text === "Tool finished" ? { ...existing.tool!, status: tool!.status, ...(tool!.output !== undefined ? { output: tool!.output } : {}) } : { ...existing.tool, ...tool! }; }
      else if (tool) workspace.entries.push({ id: id!, kind: "activity", text, tool, at: new Date().toISOString() });
      else if (workspace.entries.at(-1)?.text !== text) append(workspace, "activity", text);
      publish(workspace);
    },
    limits(usage) { workspace.usage = workspace.account ? rememberUsage(workspace.provider, workspace.account, usage) : latestCloudUsage([usage, workspace.usage]); publish(workspace); },
    compact() { workspace.compactions++; append(workspace, "context", "The runtime compacted this context."); publish(workspace); },
    usage(contextWindow, inputTokens) { workspace.contextWindow = contextWindow; workspace.inputTokens = inputTokens; publish(workspace); },
    approval(request) {
      if (closing || !runs.has(workspace.key)) return Promise.resolve({ allow: false });
      const rule = commandRule(workspace, request);
      if (rule && allowedCloudCommand(rule)) {
        append(workspace, "activity", `Allowed saved command: ${rule.command}`); publish(workspace);
        return Promise.resolve({ allow: true });
      }
      if (!rule) request = { ...request, command: undefined };
      const id = crypto.randomUUID();
      workspace.approvals.push({ ...request, id }); workspace.state = "waiting"; publish(workspace);
      return new Promise(resolve => approvals.set(id, { key: workspace.key, resolve }));
    },
  };
  const run = runtime(input.provider).run(settings, structuredClone(workspace), runtimePrompt, sink, images);
  runs.set(workspace.key, run);
  let succeeded = false;
  void run.done.then(() => { succeeded = true; })
    .catch(error => { if (!closing && !stopping.has(workspace.key)) append(workspace, "error", error instanceof Error ? error.message : "The runtime could not finish this work."); })
    .finally(async () => {
      await steering.get(workspace.key)?.catch(() => undefined);
      if (succeeded) rememberCloudSession(workspace);
      for (const entry of workspace.entries.slice(firstEntry)) if (entry.kind === "instruction") entry.completedAt ??= new Date().toISOString();
      const stopped = stopping.delete(workspace.key);
      if (stopped) append(workspace, "activity", "Work stopped.");
      for (const entry of workspace.entries) if (entry.tool?.status === "running") entry.tool.status = "stopped";
      denyApprovals(workspace.key); runs.delete(workspace.key); workspace.state = "idle";
      workspace.lastActiveAt = new Date().toISOString();
      // The service owns the queue, so switching providers or closing a view cannot lose a follow-up.
      if (succeeded && !stopped && !closing && workspace.queuedPrompts?.length) {
        const next = workspace.queuedPrompts.shift()!;
        try { startCloudTurn({ provider: workspace.provider, key: workspace.key, prompt: next.prompt, imageIds: next.images.map(image => image.id) }); return; }
        catch (cause) {
          workspace.queuedPrompts.unshift(next);
          append(workspace, "error", cause instanceof Error ? cause.message : "The queued prompt could not start.");
        }
      }
      flush(workspace);
    });
  flush(workspace);
  return structuredClone(workspace);
}

export async function sendCloudFollowUp(input: CloudFollowUpInput): Promise<CloudWorkspace> {
  if (closing) throw new Error("Umbratic is closing.");
  if (input?.mode !== "queue" && input?.mode !== "steer") throw new Error("Choose whether to queue or steer this prompt.");
  const workspace = requiredWorkspace(input.key);
  const queued = input.queuedId ? workspace.queuedPrompts?.find(item => item.id === input.queuedId) : undefined;
  if (input.queuedId && (!queued || input.mode !== "steer")) throw new Error("This queued prompt is no longer available.");
  const prompt = queued?.prompt ?? input.prompt;
  const imageIds = queued ? queued.images.map(image => image.id) : input.imageIds ?? [];
  if (typeof prompt !== "string" || (!prompt.trim() && !imageIds.length) || prompt.length > 100_000) throw new Error("Enter an instruction of up to 100,000 characters.");
  const images = resolveCloudImages(imageIds);
  const run = runs.get(workspace.key);
  if (!run) {
    if (queued) {
      workspace.queuedPrompts = workspace.queuedPrompts?.filter(item => item.id !== queued.id);
      try { return startCloudTurn({ provider: workspace.provider, key: workspace.key, prompt, imageIds }); }
      catch (cause) { workspace.queuedPrompts?.unshift(queued); throw cause; }
    }
    if (input.mode === "queue") return startCloudTurn({ provider: workspace.provider, key: workspace.key, prompt, imageIds });
    throw new Error("This turn has finished. Send the prompt as a new turn.");
  }
  if (stopping.has(workspace.key)) throw new Error("Wait for the current work to stop.");
  if (input.mode === "queue") {
    workspace.queuedPrompts ??= [];
    if (workspace.queuedPrompts.length >= 20) throw new Error("The queue is full. Wait for a prompt to finish or remove one.");
    workspace.queuedPrompts.push({ id: crypto.randomUUID(), prompt: prompt.trim(), images: images.map(image => image.image) });
    flush(workspace);
  } else {
    if (steering.has(workspace.key)) throw new Error("Wait for the previous steering message to send.");
    const operation = (async () => {
      append(workspace, "instruction", prompt.trim());
      const entry = workspace.entries.at(-1)!;
      if (images.length) entry.images = images.map(image => image.image);
      publish(workspace);
      try {
        await run.steer(prompt.trim(), images);
        if (queued) workspace.queuedPrompts = workspace.queuedPrompts?.filter(item => item.id !== queued.id);
        flush(workspace);
      } catch (cause) {
        workspace.entries = workspace.entries.filter(item => item.id !== entry.id);
        flush(workspace);
        throw cause;
      }
    })();
    steering.set(workspace.key, operation);
    try { await operation; } finally { steering.delete(workspace.key); }
  }
  return structuredClone(workspace);
}

export function removeCloudQueuedPrompt(input: { key: string; id: string }): CloudWorkspace {
  const workspace = requiredWorkspace(input?.key);
  if (steering.has(workspace.key)) throw new Error("Wait for the steering message to send.");
  if (!workspace.queuedPrompts?.some(item => item.id === input.id)) throw new Error("This queued prompt is no longer available.");
  workspace.queuedPrompts = workspace.queuedPrompts.filter(item => item.id !== input.id);
  flush(workspace);
  return structuredClone(workspace);
}

function denyApprovals(key: string): void {
  for (const [id, pending] of approvals) if (pending.key === key) { approvals.delete(id); pending.resolve({ allow: false }); }
  const workspace = workspaces.get(key); if (workspace) workspace.approvals = [];
}
export function respondCloudApproval(input: { key: string; id: string; allow: boolean; remember?: boolean; answers?: Record<string, string> }): void {
  const pending = approvals.get(input?.id);
  if (!pending || pending.key !== input.key || typeof input.allow !== "boolean") throw new Error("This approval is no longer pending.");
  const workspace = requiredWorkspace(input.key);
  const request = workspace.approvals.find(approval => approval.id === input.id);
  const answers: Record<string, string> = {};
  if (input.allow && request?.questions) for (const question of request.questions) {
    const answer = input.answers?.[question.id];
    if (typeof answer !== "string" || !answer.trim() || answer.length > 10_000) throw new Error("Answer each question before continuing.");
    answers[question.id] = answer;
  }
  if (input.remember) {
    const rule = input.allow && request ? commandRule(workspace, request) : undefined;
    if (!rule) throw new Error("Only an approved command can be remembered.");
    rememberCloudCommand(rule);
  }
  approvals.delete(input.id); workspace.approvals = workspace.approvals.filter(approval => approval.id !== input.id);
  workspace.state = workspace.approvals.length ? "waiting" : "running";
  pending.resolve({ allow: input.allow, answers }); publish(workspace);
}
export async function stopCloudTurn(input: { key: string }): Promise<void> {
  const run = runs.get(input?.key); if (!run) return;
  stopping.add(input.key);
  denyApprovals(input.key);
  await run.stop();
}
export function stopCloudService(): void {
  for (const workspace of workspaces.values()) flush(workspace);
  closing = true;
  stopCodexLogin(); stopClaudeLogin();
  stopCloudInstall();
  for (const [key, run] of runs) { denyApprovals(key); void run.stop().catch(() => undefined); }
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}
