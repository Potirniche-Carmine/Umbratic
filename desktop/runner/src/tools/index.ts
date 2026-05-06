import { nowIso, type AegisRunnerEvent } from "../events.js";
import { classifyCommandText, redactText } from "../policy.js";
import { commandTool } from "./command.js";
import { editTool } from "./edit.js";
import { readTool } from "./read.js";
import { searchTool } from "./search.js";
import { writeTool } from "./write.js";
import type { ToolContext, ToolResult } from "./common.js";

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
      description: "Run a local shell command in the workspace after policy and permission checks.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
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

export async function runTool(ctx: ToolContext, emit: (event: AegisRunnerEvent) => void, toolCall: { id: string; name: string; arguments: unknown }): Promise<ToolResult> {
  const input = parseArguments(toolCall.arguments);
  const commandSummary = toolCall.name === "command" && typeof input.command === "string" ? input.command : toolCall.name;
  const classification = toolCall.name === "command" && typeof input.command === "string" ? classifyCommandText(input.command, ctx.cwd) : { commandClass: "edit" as const, risky: false };
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
    (() => { throw new Error(`Unknown tool: ${toolCall.name}`); })();
  emit({ type: "tool.finished", taskId: ctx.taskId, toolCallId: toolCall.id, exitCode: 0, at: nowIso() });
  return result;
}
