import { nowIso, type ToolPolicyStage, type UmbraticRunnerEvent } from "../events.js";
import { classifyCommandText, redactText } from "../policy.js";
import { commandTool } from "./command.js";
import { editTool } from "./edit.js";
import { readTool } from "./read.js";
import { searchTool } from "./search.js";
import { writeTool } from "./write.js";
import { toolError, toolFailureDetails, type ToolContext, type ToolResult } from "./common.js";
import { isRunnerToolName, type RunnerToolName } from "../config.js";
import type { RetrievedContextWindow } from "../context/sessionContextStore.js";

function quoteToolArg(value: string): string {
  return /\s|["']/.test(value) ? JSON.stringify(value) : value;
}

function toolInvocationSummary(name: string, input: Record<string, unknown>): string {
  if (name === "read") {
    const filePath = typeof input.filePath === "string" ? input.filePath : typeof input.path === "string" ? input.path : "";
    const offset = typeof input.offset === "number" ? ` --offset ${Math.floor(input.offset)}` : "";
    const limit = typeof input.limit === "number" ? ` --limit ${Math.floor(input.limit)}` : "";
    const depth = typeof input.depth === "number" ? ` --depth ${Math.floor(input.depth)}` : "";
    return `read ${quoteToolArg(filePath)}${offset}${limit}${depth}`.trim();
  }
  if (name === "search") {
    const query = typeof input.query === "string" ? quoteToolArg(input.query) : "";
    const limit = typeof input.limit === "number" ? ` --limit ${Math.floor(input.limit)}` : "";
    return `search ${query}${limit}`.trim();
  }
  if (name === "retrieve_context") {
    const hash = typeof input.hash === "string" ? input.hash : "";
    const offset = typeof input.offset === "number" ? ` --offset ${Math.floor(input.offset)}` : "";
    const limit = typeof input.limit === "number" ? ` --limit ${Math.floor(input.limit)}` : "";
    return `retrieve_context ${quoteToolArg(hash)}${offset}${limit}`.trim();
  }
  if (name === "write" || name === "edit") {
    const filePath = typeof input.filePath === "string" ? input.filePath : "";
    if (name === "edit" && input.mode === "patch") return "edit patch";
    return `${name} ${quoteToolArg(filePath)}`.trim();
  }
  return name;
}

function toolCommandClass(name: string): ReturnType<typeof classifyCommandText>["commandClass"] {
  if (name === "retrieve_context") return "read";
  if (name === "read" || name === "search") return "read";
  if (name === "write" || name === "edit") return "edit";
  return "unknown";
}

type ModelToolSpec = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

export const toolSpecs: ModelToolSpec[] = [
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a workspace file, or list a workspace directory. Directory listings include completion metadata; for complete folder overviews, read \".\" with depth 2 or 3 and continue with offset only when the listing says partial. /workspace/... aliases are accepted.",
      parameters: { type: "object", properties: { filePath: { type: "string" }, offset: { type: "number" }, limit: { type: "number" }, depth: { type: "number" } }, required: ["filePath"] },
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description: "Write a workspace file after permission.",
      parameters: { type: "object", properties: { filePath: { type: "string" }, content: { type: "string" } }, required: ["filePath", "content"] },
    },
  },
  {
    type: "function",
    function: {
      name: "edit",
      description: "Edit workspace files after permission. Use mode replace for one exact replacement, or mode patch for a strict multi-file patch using *** Begin Patch / *** Add File / *** Update File / *** Delete File / *** End Patch.",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["replace", "patch"], default: "replace" },
          filePath: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" },
          patch: { type: "string" },
        },
        required: ["mode"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description: "Search workspace file paths and small text-file contents before reading exact files. This finds path/content matches, not a complete directory inventory.",
      parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "command",
      description: "Run a local workspace shell command after policy and permission checks. Use it for tests, builds, and Git operations such as status, diff, branch, restore, reset, and worktree commands when the user asks.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  },
];

function internalToolSpecs(): ModelToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: "retrieve_context",
        description: "Retrieve a bounded window of exact local tool output previously compacted behind an umbratic-context marker. Use only when exact omitted output is necessary.",
        parameters: {
          type: "object",
          properties: {
            hash: { type: "string" },
            offset: { type: "number" },
            limit: { type: "number" },
          },
          required: ["hash"],
        },
      },
    },
  ];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSchemaType(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value;
  return value.find((entry) => typeof entry === "string" && entry !== "null") ?? value.find((entry) => typeof entry === "string");
}

function normalizeJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJsonSchema);
  if (!isPlainRecord(value)) return value;

  const normalized: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === "oneOf" || key === "anyOf" || key === "allOf") continue;
    if (key === "additionalProperties" && typeof raw === "boolean") continue;
    if (key === "required") {
      normalized.required = Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : [];
      continue;
    }
    if (key === "type") {
      const type = normalizeSchemaType(raw);
      if (typeof type === "string") normalized.type = type;
      continue;
    }
    normalized[key] = normalizeJsonSchema(raw);
  }

  if (normalized.type === undefined) {
    if (isPlainRecord(normalized.properties)) {
      normalized.type = "object";
    } else if (normalized.items !== undefined) {
      normalized.type = "array";
    } else if (Array.isArray(normalized.enum)) {
      const enumValue = normalized.enum.find((entry) => entry !== null && entry !== undefined);
      if (typeof enumValue === "string") normalized.type = "string";
      if (typeof enumValue === "number") normalized.type = "number";
      if (typeof enumValue === "boolean") normalized.type = "boolean";
    }
  }

  if (normalized.type === "object" && !Array.isArray(normalized.required)) {
    normalized.required = [];
  }

  return normalized;
}

export function normalizeModelToolSpec(spec: ModelToolSpec): ModelToolSpec {
  return {
    type: "function",
    function: {
      name: spec.function.name,
      ...(spec.function.description ? { description: spec.function.description } : {}),
      parameters: normalizeJsonSchema(spec.function.parameters) as Record<string, unknown>,
    },
  };
}

export function enabledToolSpecs(enabledTools: readonly RunnerToolName[]) {
  const enabled = new Set(enabledTools);
  return toolSpecs.filter((spec) => enabled.has(spec.function.name as RunnerToolName));
}

export function enabledModelToolSpecs(
  enabledTools: readonly RunnerToolName[],
  options: { includeContextRetrieval?: boolean } = {},
) {
  const specs = [
    ...enabledToolSpecs(enabledTools),
    ...(options.includeContextRetrieval ? internalToolSpecs() : []),
  ];
  return specs.map((spec) => normalizeModelToolSpec(spec));
}

export function schemaHasAdapterHostileShapes(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(schemaHasAdapterHostileShapes);
  if (!isPlainRecord(value)) return false;
  if (Array.isArray(value.type)) return true;
  if (typeof value.additionalProperties === "boolean") return true;
  if ("oneOf" in value || "anyOf" in value || "allOf" in value) return true;
  if (isPlainRecord(value.properties) && typeof value.type !== "string") return true;
  return Object.values(value).some(schemaHasAdapterHostileShapes);
}

function staticCommandDenyReason(classification: ReturnType<typeof classifyCommandText>): string | null {
  if (classification.commandClass === "network" || classification.commandClass === "external-directory") {
    return `Command blocked by policy: ${classification.reason ?? classification.commandClass}`;
  }
  if (classification.commandClass === "python-runtime" && classification.risky) {
    return "Bare python commands are blocked; use uv or a workspace virtual environment.";
  }
  return null;
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") throw toolError("validation_error", "invalid_arguments", "Tool arguments must be a JSON object.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw toolError("validation_error", "invalid_arguments", "Tool arguments must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw toolError("validation_error", "invalid_arguments", "Tool arguments must decode to a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function numberArgument(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function retrievalOutput(window: RetrievedContextWindow): string {
  const endOffset = window.offset + window.bytesShown;
  const lines = [
    `Retrieved context ${window.entry.hash}`,
    `Kind: ${window.entry.kind}`,
    `Strategy: ${window.entry.strategy}`,
    `Bytes shown: ${window.offset}-${endOffset} of ${window.entry.originalBytes}`,
    ...(window.entry.originalTruncated ? [`Stored bytes: ${window.totalBytes}; original exceeded the per-session storage cap.`] : []),
    ...(window.nextOffset !== undefined ? [`Next offset: ${window.nextOffset}`] : []),
    "",
    window.content,
  ];
  return lines.join("\n");
}

function retrieveContextTool(ctx: ToolContext, input: Record<string, unknown>, toolCallId: string, emit: (event: UmbraticRunnerEvent) => void): ToolResult {
  const hash = typeof input.hash === "string" ? input.hash.trim() : "";
  if (!hash) throw toolError("validation_error", "invalid_arguments", "retrieve_context requires hash");
  if (!ctx.contextStore) {
    throw toolError("validation_error", "invalid_arguments", "No session context store is available.");
  }
  const window = ctx.contextStore.retrieve(hash, {
    offset: numberArgument(input, "offset"),
    limit: numberArgument(input, "limit"),
  });
  if (!window) {
    throw toolError("validation_error", "invalid_arguments", `No stored context found for hash ${hash}.`);
  }
  emit({
    type: "context.retrieved",
    taskId: ctx.taskId,
    toolCallId,
    hash: window.entry.hash,
    offset: window.offset,
    bytesShown: window.bytesShown,
    totalBytes: window.entry.originalBytes,
    at: nowIso(),
  });
  return {
    title: hash,
    output: retrievalOutput(window),
    status: "success",
    exitCode: 0,
  };
}

export async function runTool(ctx: ToolContext, emit: (event: UmbraticRunnerEvent) => void, toolCall: { id: string; name: string; arguments: unknown }): Promise<ToolResult> {
  const startedAt = nowIso();
  const startedMs = Date.now();
  const emitStage = (
    stage: ToolPolicyStage,
    outcome: "started" | "passed" | "blocked" | "skipped",
    summary?: string,
    code?: ToolResult["errorCode"],
  ) => {
    emit({
      type: "tool.policy.stage",
      taskId: ctx.taskId,
      toolCallId: toolCall.id,
      stage,
      outcome,
      ...(summary ? { summary: redactText(summary, 320) } : {}),
      ...(code ? { code } : {}),
      at: nowIso(),
    });
  };
  let input: Record<string, unknown> = {};
  let argumentError: unknown;
  emitStage("normalize_tool_call", "started");
  try {
    input = parseArguments(toolCall.arguments);
  } catch (error) {
    argumentError = error;
  }
  if (argumentError) {
    const failure = toolFailureDetails(argumentError);
    emitStage("normalize_tool_call", "blocked", failure.message, failure.errorCode);
  } else {
    emitStage("normalize_tool_call", "passed");
  }
  const commandSummary =
    argumentError ? toolCall.name :
    toolCall.name === "command" && typeof input.command === "string" ? input.command :
    toolInvocationSummary(toolCall.name, input);
  const classification =
    toolCall.name === "command" && typeof input.command === "string" ? classifyCommandText(input.command, ctx.cwd) :
    { commandClass: toolCommandClass(toolCall.name), risky: false };
  emit({
    type: "tool.requested",
    taskId: ctx.taskId,
    toolCallId: toolCall.id,
    toolKind: toolCall.name,
    commandClass: classification.commandClass,
    summary: redactText(commandSummary, 320),
    cwd: ctx.cwd,
    at: startedAt,
  });
  emitStage(
    "resolve_workspace_paths",
    toolCall.name === "command" || argumentError ? "skipped" : "passed",
    toolCall.name === "command" ? "command policy does not resolve a file path" : commandSummary,
  );
  emitStage("classify_action", "passed", classification.commandClass);

  const finish = (result: Pick<ToolResult, "status" | "errorCode" | "errorMessage" | "exitCode">) => {
    const finishedAt = nowIso();
    emit({
      type: "tool.finished",
      taskId: ctx.taskId,
      toolCallId: toolCall.id,
      exitCode: result.exitCode ?? (result.status === "success" ? 0 : 1),
      status: result.status,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      ...(result.errorMessage ? { errorMessage: redactText(result.errorMessage, 320) } : {}),
      startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.now() - startedMs),
      at: finishedAt,
    });
  };

  try {
    if (argumentError) throw argumentError;
    if (toolCall.name === "retrieve_context") {
      emitStage("apply_static_deny_rules", "passed", "internal context retrieval");
      emitStage("request_permission", "skipped", "internal read-only context retrieval");
      emitStage("execute_backend", "started");
      const result = retrieveContextTool(ctx, input, toolCall.id, emit);
      emitStage("execute_backend", "passed");
      emitStage("redact_and_summarize_output", "passed", result.title);
      finish(result);
      emitStage("emit_audit_telemetry", "passed", result.status);
      return result;
    }
    if (!isRunnerToolName(toolCall.name)) {
      emitStage("apply_static_deny_rules", "blocked", `Unknown tool: ${toolCall.name}`, "unknown_tool");
      throw toolError("validation_error", "unknown_tool", `Unknown tool: ${toolCall.name}`);
    }
    if (!ctx.enabledTools.includes(toolCall.name)) {
      emitStage("apply_static_deny_rules", "blocked", `Tool "${toolCall.name}" is disabled`, "tool_disabled");
      throw toolError("validation_error", "tool_disabled", `Tool "${toolCall.name}" is disabled by the current tool settings.`);
    }
    if (toolCall.name === "command") {
      const deny = staticCommandDenyReason(classification);
      if (deny) {
        emitStage("apply_static_deny_rules", "blocked", deny, "policy_blocked");
        throw toolError("policy_blocked", "policy_blocked", deny);
      }
    }
    emitStage("apply_static_deny_rules", "passed");
    emitStage(
      "request_permission",
      toolCall.name === "read" || toolCall.name === "search" ? "skipped" : "started",
      toolCall.name === "read" || toolCall.name === "search" ? "read-only tool" : commandSummary,
    );
    emitStage("execute_backend", "started");
    const result =
      toolCall.name === "read" ? await readTool(ctx, input) :
      toolCall.name === "write" ? await writeTool(ctx, input) :
      toolCall.name === "edit" ? await editTool(ctx, input) :
      toolCall.name === "search" ? await searchTool(ctx, input) :
      toolCall.name === "command" ? await commandTool(ctx, input, toolCall.id) :
      (() => { throw toolError("validation_error", "unknown_tool", `Unknown tool: ${toolCall.name}`); })();
    emitStage("execute_backend", "passed");
    if (toolCall.name !== "command" && result.output) {
      ctx.emitToolOutput(toolCall.id, "stdout", `${result.output}\n`);
    }
    emitStage("redact_and_summarize_output", "passed", result.title);
    finish(result);
    emitStage("emit_audit_telemetry", "passed", result.status);
    return result;
  } catch (error) {
    const failure = toolFailureDetails(error);
    emitStage("execute_backend", "blocked", failure.message, failure.errorCode);
    finish({ status: failure.status, errorCode: failure.errorCode, errorMessage: failure.message, exitCode: 1 });
    emitStage("emit_audit_telemetry", "passed", failure.status);
    throw error;
  }
}
