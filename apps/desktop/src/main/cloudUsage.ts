import type { CloudLimit, CloudUsage } from "../shared/cloud";

function limit(id: string, label: string, percent: unknown, reset: unknown): CloudLimit[] {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return [];
  const timestamp = typeof reset === "number" ? reset * 1000 : typeof reset === "string" ? Date.parse(reset) : NaN;
  return [{ id, label, usedPercent: Math.max(0, Math.min(100, percent)), ...(Number.isFinite(timestamp) ? { resetsAt: new Date(timestamp).toISOString() } : {}) }];
}
export function codexUsage(input: any): CloudUsage {
  const buckets = input?.rateLimitsByLimitId ? Object.values(input.rateLimitsByLimitId) : input?.rateLimits ? [input.rateLimits] : [];
  const limits = (buckets as any[]).flatMap(bucket => ["primary", "secondary"].flatMap(window => {
    const value = bucket[window];
    const minutes = value?.windowDurationMins;
    const duration = minutes === 10080 ? "Weekly" : minutes === 300 ? "5 hours" : minutes ? `${Math.round(minutes / 60)} hours` : window === "primary" ? "Current window" : "Longer window";
    return limit(`${bucket.limitId || "codex"}:${window}`, bucket.limitName ? `${bucket.limitName} · ${duration}` : duration, value?.usedPercent, value?.resetsAtUnixSeconds ?? value?.resetsAt);
  }));
  return { limits, fetchedAt: new Date().toISOString() };
}
export function claudeUsage(input: any): CloudUsage {
  const value = input?.rate_limits_available === false ? undefined : input?.rate_limits;
  // /usage carries the server's ordered rows, including model and surface
  // scopes. Prefer these over the older control-response window names.
  if (Array.isArray(value?.limits)) return { fetchedAt: new Date().toISOString(), limits: value.limits.flatMap((row: any, index: number) => {
    const scope = row.scope?.model?.display_name || row.scope?.surface?.display_name;
    const label = row.kind === "session" ? "5 hours" : row.group === "weekly" ? "Weekly" : String(row.group || row.kind || "Usage").replace(/_/g, " ");
    return limit(`${row.kind}:${scope || index}`, scope ? `${scope} · ${label.toLowerCase()}` : label, row.percent, row.resets_at)
      .map(item => ({ ...item, severity: typeof row.severity === "string" ? row.severity : undefined, active: row.is_active === true }));
  }) };
  const windows: [string, string][] = [["five_hour", "5 hours"], ["seven_day", "Weekly"], ["seven_day_opus", "Opus · weekly"], ["seven_day_sonnet", "Sonnet · weekly"], ["seven_day_oauth_apps", "Connected apps · weekly"]];
  const limits = windows.flatMap(([key, label]) => limit(key, label, value?.[key]?.utilization, value?.[key]?.resets_at));
  for (const [index, model] of (value?.model_scoped || value?.seven_day_model_scoped || []).entries()) limits.push(...limit(`model-${index}`, `${model.display_name} · weekly`, model.utilization, model.resets_at));
  return { limits, fetchedAt: new Date().toISOString() };
}
export function planLabel(value?: string): string | undefined {
  if (!value) return undefined;
  const names: Record<string, string> = { prolite: "Pro Lite", pro: "Pro", plus: "Plus", max: "Max", team: "Team", business: "Business", enterprise: "Enterprise", free: "Free", edu: "Education" };
  return names[value.toLowerCase()] || value.replace(/[_-]/g, " ").replace(/^./, initial => initial.toUpperCase());
}
export function claudeModelLabel(id: string, fallback: string): string {
  const match = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)(?:-|$)/.exec(id);
  return match ? `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2]}.${match[3]}` : fallback;
}

export async function optionalRuntimeRead<T>(read: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([read.catch(() => undefined), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 4000); })]); }
  finally { clearTimeout(timer); }
}
