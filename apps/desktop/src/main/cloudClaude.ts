import { claudeUsage, claudeModelLabel, optionalRuntimeRead, planLabel } from "./cloudUsage";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { AccountInfo, AgentDefinition, ModelInfo, Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import type { CloudConnection, CloudSettings } from "../shared/cloud";
import { cloudEnvironment, cloudWorkflowInstructions, enabledCloudRoles, roleInstructions, validateCloudConnection } from "./cloudPolicy";
import type { CloudRuntime, CloudRuntimeSink } from "./cloudRuntimeTypes";
import { CloudRuntimeMissing } from "./cloudInstall";

export function claudeExecutable(configured: string): string {
  if (configured) {
    if (!path.isAbsolute(configured) || !fs.existsSync(configured)) throw new Error("Choose an existing, absolute path to the official Claude Code executable.");
    return configured;
  }
  const platform = process.platform === "win32" ? "win32" : process.platform;
  const suffix = platform === "linux" && process.report?.getReport && !(process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime ? "-musl" : "";
  const packageName = `@anthropic-ai/claude-agent-sdk-${platform}-${process.arch}${suffix}`;
  try { return require.resolve(`${packageName}/${platform === "win32" ? "claude.exe" : "claude"}`).replace(/app\.asar([/\\])/, "app.asar.unpacked$1"); }
  catch {
    const binary = platform === "win32" ? "claude.exe" : "claude";
    const candidates = [path.join(os.homedir(), ".local", "bin", binary), ...String(process.env.PATH || "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, binary))];
    const found = candidates.find(candidate => { try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch { return false; } });
    if (found) return found;
    throw new CloudRuntimeMissing("Claude Code is not installed.");
  }
}

class PromptGate {
  private resolve!: (value: SDKUserMessage["message"]["content"] | undefined) => void;
  private next = new Promise<SDKUserMessage["message"]["content"] | undefined>(resolve => { this.resolve = resolve; });
  send(text: SDKUserMessage["message"]["content"]): void { this.resolve(text); }
  close(): void { this.resolve(undefined); }
  async *messages(): AsyncGenerator<SDKUserMessage> {
    const text = await this.next;
    if (text !== undefined) yield { type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: text } };
  }
}

export type ClaudeAuthStatus = { loggedIn?: boolean; authMethod?: string; apiProvider?: string; apiKeySource?: string; subscriptionType?: string; email?: string };
async function authStatus(settings: CloudSettings, cwd: string): Promise<ClaudeAuthStatus> {
  return new Promise((resolve, reject) => {
    execFile(claudeExecutable(settings.providers.claude.executable), ["--setting-sources", "", "auth", "status", "--json"],
      { cwd, env: cloudEnvironment(), timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true }, (_error, stdout) => {
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Claude Code could not verify its authentication method. Update the runtime and reconnect.")); }
      });
  });
}

export function claudeConnection(account: AccountInfo, models: ModelInfo[], version?: string, auth?: ClaudeAuthStatus): CloudConnection {
  const common = { provider: "claude" as const, version, models: [] };
  if (!auth?.loggedIn) return { ...common, state: "sign_in", message: "Connect your Claude account." };
  // An account label alone does not establish the active billing route.
  if (auth.authMethod !== "claude.ai" || auth.apiProvider !== "firstParty" || !account.subscriptionType ||
      (account.apiProvider && account.apiProvider !== "firstParty") ||
      (auth.apiKeySource && auth.apiKeySource !== "none") ||
      (account.apiKeySource && account.apiKeySource !== "none")) {
    return { ...common, state: "unsupported_account", message: "Claude Code is not using a Claude subscription. Sign in with your Claude plan; API and gateway accounts are not used here." };
  }
  const unique = new Map<string, CloudConnection["models"][number]>();
  for (const model of models) {
    const id = model.resolvedModel || model.value;
    // Availability belongs to the signed-in runtime, not a family allowlist.
    unique.set(id, { id, label: claudeModelLabel(id, model.displayName), efforts: model.supportedEffortLevels || [] });
  }
  return { ...common, state: "ready", models: [...unique.values()], accountEmail: account.email || auth.email, planName: planLabel(account.subscriptionType), account: `${account.email || auth.email || "Claude"} · ${account.subscriptionType}`,
    message: "Connected through the official Claude Code runtime." };
}

function options(settings: CloudSettings, cwd: string): Options {
  return { cwd, pathToClaudeCodeExecutable: claudeExecutable(settings.providers.claude.executable), env: cloudEnvironment(),
    settingSources: [], settings: { fastMode: false, autoMemoryEnabled: false }, permissionMode: "default", includePartialMessages: true,
    systemPrompt: { type: "preset", preset: "claude_code", append: cloudWorkflowInstructions(settings, "claude") },
    disallowedTools: ["Skill", ...(settings.subagents ? [] : ["Agent", "Task"])],
  };
}

async function inspect(query: Query, settings: CloudSettings, cwd: string): Promise<CloudConnection> {
  const init = await query.initializationResult();
  const account = await query.accountInfo();
  const connection = claudeConnection(account, await query.supportedModels(), init.claude_code_version, await authStatus(settings, cwd));
  if (connection.state === "ready") {
    const usage = await optionalRuntimeRead(query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }));
    if (usage) connection.usage = claudeUsage(usage);
  }
  return connection;
}

async function readUsageReport(query: Query, gate: PromptGate) {
  gate.send("/usage");
  // /usage is a runtime command: no inference and no changes to the user's
  // conversation. Newer CLIs expose all account meters on this message.
  for await (const message of query) {
    if (message.type === "assistant" && message.usage_report) return claudeUsage(message.usage_report);
    if (message.type === "result") break;
  }
  return undefined;
}

async function standaloneUsage(settings: CloudSettings, cwd: string) {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const gate = new PromptGate();
  const query = sdk.query({ prompt: gate.messages(), options: { ...options(settings, cwd), persistSession: false } });
  try { return await optionalRuntimeRead(readUsageReport(query, gate)); }
  finally { gate.close(); query.close(); }
}

function agentDefinitions(settings: CloudSettings): Record<string, AgentDefinition> {
  return Object.fromEntries(enabledCloudRoles(settings).map(role => {
    const choice = settings.providers.claude.roles[role];
    return [`umbratic_${role}`, { description: roleInstructions[role], prompt: roleInstructions[role], model: choice.model,
      effort: choice.effort === "none" || choice.effort === "minimal" || choice.effort === "ultra" ? undefined : choice.effort,
      ...(role === "research" ? { tools: ["Read", "Grep", "Glob", "WebSearch", "WebFetch"] } : {}),
      background: false,
    }];
  }));
}

let login: ChildProcess | undefined;
export const claudeCloudRuntime: CloudRuntime = {
  async inspect(settings, cwd) {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const gate = new PromptGate();
    const query = sdk.query({ prompt: gate.messages(), options: { ...options(settings, cwd), persistSession: false } });
    try {
      const connection = await inspect(query, settings, cwd);
      if (connection.state === "ready") {
        const report = await optionalRuntimeRead(readUsageReport(query, gate));
        if (report?.limits.length) connection.usage = report;
      }
      return connection;
    } finally { gate.close(); query.close(); }
  },
  async signIn(settings, cwd) {
    login?.kill();
    const child = spawn(claudeExecutable(settings.providers.claude.executable), ["auth", "login"], { cwd, env: cloudEnvironment(), stdio: "ignore", windowsHide: true, shell: false });
    login = child;
    const timer = setTimeout(() => child.kill(), 5 * 60_000);
    child.once("exit", () => { clearTimeout(timer); if (login === child) login = undefined; });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", () => { clearTimeout(timer); reject(new Error("Could not start Claude Code sign-in.")); }); });
    return { message: "Finish connecting in your browser." };
  },
  run(settings, workspace, prompt, sink, images = []) {
    let query: Query | undefined; let stopped = false;
    const gate = new PromptGate();
    const done = (async () => {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      if (stopped) return;
      const config = settings.providers.claude;
      query = sdk.query({ prompt: gate.messages(), options: {
        ...options(settings, workspace.path), additionalDirectories: (workspace.paths || []).filter(root => root !== workspace.path), model: config.orchestrator.model,
        effort: config.orchestrator.effort === "none" || config.orchestrator.effort === "minimal" || config.orchestrator.effort === "ultra" ? undefined : config.orchestrator.effort,
        agents: agentDefinitions(settings), resume: workspace.sessionId, enableFileCheckpointing: true,
        canUseTool: async (tool, input, details) => {
          const questions = tool === "AskUserQuestion" && Array.isArray(input.questions)
            ? input.questions.map((q: any) => ({ id: q.question, question: q.question, options: (q.options || []).map((option: any) => option.label) })) : undefined;
          const answer = await sink.approval({ title: details.title || `Allow ${tool}?`, detail: JSON.stringify(input, null, 2), questions });
          return answer.allow ? { behavior: "allow", updatedInput: questions ? { ...input, answers: answer.answers || {} } : input }
            : { behavior: "deny", message: "The user declined this action." };
        },
      } });
      try {
        const connection = await inspect(query, settings, workspace.path);
        validateCloudConnection(connection, settings);
        if (stopped) return;
        if (workspace.account && workspace.account !== connection.account && workspace.sessionId) throw new Error("The signed-in account changed. Clear context before continuing.");
        if (connection.usage) sink.limits?.(connection.usage);
        gate.send(images.length ? [...(prompt ? [{ type: "text" as const, text: prompt }] : []), ...images.map(image => ({ type: "image" as const,
          source: { type: "base64" as const, media_type: "image/png" as const, data: fs.readFileSync(image.path).toString("base64") } }))] : prompt);
        let resultReceived = false;
        const stream = { messageId: "" };
        for await (const message of query) {
          consumeMessage(message, sink, connection.account || "Claude", stream);
          if (message.type === "result") {
            resultReceived = true;
            const [context, usage] = await Promise.all([
              optionalRuntimeRead(query.getContextUsage({ detail: "summary" })),
              optionalRuntimeRead(query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })),
            ]);
            if (context) sink.usage(context.rawMaxTokens, context.totalTokens);
            const limits = usage && claudeUsage(usage);
            if (limits?.limits.length) sink.limits?.(limits);
            else if (!stopped) {
              const report = await standaloneUsage(settings, workspace.path);
              if (report?.limits.length) sink.limits?.(report);
            }
            if (message.is_error) throw new Error("errors" in message ? message.errors.join("\n") : "Claude could not complete this turn.");
            break;
          }
        }
        if (!resultReceived && !stopped) throw new Error("Claude Code stopped before completing the turn.");
      } finally { gate.close(); query.close(); }
    })();
    return { done, async stop() { stopped = true; gate.close(); try { await query?.interrupt(); } finally { query?.close(); } } };
  },
};

export function consumeClaudeMessage(message: any, sink: CloudRuntimeSink, account: string, stream: { messageId: string }): void {
  // Child contexts have independent compaction budgets and transcripts.
  if (message.parent_tool_use_id) return;
  if (message.type === "system" && message.subtype === "init") sink.session(message.session_id, account);
  if (message.type === "system" && message.subtype === "compact_boundary") sink.compact();
  // Final assistant blocks replace their streamed counterpart instead of
  // duplicating it. Subagent output stays in the parent's native context.
  if (message.type === "stream_event") {
    const event = message.event;
    if (event?.type === "message_start") stream.messageId = event.message?.id || "";
    if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && stream.messageId) sink.text(stream.messageId, event.delta.text, true);
  }
  if (message.type === "assistant") {
    const content = message.message.content || [];
    sink.text(message.message.id, content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n"), false);
    for (const block of content) if (block.type === "tool_use") sink.activity(block.name, { id: block.id, label: block.input?.description || block.name, detail: typeof block.input?.command === "string" ? block.input.command : JSON.stringify(block.input, null, 2).slice(0, 12000), status: "running" });
  }
  if (message.type === "user" && Array.isArray(message.message?.content)) {
    for (const block of message.message.content) if (block.type === "tool_result") sink.activity("Tool finished", { id: block.tool_use_id, label: "Tool finished", status: block.is_error ? "failed" : "completed" });
  }
  if (message.type === "result") {
    const usage = Object.values(message.modelUsage || {}) as { contextWindow: number; inputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }[];
    if (usage.length) sink.usage(usage[0].contextWindow, undefined);
  }
}

const consumeMessage = consumeClaudeMessage;

export function stopClaudeLogin(): void { login?.kill(); login = undefined; }
