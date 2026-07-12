import { nowIso, toolFailureRepairable, type UmbraticRunnerEvent } from "../events.js";
import { compressToolResult } from "../context/contentRouter.js";
import type { SessionContextStore } from "../context/sessionContextStore.js";
import { redactText } from "../policy.js";
import { toolFailureDetails, type ToolResult } from "./common.js";
import type { ToolExecutionResult } from "./types.js";

export function executionResult(result: ToolResult, details?: unknown): ToolExecutionResult {
  return {
    title: result.title,
    status: result.status,
    content: [{ type: "text", text: result.output }],
    ...(details !== undefined ? { details } : {}),
    ...(result.errorCode && result.errorMessage ? {
      error: { code: result.errorCode, message: result.errorMessage, repairable: toolFailureRepairable(result.status, result.errorCode) },
    } : {}),
    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
  };
}

export function failedExecutionResult(error: unknown, title: string): ToolExecutionResult {
  const failure = toolFailureDetails(error);
  return {
    title,
    status: failure.status,
    content: [{ type: "text", text: redactText(`Tool failed: ${failure.message}`) }],
    error: { code: failure.errorCode, message: failure.message, repairable: toolFailureRepairable(failure.status, failure.errorCode) },
    exitCode: 1,
  };
}

export function executionResultText(result: ToolExecutionResult): string {
  return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

export function legacyToolResult(result: ToolExecutionResult): ToolResult {
  return {
    title: result.title,
    output: executionResultText(result),
    status: result.status,
    ...(result.error ? { errorCode: result.error.code, errorMessage: result.error.message } : {}),
    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
  };
}

export function finalizeToolExecution(input: {
  taskId: string;
  toolName: string;
  toolCallId: string;
  result: ToolExecutionResult;
  contextStore: SessionContextStore;
  emit: (event: UmbraticRunnerEvent) => void;
}) {
  const legacy = legacyToolResult(input.result);
  const compressed = compressToolResult({
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    title: legacy.title,
    output: legacy.output,
    status: legacy.status,
    contextStore: input.contextStore,
  });
  if (compressed.modified) {
    input.emit({
      type: "context.compressed", taskId: input.taskId, toolCallId: input.toolCallId, toolKind: input.toolName,
      kind: compressed.kind, strategy: compressed.strategy, ...(compressed.markerHash ? { hash: compressed.markerHash } : {}),
      originalBytes: compressed.originalBytes, outputBytes: compressed.outputBytes, at: nowIso(),
    });
  }
  return { legacy, modelOutput: compressed.output, details: input.result.details };
}
