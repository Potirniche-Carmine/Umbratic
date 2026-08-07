import { isContextBreakdown, type BackendContextBreakdown } from "../shared/backendEvents";

type RunnerEventBase = {
  taskId: string;
  at?: string;
  endedAt?: string;
};

export type RunnerEvent =
  // kind "status" marks harness-emitted work narration (the run's opening
  // status line): rendered inside the working timeline, never as answer text.
  | (RunnerEventBase & { type: "assistant.delta"; text: string; kind?: "status" })
  | (RunnerEventBase & { type: "assistant.progress.delta"; text: string })
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
      // Harness-internal classification for a run. Recorded to the local
      // diagnostic log only; never forwarded to the renderer, so bucket ids
      // stay out of chat output.
      type: "orient.decision";
      outcome: "guided" | "direct" | "degraded";
      bucket?: string;
      sentence?: "emitted" | "missing";
      evidenceRequired?: boolean;
      message?: string;
    })
  | (RunnerEventBase & {
      // The run answered before calling any tool in a bucket that may not, so
      // the runner refused that answer once. Diagnostic only, like the
      // decision it follows; the bucket id never reaches the renderer.
      type: "orient.evidence_retry";
      bucket?: string;
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
  "context.retrieved",
  "permission.requested",
  "runner.error",
  "tool.policy.stage",
  "skill.requested",
  "skill.loaded",
  "skill.failed",
  "step.settled",
  "run.settled",
  "run.queue.updated",
  "orient.decision",
  "orient.evidence_retry",
]);

const ignoredTypes = new Set([
  "permission.resolved",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasString(value: Record<string, unknown>, name: string): boolean {
  return typeof value[name] === "string";
}

function hasNonNegativeNumber(value: Record<string, unknown>, name: string): boolean {
  return isFiniteNumber(value[name]) && value[name] >= 0;
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
      return hasString(value, "text") && (value.kind === undefined || value.kind === "status");
    case "assistant.progress.delta":
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
    case "orient.decision":
      return (
        (value.outcome === "guided" || value.outcome === "direct" || value.outcome === "degraded")
        && (value.bucket === undefined || typeof value.bucket === "string")
        && (value.sentence === undefined || value.sentence === "emitted" || value.sentence === "missing")
        && (value.evidenceRequired === undefined || typeof value.evidenceRequired === "boolean")
        && (value.message === undefined || typeof value.message === "string")
      );
    case "orient.evidence_retry":
      return value.bucket === undefined || typeof value.bucket === "string";
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
