import type { BackendUiEvent } from "../shared/desktopApi";
import { activityToolLabel, type CommandRun } from "./commandDisplay";
import type { ComposerActivitySegment, ComposerTimelineItem, PermissionRequest } from "./rendererTypes";

export function commandRunsFromEvents(events: BackendUiEvent[]): CommandRun[] {
  const runs = new Map<string, CommandRun>();
  for (const event of events) {
    if (event.type === "command.started") {
      const existing = runs.get(event.id);
      if (existing) {
        existing.command = event.command;
        existing.kind = event.kind;
        existing.toolKind = event.toolKind;
        existing.commandClass = event.commandClass;
        existing.cwd = event.cwd;
        continue;
      }
      runs.set(event.id, {
        id: event.id,
        command: event.command,
        kind: event.kind,
        toolKind: event.toolKind,
        commandClass: event.commandClass,
        cwd: event.cwd,
        stdout: "",
        stderr: "",
        exitCode: null,
        status: "running",
        startedAt: event.at,
        endedAt: event.at,
      });
      continue;
    }
    if (event.type === "command.output") {
      let run = runs.get(event.id);
      if (!run) {
        run = {
          id: event.id,
          command: event.id,
          kind: "bash",
          commandClass: "unknown",
          cwd: "",
          stdout: "",
          stderr: "",
          exitCode: null,
          status: "running",
          startedAt: event.at,
          endedAt: event.at,
        };
        runs.set(event.id, run);
      }
      run.endedAt = event.endedAt ?? event.at ?? run.endedAt;
      if (event.stream === "stdout") {
        run.stdout = `${run.stdout}${event.text}`;
      } else {
        run.stderr = `${run.stderr}${event.text}`;
      }
      continue;
    }
    if (event.type === "command.finished") {
      let run = runs.get(event.id);
      if (!run) {
        run = {
          id: event.id,
          command: event.id,
          kind: "bash",
          commandClass: "unknown",
          cwd: "",
          stdout: "",
          stderr: "",
          exitCode: null,
          status: "running",
          startedAt: event.at,
          endedAt: event.at,
        };
        runs.set(event.id, run);
      }
      run.exitCode = event.exitCode;
      run.status = event.exitCode === 0 ? "passed" : "failed";
      run.resultStatus = event.status;
      run.details = event.details;
      run.errorCode = event.errorCode;
      if (event.errorMessage && !run.stderr.trim()) run.stderr = event.errorMessage;
      run.endedAt = event.at ?? run.endedAt;
      run.durationMs = event.durationMs;
    }
  }
  return Array.from(runs.values());
}

export function pendingPermissionFromEvents(events: BackendUiEvent[]): PermissionRequest | null {
  const requests = new Map<string, PermissionRequest>();
  for (const event of events) {
    if (event.type === "permission.requested") {
      requests.set(event.request.id, event.request);
      continue;
    }
    if (event.type === "permission.resolved") {
      requests.delete(event.id);
    }
  }
  return Array.from(requests.values()).at(-1) ?? null;
}

export function activityToolGroups(segments: ComposerActivitySegment[]): Array<{
  id: string;
  label: string;
  runs: CommandRun[];
  status: CommandRun["status"];
}> {
  const groups = new Map<string, { id: string; label: string; runs: CommandRun[]; status: CommandRun["status"] }>();
  for (const segment of segments) {
    if (segment.type !== "command") continue;
    const { key, label } = activityToolLabel(segment.run);
    const group = groups.get(key) ?? { id: `tool-group-${groups.size + 1}`, label, runs: [], status: "passed" as const };
    group.runs.push(segment.run);
    group.status = group.runs.some((run) => run.status === "running")
      ? "running"
      : group.runs.some((run) => run.status === "failed")
        ? "failed"
        : "passed";
    groups.set(key, group);
  }
  return Array.from(groups.values());
}

/**
 * Prunes disclosure state down to the blocks that still exist. Blocks opened
 * manually or by the auto-expand preference stay open when streaming finishes.
 */
export function reconcileActivityDisclosureState(
  currentExpandedIds: Set<string>,
  items: ComposerTimelineItem[],
): Set<string> {
  const activeIds = new Set(
    items
      .filter((item): item is Extract<ComposerTimelineItem, { type: "activity" }> => item.type === "activity")
      .map((item) => item.id),
  );
  let changed = false;
  const next = new Set(currentExpandedIds);
  for (const id of next) {
    if (activeIds.has(id)) continue;
    next.delete(id);
    changed = true;
  }
  // The same set back when nothing changed, so a state setter reading this
  // does not re-render the page every reconcile.
  return changed ? next : currentExpandedIds;
}
