import React, { useRef } from "react";
import type { CloudUsage as Usage, CloudWorkspace } from "../../shared/cloud";

function tone(used?: number, severity?: string) {
  if (severity) return severity === "critical" ? "critical" : severity === "warning" ? "warning" : severity === "normal" ? "normal" : "unknown";
  return used === undefined ? "unknown" : used >= 90 ? "critical" : used >= 70 ? "warning" : "normal";
}
function UsageRing({ value, used, severity, compact = false }: { value?: number; used?: number; severity?: string; compact?: boolean }) {
  return <span className={`cloudUsageRing ${compact ? "isCompact" : ""} is-${tone(used, severity)}`} aria-hidden="true">
    <svg viewBox="0 0 48 48"><circle className="cloudRingTrack" cx="24" cy="24" r="20"/>{value !== undefined && <circle className="cloudRingValue" cx="24" cy="24" r="20" pathLength="100" strokeDasharray={`${Math.max(0, Math.min(100, value))} 100`}/>}</svg>
    {!compact && <span>{value === undefined ? "—" : Math.round(value)}{value !== undefined && <small>%</small>}</span>}
  </span>;
}
export function CloudUsageDetails({ usage }: { usage?: Usage }) {
  if (!usage?.limits.length) return <div className="cloudUsageWindow cloudUsageUnavailable"><UsageRing/><div><strong>Usage unavailable</strong><small>Try refreshing your connection.</small></div></div>;
  return <div className="cloudUsageDetails">{usage.limits.map(limit => <div className="cloudUsageWindow" key={limit.id} aria-label={`${limit.label}: ${Math.round(100 - limit.usedPercent)}% left`}>
    <UsageRing value={100 - limit.usedPercent} used={limit.usedPercent} severity={limit.severity}/>
    <div><strong>{limit.label}</strong><span>{Math.round(100 - limit.usedPercent)}% left</span>
      {limit.resetsAt && <small>Resets {new Date(limit.resetsAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</small>}</div>
  </div>)}</div>;
}
export function CloudUsageIndicator({ workspace, usage }: { workspace: CloudWorkspace | null; usage?: Usage }) {
  const popover = useRef<HTMLDivElement>(null);
  const contextKnown = !!workspace?.contextWindow && typeof workspace.inputTokens === "number";
  const percent = contextKnown ? Math.min(100, workspace!.inputTokens! / workspace!.contextWindow! * 100) : undefined;
  const headline = usage?.limits.find(limit => limit.active) || usage?.limits.reduce((a, b) => a.usedPercent >= b.usedPercent ? a : b, usage.limits[0]);
  const remaining = headline ? Math.round(100 - headline.usedPercent) : undefined;
  return <>
    <button type="button" className="cloudUsageTrigger" aria-label={`Context and usage${remaining === undefined ? "" : `, ${remaining}% usage left`}${percent === undefined ? "" : `, ${Math.round(percent)}% context used`}`} aria-haspopup="dialog" onClick={event => {
      const element = popover.current!;
      if (element.matches(":popover-open")) { element.hidePopover(); return; }
      const rect = event.currentTarget.getBoundingClientRect();
      element.style.left = `${Math.max(12, Math.min(rect.right - 280, window.innerWidth - 292))}px`;
      element.style.bottom = `${window.innerHeight - rect.top + 8}px`;
      element.showPopover();
    }}><span className="cloudMiniUsage"><UsageRing compact value={remaining} used={headline?.usedPercent} severity={headline?.severity}/><span>{remaining === undefined ? "—" : `${remaining}%`}<small>Usage left</small></span></span>
      <span className="cloudMiniUsage"><UsageRing compact value={percent} used={percent}/><span>{percent === undefined ? "—" : `${Math.round(percent)}%`}<small>Context</small></span></span></button>
    <div ref={popover} popover="auto" role="dialog" aria-label="Context and usage" className="cloudUsagePopover">
      <div className="cloudContextUsage cloudUsageWindow"><UsageRing value={percent} used={percent}/><div><strong>Context</strong><span>{contextKnown ? `${workspace!.inputTokens!.toLocaleString()} / ${workspace!.contextWindow!.toLocaleString()}` : "Available after your first turn"}</span></div></div>
      <CloudUsageDetails usage={usage}/>
    </div>
  </>;
}
