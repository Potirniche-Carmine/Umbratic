import { nowIso, type UmbraticRunnerEvent } from "../events.js";
import { classifyCommandText, redactText } from "../policy.js";
import { commandTool } from "./command.js";
import { debuggerTool } from "./debugger.js";
import { editTool } from "./edit.js";
import { readTool } from "./read.js";
import { searchTool } from "./search.js";
import { writeTool } from "./write.js";
import type { ToolContext, ToolResult } from "./common.js";

function quoteToolArg(value: string): string {
  return /\s|["']/.test(value) ? JSON.stringify(value) : value;
}

function toolInvocationSummary(name: string, input: Record<string, unknown>): string {
  if (name === "read") {
    const filePath = typeof input.filePath === "string" ? input.filePath : typeof input.path === "string" ? input.path : "";
    const offset = typeof input.offset === "number" ? ` --offset ${Math.floor(input.offset)}` : "";
    const limit = typeof input.limit === "number" ? ` --limit ${Math.floor(input.limit)}` : "";
    return `read ${quoteToolArg(filePath)}${offset}${limit}`.trim();
  }
  if (name === "search") {
    const query = typeof input.query === "string" ? quoteToolArg(input.query) : "";
    const limit = typeof input.limit === "number" ? ` --limit ${Math.floor(input.limit)}` : "";
    return `search ${query}${limit}`.trim();
  }
  if (name === "write" || name === "edit") {
    const filePath = typeof input.filePath === "string" ? input.filePath : "";
    return `${name} ${quoteToolArg(filePath)}`.trim();
  }
  return name;
}

function toolCommandClass(name: string): ReturnType<typeof classifyCommandText>["commandClass"] {
  if (name === "read" || name === "search") return "read";
  if (name === "write" || name === "edit") return "edit";
  return "unknown";
}

export const toolSpecs = [
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a workspace file or list a workspace directory.",
      parameters: { type: "object", properties: { filePath: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["filePath"] },
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
      description: "Replace exact text in a workspace file after permission.",
      parameters: { type: "object", properties: { filePath: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["filePath", "oldText", "newText"] },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description: "Search workspace file paths and small text files.",
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
  {
    type: "function",
    function: {
      name: "debugger",
      description: "Run a non-interactive debugger pass against a workspace-built executable for crash, memory, pointer, and security analysis.",
      parameters: {
        type: "object",
        properties: {
          executablePath: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          debugger: { type: "string", enum: ["auto", "gdb", "lldb", "cdb"] },
          timeoutMs: { type: "number" },
        },
        required: ["executablePath"],
      },
    },
  },
];

function parseArguments(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function runTool(ctx: ToolContext, emit: (event: UmbraticRunnerEvent) => void, toolCall: { id: string; name: string; arguments: unknown }): Promise<ToolResult> {
  const input = parseArguments(toolCall.arguments);
  const commandSummary =
    toolCall.name === "command" && typeof input.command === "string" ? input.command :
    toolCall.name === "debugger" && typeof input.executablePath === "string" ? `debugger ${input.executablePath}` :
    toolInvocationSummary(toolCall.name, input);
  const classification =
    toolCall.name === "command" && typeof input.command === "string" ? classifyCommandText(input.command, ctx.cwd) :
    toolCall.name === "debugger" ? { commandClass: "debugger" as const, risky: false } :
    { commandClass: toolCommandClass(toolCall.name), risky: false };
  emit({
    type: "tool.requested",
    taskId: ctx.taskId,
    toolCallId: toolCall.id,
    toolKind: toolCall.name,
    commandClass: classification.commandClass,
    summary: redactText(commandSummary, 320),
    cwd: ctx.cwd,
    at: nowIso(),
  });
  const result =
    toolCall.name === "read" ? await readTool(ctx, input) :
    toolCall.name === "write" ? await writeTool(ctx, input) :
    toolCall.name === "edit" ? await editTool(ctx, input) :
    toolCall.name === "search" ? await searchTool(ctx, input) :
    toolCall.name === "command" ? await commandTool(ctx, input, toolCall.id) :
    toolCall.name === "debugger" ? await debuggerTool(ctx, input, toolCall.id) :
    (() => { throw new Error(`Unknown tool: ${toolCall.name}`); })();
  if (toolCall.name !== "command" && result.output) {
    ctx.emitToolOutput(toolCall.id, "stdout", `${result.output}\n`);
  }
  emit({ type: "tool.finished", taskId: ctx.taskId, toolCallId: toolCall.id, exitCode: result.exitCode ?? 0, at: nowIso() });
  return result;
}
