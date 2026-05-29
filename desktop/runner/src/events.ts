import type { CommandClass } from "./policy.js";

export type UmbraticRunnerEvent =
  | { type: "assistant.delta"; taskId: string; text: string; at: string }
  | { type: "assistant.reasoning.delta"; taskId: string; text: string; at: string }
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
    }
  | { type: "tool.finished"; taskId: string; toolCallId: string; exitCode: number | null; at: string }
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
  | { type: "runner.error"; taskId: string; category: string; message: string; at: string };

export function nowIso(): string {
  return new Date().toISOString();
}
