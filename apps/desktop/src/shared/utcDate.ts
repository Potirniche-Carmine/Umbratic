/// Chat and task timestamps are UTC instants. SQLite stores them as ISO-8601
/// TEXT (`YYYY-MM-DDTHH:mm:ss.sssZ`). Relative sidebar labels are computed from
/// that stored datetime, never written back as "1h" / "<1m".

const utcDateTimePattern =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(Z|[+-]\d{2}:?\d{2})?$/i;

export type TimedRecord = {
  at?: string;
  endedAt?: string;
};

export function utcNowIso(now = Date.now()): string {
  return new Date(now).toISOString();
}

export function parseUtcMs(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const match = utcDateTimePattern.exec(trimmed);
  if (match) {
    const time = match[2].length === 5 ? `${match[2]}:00` : match[2];
    const parsed = Date.parse(`${match[1]}T${time}${match[3] ?? "Z"}`);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (/^\d{10,13}$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) return undefined;
    return trimmed.length <= 10 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function normalizeUtcIso(value: string): string | undefined {
  const parsed = parseUtcMs(value);
  return parsed === undefined ? undefined : new Date(parsed).toISOString();
}

export function compareUtcIsoDesc(left: string, right: string): number {
  return (parseUtcMs(right) ?? 0) - (parseUtcMs(left) ?? 0);
}

export function latestEventUtcIso(events: ReadonlyArray<TimedRecord>): string | undefined {
  let latest = Number.NaN;
  for (const event of events) {
    for (const value of [event.endedAt, event.at]) {
      if (!value) continue;
      const parsed = parseUtcMs(value);
      if (parsed !== undefined && (Number.isNaN(latest) || parsed > latest)) latest = parsed;
    }
  }
  return Number.isNaN(latest) ? undefined : new Date(latest).toISOString();
}

export function chatActivityUtcIso(
  task: { createdAt?: string; events?: ReadonlyArray<TimedRecord> },
  existingUpdatedAt?: string,
): string | undefined {
  return latestEventUtcIso(task.events ?? [])
    ?? normalizeUtcIso(existingUpdatedAt ?? "")
    ?? normalizeUtcIso(task.createdAt ?? "");
}
