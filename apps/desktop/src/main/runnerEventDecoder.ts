type RunnerEventBase = {
  taskId: string;
  at?: string;
  endedAt?: string;
};

export type RunnerEvent =
  | (RunnerEventBase & { type: "assistant.delta"; text: string })
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
      phase?: unknown;
      source?: unknown;
      confidence?: unknown;
    })
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
      type: "skill.selected";
      skillId: string;
      source: "system" | "local";
      reason: "explicit_request" | "strong_match" | "metadata";
      fullContent: boolean;
    })
  | (RunnerEventBase & { type: "session.idle"; summary?: unknown });

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
  "context.retrieved",
  "permission.requested",
  "runner.error",
  "tool.policy.stage",
  "skill.selected",
  "session.idle",
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
    case "assistant.progress.delta":
      return hasString(value, "text");
    case "command.safety.decision":
    case "session.idle":
      return true;
    case "tool.policy.stage":
      return hasString(value, "toolCallId") && hasString(value, "stage") && hasString(value, "outcome")
        && (value.reason === undefined || hasString(value, "reason"));
    case "skill.selected":
      return hasString(value, "skillId")
        && (value.source === "system" || value.source === "local")
        && ["explicit_request", "strong_match", "metadata"].includes(String(value.reason))
        && typeof value.fullContent === "boolean";
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
      );
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
