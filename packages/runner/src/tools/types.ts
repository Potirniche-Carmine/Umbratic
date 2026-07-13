import type { RunnerSkillConfig, RunnerToolName } from "../config.js";
import type { SessionContextStore } from "../context/sessionContextStore.js";
import type { UmbraticRunnerEvent } from "../events.js";
import type { CommandClass } from "../policy.js";
import type { ToolErrorCode, ToolResultStatus } from "./common.js";
import type { WorkspaceGraphService } from "../workspaceGraph/service.js";

export type JsonSchema = Record<string, unknown>;

export type ToolName = Readonly<{ namespace?: string; name: string }>;

export type ToolExposure = "direct" | "internal" | "deferred";
export type ToolExecutionMode = "parallel" | "exclusive";
export type ToolRisk = "read" | "write" | "command" | "internal";

export type ToolCall = Readonly<{
  id: string;
  name: ToolName;
  payload: { kind: "function"; arguments: string | Record<string, unknown> };
  index: number;
  providerMetadata?: unknown;
}>;

export type ToolContent = { type: "text"; text: string };

export type ToolExecutionResult<TDetails = unknown> = {
  title: string;
  status: ToolResultStatus;
  content: ToolContent[];
  details?: TDetails;
  error?: { code: ToolErrorCode; message: string; repairable: boolean };
  exitCode?: number | null;
  terminate?: boolean;
};

export type ToolRuntimeContext = {
  taskId: string;
  cwd: string;
  permissionMode: "normal" | "bypass";
  enabledTools: readonly RunnerToolName[];
  skills?: readonly RunnerSkillConfig[];
  contextStore?: SessionContextStore;
  workspaceGraph?: WorkspaceGraphService;
  signal: AbortSignal;
  askPermission(input: { permissionKind: string; summary: string; autoAllow: boolean }): Promise<"allow" | "deny">;
  emitToolOutput(toolCallId: string, stream: "stdout" | "stderr", text: string): void;
};

export type ToolIntent = {
  risk: ToolRisk;
  summary: string;
  affectedPaths?: string[];
  commandClass?: CommandClass;
  risky?: boolean;
  denyReason?: string;
};

export type ToolInvocation<TArgs> = {
  call: ToolCall;
  arguments: TArgs;
  context: ToolRuntimeContext;
  signal: AbortSignal;
  emit: (event: UmbraticRunnerEvent) => void;
};

export type ToolDefinition<TArgs = Record<string, unknown>, TDetails = unknown> = {
  name: ToolName;
  label: string;
  description: string;
  parameters: JsonSchema;
  exposure: ToolExposure;
  executionMode: ToolExecutionMode;
  risk: ToolRisk;
  prepareArguments?: (raw: unknown) => unknown;
  validateArguments: (raw: unknown) => TArgs;
  createIntent: (invocation: ToolInvocation<TArgs>) => ToolIntent | Promise<ToolIntent>;
  execute: (invocation: ToolInvocation<TArgs>) => Promise<ToolExecutionResult<TDetails>>;
};

export type ModelToolSpec = {
  type: "function";
  function: { name: string; description?: string; parameters: JsonSchema };
};

export function canonicalToolNameString(name: ToolName): string {
  return name.namespace ? `${name.namespace}__${name.name}` : name.name;
}

export function toolNameFromProvider(value: string): ToolName {
  const separator = value.indexOf("__");
  if (separator > 0 && separator < value.length - 2) {
    return { namespace: value.slice(0, separator), name: value.slice(separator + 2) };
  }
  return { name: value };
}
