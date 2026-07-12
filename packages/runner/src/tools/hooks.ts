import type { ToolCall, ToolContent, ToolDefinition, ToolExecutionResult } from "./types.js";

export type ToolHookContext<TArgs = unknown> = { definition: ToolDefinition<any>; call: ToolCall; arguments: TArgs };

export type ToolHooks = {
  beforeExecution?: (context: ToolHookContext) => unknown | void | Promise<unknown | void>;
  afterExecution?: (context: ToolHookContext & { result: ToolExecutionResult }) => ToolContent[] | void | Promise<ToolContent[] | void>;
};

export const noToolHooks: ToolHooks = Object.freeze({});
