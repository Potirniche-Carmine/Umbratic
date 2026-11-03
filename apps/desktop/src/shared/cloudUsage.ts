import type { CloudUsage } from "./cloud";

// A failed fetch must not replace a recent good one, nor keep an expired
// quota looking current. Account identity is checked by the caller.
export function latestCloudUsage(values: (CloudUsage | undefined)[], now = Date.now()): CloudUsage | undefined {
  return values.filter((value): value is CloudUsage => !!value && now - Date.parse(value.fetchedAt) < 15 * 60_000)
    .sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt))
    .map(value => ({ ...value, limits: value.limits.filter(limit => !limit.resetsAt || Date.parse(limit.resetsAt) > now) }))
    .find(value => value.limits.length > 0);
}
