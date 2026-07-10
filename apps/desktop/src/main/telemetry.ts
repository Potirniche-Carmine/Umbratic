import * as fs from "node:fs";
import * as path from "node:path";

import type { BackendUiEvent, RepositoryInfo, ReviewFile, TaskRecord } from "./types";
import { classifyCommandText, redactText } from "./policy";

function diffStats(diff: string): { additions: number; deletions: number } {
  return diff.split(/\r?\n/).reduce(
    (total, line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) total.additions += 1;
      if (line.startsWith("-") && !line.startsWith("---")) total.deletions += 1;
      return total;
    },
    { additions: 0, deletions: 0 },
  );
}

function reviewSummary(files: ReviewFile[]) {
  const totals = files.reduce(
    (total, file) => {
      const stats = diffStats(file.diff);
      total.additions += stats.additions;
      total.deletions += stats.deletions;
      return total;
    },
    { additions: 0, deletions: 0 },
  );
  return {
    fileCount: files.length,
    additions: totals.additions,
    deletions: totals.deletions,
  };
}

function increment(map: Record<string, number>, key: string | undefined) {
  if (!key) return;
  map[key] = (map[key] ?? 0) + 1;
}

function taskOutcome(task: TaskRecord): "success" | "failure" | "in_progress" {
  if (task.state === "completed" || task.state === "review_ready" || task.state === "approved" || task.state === "merged") {
    return "success";
  }
  if (task.state === "failed" || task.state === "rejected") return "failure";
  return "in_progress";
}

function capabilitySummary(task: TaskRecord) {
  const probes = task.capabilityProbes ?? [];
  const summary = {
    total: probes.length,
    affectedCurrentRun: 0,
    byStatus: {} as Record<string, number>,
    byImportance: {} as Record<string, number>,
  };
  for (const probe of probes) {
    increment(summary.byStatus, probe.status);
    increment(summary.byImportance, probe.importance);
    if (probe.affectedCurrentRun) summary.affectedCurrentRun += 1;
  }
  return summary;
}

function telemetryEventSummary(events: BackendUiEvent[]) {
  const summary = {
    eventCount: events.length,
    messages: {
      user: 0,
      promptChars: 0,
      assistantChars: 0,
      reasoningChars: 0,
    },
    commands: {
      started: 0,
      finished: 0,
      failed: 0,
      outputEvents: 0,
      outputChars: 0,
      durationMs: 0,
      byClass: {} as Record<string, number>,
      errors: {} as Record<string, number>,
    },
    permissions: {
      requested: 0,
      allowed: 0,
      denied: 0,
    },
    reviews: {
      ready: 0,
      changedSinceReady: 0,
    },
    context: {
      compressed: 0,
      retrieved: 0,
      originalBytes: 0,
      outputBytes: 0,
      bytesSaved: 0,
      retrievedBytes: 0,
      byKind: {} as Record<string, number>,
      byStrategy: {} as Record<string, number>,
    },
    requiredToolFailures: {} as Record<string, number>,
    feedback: {
      good: 0,
      bad: 0,
    },
  };

  for (const event of events) {
    if (event.type === "user.message") {
      summary.messages.user += 1;
      summary.messages.promptChars += event.text.length;
      continue;
    }
    if (event.type === "assistant.delta") {
      summary.messages.assistantChars += event.text.length;
      continue;
    }
    if (event.type === "assistant.reasoning.delta") {
      summary.messages.reasoningChars += event.text.length;
      continue;
    }
    if (event.type === "command.started") {
      const commandClass = event.commandClass ?? classifyCommandText(event.command, event.cwd).commandClass;
      summary.commands.started += 1;
      increment(summary.commands.byClass, commandClass);
      continue;
    }
    if (event.type === "command.output") {
      summary.commands.outputEvents += 1;
      summary.commands.outputChars += event.text.length;
      continue;
    }
    if (event.type === "command.finished") {
      summary.commands.finished += 1;
      if (event.exitCode !== 0 || (event.status && event.status !== "success")) summary.commands.failed += 1;
      if (typeof event.durationMs === "number" && Number.isFinite(event.durationMs)) {
        summary.commands.durationMs += event.durationMs;
      }
      increment(summary.commands.errors, event.errorCode);
      continue;
    }
    if (event.type === "permission.requested") {
      summary.permissions.requested += 1;
      continue;
    }
    if (event.type === "permission.resolved") {
      if (event.decision === "allow") summary.permissions.allowed += 1;
      if (event.decision === "deny") summary.permissions.denied += 1;
      continue;
    }
    if (event.type === "review.ready") {
      summary.reviews.ready += 1;
      continue;
    }
    if (event.type === "review.changed_since_ready") {
      summary.reviews.changedSinceReady += 1;
      continue;
    }
    if (event.type === "context.compressed") {
      summary.context.compressed += 1;
      summary.context.originalBytes += event.originalBytes;
      summary.context.outputBytes += event.outputBytes;
      summary.context.bytesSaved += Math.max(0, event.originalBytes - event.outputBytes);
      increment(summary.context.byKind, event.kind);
      increment(summary.context.byStrategy, event.strategy);
      continue;
    }
    if (event.type === "context.retrieved") {
      summary.context.retrieved += 1;
      summary.context.retrievedBytes += event.bytesShown;
      continue;
    }
    if (event.type === "required_tool.failed") {
      increment(summary.requiredToolFailures, event.reason);
      continue;
    }
    if (event.type === "response.feedback") {
      summary.feedback[event.rating] += 1;
    }
  }
  return summary;
}

export function buildRedactedTelemetryBundle(tasks: TaskRecord[], _projects: RepositoryInfo[]) {
  return {
    schemaVersion: 3,
    exportedAt: new Date().toISOString(),
    tasks: tasks.map((task) => {
      const events = task.events ?? [];
      return {
        id: task.id,
        chatId: task.chatId,
        repoId: task.repositoryId,
        workspace: {
          kind: task.workspaceKind,
          mode: task.workspaceMode,
        },
        model: {
          providerId: task.providerId ?? task.model?.providerId,
          modelId: task.modelId ?? task.model?.modelId,
        },
        runner: {
          name: task.runnerName,
          version: task.runnerVersion,
        },
        mode: {
          permission: task.permissionMode,
          reasoning: task.reasoningMode,
        },
        status: task.state,
        outcome: taskOutcome(task),
        startedAt: task.createdAt,
        completedAt: task.approvedAt ?? task.mergedAt ?? task.rejectedAt,
        errorMessage: task.error ? redactText(task.error, 320) : undefined,
        changes: {
          fileCount: task.changedFiles.length,
          review: reviewSummary(task.reviewFiles ?? []),
          latestTest: task.latestTest
            ? {
                passed: task.latestTest.passed,
                exitCode: task.latestTest.exitCode,
              }
            : undefined,
        },
        runtimeHealth: capabilitySummary(task),
        activity: telemetryEventSummary(events),
      };
    }),
  };
}

export type RedactedTelemetryBundle = ReturnType<typeof buildRedactedTelemetryBundle>;

export function telemetrySpoolFileName(date = new Date()): string {
  return `telemetry-${date.toISOString().replace(/[:.]/g, "-")}.json`;
}

export async function writeTelemetrySpoolFile(
  directory: string,
  bundle: RedactedTelemetryBundle,
  date = new Date(),
): Promise<string> {
  await fs.promises.mkdir(directory, { recursive: true });
  const baseName = telemetrySpoolFileName(date).replace(/\.json$/, "");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    const filePath = path.join(directory, `${baseName}${suffix}.json`);
    try {
      await fs.promises.writeFile(filePath, `${JSON.stringify(bundle)}\n`, { encoding: "utf8", flag: "wx" });
      return filePath;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw cause;
    }
  }
  throw new Error("Unable to allocate a telemetry spool file name.");
}

export async function listTelemetrySpoolFiles(directory: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /^telemetry-.+\.json$/.test(entry.name))
      .map((entry) => path.join(directory, entry.name))
      .sort();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
}
