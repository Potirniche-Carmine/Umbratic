import { isContextBreakdown, type BackendContextBreakdown } from "../shared/backendEvents";
import { hasNonNegativeNumber, hasString, isRecord } from "../shared/records";

type RunnerEventBase = {
  taskId: string;
  at?: string;
  endedAt?: string;
};

export type RunnerEvent =
  | (RunnerEventBase & { type: "assistant.delta"; text: string })
  | (RunnerEventBase & { type: "assistant.progress.delta"; text: string; kind?: "thinking" })
  | (RunnerEventBase & {
      type: "tool.requested";
      toolCallId: string;
      toolKind: string;
      summary?: string;
      commandClass?: string;
      arguments?: unknown;
    })
  | (RunnerEventBase & {
      type: "command.safety.decision";
      [key: string]: unknown;
    })
  | (RunnerEventBase & {
      type: "tool.output";
      toolCallId: string;
      stream: "stdout" | "stderr";
      text: string;
    })
  | (RunnerEventBase & {
      type: "tool.finished";
      toolCallId: string;
      exitCode: number | null;
      status?: string;
      errorCode?: string | null;
      errorMessage?: string | null;
      durationMs?: number;
      response?: string | null;
      /// Typed result payload. Consumers read this, never the model-facing text.
      details?: unknown;
      continuation?: unknown;
    })
  | (RunnerEventBase & {
      type: "context.compressed";
      toolCallId: string;
      toolKind: string;
      kind: string;
      strategy: string;
      hash?: string;
      originalBytes: number;
      outputBytes: number;
    })
  | (RunnerEventBase & {
      type: "context.usage";
      contextLength: number;
      contentTokens: number;
      promptTokens?: number;
      completionTokens?: number;
      reserveTokens: number;
      protectedTokens?: number;
      estimatedTokens?: number;
      anchored?: boolean;
      compactionBlocked?: boolean;
      compactionBlockedReason?: "floor" | "failing";
      awaitingMeasurement?: boolean;
      breakdown?: BackendContextBreakdown;
      phase?: unknown;
      source?: unknown;
      confidence?: unknown;
    })
  | (RunnerEventBase & {
      type: "context.compaction";
      phase: "started" | "finished";
      outcome?: "compacted" | "unchanged" | "failed";
      reclaimedTokens?: number;
    })
  | (RunnerEventBase & {
      type: "provider.reconnecting";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
    })
  | (RunnerEventBase & { type: "provider.reconnected"; attempt: number })
  | (RunnerEventBase & { type: "provider.session_rejected" })
  | (RunnerEventBase & {
      type: "context.retrieved";
      toolCallId: string;
      hash: string;
      offset: number;
      bytesShown: number;
      totalBytes: number;
    })
  | (RunnerEventBase & {
      type: "permission.requested";
      permissionId: string;
      permissionKind: string;
      summary: string;
    })
  | (RunnerEventBase & {
      type: "artifact.requested";
      artifactId: string;
      action: "inspect" | "create" | "edit";
      format: string;
      path?: string;
      out?: string;
      absolutePath?: string;
      absoluteOut?: string;
      templatePath?: string;
      spec?: unknown;
      ops?: unknown[];
      options?: Record<string, unknown>;
      timeoutMs: number;
    })
  | (RunnerEventBase & {
      type: "runner.error";
      message: string;
      category?: string;
      code?: string;
      detail?: string;
    })
  | (RunnerEventBase & {
      type: "tool.policy.stage";
      toolCallId: string;
      stage: string;
      outcome: string;
      reason?: string;
    })
  | (RunnerEventBase & {
      type: "skill.requested";
      sessionId: string;
      runId: string;
      requestId: string;
      skillId: string;
      source: string;
      origin: "harness" | "model";
    })
  | (RunnerEventBase & {
      type: "skill.loaded";
      sessionId: string;
      runId: string;
      requestId: string;
      skillId: string;
      source: string;
      origin: "harness" | "model";
      contentHash: string;
      bytes: number;
    })
  | (RunnerEventBase & {
      type: "skill.failed";
      sessionId: string;
      runId: string;
      requestId: string;
      skillId: string;
      source: string;
      origin: "harness" | "model";
      code: string;
      message: string;
    })
  | (RunnerEventBase & {
      type: "step.settled";
      sessionId: string;
      runId: string;
      stepId: string;
      outcome: "completed" | "interrupted";
      conversationState: unknown;
    })
  | (RunnerEventBase & {
      type: "run.settled";
      sessionId: string;
      runId: string;
      outcome: "completed" | "failed" | "aborted" | "model_gave_up" | "safety_limit";
      summary: unknown;
      errorCode: string | null;
    })
  | (RunnerEventBase & {
      type: "run.queue.updated";
      sessionId: string;
      runId: string | null;
      actionId: string;
      action: "steer" | "follow_up" | "drop" | "cancel";
      disposition: "accepted" | "rejected" | "applied" | "dequeued" | "cleared";
      pendingSteer: boolean;
      followUpCount: number;
      followUpCapacity: number;
      reasonCode: string | null;
    });

export type RunnerEventDecodeResult =
  | { ok: true; ignored: false; event: RunnerEvent }
  | { ok: true; ignored: true }
  | {
      ok: false;
      code: "not_an_object" | "invalid_common_field" | "unknown_type" | "invalid_payload";
      type?: string;
      message: string;
    };

const handledTypes = new Set<RunnerEvent["type"]>([
  "assistant.delta",
  "assistant.progress.delta",
  "tool.requested",
  "command.safety.decision",
  "tool.output",
  "tool.finished",
  "context.compressed",
  "context.usage",
  "context.compaction",
  "provider.reconnecting",
  "provider.reconnected",
  "provider.session_rejected",
  "context.retrieved",
  "permission.requested",
  "artifact.requested",
  "runner.error",
  "tool.policy.stage",
  "skill.requested",
  "skill.loaded",
  "skill.failed",
  "step.settled",
  "run.settled",
  "run.queue.updated",
]);

const ignoredTypes = new Set([
  "permission.resolved",
  "artifact.resolved",
]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validTimestamps(value: Record<string, unknown>): boolean {
  return (
    (value.at === undefined || typeof value.at === "string")
    && (value.endedAt === undefined || typeof value.endedAt === "string")
  );
}

function validPayload(value: Record<string, unknown>, type: RunnerEvent["type"]): boolean {
  switch (type) {
    case "assistant.delta":
      // A `kind` from an older runner is ignored rather than rejected: the
      // field no longer changes where the delta renders, and dropping the text
      // over a leftover tag would lose the run's opening sentence.
      return hasString(value, "text");
    case "assistant.progress.delta":
      // `kind` is optional and additive. Unknown values are dropped later
      // rather than failing the payload: an older runner has no kind, and a
      // newer one may send a tag this build has not named yet.
      return hasString(value, "text");
    case "command.safety.decision":
      return true;
    case "step.settled":
      return hasString(value, "sessionId")
        && hasString(value, "runId")
        && hasString(value, "stepId")
        && (value.outcome === "completed" || value.outcome === "interrupted")
        && isRecord(value.conversationState);
    case "run.settled":
      return hasString(value, "sessionId")
        && hasString(value, "runId")
        && ["completed", "failed", "aborted", "model_gave_up", "safety_limit"].includes(String(value.outcome))
        && (value.summary === null || typeof value.summary === "object")
        && (value.errorCode === null || typeof value.errorCode === "string");
    case "run.queue.updated":
      return hasString(value, "sessionId")
        && (value.runId === null || typeof value.runId === "string")
        && hasString(value, "actionId")
        && (value.action === "steer" || value.action === "follow_up"
          || value.action === "drop" || value.action === "cancel")
        && (value.disposition === "accepted"
          || value.disposition === "rejected"
          || value.disposition === "applied"
          || value.disposition === "dequeued"
          || value.disposition === "cleared")
        && typeof value.pendingSteer === "boolean"
        && isFiniteNumber(value.followUpCount)
        && value.followUpCount >= 0
        && isFiniteNumber(value.followUpCapacity)
        && value.followUpCapacity >= 0
        && (value.reasonCode === null || typeof value.reasonCode === "string");
    case "artifact.requested":
      // The spec and ops are the format engine's business, not this decoder's:
      // closing them here would reject a field a newer engine understands.
      return hasString(value, "artifactId")
        && (value.action === "inspect" || value.action === "create" || value.action === "edit")
        && hasString(value, "format")
        && hasNonNegativeNumber(value, "timeoutMs");
    case "tool.policy.stage":
      return hasString(value, "toolCallId") && hasString(value, "stage") && hasString(value, "outcome")
        && (value.reason === undefined || hasString(value, "reason"));
    case "skill.requested":
      return hasString(value, "sessionId")
        && hasString(value, "runId")
        && hasString(value, "requestId")
        && hasString(value, "skillId")
        && hasString(value, "source")
        && (value.origin === "harness" || value.origin === "model");
    case "skill.loaded":
      return hasString(value, "sessionId")
        && hasString(value, "runId")
        && hasString(value, "requestId")
        && hasString(value, "skillId")
        && hasString(value, "source")
        && (value.origin === "harness" || value.origin === "model")
        && hasString(value, "contentHash")
        && hasNonNegativeNumber(value, "bytes");
    case "skill.failed":
      return hasString(value, "sessionId")
        && hasString(value, "runId")
        && hasString(value, "requestId")
        && hasString(value, "skillId")
        && hasString(value, "source")
        && (value.origin === "harness" || value.origin === "model")
        && hasString(value, "code")
        && hasString(value, "message");
    case "tool.requested":
      return (
        hasString(value, "toolCallId")
        && hasString(value, "toolKind")
        && (value.summary === undefined || typeof value.summary === "string")
        && (value.commandClass === undefined || typeof value.commandClass === "string")
      );
    case "tool.output":
      return (
        hasString(value, "toolCallId")
        && hasString(value, "text")
        && (value.stream === "stdout" || value.stream === "stderr")
      );
    case "tool.finished":
      return (
        hasString(value, "toolCallId")
        && (value.exitCode === null || isFiniteNumber(value.exitCode))
        && (value.status === undefined || typeof value.status === "string")
        && (value.errorCode == null || typeof value.errorCode === "string")
        && (value.errorMessage == null || typeof value.errorMessage === "string")
        && (value.durationMs === undefined || hasNonNegativeNumber(value, "durationMs"))
        && (value.response == null || typeof value.response === "string")
        && (value.details === undefined || isRecord(value.details))
        && (value.continuation === undefined || isRecord(value.continuation))
      );
    case "context.compressed":
      return (
        hasString(value, "toolCallId")
        && hasString(value, "toolKind")
        && hasString(value, "kind")
        && hasString(value, "strategy")
        && hasNonNegativeNumber(value, "originalBytes")
        && hasNonNegativeNumber(value, "outputBytes")
        && (value.hash == null || typeof value.hash === "string")
      );
    case "context.usage":
      return (
        isFiniteNumber(value.contextLength)
        && value.contextLength > 0
        && hasNonNegativeNumber(value, "contentTokens")
        && hasNonNegativeNumber(value, "reserveTokens")
        && (value.promptTokens === undefined || hasNonNegativeNumber(value, "promptTokens"))
        && (value.completionTokens === undefined || hasNonNegativeNumber(value, "completionTokens"))
        && (value.protectedTokens === undefined || hasNonNegativeNumber(value, "protectedTokens"))
        && (value.estimatedTokens === undefined || hasNonNegativeNumber(value, "estimatedTokens"))
        && (value.anchored === undefined || typeof value.anchored === "boolean")
        && (value.compactionBlocked === undefined || typeof value.compactionBlocked === "boolean")
        && (value.compactionBlockedReason === undefined || value.compactionBlockedReason === "floor" || value.compactionBlockedReason === "failing")
        && (value.awaitingMeasurement === undefined || typeof value.awaitingMeasurement === "boolean")
        && (value.breakdown === undefined || isContextBreakdown(value.breakdown))
      );
    case "context.compaction":
      return (
        (value.phase === "started" || value.phase === "finished")
        && (value.outcome === undefined
          || ["compacted", "unchanged", "failed"].includes(String(value.outcome)))
        && (value.reclaimedTokens === undefined
          || hasNonNegativeNumber(value, "reclaimedTokens"))
      );
    case "provider.reconnecting":
      return (
        hasNonNegativeNumber(value, "attempt")
        && Number(value.attempt) >= 1
        && hasNonNegativeNumber(value, "maxAttempts")
        && Number(value.maxAttempts) >= Number(value.attempt)
        && hasNonNegativeNumber(value, "delayMs")
      );
    case "provider.reconnected":
      return hasNonNegativeNumber(value, "attempt") && Number(value.attempt) >= 1;
    case "provider.session_rejected":
      // The task id and timestamp every event carries are the whole payload.
      return true;
    case "context.retrieved":
      return (
        hasString(value, "toolCallId")
        && hasString(value, "hash")
        && hasNonNegativeNumber(value, "offset")
        && hasNonNegativeNumber(value, "bytesShown")
        && hasNonNegativeNumber(value, "totalBytes")
      );
    case "permission.requested":
      return (
        hasString(value, "permissionId")
        && hasString(value, "permissionKind")
        && hasString(value, "summary")
      );
    case "runner.error":
      return (
        hasString(value, "message")
        && (value.category === undefined || typeof value.category === "string")
        && (value.code === undefined || typeof value.code === "string")
        && (value.detail === undefined || typeof value.detail === "string")
      );
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

export function decodeRunnerEvent(value: unknown): RunnerEventDecodeResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      code: "not_an_object",
      message: "Runner event must be an object.",
    };
  }
  const type = typeof value.type === "string" ? value.type : undefined;
  if (type && ignoredTypes.has(type)) {
    return { ok: true, ignored: true };
  }
  if (!type || !handledTypes.has(type as RunnerEvent["type"])) {
    return {
      ok: false,
      code: "unknown_type",
      ...(type ? { type } : {}),
      message: "Runner event type is missing or unknown.",
    };
  }
  if (!hasString(value, "taskId") || !validTimestamps(value)) {
    return {
      ok: false,
      code: "invalid_common_field",
      type,
      message: "Runner event has invalid task or timestamp fields.",
    };
  }
  if (!validPayload(value, type as RunnerEvent["type"])) {
    return {
      ok: false,
      code: "invalid_payload",
      type,
      message: `Runner event ${type} has invalid fields.`,
    };
  }
  return {
    ok: true,
    ignored: false,
    event: value as RunnerEvent,
  };
}
