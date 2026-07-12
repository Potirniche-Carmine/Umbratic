import type { CommandClass } from "./policy.js";
import type { ContextCompressionStrategy, ContextContentKind } from "./context/types.js";
import type { ToolErrorCode, ToolResultStatus } from "./tools/common.js";

export type ToolPolicyStage =
  | "normalize_tool_call"
  | "resolve_workspace_paths"
  | "classify_action"
  | "apply_static_deny_rules"
  | "request_permission"
  | "execute_backend"
  | "redact_and_summarize_output"
  | "emit_audit_telemetry";

export type AttemptRecord = {
  attempt: number;
  phase: "stream" | "tool-parse" | "tool-validate" | "permission" | "execute";
  code: ToolErrorCode | "model_error";
  repairable: boolean;
  toolId?: string;
  redactedSummary: string;
};

export type RunnerTurnSummary = {
  status: "completed";
  turns: number;
  assistantTextChars: number;
  reasoningTextChars: number;
  toolCalls: number;
  failedToolCalls: number;
  attempts: AttemptRecord[];
  lastToolFailure?: {
    toolKind: string;
    status: ToolResultStatus;
    errorCode?: ToolErrorCode;
    message: string;
  };
};

export function toolFailureRepairable(status: ToolResultStatus, code?: ToolErrorCode): boolean {
  if (status === "permission_denied" || status === "policy_blocked") return false;
  return code === "unknown_tool" || code === "invalid_arguments" || code === "missing_dependency";
}

export type UmbraticRunnerEvent =
  | { type: "assistant.delta"; taskId: string; text: string; at: string; endedAt?: string }
  | { type: "assistant.reasoning.delta"; taskId: string; text: string; at: string; endedAt?: string }
  | {
      type: "tool.requested";
      taskId: string;
      toolCallId: string;
      toolKind: string;
      commandClass: CommandClass;
      summary: string;
      cwd: string;
      at: string;
    }
  | {
      type: "tool.started";
      taskId: string;
      toolCallId: string;
      toolKind: string;
      queueWaitMs?: number;
      planFingerprint?: string;
      at: string;
    }
  | {
      type: "tool.output";
      taskId: string;
      toolCallId: string;
      stream: "stdout" | "stderr";
      text: string;
      redacted: boolean;
      at: string;
      endedAt?: string;
    }
  | {
      type: "tool.execution.update";
      taskId: string;
      toolCallId: string;
      stream?: "stdout" | "stderr";
      text: string;
      at: string;
    }
  | {
      type: "tool.policy.stage";
      taskId: string;
      toolCallId: string;
      stage: ToolPolicyStage;
      outcome: "started" | "passed" | "blocked" | "skipped";
      summary?: string;
      code?: ToolErrorCode;
      at: string;
    }
  | {
      type: "tool.finished";
      taskId: string;
      toolCallId: string;
      exitCode: number | null;
      status?: ToolResultStatus;
      errorCode?: ToolErrorCode;
      errorMessage?: string;
      startedAt?: string;
      finishedAt?: string;
      durationMs?: number;
      at: string;
    }
  | {
      type: "context.compressed";
      taskId: string;
      toolCallId: string;
      toolKind: string;
      kind: ContextContentKind;
      strategy: ContextCompressionStrategy;
      hash?: string;
      originalBytes: number;
      outputBytes: number;
      at: string;
    }
  | {
      type: "context.retrieved";
      taskId: string;
      toolCallId: string;
      hash: string;
      offset: number;
      bytesShown: number;
      totalBytes: number;
      at: string;
    }
  | {
      type: "permission.requested";
      taskId: string;
      permissionId: string;
      permissionKind: string;
      summary: string;
      at: string;
    }
  | {
      type: "permission.resolved";
      taskId: string;
      permissionId: string;
      decision: "allow" | "deny";
      at: string;
    }
  | { type: "session.idle"; taskId: string; sessionId: string; summary?: RunnerTurnSummary; at: string }
  | { type: "runner.error"; taskId: string; category: string; code?: string; message: string; detail?: string; at: string };

export function nowIso(): string {
  return new Date().toISOString();
}
