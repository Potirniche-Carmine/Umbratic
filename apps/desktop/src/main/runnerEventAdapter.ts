import { classifyCommandText } from "./policy";
import {
  decodeRunnerEvent,
  type RunnerEvent,
} from "./runnerEventDecoder";
import type {
  BackendUiEvent,
  CommandClass,
  ContextCompressionStrategy,
  ContextContentKind,
  PermissionRequest,
  TaskRecord,
  ToolErrorCode,
  ToolResultStatus,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Recovering compacted context is runner bookkeeping, not workspace activity
// the user asked for, so it never becomes a timeline row.
const internalToolKinds = new Set(["retrieve_context"]);

type ToolRun = {
  commandId: string;
  command: string;
  kind: PermissionRequest["kind"];
  toolKind?: string;
  input: unknown;
  stdout: string[];
  stderr: string[];
  finished: boolean;
};

export type RunnerPermissionEvent = {
  id: string;
  type: string;
  title: string;
};

export type RunnerFailureDetails = {
  category?: string;
  code?: string;
  detail?: string;
};

export type RunnerEventAdapterOptions = {
  task: Pick<TaskRecord, "id" | "reasoningMode" | "worktreePath">;
  emit(event: BackendUiEvent): void;
  onPermission(
    permission: RunnerPermissionEvent,
    safety?: Record<string, unknown>,
  ): Promise<"pending" | "resolved" | "worktree_requested">;
  onDelegated(): void;
  onStepSettled(conversationState: unknown): void;
  onFinish(): void;
  onFailure(message: string, details?: RunnerFailureDetails): void;
  onInvalid(input: { message: string; code: string; type?: string }): void;
  onQueueUpdated?(event: Extract<RunnerEvent, { type: "run.queue.updated" }>): void;
};

function eventAt(event: RunnerEvent): string | undefined {
  return event.at;
}

function eventEndedAt(event: RunnerEvent): string | undefined {
  return event.endedAt;
}

export class RunnerEventAdapter {
  readonly handle = (value: unknown): void => {
    const decoded = decodeRunnerEvent(value);
    if (!decoded.ok) {
      this.options.onInvalid({
        message: decoded.message,
        code: decoded.code,
        type: decoded.type,
      });
      return;
    }
    if (decoded.ignored) return;
    const event = decoded.event;
    if (event.taskId !== this.options.task.id) return;

    switch (event.type) {
      case "assistant.delta":
        this.emitAssistant(event.text, eventAt(event), eventEndedAt(event));
        return;
      case "assistant.progress.delta":
        this.emitProgress(event.text, eventAt(event), eventEndedAt(event));
        return;
      case "tool.requested":
        this.handleToolRequested(event);
        return;
      case "tool.policy.stage":
        this.options.emit({
          type: "tool.policy.stage",
          taskId: this.options.task.id,
          toolCallId: event.toolCallId,
          stage: event.stage,
          outcome: event.outcome,
          ...(event.reason ? { reason: event.reason } : {}),
          at: eventAt(event),
        });
        return;
      case "skill.requested":
        this.options.emit({
          type: "skill.requested",
          taskId: this.options.task.id,
          sessionId: event.sessionId,
          runId: event.runId,
          requestId: event.requestId,
          skillId: event.skillId,
          source: event.source,
          origin: event.origin,
          at: eventAt(event),
        });
        return;
      case "skill.loaded":
        this.options.emit({
          type: "skill.loaded",
          taskId: this.options.task.id,
          sessionId: event.sessionId,
          runId: event.runId,
          requestId: event.requestId,
          skillId: event.skillId,
          source: event.source,
          origin: event.origin,
          contentHash: event.contentHash,
          bytes: event.bytes,
          at: eventAt(event),
        });
        return;
      case "skill.failed":
        this.options.emit({
          type: "skill.failed",
          taskId: this.options.task.id,
          sessionId: event.sessionId,
          runId: event.runId,
          requestId: event.requestId,
          skillId: event.skillId,
          source: event.source,
          origin: event.origin,
          code: event.code,
          message: event.message,
          at: eventAt(event),
        });
        return;
      case "command.safety.decision":
        this.latestCommandSafety = event;
        return;
      case "tool.output":
        this.handleToolOutput(event);
        return;
      case "tool.finished":
        this.handleToolFinished(event);
        return;
      case "context.compressed":
        this.handleContextCompressed(event);
        return;
      case "context.usage":
        this.handleContextUsage(event);
        return;
      case "context.retrieved":
        this.options.emit({
          type: "context.retrieved",
          taskId: this.options.task.id,
          toolCallId: event.toolCallId,
          hash: event.hash,
          offset: event.offset,
          bytesShown: event.bytesShown,
          totalBytes: event.totalBytes,
          at: eventAt(event),
        });
        return;
      case "permission.requested":
        this.handlePermission(event);
        return;
      case "runner.error":
        this.pendingFailure = {
          message: event.message.trim() || "Umbratic runner failed.",
          details: {
            ...(event.category
              ? { category: event.category.slice(0, 80) }
              : {}),
            ...(event.code ? { code: event.code.slice(0, 120) } : {}),
            ...(event.detail ? { detail: event.detail.slice(0, 1000) } : {}),
          },
        };
        return;
      case "step.settled":
        this.options.onStepSettled(event.conversationState);
        return;
      case "run.settled":
        this.finishOpenToolRuns();
        if (
          event.outcome === "completed"
          || event.outcome === "model_gave_up"
          || event.outcome === "safety_limit"
        ) {
          this.options.emit({
            type: "turn.outcome",
            taskId: this.options.task.id,
            outcome: event.outcome,
            at: eventAt(event),
          });
          this.options.onFinish();
          return;
        }
        {
          const pending = this.pendingFailure;
          this.pendingFailure = undefined;
          this.options.onFailure(
            pending?.message
              ?? (event.errorCode
                ? `Runner run settled with ${event.outcome} (${event.errorCode}).`
                : `Runner run settled with ${event.outcome}.`),
            pending?.details ?? (event.errorCode ? { code: event.errorCode } : undefined),
          );
        }
        return;
      case "run.queue.updated":
        this.options.onQueueUpdated?.(event);
        return;
    }
  };

  private readonly toolRuns = new Map<string, ToolRun>();
  private readonly internalToolCallIds = new Set<string>();
  private readonly options: RunnerEventAdapterOptions;
  private latestCommandSafety: Record<string, unknown> | undefined;
  private pendingFailure:
    | { message: string; details?: RunnerFailureDetails }
    | undefined;

  constructor(options: RunnerEventAdapterOptions) {
    this.options = options;
  }

  failStream(message: string): void {
    this.options.onFailure(message);
  }

  private emitAssistant(text: string, at?: string, endedAt?: string): void {
    if (!text || text.trim() === "Ready for review.") return;
    this.options.emit({
      type: "assistant.delta",
      taskId: this.options.task.id,
      text,
      at,
      endedAt,
    });
  }

  private emitProgress(text: string, at?: string, endedAt?: string): void {
    if (!text) return;
    this.options.emit({
      type: "assistant.progress.delta",
      taskId: this.options.task.id,
      text,
      at,
      endedAt,
    });
  }

  private ensureToolRun(
    toolCallId: string,
    command: string,
    kind: PermissionRequest["kind"],
    commandClass: CommandClass,
    toolKind?: string,
    input?: unknown,
  ): ToolRun {
    const existing = this.toolRuns.get(toolCallId);
    if (existing) {
      if (toolKind && !existing.toolKind) existing.toolKind = toolKind;
      if (input !== undefined) existing.input = input;
      return existing;
    }
    const current: ToolRun = {
      commandId: `ar-${toolCallId}`,
      command,
      kind,
      toolKind,
      input: input ?? {},
      stdout: [],
      stderr: [],
      finished: false,
    };
    this.toolRuns.set(toolCallId, current);
    this.options.emit({
      type: "command.started",
      taskId: this.options.task.id,
      id: current.commandId,
      command,
      cwd: this.options.task.worktreePath,
      kind,
      commandClass,
      toolKind,
      input,
    });
    return current;
  }

  private handleToolRequested(
    event: Extract<RunnerEvent, { type: "tool.requested" }>,
  ): void {
    if (internalToolKinds.has(event.toolKind)) {
      this.internalToolCallIds.add(event.toolCallId);
      return;
    }
    const toolKind = event.toolKind;
    const command = event.summary?.trim() || toolKind;
    const kind: PermissionRequest["kind"] =
      toolKind === "command" || toolKind === "run_program"
        ? "bash"
        : toolKind === "read"
            || toolKind === "ls" || toolKind === "find" || toolKind === "grep"
            || toolKind === "read_skill"
          ? "read"
          : "edit";
    const fallbackClass =
      kind === "bash"
        ? classifyCommandText(command, this.options.task.worktreePath)
            .commandClass
        : kind;
    const commandClass = event.commandClass
      ? (event.commandClass as CommandClass)
      : fallbackClass;
    this.ensureToolRun(
      event.toolCallId,
      command,
      kind,
      commandClass,
      toolKind,
      event.arguments,
    );
  }

  private handleToolOutput(
    event: Extract<RunnerEvent, { type: "tool.output" }>,
  ): void {
    if (this.internalToolCallIds.has(event.toolCallId)) return;
    const current = this.ensureToolRun(
      event.toolCallId,
      event.toolCallId,
      "bash",
      "shell",
    );
    if (!event.text) return;
    current[event.stream] = [
      `${current[event.stream].join("")}${event.text}`.slice(-16_384),
    ];
    this.options.emit({
      type: "command.output",
      taskId: this.options.task.id,
      id: current.commandId,
      stream: event.stream,
      text: event.text.slice(0, 16_384),
      at: eventAt(event),
      endedAt: eventEndedAt(event),
    });
  }

  private handleToolFinished(
    event: Extract<RunnerEvent, { type: "tool.finished" }>,
  ): void {
    if (this.internalToolCallIds.delete(event.toolCallId)) return;
    const current = this.ensureToolRun(
      event.toolCallId,
      event.toolCallId,
      "bash",
      "shell",
    );
    if (current.finished) return;
    current.finished = true;
    const status = event.status as ToolResultStatus | undefined;
    const errorCode = event.errorCode as ToolErrorCode | undefined;
    this.options.emit({
      type: "command.finished",
      taskId: this.options.task.id,
      id: current.commandId,
      exitCode: event.exitCode,
      ...(status ? { status } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(event.errorMessage
        ? { errorMessage: event.errorMessage.slice(0, 1000) }
        : {}),
      ...(event.durationMs !== undefined
        ? { durationMs: event.durationMs }
        : {}),
      ...(isRecord(event.details) ? { details: event.details } : {}),
      ...(isRecord(event.continuation) ? { continuation: event.continuation } : {}),
      at: eventAt(event),
    });
    if (event.exitCode === 0 && (!status || status === "success")) return;
    this.options.emit({
      type: "tool.failed",
      taskId: this.options.task.id,
      id: current.commandId,
      toolKind: current.toolKind ?? "tool",
      input: current.input,
      response: {
        stdout: current.stdout.join(""),
        stderr: current.stderr.join(""),
        ...(event.response ? { toolResponse: event.response } : {}),
        exitCode: event.exitCode,
        ...(status ? { status } : {}),
        ...(errorCode ? { errorCode } : {}),
        ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
      },
      ...(isRecord(event.details) ? { details: event.details } : {}),
      at: eventAt(event),
    });
  }

  private handleContextCompressed(
    event: Extract<RunnerEvent, { type: "context.compressed" }>,
  ): void {
    this.options.emit({
      type: "context.compressed",
      taskId: this.options.task.id,
      toolCallId: event.toolCallId,
      toolKind: event.toolKind,
      kind: event.kind as ContextContentKind,
      strategy: event.strategy as ContextCompressionStrategy,
      ...(event.hash ? { hash: event.hash } : {}),
      originalBytes: event.originalBytes,
      outputBytes: event.outputBytes,
      at: eventAt(event),
    });
  }

  private handleContextUsage(
    event: Extract<RunnerEvent, { type: "context.usage" }>,
  ): void {
    if (
      event.promptTokens !== undefined
      && event.promptTokens !== event.contentTokens
    ) {
      return;
    }
    this.options.emit({
      type: "context.usage",
      taskId: this.options.task.id,
      contextLength: event.contextLength,
      contentTokens: event.contentTokens,
      ...(event.promptTokens !== undefined
        ? { promptTokens: event.promptTokens }
        : {}),
      ...(event.completionTokens !== undefined
        ? { completionTokens: event.completionTokens }
        : {}),
      reserveTokens: event.reserveTokens,
      estimatedTokens: event.contentTokens + event.reserveTokens,
      ...(event.phase === "preflight" || event.phase === "observed"
        ? { phase: event.phase }
        : {}),
      ...(event.source === "heuristic" || event.source === "provider"
        ? { source: event.source }
        : {}),
      ...(event.confidence === "low" || event.confidence === "high"
        ? { confidence: event.confidence }
        : {}),
      at: eventAt(event),
    });
  }

  private handlePermission(
    event: Extract<RunnerEvent, { type: "permission.requested" }>,
  ): void {
    const safety = this.latestCommandSafety;
    this.latestCommandSafety = undefined;
    void this.options
      .onPermission(
        {
          id: event.permissionId,
          type: event.permissionKind,
          title: event.summary,
        },
        safety,
      )
      .then((result) => {
        if (result !== "worktree_requested") return;
        this.options.onDelegated();
        this.options.onFinish();
      })
      .catch((error) =>
        this.options.onFailure(
          String(error instanceof Error ? error.message : error),
        ),
      );
  }

  private finishOpenToolRuns(): void {
    for (const current of this.toolRuns.values()) {
      if (current.finished) continue;
      current.finished = true;
      this.options.emit({
        type: "command.finished",
        taskId: this.options.task.id,
        id: current.commandId,
        exitCode: 0,
      });
    }
  }
}
