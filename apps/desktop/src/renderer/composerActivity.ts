import type { BackendUiEvent } from "../shared/desktopApi";
import { activityHasNarration, activityHasTools } from "./activityTiming";
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

export function reconcileActivityDisclosureState(
  currentExpandedIds: Set<string>,
  items: ComposerTimelineItem[],
  taskId: string | undefined,
  currentAutoOpenedKeys: Set<string>,
  keepFinishedOpen = false,
): { expandedIds: Set<string>; autoOpenedKeys: Set<string>; newlyOpenedIds: string[] } {
  const activities = items.filter(
    (item): item is Extract<ComposerTimelineItem, { type: "activity" }> => item.type === "activity",
  );
  const activityKey = (id: string) => `${taskId ?? "no-task"}:${id}`;
  const activeIds = new Set(activities.map((item) => item.id));
  const activeKeys = new Set(activities.map((item) => activityKey(item.id)));
  const nextExpandedIds = new Set(currentExpandedIds);
  const nextAutoOpenedKeys = new Set(currentAutoOpenedKeys);
  const newlyOpenedIds: string[] = [];

  for (const activity of activities) {
    const key = activityKey(activity.id);
    // A live compaction block auto-opens for the same reason a tool block does:
    // the row explaining the pause is the point of showing the block at all.
    // Narration opens it too, and often first — orientation arrives before any
    // tool, and a block that stayed shut would replace it with "Working".
    const opensLive = activityHasTools(activity.segments) || activityHasNarration(activity.segments);
    if (!activity.finished && opensLive && !nextAutoOpenedKeys.has(key)) {
      nextAutoOpenedKeys.add(key);
      nextExpandedIds.add(activity.id);
      newlyOpenedIds.push(activity.id);
      continue;
    }
    if ((!opensLive || activity.finished) && nextAutoOpenedKeys.has(key)) {
      // Keep the block open while the last passage lifts out of it, so the
      // answer restyles in place rather than dropping as the log tucks away.
      if (keepFinishedOpen && activity.finished) continue;
      nextAutoOpenedKeys.delete(key);
      nextExpandedIds.delete(activity.id);
    }
  }

  for (const id of nextExpandedIds) {
    if (!activeIds.has(id)) nextExpandedIds.delete(id);
  }
  for (const key of nextAutoOpenedKeys) {
    if (!activeKeys.has(key)) nextAutoOpenedKeys.delete(key);
  }

  return { expandedIds: nextExpandedIds, autoOpenedKeys: nextAutoOpenedKeys, newlyOpenedIds };
}
