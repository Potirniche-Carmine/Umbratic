import { codexBrowserConfig } from "./cloudBrowser";
import { codexStreamConsumer } from "./cloudCodexStream";
import { codexUsage, optionalRuntimeRead, planLabel } from "./cloudUsage";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shell } from "electron";
import { CloudRpc, type RpcMessage } from "./cloudTransport";
import { cloudEnvironment, cloudWorkflowInstructions, cloudWorkspaceInstructions, validateCloudConnection } from "./cloudPolicy";
import { isCloudEffort, type CloudConnection, type CloudSettings } from "../shared/cloud";
import type { CloudRuntime } from "./cloudRuntimeTypes";
import { CloudRuntimeMissing } from "./cloudInstall";

export function codexExecutable(configured: string): string {
  if (configured) {
    if (!path.isAbsolute(configured) || !fs.existsSync(configured)) throw new Error("Choose an existing, absolute path to the official Codex executable.");
    return configured;
  }
  const binary = process.platform === "win32" ? "codex.exe" : "codex";
  const candidates = [
    ...String(process.env.PATH || "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, binary)),
    path.join(os.homedir(), ".local", "bin", binary),
    "/opt/homebrew/bin/codex", "/usr/local/bin/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  ];
  const found = candidates.find(candidate => { try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch { return false; } });
  if (!found) throw new CloudRuntimeMissing("Codex is not installed.");
  return found;
}

async function connect(settings: CloudSettings, cwd: string, scratchPath?: string): Promise<CloudRpc> {
  const rpc = new CloudRpc(codexExecutable(settings.providers.codex.executable), ["app-server",
    "-c", "analytics.enabled=false", "-c", "otel.exporter=\"none\"", "-c", "otel.metrics_exporter=\"none\"",
    "-c", "features.memories=false", "-c", "model_provider=\"openai\""], cwd, { ...cloudEnvironment(), ...(scratchPath ? { TMPDIR: scratchPath, TMP: scratchPath, TEMP: scratchPath } : {}) });
  try {
    await rpc.request("initialize", { clientInfo: { name: "umbratic", title: "Umbratic", version: "0.0.3" } });
    rpc.send({ method: "initialized" });
    return rpc;
  } catch (error) { rpc.close(); throw error; }
}

async function inspect(rpc: CloudRpc): Promise<CloudConnection> {
  const { account } = await rpc.request("account/read", { refreshToken: false });
  if (!account) return { provider: "codex", state: "sign_in", models: [], message: "Connect your ChatGPT account." };
  if (account.type !== "chatgpt") return { provider: "codex", state: "unsupported_account", models: [], message: "Codex is using an API account. Sign in with ChatGPT to use your plan in Cloud." };
  const models: CloudConnection["models"] = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    const page = await rpc.request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
    for (const model of page.data ?? []) {
      if (typeof model.model !== "string" || model.hidden) continue;
      models.push({ id: model.model, label: model.displayName || model.model,
        efforts: (model.supportedReasoningEfforts ?? []).map((item: { reasoningEffort: unknown }) => item.reasoningEffort).filter(isCloudEffort),
        serviceTiers: (model.serviceTiers || []).filter((tier: any) => typeof tier.id === "string" && typeof tier.name === "string").map((tier: any) => ({ id: tier.id, name: tier.name })),
        defaultEffort: isCloudEffort(model.defaultReasoningEffort) ? model.defaultReasoningEffort : undefined });
    }
    cursor = page.nextCursor || undefined;
    if (cursor && cursors.has(cursor)) throw new Error("Codex returned a repeated model catalog page.");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  const usage = await optionalRuntimeRead(rpc.request("account/rateLimits/read", {}));
  return { provider: "codex", state: "ready", models, usage: usage ? codexUsage(usage) : undefined, accountEmail: account.email, planName: planLabel(account.planType), account: `${account.email || "ChatGPT"} · ${account.planType || "plan"}`, message: "Connected through the official Codex runtime." };
}

let login: CloudRpc | undefined;
let loginGeneration = 0;
export const codexCloudRuntime: CloudRuntime = {
  async signOut(settings, cwd) {
    stopCodexLogin();
    const rpc = await connect(settings, cwd);
    try { await rpc.request("account/logout", {}); } finally { rpc.close(); }
  },
  async inspect(settings, cwd) {
    const rpc = await connect(settings, cwd);
    try { return await inspect(rpc); } finally { rpc.close(); }
  },
  async signIn(settings, cwd) {
    stopCodexLogin();
    const generation = loginGeneration;
    const rpc = await connect(settings, cwd);
    if (generation !== loginGeneration) { rpc.close(); throw new Error("Connection cancelled."); }
    login = rpc;
    const timer = setTimeout(() => rpc.close(), 5 * 60_000);
    rpc.onClose = () => { clearTimeout(timer); if (login === rpc) login = undefined; };
    rpc.onMessage = message => { if (message.method === "account/login/completed") rpc.close(); };
    try {
      const result = await rpc.request("account/login/start", { type: "chatgpt" });
      if (generation !== loginGeneration) throw new Error("Connection cancelled.");
      const url = new URL(result.authUrl);
      if (url.protocol !== "https:" || !["auth.openai.com", "auth0.openai.com", "chatgpt.com"].includes(url.hostname)) throw new Error("Codex returned an unsupported sign-in address.");
      await shell.openExternal(url.href);
      return { message: "Finish connecting in your browser." };
    } catch (error) { rpc.close(); throw error; }
  },
  run(settings, workspace, prompt, sink, images = []) {
    let rpc: CloudRpc | undefined;
    let threadId = ""; let turnId = ""; let stopped = false;
    let finish: (() => void) | undefined;
    let accepting = true;
    let readyResolve!: () => void; let readyReject!: (cause: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    void ready.catch(() => undefined);
    const done = (async () => {
      rpc = await connect(settings, workspace.path, workspace.scratchPath);
      try {
        const connection = await inspect(rpc);
        validateCloudConnection(connection, settings);
        if (connection.usage) sink.limits?.(connection.usage);
        if (stopped) return;
        if (workspace.account && workspace.account !== connection.account && workspace.sessionId) throw new Error("The signed-in account changed. Clear context before continuing.");
        const config = settings.providers.codex;
        const roots = [...new Set([...(workspace.paths || [workspace.path]), ...(workspace.scratchPath ? [workspace.scratchPath] : [])])];
        const access = codexAccess(config.approvalMode, roots);
        if (config.serviceTier !== "default" && !connection.models.find(model => model.id === config.orchestrator.model)?.serviceTiers?.some(tier => tier.id === config.serviceTier)) throw new Error("This model no longer offers the selected speed. Choose Standard or another available speed.");
        const result = await rpc.request(workspace.sessionId ? "thread/resume" : "thread/start", {
          ...(workspace.sessionId ? { threadId: workspace.sessionId, excludeTurns: true } : {}),
          cwd: workspace.path, model: config.orchestrator.model, modelProvider: "openai",
          sandbox: access.sandbox, approvalPolicy: access.approvalPolicy, approvalsReviewer: access.approvalsReviewer, serviceTier: config.serviceTier,
          developerInstructions: cloudWorkflowInstructions(settings, "codex") + "\n" + cloudWorkspaceInstructions(workspace.paths || [workspace.path], workspace.scratchPath),
          config: { ...codexBrowserConfig(settings, workspace), "sandbox_workspace_write.writable_roots": roots, "features.memories": false, "agents.enabled": settings.subagents, "skills.include_instructions": false, "skills.bundled.enabled": false },
        });
        threadId = result.thread.id;
        sink.session(threadId, connection.account || "ChatGPT");
        if (stopped) return;
        const consumeStream = codexStreamConsumer(sink);
        const completion = new Promise<void>((resolve, reject) => {
          finish = resolve;
          rpc!.onClose = reject;
          rpc!.onMessage = message => {
            if (message.id !== undefined && message.method) {
              void answerRequest(rpc!, message, sink).catch(reject); return;
            }
            const params = message.params || {};
            if (params.threadId && params.threadId !== threadId) return;
            if (message.method === "turn/started") turnId = params.turn?.id || turnId;
            consumeStream(message);
            if (message.method === "account/rateLimits/updated") sink.limits?.(codexUsage(params));
            if (message.method === "thread/tokenUsage/updated") sink.usage(params.tokenUsage?.modelContextWindow, params.tokenUsage?.last?.inputTokens);
            if (message.method === "turn/completed") {
              accepting = false;
              if (params.turn?.status === "failed") reject(new Error(params.turn.error?.message || "Codex could not complete this turn."));
              else { sink.complete?.(); resolve(); }
            }
          };
        });
        // A process can die while turn/start itself is still awaiting a reply.
        // Observe completion immediately so that race never leaks a rejection.
        void completion.catch(() => undefined);
        // Install listeners before turn/start: notifications can precede its response.
        const turn = await rpc.request("turn/start", { threadId, model: config.orchestrator.model, effort: config.orchestrator.effort,
          sandboxPolicy: access.sandboxPolicy, approvalPolicy: access.approvalPolicy, approvalsReviewer: access.approvalsReviewer, serviceTier: config.serviceTier,
          input: [...(prompt ? [{ type: "text", text: prompt, text_elements: [] }] : []), ...images.map(image => image.mimeType.startsWith("image/") ? ({ type: "localImage", path: image.path }) : ({ type: "text", text: `Attached file: ${image.path}\nRead it with native tools as needed.`, text_elements: [] }))] });
        turnId = turn.turn.id;
        readyResolve();
        if (stopped) { await rpc.request("turn/interrupt", { threadId, turnId }); finish?.(); }
        await completion;
        const usage = await optionalRuntimeRead(rpc.request("account/rateLimits/read", {}));
        if (usage) sink.limits?.(codexUsage(usage));
      } finally { accepting = false; if (rpc) { rpc.onClose = () => undefined; rpc.close(); } }
    })();
    void done.then(() => readyReject(new Error("This turn has finished.")), readyReject);
    return { done, async steer(text, attachments = []) {
      await ready;
      if (stopped || !accepting || !rpc) throw new Error("This turn has finished. Send the prompt as a new turn.");
      await rpc.request("turn/steer", { threadId, expectedTurnId: turnId,
        input: [...(text ? [{ type: "text", text, text_elements: [] }] : []), ...attachments.map(image => image.mimeType.startsWith("image/")
          ? ({ type: "localImage", path: image.path })
          : ({ type: "text", text: `Attached file: ${image.path}\nRead it with native tools as needed.`, text_elements: [] }))] });
    }, async stop() {
      stopped = true;
      try { if (rpc && threadId && turnId) await rpc.request("turn/interrupt", { threadId, turnId }); }
      finally { finish?.(); rpc?.close(); }
    } };
  },
};

export function codexAccess(mode: string, roots: string[]) {
  return { sandbox: mode === "full-access" ? "danger-full-access" : mode === "read-only" ? "read-only" : "workspace-write",
    approvalPolicy: mode === "full-access" ? "never" : "on-request", approvalsReviewer: mode === "auto" ? "auto_review" : "user",
    sandboxPolicy: mode === "full-access" ? { type: "dangerFullAccess" } : mode === "read-only" ? { type: "readOnly" } : { type: "workspaceWrite", writableRoots: roots, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } };
}

async function answerRequest(rpc: CloudRpc, message: RpcMessage, sink: Parameters<CloudRuntime["run"]>[3]): Promise<void> {
  const params = message.params || {};
  if (message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval") {
    const answer = await sink.approval({ title: message.method.includes("commandExecution") ? "Run this command?" : "Allow these file changes?",
      detail: [params.reason, params.command, params.cwd, params.grantRoot].filter(Boolean).join("\n"),
      command: message.method === "item/commandExecution/requestApproval" && (!params.kind || params.kind === "command") && typeof params.command === "string" && typeof params.cwd === "string" ? { command: params.command, cwd: params.cwd, context: JSON.stringify({ kind: params.kind || "command", environmentId: params.environmentId, additionalPermissions: params.additionalPermissions, networkApprovalContext: params.networkApprovalContext, grantRoot: params.grantRoot }) } : undefined });
    rpc.send({ id: message.id, result: { decision: answer.allow ? "accept" : "decline" } });
  } else if (message.method === "item/permissions/requestApproval") {
    const answer = await sink.approval({ title: "Allow additional access for this turn?", detail: JSON.stringify(params.permissions, null, 2) });
    rpc.send({ id: message.id, result: { permissions: answer.allow ? params.permissions : {}, scope: "turn" } });
  } else if (message.method === "item/tool/requestUserInput") {
    const answer = await sink.approval({ title: "A detail is needed", detail: "", questions: (params.questions || []).map((q: any) => ({ id: q.id, question: q.question, options: (q.options || []).map((option: any) => option.label) })) });
    rpc.send({ id: message.id, result: { answers: Object.fromEntries(Object.entries(answer.answers || {}).map(([key, value]) => [key, { answers: [value] }])) } });
  } else {
    // Unknown requests never auto-approve capabilities added by a newer runtime.
    rpc.send({ id: message.id, error: { code: -32601, message: "This runtime request is not supported by Umbratic." } });
  }
}

export function stopCodexLogin(): void { loginGeneration++; login?.close(); login = undefined; }
