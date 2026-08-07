type TimedActivity = {
  startedAt?: string;
  endedAt?: string;
  finished: boolean;
  segments?: ReadonlyArray<{ type: string }>;
};

function eventTimeMs(value?: string): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function formatDuration(value: number | null): string {
  if (value === null) return "";
  const totalSeconds = Math.max(1, Math.round(value / 1000));
  if (totalSeconds < 60) return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const minuteLabel = `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return seconds ? `${minuteLabel} ${seconds} second${seconds === 1 ? "" : "s"}` : minuteLabel;
}

export function thoughtDurationMs(startedAt?: string, endedAt?: string, finished = true): number | null {
  const start = eventTimeMs(startedAt);
  if (start === undefined) return null;
  const end = eventTimeMs(endedAt) ?? (finished ? start : Date.now());
  return Math.max(0, end - start);
}

export function activityHasTools(segments: ReadonlyArray<{ type: string }> | undefined): boolean {
  return (segments ?? []).some((segment) => segment.type === "command" || segment.type === "skill");
}

/// How long compaction has been running, or how long it took.
///
/// A running row is measured against the caller's clock rather than its own, so
/// the elapsed time ticks with the Working header above it instead of drifting
/// against it.
export function compactionElapsedLabel(
  segment: { startedAt?: string; endedAt?: string; status: string },
  now = Date.now(),
): string {
  const start = eventTimeMs(segment.startedAt);
  if (start === undefined) return "";
  const end = segment.status === "running" ? now : eventTimeMs(segment.endedAt) ?? now;
  return formatDuration(Math.max(0, end - start));
}

export function activitySummary(item: TimedActivity, now = Date.now()): string {
  const start = eventTimeMs(item.startedAt);
  const end = item.finished ? eventTimeMs(item.endedAt) ?? start : now;
  const duration = formatDuration(start === undefined || end === undefined ? null : Math.max(0, end - start));
  if (!item.finished) {
    if (!activityHasTools(item.segments)) return "Thinking";
    return ["Working", duration].filter(Boolean).join(" · ");
  }
  return duration ? `Worked for ${duration}` : "Work complete";
}
