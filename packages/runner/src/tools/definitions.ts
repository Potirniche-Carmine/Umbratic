import { nowIso } from "../events.js";
import { classifyCommandText, redactCommandText } from "../policy.js";
import type { RetrievedContextWindow } from "../context/sessionContextStore.js";
import { commandTool } from "./command.js";
import { editTool, prepareEditIntent } from "./edit.js";
import { readTool } from "./read.js";
import { readSkillTool } from "./readSkill.js";
import { searchTool } from "./search.js";
import { writeTool } from "./write.js";
import { resolveWorkspacePath, toolError, type ToolResult } from "./common.js";
import { executionResult } from "./results.js";
import { parseToolArguments, validateObjectArguments } from "./schema.js";
import type { ToolDefinition, ToolInvocation } from "./types.js";
import { validateWorkspaceGraphArgs } from "../workspaceGraph/tool.js";

type Args = Record<string, unknown>;

function quote(value: string): string {
  return /\s|["']/.test(value) ? JSON.stringify(value) : value;
}

function filePath(input: Args): string {
  return typeof input.filePath === "string" ? input.filePath : typeof input.path === "string" ? input.path : "";
}

function validate(name: string, raw: unknown, allowed: readonly string[], requiredStrings: readonly string[], options: { emptyStrings?: readonly string[]; numbers?: readonly string[] } = {}): Args {
  return validateObjectArguments(name, raw, { allowed, requiredStrings, ...options });
}

function textResult(result: ToolResult, details?: unknown) {
  return executionResult(result, details);
}

function numberArgument(input: Args, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function retrievalOutput(window: RetrievedContextWindow): string {
  const endOffset = window.offset + window.bytesShown;
  return [
    `Retrieved context ${window.entry.hash}`,
    `Kind: ${window.entry.kind}`,
    `Strategy: ${window.entry.strategy}`,
    `Bytes shown: ${window.offset}-${endOffset} of ${window.entry.originalBytes}`,
    ...(window.entry.originalTruncated ? [`Stored bytes: ${window.totalBytes}; original exceeded the per-session storage cap.`] : []),
    ...(window.nextOffset !== undefined ? [`Next offset: ${window.nextOffset}`] : []),
    "",
    window.content,
  ].join("\n");
}

function retrieveContext(invocation: ToolInvocation<Args>) {
  const hash = (invocation.arguments.hash as string).trim();
  const store = invocation.context.contextStore;
  if (!store) throw toolError("validation_error", "invalid_arguments", "No session context store is available.");
  const window = store.retrieve(hash, { offset: numberArgument(invocation.arguments, "offset"), limit: numberArgument(invocation.arguments, "limit") });
  if (!window) throw toolError("validation_error", "invalid_arguments", `No stored context found for hash ${hash}.`);
  invocation.emit({
    type: "context.retrieved",
    taskId: invocation.context.taskId,
    toolCallId: invocation.call.id,
    hash: window.entry.hash,
    offset: window.offset,
    bytesShown: window.bytesShown,
    totalBytes: window.entry.originalBytes,
    at: nowIso(),
  });
  return textResult({ title: hash, output: retrievalOutput(window), status: "success", exitCode: 0 });
}

function editValidator(raw: unknown): Args {
  const input = validate("edit", raw, ["mode", "filePath", "oldText", "newText", "patch"], [], { emptyStrings: ["newText"] });
  const mode = input.mode ?? "replace";
  if (mode !== "replace" && mode !== "patch") throw toolError("validation_error", "invalid_arguments", "edit mode must be replace or patch");
  if (mode === "patch") return validate("edit", input, ["mode", "filePath", "oldText", "newText", "patch"], ["patch"]);
  return validate("edit", input, ["mode", "filePath", "oldText", "newText", "patch"], ["filePath", "oldText", "newText"], { emptyStrings: ["newText"] });
}

export const toolDefinitions: readonly ToolDefinition<Args>[] = [
  {
    name: { name: "read" }, label: "Read", exposure: "direct", executionMode: "parallel", risk: "read",
    description: "Read a workspace file, or list a workspace directory. Directory listings include completion metadata; for complete folder overviews, read \".\" with depth 2 or 3 and continue with offset only when the listing says partial. /workspace/... aliases are accepted.",
    parameters: { type: "object", properties: { filePath: { type: "string" }, offset: { type: "number" }, limit: { type: "number" }, depth: { type: "number" } }, required: ["filePath"] },
    prepareArguments: parseToolArguments,
    validateArguments: (raw) => validate("read", raw, ["filePath", "offset", "limit", "depth"], ["filePath"], { numbers: ["offset", "limit", "depth"] }),
    createIntent: ({ arguments: input, context }) => { const resolved = resolveWorkspacePath(context.cwd, filePath(input)); return { risk: "read", summary: `read ${quote(resolved.relative || ".")}`, affectedPaths: [resolved.relative] }; },
    execute: async (invocation) => textResult(await readTool(invocation.context, invocation.arguments)),
  },
  {
    name: { name: "write" }, label: "Write", exposure: "direct", executionMode: "exclusive", risk: "write",
    description: "Write a workspace file after permission.",
    parameters: { type: "object", properties: { filePath: { type: "string" }, content: { type: "string" } }, required: ["filePath", "content"] },
    prepareArguments: parseToolArguments,
    validateArguments: (raw) => validate("write", raw, ["filePath", "content"], ["filePath", "content"], { emptyStrings: ["content"] }),
    createIntent: ({ arguments: input, context }) => { const resolved = resolveWorkspacePath(context.cwd, filePath(input)); return { risk: "write", summary: `write ${resolved.relative}`, affectedPaths: [resolved.relative] }; },
    execute: async (invocation) => textResult(await writeTool(invocation.context, invocation.arguments), { changedFiles: [filePath(invocation.arguments)] }),
  },
  {
    name: { name: "edit" }, label: "Edit", exposure: "direct", executionMode: "exclusive", risk: "write",
    description: "Replace exact text in one workspace file after permission. Call with one valid JSON object containing filePath, oldText, and newText; oldText must exactly occur in the file. Read the file first when exact text is not already available.",
    parameters: { type: "object", properties: { filePath: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["filePath", "oldText", "newText"] },
    prepareArguments: parseToolArguments,
    validateArguments: editValidator,
    createIntent: ({ arguments: input, context }) => ({ risk: "write", ...prepareEditIntent(context, input) }),
    execute: async (invocation) => textResult(await editTool(invocation.context, invocation.arguments)),
  },
  {
    name: { name: "search" }, label: "Search", exposure: "direct", executionMode: "parallel", risk: "read",
    description: "Search workspace file paths and small text-file contents before reading exact files. This finds path/content matches, not a complete directory inventory.",
    parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    prepareArguments: parseToolArguments,
    validateArguments: (raw) => validate("search", raw, ["query", "limit"], ["query"], { numbers: ["limit"] }),
    createIntent: ({ arguments: input }) => ({ risk: "read", summary: `search ${quote(input.query as string)}` }),
    execute: async (invocation) => textResult(await searchTool(invocation.context, invocation.arguments)),
  },
  {
    name: { name: "workspace_graph" }, label: "Workspace graph", exposure: "direct", executionMode: "parallel", risk: "read",
    description: "Query bounded, source-backed workspace graph evidence for architecture and change impact. Actions: summary, query, explain, path, affected. Graph evidence may be stale or incomplete; verify exact code with read before editing.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["summary", "query", "explain", "path", "affected"] },
        query: { type: "string" }, symbol: { type: "string" }, from: { type: "string" }, to: { type: "string" },
        files: { type: "array", items: { type: "string" } }, symbols: { type: "array", items: { type: "string" } },
        depth: { type: "number" }, limit: { type: "number" }, maxDepth: { type: "number" },
        direction: { type: "string", enum: ["incoming", "outgoing", "both"] },
      },
      required: ["action"],
    },
    prepareArguments: parseToolArguments,
    validateArguments: validateWorkspaceGraphArgs,
    createIntent: ({ arguments: input }) => ({ risk: "read", summary: `workspace_graph ${input.action}` }),
    execute: async (invocation) => {
      if (!invocation.context.workspaceGraph) throw toolError("validation_error", "tool_disabled", "Workspace graph is not configured for this session.");
      const result = invocation.context.workspaceGraph.query(invocation.arguments as never);
      return textResult({ title: `workspace_graph ${invocation.arguments.action}`, output: JSON.stringify(result), status: "success", exitCode: 0 }, result);
    },
  },
  {
    name: { name: "command" }, label: "Command", exposure: "direct", executionMode: "exclusive", risk: "command",
    description: "Run a local workspace shell command after policy and permission checks. On Windows the shell is PowerShell, so use PowerShell syntax directly and do not nest powershell -Command. Prefer uv run python or a workspace .venv interpreter when available. Bare python, python3, and py are allowed; if a bare interpreter command fails because of interpreter, environment, or dependency issues, retry it with uv. Use timeoutMs only when a command legitimately needs a non-default timeout.",
    parameters: { type: "object", properties: { command: { type: "string" }, timeoutMs: { type: "number" } }, required: ["command"] },
    prepareArguments: parseToolArguments,
    validateArguments: (raw) => validate("command", raw, ["command", "timeoutMs"], ["command"], { numbers: ["timeoutMs"] }),
    createIntent: ({ arguments: input, context }) => {
      const command = input.command as string;
      const classification = classifyCommandText(command, context.cwd);
      const blocked = classification.commandClass === "network" || classification.commandClass === "external-directory";
      return { risk: "command", summary: redactCommandText(command), commandClass: classification.commandClass, risky: classification.risky, ...(blocked ? { denyReason: `Command blocked by policy: ${classification.reason ?? classification.commandClass}` } : {}) };
    },
    execute: async (invocation) => textResult(await commandTool(invocation.context, invocation.arguments, invocation.call.id)),
  },
  {
    name: { name: "read_skill" }, label: "Read skill", exposure: "internal", executionMode: "parallel", risk: "internal",
    description: "Read the complete instructions for one enabled skill before applying it. Read SKILL.md first; if Next offset is reported, continue until Read status is complete. Use resource only for files explicitly referenced by SKILL.md.",
    parameters: { type: "object", properties: { skillId: { type: "string" }, resource: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["skillId"] },
    prepareArguments: parseToolArguments,
    validateArguments: (raw) => validate("read_skill", raw, ["skillId", "resource", "offset", "limit"], ["skillId"], { numbers: ["offset", "limit"] }),
    createIntent: ({ arguments: input }) => ({ risk: "internal", summary: `read_skill ${quote(input.skillId as string)}` }),
    execute: async (invocation) => textResult(readSkillTool(invocation.context, invocation.arguments)),
  },
  {
    name: { name: "retrieve_context" }, label: "Retrieve context", exposure: "internal", executionMode: "parallel", risk: "internal",
    description: "Retrieve a bounded window of exact local tool output previously compacted behind an umbratic-context marker. Use only when exact omitted output is necessary.",
    parameters: { type: "object", properties: { hash: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["hash"] },
    prepareArguments: parseToolArguments,
    validateArguments: (raw) => validate("retrieve_context", raw, ["hash", "offset", "limit"], ["hash"], { numbers: ["offset", "limit"] }),
    createIntent: ({ arguments: input }) => ({ risk: "internal", summary: `retrieve_context ${quote(input.hash as string)}` }),
    execute: async (invocation) => retrieveContext(invocation),
  },
] as const;
