import type { CommandClass } from "./policy.js";
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
  | { type: "session.idle"; taskId: string; sessionId: string; at: string }
  | { type: "runner.error"; taskId: string; category: string; code?: string; message: string; detail?: string; at: string };

export function nowIso(): string {
  return new Date().toISOString();
}
