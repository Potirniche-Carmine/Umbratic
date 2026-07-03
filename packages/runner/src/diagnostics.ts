import * as fs from "node:fs";
import * as path from "node:path";

import type { RunnerDiagnosticsConfig } from "./config.js";
import type { UmbraticRunnerEvent } from "./events.js";
import { redactText, shortHashValue } from "./policy.js";

export type RunnerDiagnosticMetadata = {
  enabled: boolean;
  logPath?: string;
};

type RunnerDiagnosticRecord = {
  schemaVersion: 1;
  source: "umbratic-runner";
  level: "info" | "warn" | "error";
  eventType: string;
  taskId?: string;
  at: string;
  data: Record<string, unknown>;
};

function safeFileComponent(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "runner";
}

function defaultLogPath(cwd: string, taskId?: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${safeFileComponent(taskId ?? "runner")}-${timestamp}-${process.pid}.jsonl`;
  return path.join(cwd, ".umbratic", "diagnostics", name);
}

function configuredLogPath(config: RunnerDiagnosticsConfig, cwd: string, taskId?: string): string {
  if (config.logPath) return config.logPath;
  if (config.directory) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return path.join(config.directory, `${safeFileComponent(taskId ?? "runner")}-${timestamp}-${process.pid}.jsonl`);
  }
  return defaultLogPath(cwd, taskId);
}

function recordBase(event: UmbraticRunnerEvent, level: RunnerDiagnosticRecord["level"]): Omit<RunnerDiagnosticRecord, "data"> {
  return {
    schemaVersion: 1,
    source: "umbratic-runner",
    level,
    eventType: event.type,
    taskId: event.taskId,
    at: event.at,
  };
}

function diagnosticRecordForEvent(
  event: UmbraticRunnerEvent,
  config: RunnerDiagnosticsConfig,
): RunnerDiagnosticRecord | null {
  if (event.type === "assistant.delta" || event.type === "assistant.reasoning.delta") {
    return null;
  }

  if (event.type === "tool.requested") {
    return {
      ...recordBase(event, event.commandClass === "destructive-file" || event.commandClass === "network" ? "warn" : "info"),
      data: {
        toolCallId: event.toolCallId,
        toolKind: event.toolKind,
        commandClass: event.commandClass,
        summary: redactText(event.summary, 500),
        cwdHash: shortHashValue(event.cwd),
      },
    };
  }

  if (event.type === "tool.output") {
    if (config.includeToolOutput === "none") return null;
    if (config.includeToolOutput === "stderr" && event.stream !== "stderr") return null;
    if (!event.text.trim()) return null;
    return {
      ...recordBase(event, event.stream === "stderr" ? "warn" : "info"),
      data: {
        toolCallId: event.toolCallId,
        stream: event.stream,
        outputSummary: redactText(event.text.slice(-1600), 1600),
        outputRedacted: true,
        originalLength: event.text.length,
        endedAt: event.endedAt,
      },
    };
  }

  if (event.type === "tool.policy.stage") {
    return {
      ...recordBase(event, event.outcome === "blocked" ? "warn" : "info"),
      data: {
        toolCallId: event.toolCallId,
        stage: event.stage,
        outcome: event.outcome,
        summary: event.summary ? redactText(event.summary, 500) : undefined,
        code: event.code,
      },
    };
  }

  if (event.type === "tool.finished") {
    const failed = event.status !== undefined && event.status !== "success";
    return {
      ...recordBase(event, failed ? "warn" : "info"),
      data: {
        toolCallId: event.toolCallId,
        exitCode: event.exitCode,
        status: event.status,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage ? redactText(event.errorMessage, 500) : undefined,
        startedAt: event.startedAt,
        finishedAt: event.finishedAt,
        durationMs: event.durationMs,
      },
    };
  }

  if (event.type === "permission.requested") {
    return {
      ...recordBase(event, "warn"),
      data: {
        permissionId: event.permissionId,
        permissionKind: event.permissionKind,
        summary: redactText(event.summary, 500),
      },
    };
  }

  if (event.type === "permission.resolved") {
    return {
      ...recordBase(event, event.decision === "deny" ? "warn" : "info"),
      data: {
        permissionId: event.permissionId,
        decision: event.decision,
      },
    };
  }

  if (event.type === "session.idle") {
    return {
      ...recordBase(event, "info"),
      data: {
        sessionId: event.sessionId,
      },
    };
  }

  if (event.type === "runner.error") {
    return {
      ...recordBase(event, "error"),
      data: {
        category: event.category,
        code: event.code,
        message: redactText(event.message, 1000),
        detail: event.detail ? redactText(event.detail, 1000) : undefined,
      },
    };
  }

  return null;
}

export class RunnerDiagnostics {
  private readonly logPath?: string;
  private stream: fs.WriteStream | null = null;
  private failed = false;

  constructor(
    private readonly config: RunnerDiagnosticsConfig,
    private readonly context: { cwd: string; taskId?: string },
  ) {
    this.logPath = config.enabled ? configuredLogPath(config, context.cwd, context.taskId) : undefined;
  }

  metadata(): RunnerDiagnosticMetadata {
    return {
      enabled: this.config.enabled && !this.failed,
      ...(this.logPath ? { logPath: this.logPath } : {}),
    };
  }

  record(event: UmbraticRunnerEvent): void {
    if (!this.config.enabled || this.failed || !this.logPath) return;
    const record = diagnosticRecordForEvent(event, this.config);
    if (!record) return;
    this.writeRecord(record);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.stream) {
        resolve();
        return;
      }
      const stream = this.stream;
      this.stream = null;
      stream.end(resolve);
    });
  }

  private ensureStream(): fs.WriteStream | null {
    if (this.stream) return this.stream;
    if (!this.logPath) return null;
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      this.stream = fs.createWriteStream(this.logPath, { flags: "a", encoding: "utf8" });
      this.stream.once("error", (error) => {
        this.failed = true;
        process.stderr.write(`Umbratic runner diagnostics disabled: ${redactText(error.message, 240)}\n`);
      });
      return this.stream;
    } catch (error) {
      this.failed = true;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Umbratic runner diagnostics disabled: ${redactText(message, 240)}\n`);
      return null;
    }
  }

  private writeRecord(record: RunnerDiagnosticRecord): void {
    const stream = this.ensureStream();
    if (!stream) return;
    stream.write(`${JSON.stringify(record)}\n`);
  }
}
