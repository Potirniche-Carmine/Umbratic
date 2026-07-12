import { nowIso, type ToolPolicyStage, type UmbraticRunnerEvent } from "../events.js";
import { classifyCommandText, redactText } from "../policy.js";
import { toolError, toolFailureDetails } from "./common.js";
import { ToolOrchestrator } from "./orchestrator.js";
import { noToolHooks, type ToolHooks } from "./hooks.js";
import { TerminalOutcomeGuard } from "./lifecycle.js";
import { failedExecutionResult } from "./results.js";
import { parseToolArguments } from "./schema.js";
import { canonicalToolNameString, type ToolCall, type ToolDefinition, type ToolExecutionResult, type ToolRuntimeContext } from "./types.js";

type DispatchOptions = { queueWaitMs?: number; planFingerprint?: string };

function displayName(call: ToolCall): string {
  return canonicalToolNameString(call.name);
}

function quote(value: string): string {
  return /\s|["']/.test(value) ? JSON.stringify(value) : value;
}

function invocationSummary(name: string, raw: unknown): string {
  let input: Record<string, unknown> = {};
  try { input = parseToolArguments(raw); } catch { return name; }
  if (name === "read") {
    const path = typeof input.filePath === "string" ? input.filePath : "";
    const offset = typeof input.offset === "number" ? ` --offset ${Math.floor(input.offset)}` : "";
    const limit = typeof input.limit === "number" ? ` --limit ${Math.floor(input.limit)}` : "";
    const depth = typeof input.depth === "number" ? ` --depth ${Math.floor(input.depth)}` : "";
    return `read ${quote(path)}${offset}${limit}${depth}`.trim();
  }
  if (name === "search") return `search ${quote(typeof input.query === "string" ? input.query : "")}`.trim();
  if (name === "read_skill") return `read_skill ${quote(typeof input.skillId === "string" ? input.skillId : "")}`.trim();
  if (name === "retrieve_context") return `retrieve_context ${quote(typeof input.hash === "string" ? input.hash : "")}`.trim();
  if (name === "edit" && input.mode === "patch") return "edit patch";
  if (name === "write" || name === "edit") return `${name} ${quote(typeof input.filePath === "string" ? input.filePath : "")}`.trim();
  if (name === "command" && typeof input.command === "string") return input.command;
  return name;
}

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition<any>>();
  private readonly knownDefinitions = new Map<string, ToolDefinition<any>>();
  private readonly knownNames: ReadonlySet<string>;
  private readonly orchestrator: ToolOrchestrator;
  private readonly hooks: ToolHooks;

  constructor(definitions: readonly ToolDefinition<any>[], options: { knownNames?: ReadonlySet<string>; knownDefinitions?: readonly ToolDefinition<any>[]; orchestrator?: ToolOrchestrator; hooks?: ToolHooks } = {}) {
    for (const definition of definitions) {
      const name = canonicalToolNameString(definition.name).toLowerCase();
      if (this.definitions.has(name)) throw new Error(`Duplicate tool definition: ${name}`);
      this.definitions.set(name, definition);
    }
    for (const definition of options.knownDefinitions ?? definitions) {
      this.knownDefinitions.set(canonicalToolNameString(definition.name).toLowerCase(), definition);
    }
    this.knownNames = options.knownNames ?? new Set(this.definitions.keys());
    this.orchestrator = options.orchestrator ?? new ToolOrchestrator();
    this.hooks = options.hooks ?? noToolHooks;
  }

  get(name: string): ToolDefinition<any> | undefined {
    return this.definitions.get(name.toLowerCase());
  }

  list(): readonly ToolDefinition<any>[] {
    return [...this.definitions.values()];
  }

  async dispatch(context: ToolRuntimeContext, emit: (event: UmbraticRunnerEvent) => void, call: ToolCall, options: DispatchOptions = {}): Promise<ToolExecutionResult> {
    const requestedAt = nowIso();
    const startedMs = Date.now();
    const name = displayName(call);
    const terminal = new TerminalOutcomeGuard();
    const definition = this.get(name);
    const validationDefinition = definition ?? this.knownDefinitions.get(name.toLowerCase());
    const rawSummary = invocationSummary(name, call.payload.arguments);
    let normalized = false;
    const emitStage = (stage: ToolPolicyStage, outcome: "started" | "passed" | "blocked" | "skipped", summary?: string, code?: ToolExecutionResult["error"] extends infer E ? any : never) => {
      emit({ type: "tool.policy.stage", taskId: context.taskId, toolCallId: call.id, stage, outcome, ...(summary ? { summary: redactText(summary, 320) } : {}), ...(code ? { code } : {}), at: nowIso() });
    };
    const finish = (result: ToolExecutionResult) => {
      const finishedAt = nowIso();
      terminal.run(() => emit({
        type: "tool.finished", taskId: context.taskId, toolCallId: call.id,
        exitCode: result.exitCode ?? (result.status === "success" ? 0 : 1), status: result.status,
        ...(result.error ? { errorCode: result.error.code, errorMessage: redactText(result.error.message, 320) } : {}),
        startedAt: requestedAt, finishedAt, durationMs: Math.max(0, Date.now() - startedMs), at: finishedAt,
      }));
    };

    const fallbackClass = validationDefinition?.risk === "read" || validationDefinition?.risk === "internal" ? "read" : validationDefinition?.risk === "write" ? "edit" : "unknown";
    emit({
      type: "tool.requested", taskId: context.taskId, toolCallId: call.id, toolKind: name,
      commandClass: name.toLowerCase() === "command" && typeof call.payload.arguments === "object" && typeof call.payload.arguments.command === "string"
        ? classifyCommandText(call.payload.arguments.command, context.cwd).commandClass : fallbackClass,
      summary: redactText(rawSummary || name, 320), cwd: context.cwd, at: requestedAt,
    });
    emit({ type: "tool.started", taskId: context.taskId, toolCallId: call.id, toolKind: name, ...(options.queueWaitMs !== undefined ? { queueWaitMs: options.queueWaitMs } : {}), ...(options.planFingerprint ? { planFingerprint: options.planFingerprint } : {}), at: nowIso() });

    try {
      emitStage("normalize_tool_call", "started");
      if (call.payload.kind !== "function") throw new Error(`Unsupported tool payload kind for ${name}`);
      if (!validationDefinition) throw toolError("validation_error", "unknown_tool", `Unknown tool: ${name}`);
      const prepared = validationDefinition.prepareArguments ? validationDefinition.prepareArguments(call.payload.arguments) : call.payload.arguments;
      let args = validationDefinition.validateArguments(prepared);
      emitStage("normalize_tool_call", "passed");
      normalized = true;
      if (!definition) {
        emitStage("resolve_workspace_paths", "skipped", "tool is not present in this turn plan");
        emitStage("classify_action", "passed", validationDefinition.risk);
        emitStage("apply_static_deny_rules", "blocked", `Tool "${name}" is disabled`, "tool_disabled");
        throw toolError("validation_error", "tool_disabled", `Tool "${name}" is disabled by the current tool plan.`);
      }
      const rewritten = await this.hooks.beforeExecution?.({ definition, call, arguments: args });
      if (rewritten !== undefined) args = definition.validateArguments(rewritten);

      let intent;
      try {
        intent = await definition.createIntent({ call, arguments: args, context, signal: context.signal, emit });
        emitStage("resolve_workspace_paths", definition.risk === "command" ? "skipped" : "passed", intent.summary);
      } catch (error) {
        const failure = toolFailureDetails(error);
        emitStage("resolve_workspace_paths", "blocked", failure.message, failure.errorCode);
        throw error;
      }
      emitStage("classify_action", "passed", intent.commandClass ?? intent.risk);
      if (intent.denyReason) emitStage("apply_static_deny_rules", "blocked", intent.denyReason, "policy_blocked");
      else emitStage("apply_static_deny_rules", "passed");
      emitStage("request_permission", intent.denyReason || intent.risk === "read" || intent.risk === "internal" ? "skipped" : "started", intent.summary);
      emitStage("execute_backend", "started");
      let result = await this.orchestrator.execute(
        definition,
        { call, arguments: args, context, signal: context.signal, emit },
        intent,
        { permissionResolved: (outcome, summary) => emitStage("request_permission", outcome, summary ?? intent.summary, outcome === "blocked" ? "permission_denied" : undefined) },
      );
      const replacementContent = await this.hooks.afterExecution?.({ definition, call, arguments: args, result });
      if (replacementContent) result = { ...result, content: replacementContent };
      emitStage("execute_backend", result.status === "success" ? "passed" : "blocked", result.error?.message, result.error?.code);
      if (definition.risk !== "command" && definition.risk !== "internal") {
        const output = result.content.map((part) => part.text).join("\n");
        if (output) context.emitToolOutput(call.id, "stdout", `${output}\n`);
      }
      emitStage("redact_and_summarize_output", "passed", result.title);
      finish(result);
      emitStage("emit_audit_telemetry", "passed", result.status);
      return result;
    } catch (error) {
      const result = failedExecutionResult(error, definition?.label ?? name);
      const failure = toolFailureDetails(error);
      if (!normalized) emitStage("normalize_tool_call", "blocked", failure.message, failure.errorCode);
      emitStage("execute_backend", "blocked", failure.message, failure.errorCode);
      finish(result);
      emitStage("emit_audit_telemetry", "passed", result.status);
      return result;
    }
  }
}
