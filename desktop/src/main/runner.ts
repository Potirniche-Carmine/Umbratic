import type { CommandClass, LocalModelInfo, TaskRecord } from "./types";

export type RunnerHandle = {
  taskId: string;
};

export type AegisRunnerEvent =
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
  | { type: "runner.error"; taskId: string; category: string; message: string; at: string };

export interface AegisRunner {
  start(task: TaskRecord, model: LocalModelInfo, models: LocalModelInfo[]): Promise<RunnerHandle>;
  sendPrompt(handle: RunnerHandle, prompt: string): Promise<void>;
  replyPermission(handle: RunnerHandle, permissionId: string, allow: boolean): Promise<void>;
  abort(handle: RunnerHandle): void;
  events(handle: RunnerHandle): AsyncIterable<AegisRunnerEvent>;
}
