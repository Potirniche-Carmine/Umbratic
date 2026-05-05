import type { BackendUiEvent, RepositoryInfo, ReviewFile, TaskRecord } from "./types";
import { baseUrlHost, classifyCommandText, redactCommandText, redactText, shortHashValue, telemetryPolicyInfo } from "./policy";

type RedactedTaskEvent = {
  type: string;
  at?: string;
  durationMs?: number;
  data: Record<string, unknown>;
};

function eventDurationMs(event: BackendUiEvent): number | undefined {
  if (!event.at || !event.endedAt) return undefined;
  const started = Date.parse(event.at);
  const ended = Date.parse(event.endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return undefined;
  return ended - started;
}

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
    changedFileCount: files.length,
    additions: totals.additions,
    deletions: totals.deletions,
    changedFiles: files.map((file) => ({
      path: file.path,
      status: file.status,
      ...diffStats(file.diff),
    })),
  };
}

function redactEvent(event: BackendUiEvent): RedactedTaskEvent {
  const base = {
    type: event.type,
    at: event.at,
    durationMs: eventDurationMs(event),
  };
  if (event.type === "user.message") {
    return { ...base, data: { promptRedacted: true, length: event.text.length } };
  }
  if (event.type === "assistant.delta" || event.type === "assistant.reasoning.delta") {
    return { ...base, data: { textRedacted: true, length: event.text.length } };
  }
  if (event.type === "command.started") {
    const classification = event.commandClass
      ? { commandClass: event.commandClass }
      : classifyCommandText(event.command, event.cwd);
    return {
      ...base,
      data: {
        id: event.id,
        kind: event.kind,
        commandClass: classification.commandClass,
        command: redactCommandText(event.command),
        cwdHash: shortHashValue(event.cwd),
      },
    };
  }
  if (event.type === "command.output") {
    return {
      ...base,
      data: {
        id: event.id,
        stream: event.stream,
        outputSummary: redactText(event.text.slice(-600), 600),
        outputRedacted: true,
        originalLength: event.text.length,
      },
    };
  }
  if (event.type === "command.finished") {
    return { ...base, data: { id: event.id, exitCode: event.exitCode } };
  }
  if (event.type === "permission.requested") {
    return {
      ...base,
      data: {
        id: event.request.id,
        kind: event.request.kind,
        commandClass: event.request.commandClass,
        summary: redactCommandText(event.request.summary),
        cwdHash: shortHashValue(event.request.cwd),
      },
    };
  }
  if (event.type === "permission.resolved") {
    return { ...base, data: { id: event.id, decision: event.decision } };
  }
  if (event.type === "review.ready") {
    return {
      ...base,
      data: {
        changedFiles: event.changedFiles,
        review: reviewSummary(event.reviewFiles),
        latestTest: event.latestTest
          ? {
              command: redactCommandText(event.latestTest.command),
              passed: event.latestTest.passed,
              exitCode: event.latestTest.exitCode,
              completedAt: event.latestTest.completedAt,
            }
          : undefined,
      },
    };
  }
  if (event.type === "review.changed_since_ready") {
    return {
      ...base,
      data: {
        previousPatchHash: event.previousPatchHash,
        currentPatchHash: event.currentPatchHash,
        changedFileCount: event.changedFileCount,
      },
    };
  }
  if (event.type === "approval.check") {
    return { ...base, data: { name: event.name, status: event.status, detail: event.detail ? redactText(event.detail, 320) : undefined } };
  }
  if (event.type === "merge.approval") {
    return {
      ...base,
      data: {
        decision: event.decision,
        cleanup: event.cleanup,
        reason: event.reason ? redactText(event.reason, 320) : undefined,
      },
    };
  }
  if (event.type === "merge.completed") {
    return {
      ...base,
      data: {
        targetBranch: event.targetBranch,
        commit: event.commit.slice(0, 16),
        patchHash: event.patchHash,
      },
    };
  }
  if (event.type === "ide.opened") {
    return {
      ...base,
      data: {
        ideId: event.ideId,
        target: event.target,
        filePath: event.filePath,
        result: event.result,
        message: event.message ? redactText(event.message, 320) : undefined,
      },
    };
  }
  if (event.type === "response.feedback") {
    return { ...base, data: { messageId: event.messageId, rating: event.rating } };
  }
  if (event.type === "task.error") {
    return { ...base, data: { message: redactText(event.message, 320) } };
  }
  if (event.type === "worktree.requested") {
    return {
      ...base,
      data: {
        branch: event.branch,
        pathHash: shortHashValue(event.path),
        baseCommit: event.baseCommit.slice(0, 16),
      },
    };
  }
  if (event.type === "worktree.created") {
    return { ...base, data: { branch: event.branch, pathHash: shortHashValue(event.path) } };
  }
  return { ...base, data: {} };
}

function repositoryHash(task: TaskRecord, projects: RepositoryInfo[]): string {
  const project = projects.find((row) => row.id === task.repositoryId);
  return shortHashValue(project?.rootPath ?? task.originalRepoPath);
}

export function buildRedactedTelemetryBundle(tasks: TaskRecord[], projects: RepositoryInfo[]) {
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    policy: telemetryPolicyInfo,
    tasks: tasks.map((task) => ({
      id: task.id,
      chatId: task.chatId,
      repoId: task.repositoryId,
      repoRootHash: repositoryHash(task, projects),
      workspaceKind: task.workspaceKind,
      baseBranch: task.originalBranch,
      baseCommit: task.baseCommit.slice(0, 16),
      agentBranch: task.agentBranch || undefined,
      worktreePathHash: task.worktreePath ? shortHashValue(task.worktreePath) : undefined,
      providerId: task.providerId ?? task.model?.providerId,
      modelId: task.modelId ?? task.model?.modelId,
      modelBaseUrlHost: task.modelBaseUrlHost ?? (task.model?.baseUrl ? baseUrlHost(task.model.baseUrl) : undefined),
      runnerName: task.runnerName,
      runnerVersion: task.runnerVersion,
      policyVersion: task.policyVersion,
      runtimeProfile: task.runtimeProfile,
      permissionMode: task.permissionMode,
      reasoningMode: task.reasoningMode,
      status: task.state,
      startedAt: task.createdAt,
      completedAt: task.mergedAt ?? task.rejectedAt,
      errorMessage: task.error ? redactText(task.error, 320) : undefined,
      changedFiles: task.changedFiles,
      reviewPatchHash: task.reviewPatchHash,
      patchHash: task.patchHash,
      review: reviewSummary(task.reviewFiles ?? []),
      events: (task.events ?? []).map(redactEvent),
    })),
  };
}
