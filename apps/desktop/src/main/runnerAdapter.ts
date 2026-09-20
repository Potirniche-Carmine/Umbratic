import { awaitRunnerListener, stopRunnerProcess } from "./runnerLifecycle";
import { companyTLS } from "./companyTrust";
import { resolveReasoningEffort } from "../shared/desktopApi";
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { app } from "electron";

import { runnerLogsDirectory, workspaceRuntimeDirectory } from "./appPaths";
import { companyEndpoint } from "./config";
import { artifactEngineAvailable } from "./artifacts/service";
import { probeLocalCapabilities } from "./capabilities";
import { refreshWorkspaceGraph, workspaceGraphRunnerConfig } from "./indexerService";
import { veilManagedModelId } from "./endpointConfig";
import { currentLocalVeilConnection } from "./localVeil";
import { umbraticRunnerHardeningEnvironment, assertUmbraticRunnerConfig } from "./policy";
import { localCalendarDate } from "./promptContext";
import { enabledPromptSkills } from "./skills";
import { readContextLengthSetting, readHarnessProfileSetting, readModelEndpointSettings, readReasoningEffortSetting, readShowThinkingSetting } from "./storage";
import { enabledToolsFromSettings, normalizeEnabledTools } from "./toolSettings";
import type {
  CapabilityProbeReport,
  HarnessProfileId,
  LocalModelInfo,
  LspServerLaunchConfig,
  ModelEndpointMode,
  RunnerProcess,
  RunnerToolId,
  SseStream,
  TaskRecord,
} from "./types";
import { isRecord } from "./utils";
import { connectedVeilSupports, veilFeature } from "./veilFeatures";

type HarnessRouteConfig = {
  chatEndpointPath: string;
};

export function runnerDiagnosticsDirectory(userDataPath: string): string {
  return runnerLogsDirectory(userDataPath);
}

export function harnessRouteConfig(profileId: HarnessProfileId): HarnessRouteConfig {
  return {
    chatEndpointPath: `/api/${profileId}/chat`,
  };
}

/**
 * Whether the web tools can be offered for this connection at all.
 *
 * Local mode always can: the runner queries a public engine from this machine,
 * which is what that mode is. A server deployment can only search where Veil
 * said it can, because every other route out of here crosses the boundary the
 * deployment exists to enforce.
 *
 * One switch covers `web_search` and `web_fetch` together, so this withholds
 * both. A server without search could still read a pasted URL, but the user's
 * consent for that is the same control, and a web toggle that turns on half of
 * what it says is worse than no toggle.
 *
 * `connectedVeilSupports` answers false until a health check has come back.
 * That is the safe default and it is deliberate — a server that has not yet
 * told us it can search is treated as one that cannot, so no query escapes in
 * the window before the first health check answers.
 */
export function webToolsAvailable(mode: ModelEndpointMode): boolean {
  return mode === "local" || connectedVeilSupports(veilFeature.webSearch);
}

export function buildUmbraticRunnerConfig(
  task: TaskRecord,
  selectedModel: LocalModelInfo,
  attachmentDirectory?: string,
  capabilityReport?: CapabilityProbeReport,
): Record<string, unknown> {
  const endpointSettings = readModelEndpointSettings();
  const localVeil = endpointSettings.mode === "local" ? currentLocalVeilConnection() : null;
  const harnessProfile = readHarnessProfileSetting();
  const route = harnessRouteConfig(harnessProfile);
  const requestedTools = normalizeEnabledTools(task.enabledTools, enabledToolsFromSettings({}));
  // A remote task's probe describes a filesystem this process cannot see, so
  // the paths in it are taken as reported instead of being resolved here.
  const onRemoteHost = task.remote !== undefined;
  const lspServers = approvedLspServers(capabilityReport, onRemoteHost);
  const approvedExecutables = approvedCommandExecutables(capabilityReport, onRemoteHost);
  // The workspace graph is an artifact this desktop builds from a local
  // checkout. There is none for a directory on another machine.
  const workspaceGraph = onRemoteHost ? undefined : workspaceGraphRunnerConfig(task.worktreePath);
  // Unlike the graph, the document engines belong to this desktop rather than
  // to the workspace's machine, so a remote task gets them too: the runner asks
  // over the event stream and the bytes travel.
  const artifactService = artifactEngineAvailable();
  // Same shape as the three tools below: requested plus available. A server
  // deployment that has not advertised `web.search` has nowhere to send a query
  // that keeps it inside the company boundary, so the web tools are not offered
  // at all rather than quietly answered from this machine.
  const webTools = webToolsAvailable(endpointSettings.mode);
  const enabledTools = requestedTools.filter(
    (tool) => tool !== "lsp" && tool !== "workspace_graph" && tool !== "artifact"
      && (webTools || (tool !== "web_search" && tool !== "web_fetch")),
  ) as RunnerToolId[];
  if (requestedTools.includes("lsp") && lspServers.length > 0) {
    enabledTools.splice(Math.min(4, enabledTools.length), 0, "lsp" as RunnerToolId);
  }
  // Same shape as LSP: requested plus available, never requested alone. Until
  // the artifact exists the tool simply does not admit.
  if (requestedTools.includes("workspace_graph") && workspaceGraph) {
    enabledTools.splice(Math.min(5, enabledTools.length), 0, "workspace_graph" as RunnerToolId);
  }
  if (requestedTools.includes("artifact") && artifactService) {
    enabledTools.splice(Math.min(6, enabledTools.length), 0, "artifact" as RunnerToolId);
  }
  return {
    taskId: task.id,
    cwd: task.worktreePath,
    contextLength: selectedModel.contextLength ?? readContextLengthSetting(),
    maxResponseTokens: 8_192,
    protectedPromptReserveTokens: 2_048,
    attachmentDirectory,
    workspaceMode: task.workspaceMode,
    skills: enabledPromptSkills().map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      source: skill.source,
      instructionPath: skill.instructionPath,
      paths: skill.paths,
    })),
    capabilities: task.capabilityProbes ?? [],
    permissionMode: "normal",
    localDate: localCalendarDate(),
    enabledTools,
    approvedExecutables,
    lspServers,
    workspaceGraph,
    services: { artifact: artifactService },
    diagnostics: {
      enabled: false,
    },
    provider: {
      id: selectedModel.providerId,
      name: selectedModel.providerName,
      baseURL: selectedModel.baseUrl,
      // Trusted config, not inferred from the URL.
      mode: endpointSettings.mode,
      chatEndpointPath: route.chatEndpointPath,
      apiKey: localVeil?.authToken ?? "",
      modelId: selectedModel.modelId,
      // Naming the model is only admissible where the server published a
      // registry to pick from. Local mode has one model per Veil process, and
      // the sentinel means the user never picked — both send nothing.
      sendModelField:
        endpointSettings.mode === "server"
        && connectedVeilSupports(veilFeature.modelSelection)
        && selectedModel.modelId !== veilManagedModelId,
      // Same gating as `model`: an older Veil that never advertised the toggle
      // must see the body it has always seen.
      sendThinkingField: connectedVeilSupports(veilFeature.thinkingToggle),
      thinking: endpointSettings.mode === "server" && connectedVeilSupports(veilFeature.reasoningEffort)
        ? resolveReasoningEffort(selectedModel.capabilities?.reasoningEfforts ?? [], readReasoningEffortSetting())
        : readReasoningEffortSetting() === "off" ? "off" : "on",
      sendReasoningVisibleField: connectedVeilSupports(veilFeature.reasoningVisible),
      reasoningVisible: readShowThinkingSetting() && readReasoningEffortSetting() !== "off",
      // Which side of the boundary `web_search` runs on, for the two cases
      // where it is offered at all. A company Veil that advertises the name
      // searches on the user's behalf and the query never leaves the
      // deployment; local mode leaves the runner to search the open web itself.
      veilWebSearch:
        endpointSettings.mode === "server"
        && connectedVeilSupports(veilFeature.webSearch),
      capabilities: selectedModel.capabilities ?? {
        parallelToolCalls: endpointSettings.mode === "local",
        vision: false,
        reasoning: false,
      },
      headers: Object.fromEntries(
        (endpointSettings.mode === "local" ? [] : endpointSettings.headers)
          .filter((header) => header.name.trim().toLowerCase() !== "authorization" && header.value)
          .map((header) => [header.name.trim(), header.value]),
      ),
      mtls: endpointSettings.mode === "server" ? companyTLS(endpointSettings.baseUrl, companyEndpoint.mtls) : undefined,
    },
  };
}

/**
 * Resolves a probed executable to the command the runner may launch.
 *
 * Locally that means following the path to a real file, so a stale report
 * cannot approve something that has since been removed. On a remote host there
 * is no such check to make from here: the probe ran there, moments ago, and the
 * path it reported is the only evidence available. Requiring it to be absolute
 * is what remains enforceable.
 */
function resolvedProbeCommand(executablePath: string, onRemoteHost: boolean): string | null {
  if (!path.isAbsolute(executablePath)) return null;
  if (onRemoteHost) return executablePath;
  try {
    const command = fs.realpathSync(executablePath);
    return fs.statSync(command).isFile() ? command : null;
  } catch {
    return null;
  }
}

export function approvedCommandExecutables(
  report?: CapabilityProbeReport,
  onRemoteHost = false,
): Array<{ id: string; command: string }> {
  if (!report) return [];
  const approved: Array<{ id: string; command: string }> = [];
  for (const probe of report.probes) {
    if (probe.status !== "available" || !probe.detectedCommand || !probe.executablePath) continue;
    const command = resolvedProbeCommand(probe.executablePath, onRemoteHost);
    if (command) approved.push({ id: probe.id, command });
  }
  return approved.slice(0, 32);
}

export function approvedLspServers(
  report?: CapabilityProbeReport,
  onRemoteHost = false,
): LspServerLaunchConfig[] {
  if (!report) return [];
  const definitions: Record<string, Omit<LspServerLaunchConfig, "command">> = {
    "typescript-language-server": {
      id: "typescript-language-server",
      args: ["--stdio"],
      languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
      extensions: ["ts", "tsx", "js", "jsx"],
    },
    "rust-analyzer": {
      id: "rust-analyzer",
      args: [],
      languageIds: ["rust"],
      extensions: ["rs"],
    },
  };
  const servers: LspServerLaunchConfig[] = [];
  for (const probe of report.probes) {
    const definition = definitions[probe.id];
    if (!definition || probe.status !== "available" || !probe.executablePath) continue;
    const command = resolvedProbeCommand(probe.executablePath, onRemoteHost);
    if (command) servers.push({ ...definition, command });
  }
  return servers.slice(0, 3);
}

export function runtimeEnv(worktreePath: string): NodeJS.ProcessEnv {
  const runtimeRoot = workspaceRuntimeDirectory(app.getPath("userData"), worktreePath);
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  // Keep UV_* install dirs for confirmed tooling, but never prepend workspace-controlled
  // .umbratic/runtime onto PATH — that lets a malicious repo win executable lookup.
  const env: NodeJS.ProcessEnv = {
    [pathKey]: process.env[pathKey] ?? "",
    UV_INSTALL_DIR: path.join(runtimeRoot, "uv"),
    UV_UNMANAGED_INSTALL: path.join(runtimeRoot, "uv"),
    UV_NO_MODIFY_PATH: "1",
    UV_PYTHON_INSTALL_DIR: path.join(runtimeRoot, "python"),
    UV_PYTHON_BIN_DIR: path.join(runtimeRoot, "python-bin"),
    UV_CACHE_DIR: path.join(runtimeRoot, "uv-cache"),
  };
  const allowedExact = new Set([
    "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "LANG", "TERM", "NO_PROXY",
    "SystemRoot", "SystemDrive", "WINDIR", "COMSPEC", "PATHEXT", "NODE_ENV",
    "CARGO_HOME", "RUSTUP_HOME",
  ].map((name) => name.toLowerCase()));
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || name.toLowerCase() === pathKey.toLowerCase()) continue;
    if (allowedExact.has(name.toLowerCase()) || name.toUpperCase().startsWith("LC_")) {
      env[name] = value;
    }
  }
  return env;
}

function existingRunnerBinary(candidate: string): string | null {
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function nativeRunnerFilename(): string {
  return process.platform === "win32" ? "umbratic-runner.exe" : "umbratic-runner";
}

function packagedRunnerBinaryPath(): string | null {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return resourcesPath ? path.join(resourcesPath, "runner", nativeRunnerFilename()) : null;
}

export function runnerBinaryPath(): string | null {
  const candidates: string[] = [];
  const packagedPath = packagedRunnerBinaryPath();
  if (packagedPath) candidates.push(packagedPath);
  candidates.push(path.resolve(__dirname, "../../../../target/release", nativeRunnerFilename()));
  for (const candidate of candidates) {
    const resolved = existingRunnerBinary(candidate);
    if (resolved) return resolved;
  }
  return null;
}

export async function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate an Umbratic runner port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function runnerAuthHeader(run: RunnerProcess): string {
  return `Basic ${Buffer.from(`umbratic-runner:${run.password}`).toString("base64")}`;
}

function runnerUrl(run: RunnerProcess, route: string): URL {
  return new URL(route, run.url);
}

export async function runnerRequest<T>(
  run: RunnerProcess,
  route: string,
  init: Omit<RequestInit, "body"> & { body?: unknown } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", runnerAuthHeader(run));
  if (init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(runnerUrl(run, route), {
    ...init,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal ?? run.abortController.signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Umbratic runner ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 400)}` : ""}`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export async function setRunnerProviderSession(run: RunnerProcess, session: string): Promise<void> {
  await runnerRequest<void>(run, "/provider/session", {
    method: "POST",
    body: { session },
  });
}

export async function startUmbraticRunnerServer(
  task: TaskRecord,
  model: LocalModelInfo,
  attachmentDirectory?: string,
): Promise<RunnerProcess> {
  const binaryPath = runnerBinaryPath();
  if (!binaryPath) {
    throw new Error("Umbratic runner is not built in the app bundle.");
  }
  const port = await freeLocalPort();
  const password = crypto.randomBytes(18).toString("base64url");
  const capabilityReport = await probeLocalCapabilities({ runnerPath: binaryPath });
  // The config reads the artifact's existence, so the index has to settle
  // before it is built. Opening the workspace already started this build and
  // `refreshWorkspaceGraph` coalesces onto it, so the usual cost here is the
  // incremental update. A failure resolves false and the tool stays absent.
  await refreshWorkspaceGraph(task.worktreePath);
  const config = buildUmbraticRunnerConfig(task, model, attachmentDirectory, capabilityReport);
  const diagnostics = isRecord(config.diagnostics) && typeof config.diagnostics.logPath === "string"
    ? { diagnosticLogPath: config.diagnostics.logPath }
    : {};
  assertUmbraticRunnerConfig(config, model, app.getPath("userData"));
  const env: NodeJS.ProcessEnv = {
    ...runtimeEnv(task.worktreePath),
    ...umbraticRunnerHardeningEnvironment(),
  };
  const child = spawn(binaryPath, ["serve", "--hostname=127.0.0.1", `--port=${port}`], {
    cwd: task.worktreePath,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const run: RunnerProcess = {
    taskId: task.id,
    url: `http://127.0.0.1:${port}`,
    password,
    directory: task.worktreePath,
    ...diagnostics,
    child,
    abortController: new AbortController(),
  };
  const started = await awaitRunnerListener(child, run.url, { ...config, password }, 15_000);
  if (!started.ok) {
    stopRunnerProcess(run);
    throw new Error("The Umbratic runner did not start.");
  }
  return run;
}

function parseSseBlock(block: string): unknown | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function beginRunnerEventStream(run: RunnerProcess, onEvent: (event: Record<string, unknown>) => void): SseStream {
  let markReady!: () => void;
  let failReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  const done = (async () => {
    try {
      const headers = new Headers();
      headers.set("Authorization", runnerAuthHeader(run));
      headers.set("Accept", "text/event-stream");
      const response = await fetch(runnerUrl(run, "/event"), {
        headers,
        signal: run.abortController.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`Umbratic runner event stream failed with ${response.status} ${response.statusText}.`);
      }
      markReady();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let boundary = buffer.search(/\r?\n\r?\n/);
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            const delimiterLength = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0].length ?? 2;
            buffer = buffer.slice(boundary + delimiterLength);
            const event = parseSseBlock(block);
            if (isRecord(event)) onEvent(event);
            boundary = buffer.search(/\r?\n\r?\n/);
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    } catch (error) {
      // A cancelled handshake still has a caller awaiting readiness.
      failReady(error);
      if (run.abortController.signal.aborted) return;
      throw error;
    }
  })();
  return { ready, done };
}

/**
 * Answers one artifact job.
 *
 * A 404 means the runner already gave up on this job — it timed out, or the run
 * was aborted — so the result is dropped rather than retried. The file it
 * describes was written to a confined path either way; what is lost is only the
 * model's chance to hear about it this turn.
 */
export async function replyRunnerArtifact(
  run: RunnerProcess,
  artifactId: string,
  result: unknown,
): Promise<void> {
  await runnerRequest<boolean>(run, `/artifact/${encodeURIComponent(artifactId)}/reply`, {
    method: "POST",
    body: result as Record<string, unknown>,
  }).catch(() => undefined);
}

export async function replyRunnerPermission(run: RunnerProcess, permissionId: string, allow: boolean) {
  const reply = allow ? "once" : "reject";
  await runnerRequest<boolean>(run, `/permission/${encodeURIComponent(permissionId)}/reply`, {
    method: "POST",
    body: { reply },
  });
}
