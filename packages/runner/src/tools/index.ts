import { nowIso, type ToolPolicyStage, type UmbraticRunnerEvent } from "../events.js";
import { classifyCommandText, redactText } from "../policy.js";
import { commandTool } from "./command.js";
import { editTool } from "./edit.js";
import { readTool } from "./read.js";
import { readSkillTool } from "./readSkill.js";
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
  if (name === "read_skill") {
    const skillId = typeof input.skillId === "string" ? input.skillId : "";
    const resource = typeof input.resource === "string" ? ` ${quoteToolArg(input.resource)}` : "";
    const offset = typeof input.offset === "number" ? ` --offset ${Math.floor(input.offset)}` : "";
    return `read_skill ${quoteToolArg(skillId)}${resource}${offset}`.trim();
  }
  if (name === "write" || name === "edit") {
    const filePath = typeof input.filePath === "string" ? input.filePath : "";
    if (name === "edit" && input.mode === "patch") return "edit patch";
    return `${name} ${quoteToolArg(filePath)}`.trim();
  }
  return name;
}

function toolCommandClass(name: string): ReturnType<typeof classifyCommandText>["commandClass"] {
  if (name === "retrieve_context" || name === "read_skill") return "read";
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
      description: "Edit workspace files after permission. Call with one valid JSON object, never prose or a raw patch. Prefer a focused replacement with filePath, oldText, and newText; oldText must exactly occur in the file. For a strict multi-file patch, set mode to patch and provide a complete patch in patch using *** Begin Patch / *** Add File / *** Update File / *** Delete File / *** End Patch.",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["replace", "patch"], default: "replace" },
          filePath: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" },
          patch: { type: "string" },
        },
        required: [],
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
      description: "Run a local workspace shell command after policy and permission checks. On Windows the shell is PowerShell, so use PowerShell syntax directly and do not nest powershell -Command. Prefer uv run python or a workspace .venv interpreter when available. Bare python, python3, and py are allowed; if a bare interpreter command fails because of interpreter, environment, or dependency issues, retry it with uv. Use timeoutMs only when a command legitimately needs a non-default timeout.",
      parameters: { type: "object", properties: { command: { type: "string" }, timeoutMs: { type: "number" } }, required: ["command"] },
    },
  },
];

function internalToolSpecs(options: { includeContextRetrieval?: boolean; includeSkillReader?: boolean }): ModelToolSpec[] {
  const specs: ModelToolSpec[] = [];
  if (options.includeSkillReader) {
    specs.push({
      type: "function" as const,
      function: {
        name: "read_skill",
        description: "Read the complete instructions for one enabled skill before applying it. Read SKILL.md first; if Next offset is reported, continue until Read status is complete. Use resource only for files explicitly referenced by SKILL.md.",
        parameters: {
          type: "object",
          properties: {
            skillId: { type: "string" },
            resource: { type: "string" },
            offset: { type: "number" },
            limit: { type: "number" },
          },
          required: ["skillId"],
        },
      },
    });
  }
  if (options.includeContextRetrieval) {
    specs.push({
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
    });
  }
  return specs;
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
  options: { includeContextRetrieval?: boolean; includeSkillReader?: boolean } = {},
) {
  const specs = [
    ...enabledToolSpecs(enabledTools),
    ...internalToolSpecs(options),
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
  return null;
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") throw toolError("validation_error", "invalid_arguments", "Tool arguments must be a JSON object.");
  const normalized = value.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized) as unknown;
  } catch {
    throw toolError("validation_error", "invalid_arguments", "Tool arguments must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw toolError("validation_error", "invalid_arguments", "Tool arguments must decode to a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function validateToolArguments(name: string, input: Record<string, unknown>): void {
  const allowed: Record<string, readonly string[]> = {
    read: ["filePath", "offset", "limit", "depth"],
    write: ["filePath", "content"],
    edit: ["mode", "filePath", "oldText", "newText", "patch"],
    search: ["query", "limit"],
    command: ["command", "timeoutMs"],
    read_skill: ["skillId", "resource", "offset", "limit"],
    retrieve_context: ["hash", "offset", "limit"],
  };
  const keys = allowed[name];
  if (!keys) return;
  const unknown = Object.keys(input).find((key) => !keys.includes(key));
  if (unknown) throw toolError("validation_error", "invalid_arguments", `${name} does not accept argument ${unknown}`);
  const requireString = (key: string, allowEmpty = false) => {
    if (typeof input[key] !== "string" || (!allowEmpty && !(input[key] as string).trim())) {
      throw toolError("validation_error", "invalid_arguments", `${name} requires string argument ${key}`);
    }
  };
  if (name === "read") requireString("filePath");
  if (name === "write") { requireString("filePath"); requireString("content", true); }
  if (name === "search") requireString("query");
  if (name === "command") requireString("command");
  if (name === "read_skill") requireString("skillId");
  if (name === "retrieve_context") requireString("hash");
  if (name === "edit") {
    const mode = input.mode ?? "replace";
    if (mode !== "replace" && mode !== "patch") throw toolError("validation_error", "invalid_arguments", "edit mode must be replace or patch");
    if (mode === "patch") requireString("patch");
    else { requireString("filePath"); requireString("oldText"); requireString("newText", true); }
  }
  for (const key of ["offset", "limit", "depth", "timeoutMs"]) {
    if (input[key] !== undefined && (typeof input[key] !== "number" || !Number.isFinite(input[key]) || (input[key] as number) < 0)) {
      throw toolError("validation_error", "invalid_arguments", `${name} argument ${key} must be a non-negative number`);
    }
  }
}

export function canonicalToolName(name: string): string {
  const normalized = name.toLowerCase();
  return isRunnerToolName(normalized) || normalized === "read_skill" || normalized === "retrieve_context"
    ? normalized
    : name;
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
  const toolName = canonicalToolName(toolCall.name);
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
    validateToolArguments(toolName, input);
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
    argumentError ? toolName :
    toolName === "command" && typeof input.command === "string" ? input.command :
    toolInvocationSummary(toolName, input);
  const classification =
    toolName === "command" && typeof input.command === "string" ? classifyCommandText(input.command, ctx.cwd) :
    { commandClass: toolCommandClass(toolName), risky: false };
  emit({
    type: "tool.requested",
    taskId: ctx.taskId,
    toolCallId: toolCall.id,
    toolKind: toolName,
    commandClass: classification.commandClass,
    summary: redactText(commandSummary, 320),
    cwd: ctx.cwd,
    at: startedAt,
  });
  emitStage(
    "resolve_workspace_paths",
    toolName === "command" || argumentError ? "skipped" : "passed",
    toolName === "command" ? "command policy does not resolve a file path" : commandSummary,
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
    if (toolName === "retrieve_context" || toolName === "read_skill") {
      const internalLabel = toolName === "read_skill" ? "enabled skill read" : "internal context retrieval";
      emitStage("apply_static_deny_rules", "passed", internalLabel);
      emitStage("request_permission", "skipped", `internal read-only ${internalLabel}`);
      emitStage("execute_backend", "started");
      const result = toolName === "read_skill" ? readSkillTool(ctx, input) : retrieveContextTool(ctx, input, toolCall.id, emit);
      emitStage("execute_backend", "passed");
      emitStage("redact_and_summarize_output", "passed", result.title);
      finish(result);
      emitStage("emit_audit_telemetry", "passed", result.status);
      return result;
    }
    if (!isRunnerToolName(toolName)) {
      emitStage("apply_static_deny_rules", "blocked", `Unknown tool: ${toolCall.name}`, "unknown_tool");
      throw toolError("validation_error", "unknown_tool", `Unknown tool: ${toolCall.name}`);
    }
    if (!ctx.enabledTools.includes(toolName)) {
      emitStage("apply_static_deny_rules", "blocked", `Tool "${toolName}" is disabled`, "tool_disabled");
      throw toolError("validation_error", "tool_disabled", `Tool "${toolName}" is disabled by the current tool settings.`);
    }
    if (toolName === "command") {
      const deny = staticCommandDenyReason(classification);
      if (deny) {
        emitStage("apply_static_deny_rules", "blocked", deny, "policy_blocked");
        throw toolError("policy_blocked", "policy_blocked", deny);
      }
    }
    emitStage("apply_static_deny_rules", "passed");
    emitStage(
      "request_permission",
      toolName === "read" || toolName === "search" ? "skipped" : "started",
      toolName === "read" || toolName === "search" ? "read-only tool" : commandSummary,
    );
    emitStage("execute_backend", "started");
    const result =
      toolName === "read" ? await readTool(ctx, input) :
      toolName === "write" ? await writeTool(ctx, input) :
      toolName === "edit" ? await editTool(ctx, input) :
      toolName === "search" ? await searchTool(ctx, input) :
      toolName === "command" ? await commandTool(ctx, input, toolCall.id) :
      (() => { throw toolError("validation_error", "unknown_tool", `Unknown tool: ${toolName}`); })();
    emitStage("execute_backend", "passed");
    if (toolName !== "command" && result.output) {
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
